// tools/sync_from_channel.js
// Genera HLS base per a TOTS els programes.
// - Amb MP4 si existeix (public/assets_src/<NAME>.mp4)
// - Si no, patró sintètic (smptebars + anullsrc) perquè sempre hi hagi segments reals.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const channel = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../config/channel.json'), 'utf8')
);

function ensureDir(p){ fs.mkdirSync(p, { recursive: true }); }
function hasSegments(plPath){
  try{
    const dir = path.dirname(plPath);
    const lines = fs.readFileSync(plPath, 'utf8').split(/\r?\n/);
    for(const L of lines){
      const s=L.trim(); if(!s || s.startsWith('#')) continue;
      const f = path.join(dir, s);
      const st = fs.statSync(f);
      return st.isFile() && st.size > 0;
    }
    return false;
  }catch{ return false; }
}

const SEG = 6;                 // durada segment (s)
const DUR = 300;               // durada total si és sintètic (s) → 5 min
const VBR = '2500k', A_BR='128k';

for(const prog of channel.programs){
  const name = prog.name;
  const outDir = path.join(__dirname, `../public/hls/${name}`);
  const plPath = path.join(outDir, 'index.m3u8');
  const mp4    = path.join(__dirname, `../public/vod/${name}.mp4`);

  ensureDir(outDir);

  // Si ja hi ha un HLS vàlid, no fem res
  if (fs.existsSync(plPath) && hasSegments(plPath)) {
    console.log(`✓ ${name}: HLS base OK (${plPath})`);
    continue;
  }

  // Decideix font: MP4 si existeix, sinó lavfi sintètic
  let args;
  if (fs.existsSync(mp4)) {
    console.log(`→ ${name}: generant HLS des de MP4`);
    args = [
      '-y','-hide_banner','-loglevel','warning',
      '-i', mp4,
      '-c:v','libx264','-preset','veryfast','-profile:v','main','-pix_fmt','yuv420p',
      '-b:v', VBR, '-maxrate', VBR, '-bufsize', '5000k',
      '-sc_threshold','0','-g', String(SEG*10), '-keyint_min', String(SEG*10),
      '-force_key_frames', `expr:gte(t,n_forced*${SEG})`,
      '-c:a','aac','-b:a',A_BR,'-ar','48000','-ac','2',
      '-f','hls','-hls_time', String(SEG), '-hls_list_size','0',
      '-hls_flags','independent_segments',
      '-hls_segment_filename', path.join(outDir, 'seg_%05d.ts'),
      plPath
    ];
  } else {
    console.log(`→ ${name}: NO hi ha MP4 → generant HLS SINTÈTIC (color bars)`);
    args = [
      '-y','-hide_banner','-loglevel','warning',
      // Vídeo sintètic 1280x720@30
      '-f','lavfi','-i','smptebars=size=1280x720:rate=30',
      // Àudio sintètic 48kHz estéreo
      '-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000',
      '-t', String(DUR),
      '-c:v','libx264','-preset','veryfast','-profile:v','main','-pix_fmt','yuv420p',
      '-b:v', VBR, '-maxrate', VBR, '-bufsize','5000k',
      '-sc_threshold','0','-g', String(SEG*10), '-keyint_min', String(SEG*10),
      '-force_key_frames', `expr:gte(t,n_forced*${SEG})`,
      '-c:a','aac','-b:a',A_BR,'-ar','48000','-ac','2',
      '-shortest',
      '-f','hls','-hls_time', String(SEG), '-hls_list_size','0',
      '-hls_flags','independent_segments',
      '-hls_segment_filename', path.join(outDir, 'seg_%05d.ts'),
      plPath
    ];
  }

  const { status, stderr } = spawnSync('ffmpeg', args, { encoding:'utf8' });
  if (status !== 0) {
    console.error(`✗ FFmpeg ${name}:\n${stderr}`);
  } else {
    console.log(`OK → ${plPath}`);
  }
}

console.log('Sync completada.');
