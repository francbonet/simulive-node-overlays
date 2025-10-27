// tools/generate_overlays.js
// Genera HLS amb N imatges i N textos per programa (posicions/escales/offsets independents).
// Esquema overlays.json (nou):
// [
//   {
//     "program": "AB-001",
//     "start": 1, "end": 20,                  // opcional a nivell de bloc (heretat)
//     "texts": [                              // o "text": { ... } per 1 sol
//       { "text": "AB-001", "posX": "left", "posY": "bottom", "scale": 1, "offsetX": 0, "offsetY": 0, "textOffsetX": 0, "textOffsetY": 40, "start": 1, "end": 20, "fontSize": 48, "fontColor": "white", "boxColor": "black@0.65" }
//     ],
//     "images": [                             // o "image": { "image": "assets/faldon.png", ... } per 1 sola
//       { "image": "assets/faldon.png", "posX": "left", "posY": "bottom", "scale": 1, "offsetX": 0, "offsetY": 0, "start": 1, "end": 20 }
//     ]
//   }
// ]
//
// Compatibilitat enrere: també accepta camps aplaçats (posX/posY/scale/text/image) i els converteix a arrays.
// Sortida: public/hls_ovr/<NAME>/index.m3u8
//
// Ús parcial: ONLY=AB-001 npm run gen:overlays

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Config
const channel  = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/channel.json'),  'utf8'));
const overlays = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/overlays.json'), 'utf8'));

// Origen prioritari
const VOD_DIR = path.join(__dirname, '../public/vod');

// Paràmetres encodat/HLS
const SEG = 6;               // s/segment
const DUR = 300;             // durada sintètica (s)
const VBR = '2500k';
const ABR = '128k';

// Filtre d'un sol programa
const ONLY = process.env.ONLY || null;

// ---------- Helpers ----------

// Alineació per IMATGE (overlay). ow/oh = 'overlay_w'/'overlay_h' a FFmpeg
function posToXYForOverlay(posX, posY, ow = 'w', oh = 'h') {
  const pad = 20;
  let x, y;
  switch (posX) {
    case 'right':  x = `main_w-${ow}-${pad}`; break;
    case 'center': x = `(main_w-${ow})/2`;    break;
    default:       x = `${pad}`;              break; // left
  }
  switch (posY) {
    case 'bottom': y = `main_h-${oh}-${pad}`; break;
    case 'middle': y = `(main_h-${oh})/2`;    break;
    default:       y = `${pad}`;              break; // top
  }
  return { x, y };
}

// Alineació per TEXT (drawtext). Usa text_w/text_h en comptes d'overlay_w/h
function posToXYForText(posX, posY, tw = 'text_w', th = 'text_h') {
  const pad = 20;
  let x, y;
  switch (posX) {
    case 'right':  x = `main_w-${tw}-${pad}`; break;
    case 'center': x = `(main_w-${tw})/2`;    break;
    default:       x = `${pad}`;              break; // left
  }
  switch (posY) {
    case 'bottom': y = `main_h-${th}-${pad}`; break;
    case 'middle': y = `(main_h-${th})/2`;    break;
    default:       y = `${pad}`;              break; // top
  }
  return { x, y };
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function hlsHasValidSegments(plPath) {
  try {
    if (!fs.existsSync(plPath)) return false;
    const dir = path.dirname(plPath);
    const lines = fs.readFileSync(plPath, 'utf8').split(/\r?\n/);
    for (const L of lines) {
      const s = L.trim();
      if (!s || s.startsWith('#')) continue;
      const segAbs = path.join(dir, s);
      const st = fs.statSync(segAbs);
      return st.isFile() && st.size > 0;
    }
  } catch {}
  return false;
}

// Autodetecció de font per drawtext
const FONT_CANDIDATES = [
  // macOS
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/Library/Fonts/Arial.ttf',
  '/System/Library/Fonts/Supplemental/Helvetica.ttf',
  // Linux
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
  // Windows
  'C:/Windows/Fonts/arial.ttf',
];
const FONTFILE = FONT_CANDIDATES.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;

// Normalitza un bloc d'overlay a { images:[], texts:[] } amb herència de start/end
function normalizeOverlayBlock(block) {
  const start = block.start ?? 0;
  const end   = block.end   ?? 1e9;

  // Legacy: si hi havia camps plans, convertir-los
  const images = [];
  const texts  = [];

  // Nou format
  if (Array.isArray(block.images)) {
    for (const im of block.images) {
      if (im && im.image) images.push({ ...im, start: im.start ?? start, end: im.end ?? end });
    }
  } else if (block.image && typeof block.image === 'object' && block.image.image) {
    images.push({ ...block.image, start, end });
  } else if (typeof block.image === 'string') {
    // suport ultra-legacy: image: "path"
    images.push({ image: block.image, posX: block.posX, posY: block.posY, scale: block.scale, start, end });
  }

  if (Array.isArray(block.texts)) {
    for (const tx of block.texts) {
      if (tx && (typeof tx.text === 'string')) texts.push({ ...tx, start: tx.start ?? start, end: tx.end ?? end });
    }
  } else if (block.text && typeof block.text === 'object' && typeof block.text.text === 'string') {
    texts.push({ ...block.text, start, end });
  } else if (typeof block.text === 'string') {
    // suport ultra-legacy: text: "literal"
    texts.push({ text: block.text, posX: block.posX, posY: block.posY, scale: block.scale, start, end });
  }

  return { images, texts };
}

// ---------- Procés ----------

const overlayByProgram = new Map(overlays.map(o => [o.program, o]));

for (const prog of channel.programs) {
  if (ONLY && prog.name !== ONLY) {
    console.log(`(skip ${prog.name})`);
    continue;
  }

  const name = prog.name;
  const base = overlayByProgram.get(name);
  if (!base) {
    console.log(`→ ${name}: sense overlay, omès.`);
    continue;
  }

  const { images, texts } = normalizeOverlayBlock(base);

  if (images.length === 0 && texts.length === 0) {
    console.log(`→ ${name}: overlay buit (ni imatges ni textos), omès.`);
    continue;
  }

  const outDir = path.join(__dirname, `../public/hls_ovr/${name}`);
  ensureDir(outDir);

  // Tria origen vídeo
  const inputMp4 = path.join(VOD_DIR, `${name}.mp4`);
  const inputHls = path.join(__dirname, `../public/${prog.playlist}`);
  let useSynthetic = false;

  const inputArgs = [];
  // 0) MP4 si existeix
  if (fs.existsSync(inputMp4)) {
    inputArgs.push('-i', inputMp4); // [0]: A/V
  }
  // 1) HLS base si té segments
  else if (fs.existsSync(inputHls) && hlsHasValidSegments(inputHls)) {
    inputArgs.push('-i', inputHls); // [0]: A/V
  }
  // 2) Sintètic
  else {
    useSynthetic = true;
    inputArgs.push(
      '-f','lavfi','-i','smptebars=size=1280x720:rate=30',                  // [0]: V
      '-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000'  // [1]: A
    );
    console.log(`→ ${name}: cap font trobada → generant sintètic amb overlays`);
  }

  // Afegeix totes les IMATGES com a inputs addicionals
  // Guardem el mapping index->descriptor perquè el filtre sàpiga quin input és cada imatge
  const imageInputs = [];
  for (const im of images) {
    const rel = im.image;
    const abs = rel ? path.join(__dirname, `../public/${rel}`) : null;
    if (!rel || !abs || !fs.existsSync(abs)) {
      console.warn(`⚠︎ ${name}: imatge no trobada o no definida → ${rel}`);
      imageInputs.push(null); // placeholder; s'ignorarà després
      continue;
    }
    inputArgs.push('-i', abs);
    imageInputs.push({ abs, rel });
  }

  // Índex streams
  const videoIn = '0:v';
  const audioIn = useSynthetic ? '1:a' : '0:a';

  // Construcció filters
  const steps = [];
  let currentV = videoIn;

  // 1) Aplica IMATGES (una a una, en ordre)
  // cada imatge pot tenir posició/escala/offset i start/end propis
  let imgInputBaseIndex = useSynthetic ? 2 : 1; // primer input d'imatge al grafo
  for (let i = 0; i < images.length; i++) {
    const im = images[i];
    const inputMeta = imageInputs[i];
    if (!inputMeta) continue; // imatge no trobada

    const scale = Number(im.scale ?? 1);
    const start = im.start ?? base.start ?? 0;
    const end   = im.end   ?? base.end   ?? 1e9;

    const { x: xBase, y: yBase } = posToXYForOverlay(im.posX || base.posX || 'left', im.posY || base.posY || 'top', 'overlay_w', 'overlay_h');
    const ox = Number(im.offsetX || 0);
    const oy = Number(im.offsetY || 0);
    const x  = `(${xBase})+${ox}`;
    const y  = `(${yBase})+${oy}`;
    const enable = `between(t,${start},${end})`;

    // [imgInput]scale=iw*scale:-1[ovrN]
    const imgInIdx = imgInputBaseIndex + i;
    const tagScaled = `ovr${i}`;
    steps.push(`[${imgInIdx}:v]scale=iw*${scale}:-1[${tagScaled}]`);

    // [currentV][ovrN]overlay=... [vX]
    const outTag = `v_img_${i}`;
    steps.push(`[${currentV}][${tagScaled}]overlay=x=${x}:y=${y}:enable='${enable}'[${outTag}]`);
    currentV = outTag;
  }

  // 2) Aplica TEXTOS (en ordre)
  for (let j = 0; j < texts.length; j++) {
    const tx = texts[j];
    const start = tx.start ?? base.start ?? 0;
    const end   = tx.end   ?? base.end   ?? 1e9;
    const enable = `between(t,${start},${end})`;

    const { x: xBase, y: yBase } = posToXYForText(tx.posX || base.posX || 'left', tx.posY || base.posY || 'top', 'text_w', 'text_h');
    const tox = Number(tx.textOffsetX ?? tx.offsetX ?? 0);
    const toy = Number(tx.textOffsetY ?? tx.offsetY ?? 40);
    const x   = `(${xBase})+${tox}`;
    const y   = `(${yBase})+${toy}`;

    const rawText = String(tx.text ?? '').replace(/[:'\\]/g, '\\$&');
    const fontSizeBase = Number(tx.fontSize ?? 48);
    const fontScale    = Number(tx.scale ?? base.scale ?? 1);
    const fontSize     = Math.max(8, Math.round(fontSizeBase * (isFinite(fontScale) ? fontScale : 1)));
    const fontColor    = tx.fontColor || 'white';
    const boxColor     = tx.boxColor  || 'black@0.65';
    const fontOpt      = FONTFILE ? `:fontfile=${FONTFILE.replace(/:/g, '\\:')}` : '';

    const outTag = `v_txt_${j}`;
    const draw =
      `[${currentV}]drawtext=text='${rawText}'${fontOpt}:` +
      `x=${x}:y=${y}:` +
      `fontcolor=${fontColor}:fontsize=${fontSize}:line_spacing=4:` +
      `box=1:boxcolor=${boxColor}:boxborderw=8:` +
      `enable='${enable}'[${outTag}]`;
    steps.push(draw);
    currentV = outTag;
  }

  const vf = steps.length ? steps.join(';') : 'null';

  // Args FFmpeg finals
  const args = [
    '-y', '-hide_banner', '-loglevel', 'warning',
    ...inputArgs,
    ...(useSynthetic ? ['-t', String(DUR)] : []),
    ...(steps.length ? ['-filter_complex', vf, '-map', `[${currentV}]`] : ['-map', videoIn]),
    '-map', `${audioIn}?`,
    // Encodat estable
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
    '-b:v', VBR, '-maxrate', VBR, '-bufsize', '5000k',
    '-sc_threshold', '0',
    '-g', String(SEG * 10),
    '-keyint_min', String(SEG * 10),
    '-force_key_frames', `expr:gte(t,n_forced*${SEG})`,
    '-c:a', 'aac', '-b:a', ABR, '-ar', '48000', '-ac', '2',
    // HLS out
    '-f', 'hls',
    '-hls_time', String(SEG),
    '-hls_list_size', '0',
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', path.join(outDir, 'seg_%05d.ts'),
    path.join(outDir, 'index.m3u8'),
  ];

  console.log(`>>> Generant overlay per ${name}`);
  const { status, stderr } = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (status !== 0) {
    console.error(`✗ FFmpeg (overlay ${name}):\n${stderr}`);
    process.exitCode = 1;
  } else {
    console.log(`OK → public/hls_ovr/${name}/index.m3u8`);
  }
}

console.log('Overlays llestos.');
