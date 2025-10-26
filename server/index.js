// server/index.js
const fs = require('fs');
const path = require('path');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 8080;

/* ---------- Estàtics ---------- */
app.use(express.static(path.join(__dirname, '..', 'public')));

const serveStatic = express.static;
const hlsPath = path.join(__dirname, '..', 'hls');
const hlsOvrPath = path.join(__dirname, '..', 'hls_ovr');

// Logger (només /hls_ovr) per detectar fitxers inexistents reals
app.use('/hls_ovr', (req, res, next) => {
  const rel = req.path.replace(/^\/+/, '');
  const p = path.join(hlsOvrPath, rel);
  fs.access(p, fs.constants.R_OK, (err) => {
    if (err) console.error('[MISS OVR]', p);
    next();
  });
});

// /hls sense overlays
app.use('/hls', serveStatic(hlsPath, {
  fallthrough: false,
  etag: true,
  lastModified: true,
  acceptRanges: true,
  cacheControl: true,
  setHeaders(res, filePath) {
    if (filePath && filePath.endsWith('.ts')) res.setHeader('Content-Type', 'video/MP2T');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}));

// /hls_ovr amb overlays
app.use('/hls_ovr', serveStatic(hlsOvrPath, {
  fallthrough: false,
  etag: true,
  lastModified: true,
  acceptRanges: true,
  cacheControl: true,
  setHeaders(res, filePath) {
    if (filePath && filePath.endsWith('.ts')) res.setHeader('Content-Type', 'video/MP2T');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}));

/* ---------- Utils VOD (parser robust) ---------- */
function parseVodM3U8(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).map(l => l.trim());
  const segments = [];
  let targetDuration = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      const v = parseFloat(line.split(':')[1]);
      if (Number.isFinite(v)) targetDuration = Math.ceil(v);
    }

    if (line.startsWith('#EXTINF:')) {
      let dur = parseFloat(line.substring('#EXTINF:'.length).split(',')[0]);
      if (!Number.isFinite(dur) || dur <= 0) dur = 4;

      // propera línia no comentari com a URI
      let uri = null;
      let j = i + 1;
      while (j < lines.length) {
        const cand = lines[j].trim();
        if (cand && !cand.startsWith('#')) { uri = cand; break; }
        if (cand.startsWith('#EXTINF:')) break; // sense URI vàlid
        j++;
      }
      if (uri) {
        segments.push({ uri, duration: dur });
        i = j; // salta a la línia del URI
      }
    }
  }
  return { segments, targetDuration: targetDuration || 4 };
}

function toAbsoluteLike(uri) {
  if (typeof uri !== 'string' || uri.length === 0) return '';
  if (/^https?:\/\//i.test(uri)) return uri;
  if (!uri.startsWith('/')) return '/' + uri.replace(/^\/+/, '');
  return uri;
}

/* ---------- Helpers segurs ---------- */
function modSafe(k, n) {
  if (!Number.isFinite(k) || !Number.isFinite(n) || n <= 0) return 0;
  return ((Math.trunc(k) % Math.trunc(n)) + Math.trunc(n)) % Math.trunc(n);
}
function numOr(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

/* ---------- Timeline “live” robusta (ms-based + índex segur) ---------- */
function buildTimeline(schedulePath) {
  const DEFAULT_DUR = 4;
  const schedule = JSON.parse(fs.readFileSync(schedulePath, 'utf8'));

  const programs = schedule.programs.map(p => {
    const abs = path.isAbsolute(p.playlist) ? p.playlist : path.join(process.cwd(), p.playlist);
    if (!fs.existsSync(abs)) {
      console.warn('[simulive] WARN playlist not found ->', abs);
      return null;
    }
    const parsed = parseVodM3U8(abs);

    // base dir com es servirà via HTTP (p.ex. "hls_ovr/AB-001")
    const baseDir = path.dirname(p.playlist).replace(/\\/g, '/').replace(/^\.\//, '');

    const segs = parsed.segments.map(s => {
      const localUri = /^https?:\/\//i.test(s.uri) ? s.uri : `${baseDir}/${s.uri}`.replace(/\/{2,}/g, '/');
      const uri = toAbsoluteLike(localUri);
      const dur = Number.isFinite(s.duration) && s.duration > 0 ? s.duration : DEFAULT_DUR;
      return uri ? { uri, duration: dur, programBaseDir: baseDir } : null;
    }).filter(Boolean);

    return { name: p.name, segments: segs, baseDir };
  }).filter(Boolean);

  // Aplana, valida i normalitza
  const ALL_SEGMENTS = [];
  let TARGET_DURATION = 0;

  programs.forEach((prog, idx) => {
    prog.segments.forEach((s, i) => {
      if (!s || typeof s.uri !== 'string' || s.uri.length < 2) return;
      const dur = Number.isFinite(s.duration) && s.duration > 0 ? s.duration : DEFAULT_DUR;
      ALL_SEGMENTS.push({
        programIndex: idx,
        segmentIndex: i,
        uri: toAbsoluteLike(s.uri),
        duration: dur,
        baseDir: prog.baseDir
      });
      TARGET_DURATION = Math.max(TARGET_DURATION, Math.ceil(dur));
    });
  });

  const SEGMENTS = ALL_SEGMENTS.filter(s => s && typeof s.uri === 'string' && s.uri.length > 1);
  if (SEGMENTS.length === 0) {
    console.error('[simulive] ERROR: no valid segments after parsing', { schedulePath });
    return {
      debug: () => ({ totalSegments: 0 }),
      renderPlaylist: (req, res) => {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-store, must-revalidate');
        return res.status(500).send('#EXTM3U\n# No valid segments');
      }
    };
  }

  // Timebase ms (enter)
  const DUR_MS = SEGMENTS.map(s => Math.round(numOr(s.duration, DEFAULT_DUR) * 1000));
  const TOTAL_MS = DUR_MS.reduce((a,b)=>a+b, 0);
  const CUM_MS = new Array(DUR_MS.length + 1);
  CUM_MS[0] = 0;
  for (let i = 0; i < DUR_MS.length; i++) CUM_MS[i+1] = CUM_MS[i] + DUR_MS[i];

  const WINDOW_SEGMENTS = Math.max(3, schedule.windowSegments || 12);

  // discontinuïtats per programa
  const DISCO_FLAGS = [];
  let prevProg = SEGMENTS[0].programIndex;
  for (let i = 0; i < SEGMENTS.length; i++) {
    const p = SEGMENTS[i].programIndex;
    DISCO_FLAGS[i] = i === 0 ? 0 : (p !== prevProg ? 1 : 0);
    prevProg = p;
  }
  const DISCO_PER_LOOP = DISCO_FLAGS.slice(1).reduce((a,b)=>a+b,0);

  // època fixa
  const EPOCH_MS = Date.now();

  // helpers (ms)
  function indexInLoopFromOffsetMs(offMs) {
    // binary search segura
    let lo = 0, hi = DUR_MS.length - 1, ans = DUR_MS.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (offMs < CUM_MS[mid+1]) { ans = mid; hi = mid - 1; }
      else lo = mid + 1;
    }
    return ans;
  }
  function currentSegmentIndexMs(nowMs) {
    const sinceEpoch = nowMs - EPOCH_MS;
    const mod = modSafe(sinceEpoch % TOTAL_MS, TOTAL_MS);
    return indexInLoopFromOffsetMs(mod);
  }
  function mediaSequenceNumberMs(nowMs) {
    const sinceEpoch = nowMs - EPOCH_MS;
    const loops = Math.floor(numOr(sinceEpoch / TOTAL_MS, 0));
    const idx = currentSegmentIndexMs(nowMs);
    return loops * SEGMENTS.length + idx;
  }
  function discontinuitySequenceFor(firstGlobalSegNumber) {
    const loops = Math.floor(firstGlobalSegNumber / SEGMENTS.length);
    const pos = firstGlobalSegNumber % SEGMENTS.length;
    let seq = loops * DISCO_PER_LOOP;
    for (let i = 0; i < pos; i++) seq += DISCO_FLAGS[i];
    return seq;
  }

  // comprova si el .ts local existeix (només per rutes locals)
  function segmentExistsLocal(uri) {
    if (/^https?:\/\//i.test(uri)) return true; // assumim remot OK
    const rel = uri.replace(/^\//, ''); // treu leading /
    const candidate1 = path.join(process.cwd(), rel); // e.g. /project/hls/AB-001/seg_00001.ts
    try {
      fs.accessSync(candidate1, fs.constants.R_OK);
      return true;
    } catch {}
    return false;
  }

  function renderPlaylist(req, res) {
    try {
      const ct = 'application/vnd.apple.mpegurl';
      const nowMs = Date.now();

      // Índex start segur
      let startIdx = currentSegmentIndexMs(nowMs);
      startIdx = modSafe(startIdx, SEGMENTS.length);

      // MEDIA-SEQUENCE ≥ 0
      let firstGlobalSegNumber = mediaSequenceNumberMs(nowMs) - (WINDOW_SEGMENTS - 1);
      if (!Number.isFinite(firstGlobalSegNumber) || firstGlobalSegNumber < 0) firstGlobalSegNumber = 0;

      const discoSeq = discontinuitySequenceFor(firstGlobalSegNumber);

      // Finestra de segments (omple només amb segments que existeixen; sense fallbacks)
      const windowSegs = [];
      let back = WINDOW_SEGMENTS - 1;
      while (windowSegs.length < WINDOW_SEGMENTS && back >= -SEGMENTS.length) {
        const i = modSafe(startIdx - back, SEGMENTS.length);
        const seg = SEGMENTS[i];
        if (seg && seg.uri && segmentExistsLocal(seg.uri)) {
          windowSegs.push({ ...seg });
        } else {
          // si falta, continua buscant cap enrere sense introduir cap segment de substitució
        }
        back--;
      }

      // si per qualsevol motiu no aconsegueixes omplir, envia el que tinguis (millor que col·lapsar)
      if (windowSegs.length === 0) {
        res.setHeader('Content-Type', ct);
        res.setHeader('Cache-Control', 'no-store, must-revalidate');
        return res.status(503).send('#EXTM3U\n# Window empty');
      }

      // segment anterior segur (per a DISCONTINUITY)
      const prevIndex = modSafe(startIdx - WINDOW_SEGMENTS, SEGMENTS.length);
      let lastProgram = (SEGMENTS[prevIndex] && SEGMENTS[prevIndex].programIndex) != null
        ? SEGMENTS[prevIndex].programIndex
        : SEGMENTS[0].programIndex;

      // Manifest
      let out = '#EXTM3U\n';
      out += '#EXT-X-VERSION:3\n';
      out += '#EXT-X-PLAYLIST-TYPE:EVENT\n';
      out += '#EXT-X-INDEPENDENT-SEGMENTS\n';
      out += `#EXT-X-TARGETDURATION:${Math.max(4, ...windowSegs.map(s=>Math.ceil(numOr(s.duration, DEFAULT_DUR))))}\n`;
      out += `#EXT-X-MEDIA-SEQUENCE:${firstGlobalSegNumber}\n`;
      out += `#EXT-X-DISCONTINUITY-SEQUENCE:${discoSeq}\n`;

      // força DISCONTINUÏTAT al primer
      let forceFirstDisco = true;

      windowSegs.forEach((s, idx) => {
        const uriClean = toAbsoluteLike(s.uri);
        const d = numOr(s.duration, DEFAULT_DUR);

        if (!uriClean) return; // salta per seguretat

        if (forceFirstDisco || lastProgram !== s.programIndex) {
          out += '#EXT-X-DISCONTINUITY\n';
        }
        forceFirstDisco = false;

        // (Hem tret PROGRAM-DATE-TIME per evitar desalineacions amb PTS reals)
        out += `#EXTINF:${d.toFixed(3)},\n`;
        out += `${uriClean}?v=${firstGlobalSegNumber + idx}\n`;

        lastProgram = s.programIndex;
      });

      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      return res.send(out);
    } catch (e) {
      console.error('[renderPlaylist] error:', e);
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.status(500).send('#EXTM3U\n# Error generating playlist');
      }
      return res.end();
    }
  }

  return {
    renderPlaylist,
    debug: () => ({
      totalSegments: SEGMENTS.length,
      sample: SEGMENTS.slice(0, 3).map(s => ({ uri: s.uri, d: s.duration }))
    })
  };
}

/* ---------- Timelines i rutes ---------- */
const timelineNormal  = buildTimeline(path.join(__dirname, 'schedule.json'));
const timelineOverlay = buildTimeline(path.join(__dirname, 'schedule_overlay.json'));

app.get('/channel/playlist.m3u8', timelineNormal.renderPlaylist);
app.get('/channel/ovr.m3u8',     timelineOverlay.renderPlaylist);

app.use('/hls_live', express.static(path.join(__dirname, '..', 'hls_live')));

// Debug
app.get('/debug/normal', (_req, res) => res.json(timelineNormal.debug()));
app.get('/debug/ovr',    (_req, res) => res.json(timelineOverlay.debug()));

app.get('/', (_req, res) => res.send('Up. Try /channel/playlist.m3u8 or /channel/ovr.m3u8 or /player.html'));

app.listen(PORT, () => {
  console.log(`Simulive listening on http://localhost:${PORT}`);
});
