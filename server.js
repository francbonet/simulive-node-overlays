// server.js
import fs from 'fs';
import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';
import { Parser as M3U8Parser } from 'm3u8-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// --- CONFIG ---
const CHANNEL_CFG = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'config/channel.json'), 'utf8')
);
// overlays.json no es imprescindible en el servidor (se usa para generar),
// pero lo cargamos para decidir si hay versión overlay disponible.
const OVERLAYS = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'config/overlays.json'), 'utf8')
);

// Public (sirve hls y hls_ovr tal cual)
app.use(express.static(path.join(__dirname, 'public')));

// Ancla temporal estable (puedes cambiarla si quieres “sincronizar” el directo)
const EPOCH_MS = Date.UTC(2025, 0, 1, 0, 0, 0);

// Util: lee y parsea un playlist .m3u8 local
function parseLocalM3U8(playlistRelPath) {
  const full = path.join(__dirname, 'public', playlistRelPath);
  if (!fs.existsSync(full)) {
    throw new Error(`No existe playlist: ${playlistRelPath}`);
  }
  const content = fs.readFileSync(full, 'utf8');
  const parser = new M3U8Parser();
  parser.push(content);
  parser.end();
  const manifest = parser.manifest;

  // Normaliza segmentos con su URI absoluto relativo al playlist
  const baseDir = path.dirname(playlistRelPath);
  const segments = (manifest.segments || []).map((s) => ({
    duration: s.duration,
    uri: path.posix.join(baseDir, s.uri),
  }));
  const targetDuration = manifest.targetDuration || Math.ceil(
    Math.max(...segments.map(s => s.duration || 6), 6)
  );

  return { targetDuration, segments };
}

// Decide si usaremos overlay (hls_ovr) para un programa, si existe
function overlayPlaylistFor(programName) {
  const ovrIndex = `hls_ovr/${programName}/index.m3u8`;
  const full = path.join(__dirname, 'public', ovrIndex);
  if (fs.existsSync(full)) return ovrIndex;
  // fallback al playlist “base”
  const prog = CHANNEL_CFG.programs.find(p => p.name === programName);
  if (!prog) throw new Error(`Programa no encontrado: ${programName}`);
  return prog.playlist;
}

// Carga todos los programas (sus segmentos) y aplana a una línea temporal
function buildProgramTimeline() {
  const timeline = [];
  let maxTarget = 6;

  for (const prog of CHANNEL_CFG.programs) {
    const chosenPlaylist = overlayPlaylistFor(prog.name);
    const { targetDuration, segments } = parseLocalM3U8(chosenPlaylist);
    maxTarget = Math.max(maxTarget, targetDuration);

    // Guarda lista con marca del programa
    timeline.push({
      program: prog.name,
      playlistPath: chosenPlaylist,
      targetDuration,
      segments, // [{duration, uri}]
      totalDuration: segments.reduce((acc, s) => acc + s.duration, 0),
    });
  }

  // Aplanar a una lista global de segmentos con info de programa
  const flat = [];
  for (let i = 0; i < timeline.length; i++) {
    const t = timeline[i];
    for (let j = 0; j < t.segments.length; j++) {
      flat.push({
        program: t.program,
        uri: t.segments[j].uri,
        duration: t.segments[j].duration,
        // discontinuity si cambia de programa respecto al anterior
        discontinuity: (flat.length > 0 && flat[flat.length - 1].program !== t.program),
      });
    }
  }

  const totalDuration = flat.reduce((a, s) => a + s.duration, 0);
  const targetDuration = Math.ceil(Math.max(maxTarget, ...flat.map(s => s.duration)));

  return { flat, totalDuration, targetDuration };
}

// Busca el índice de segmento “cabeza” según el reloj
function headIndexFromNow(flat, totalDuration) {
  const now = Date.now();
  const sinceEpoch = (now - EPOCH_MS) / 1000; // seg
  const pos = ((sinceEpoch % totalDuration) + totalDuration) % totalDuration;
  // recorre sumando duraciones hasta encontrar el segmento donde cae pos
  let acc = 0;
  for (let i = 0; i < flat.length; i++) {
    const next = acc + flat[i].duration;
    if (pos < next) return i;
    acc = next;
  }
  return 0;
}

function mod(n, m) {
  return ((n % m) + m) % m;
}

// Endpoint LIVE
app.get('/channel/ovr.m3u8', (req, res) => {
  try {
    const windowSegments = CHANNEL_CFG.windowSegments || 12;
    const loopEnabled = CHANNEL_CFG.loop !== false;

    const { flat, totalDuration, targetDuration } = buildProgramTimeline();
    if (flat.length === 0) {
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      return res.status(503).send('#EXTM3U\n# No segments');
    }

    let head = headIndexFromNow(flat, totalDuration);
    // Construye la ventana
    const out = [];
    let seq = Math.floor((Date.now() - EPOCH_MS) / (targetDuration * 1000)); // pseudo media sequence
    const dateTimeStart = new Date(Date.now()); // marca temporal del primer EXTINF

    out.push('#EXTM3U');
    out.push('#EXT-X-VERSION:3');
    out.push(`#EXT-X-TARGETDURATION:${targetDuration}`);
    out.push(`#EXT-X-MEDIA-SEQUENCE:${seq}`);
    out.push('#EXT-X-PLAYLIST-TYPE:EVENT');

    // Marca de tiempo del primer segmento
    out.push(`#EXT-X-PROGRAM-DATE-TIME:${dateTimeStart.toISOString()}`);

    let lastProgram = flat[head].program;
    for (let k = 0; k < windowSegments; k++) {
      const idx = mod(head + k, flat.length);

      if (!loopEnabled && head + k >= flat.length) break;

      const seg = flat[idx];

      // DISCONTINUITY si cambiamos de programa
      if (k === 0) {
        // para el primero ya pusimos PDT; si cambia en el siguiente, marcamos discont.
      } else if (seg.program !== lastProgram) {
        out.push('#EXT-X-DISCONTINUITY');
      }

      out.push(`#EXTINF:${seg.duration.toFixed(3)},`);
      out.push(`/${seg.uri.replace(/^\//, '')}`);

      lastProgram = seg.program;
    }

    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Cache-Control', 'no-store, must-revalidate');
    res.send(out.join('\n') + '\n');
  } catch (err) {
    console.error('[renderPlaylist] error:', err);
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Cache-Control', 'no-store, must-revalidate');
    res.status(500).send('#EXTM3U\n# Error generating playlist');
  }
});

// Arranque
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Simulive listening on http://localhost:${PORT}`);
  console.log(`Live endpoint: http://localhost:${PORT}/channel/ovr.m3u8`);
});
