import { Renderer } from './gl.js';
import { Muxer, ArrayBufferTarget } from './vendor/mp4-muxer.mjs';

// ------------------------------------------------------------------ state

const DEFAULTS = {
  format: '16:9', fps: 30, audio: true, quality: 'high',
  design: { source: 'text', text: 'GN', above: '', below: '', fill: 'fade', align: 'center', leading: 99, subSize: 20, aboveGap: 20, belowGap: 20, subStrength: 59, blend: 'overlay', strength: 170, size: 100, x: 50, y: 35.9 },
  glow:   { on: true, halo: 170, haloSize: 69, haloBlend: 'overlay', bloom: 120, bloomSize: 10.5 },
  ca:     { on: true, mode: 'radial', style: 'spectral', amount: 3, falloff: 1.5, angle: 0 },
  grain:  { on: true, amount: 10, size: 1, color: 'mono', motion: 'moving' },
  video:  { zoom: 100, panX: 0, panY: 0, exposure: 0, contrast: 0, saturation: 0 },
  look:   { on: true, vignette: 80, spread: 53 },
  logo:   { on: true, size: 6.1, y: 90.2 },
  icon:   { on: true, badge: '', blend: 'hardlight', size: 45, x: 26.8, y: 40.4, zoom: 109.6, edge: 1.7 },
};
const FORMATS = { '16:9': [1920, 1080], '1:1': [1080, 1080], '4:5': [1080, 1350], '9:16': [1080, 1920] };
const clone = (o) => JSON.parse(JSON.stringify(o));
function merge(base, over) {
  const out = clone(base);
  if (!over || typeof over !== 'object') return out;
  for (const k of Object.keys(out)) {
    if (over[k] === undefined) continue;
    if (out[k] && typeof out[k] === 'object') {
      for (const j of Object.keys(out[k])) if (over[k] && typeof over[k][j] === typeof out[k][j]) out[k][j] = over[k][j];
    } else if (typeof over[k] === typeof out[k]) out[k] = over[k];
  }
  return out;
}
let S = clone(DEFAULTS);
let savedHadSource = false;
try {
  const saved = JSON.parse(localStorage.getItem('afterglow.settings') || 'null');
  S = merge(DEFAULTS, saved);
  savedHadSource = !!(saved && saved.design && 'source' in saved.design);
} catch (e) {}
const getP = (path) => path.split('.').reduce((o, k) => o[k], S);
function setP(path, v) { const ks = path.split('.'); const last = ks.pop(); ks.reduce((o, k) => o[k], S)[last] = v; }
const defP = (path) => path.split('.').reduce((o, k) => o[k], DEFAULTS);
const outDims = () => FORMATS[S.format] || FORMATS['16:9'];

let mode = 'edit';
const media = {
  kind: null,          // 'video' | 'image' | null
  el: null, file: null, name: '', w: 0, h: 0, duration: 6,
  image: null, imageName: '',   // dropped / pasted design PNG
  text: null,                   // rendered text design { canvas, fit, px }
  logo: null, logoName: '',     // logo image (kept in this browser)
  icon: null, iconName: '',     // icon picture (kept in this browser)
};
const activeDesign = () => (S.design.source === 'text' ? media.text : media.image);
const clip = { in: 0, out: 6 };
let playing = false;
let muted = false;

const $ = (id) => document.getElementById(id);
const canvas = $('c');
let renderer;
try { renderer = new Renderer(canvas); } catch (e) { document.body.innerHTML = '<p style="padding:40px">WebGL 2 is required: ' + e.message + '</p>'; throw e; }

// ------------------------------------------------------------------ text design
// Same setup as the GN layer in Figma (Obol Internal 115:74): A-OTF Shin Go Pro M at 602.302 px in a
// 1350 px tall frame, tracking -6%, fill = vertical gradient white 0% (cap top) -> white 100% (baseline).
// The glow layers come from the renderer, exactly as for a pasted PNG.
const TXT = {
  face: 'AfterglowShinGo',
  size: 602.302 / 1350,   // max font px per px of min(frame w, h): plain "GN" lands at the Figma size
  tracking: -0.06,
  // line spacing (baseline to baseline) is design.leading, in % of the font size: 99 = LIVE ON OBOL (128:120)
  maxW: 0.84, maxH: 0.66, // auto-fit box, fraction of the frame
  ss: 2,                  // rendered at 2x output so scaling up stays sharp
  y: 35.9,                // GN centre in the Figma frame: 484.5 / 1350
  subTracking: -0.06, subLeading: 1.25, // "OBOL burned" in Obol Internal 97:47: same font and tracking as the main text
};
const FALLBACK = '"Helvetica Neue", Helvetica, Arial, sans-serif';
let textFamily = FALLBACK, fontName = '', fontSeq = 0;
// A face can report "loaded" and still not draw (some browsers hide user-installed fonts from local()),
// so check that text measures differently from both generic fallbacks.
function faceDraws(fam) {
  const c = document.createElement('canvas').getContext('2d'), s = 'GNRQgaW@0123';
  const w = (f) => { c.font = '100px ' + f; return c.measureText(s).width; };
  return w(fam + ', monospace') !== w('monospace') && w(fam + ', serif') !== w('serif');
}
async function useFontSource(src, name) {
  const fam = TXT.face + (++fontSeq);
  const ff = new FontFace(fam, src);
  await ff.load(); document.fonts.add(ff);
  if (!faceDraws(fam)) { document.fonts.delete(ff); return false; }
  textFamily = fam + ', ' + FALLBACK; fontName = name; return true;
}
// Fonts dropped by the user live only in this browser (IndexedDB); Shin Go is licensed and never deployed.
function idb() {
  return new Promise((res, rej) => { const r = indexedDB.open('afterglow', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function idbGet(k) { const db = await idb(); return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
async function idbPut(k, v) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
const fontReady = (async () => {
  const sources = [
    async () => { const rec = await idbGet('font'); return rec ? [rec.buf.slice(0), rec.name] : null; }, // font the user dropped
    async () => { const r = await fetch('fonts/AOTFShinGoProMedium.otf'); return r.ok ? [await r.arrayBuffer(), 'Shin Go Pro M'] : null; }, // local copy (gitignored)
    async () => ['local("ShinGoPro-Medium"), local("A-OTF Shin Go Pro M")', 'Shin Go Pro M'], // installed on this machine
  ];
  for (const get of sources) {
    try { const v = await withTimeout(get(), 3000); if (v && await withTimeout(useFontSource(v[0], v[1]), 3000)) return true; } catch (e) {} // a stuck source (IndexedDB, local()) must not block the next
  }
  return false;
})();
const isFontFile = (f) => /\.(otf|ttf|woff2?)$/i.test(f.name) || /^font\//.test(f.type);
async function loadFontFile(file) {
  const buf = await file.arrayBuffer();
  const name = file.name.replace(/\.(otf|ttf|woff2?)$/i, '');
  let ok = false;
  try { ok = await useFontSource(buf.slice(0), name); } catch (e) {}
  if (!ok) { toast('Could not use that font file', true); return; }
  try { await idbPut('font', { buf, name }); } catch (e) {}
  toast('Font: ' + name + ' (saved in this browser)');
  updateMediaLabels(); changed();
}
// Logo: SVG or PNG, drawn last at the bottom centre with no effects. Kept in this browser (IndexedDB).
async function useLogo(blob, name, save) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  try { await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; }); }
  catch (e) { toast('Could not read that logo', true); return false; }
  let src = img;
  if (/svg/.test(blob.type) || /\.svg$/i.test(name)) { // raster vectors big enough for 4K, mipmaps do the rest
    const a = (img.naturalWidth && img.naturalHeight) ? img.naturalWidth / img.naturalHeight : 1;
    const c = document.createElement('canvas'); c.height = 512; c.width = Math.max(1, Math.round(512 * a));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); src = c;
  }
  renderer.setLogo(src);
  media.logo = src; media.logoName = name;
  if (save) { S.logo.on = true; try { await idbPut('logo', { blob, name }); } catch (e) {} }
  updateLogoLabel(); changed();
  return true;
}
function clearLogo() {
  renderer.setLogo(null); media.logo = null; media.logoName = '';
  idb().then((db) => db.transaction('kv', 'readwrite').objectStore('kv').delete('logo')).catch(() => {});
  updateLogoLabel(); changed();
}
const logoInput = document.createElement('input');
logoInput.type = 'file'; logoInput.accept = '.svg,.png,.webp,image/svg+xml,image/png,image/webp'; logoInput.hidden = true;
logoInput.addEventListener('change', (e) => { const f = e.target.files[0]; if (f) useLogo(f, f.name, true); e.target.value = ''; });
document.body.appendChild(logoInput);
let updateLogoLabel = () => {};
function buildLogoRow(parent) {
  const r = document.createElement('div'); r.className = 'font-row';
  const n = document.createElement('span'); n.className = 'font-name';
  const b = document.createElement('button'); b.className = 'ghost'; b.title = 'SVG or PNG, white on transparent. Stays in this browser.';
  b.addEventListener('click', () => logoInput.click());
  const x = document.createElement('button'); x.className = 'ghost'; x.textContent = 'Remove';
  x.addEventListener('click', clearLogo);
  r.append(n, b, x); parent.appendChild(r);
  updateLogoLabel = () => {
    n.textContent = media.logo ? media.logoName : 'No logo (SVG or PNG, drawn on top, no effects)';
    b.textContent = media.logo ? 'Replace' : 'Add logo';
    x.hidden = !media.logo;
  };
  updateLogoLabel();
}
idbGet('logo').then((rec) => { if (rec && rec.blob) useLogo(rec.blob, rec.name, false); }).catch(() => {});
// ------------------------------------------------------------------ icon (picture + badge)
// LIVE ON OBOL (Obol Internal 128:120): a round picture with a feathered edge and a "5x" badge at its top
// left, all in one Hard light group above the text. Everything is in fractions of the picture diameter D,
// measured off the Figma frame (the group scales uniformly there too).
const ICN = {
  pill: 0.2796, pillX: -0.3946, pillY: -0.3526,       // badge diameter and centre offset
  text: 0.4849, blurs: [[0.00275, 1], [0.02955, 0.5], [0.0688, 0.5]], // badge text size (of the badge), blur copies
};
const mkCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); return c; };
function boxesForGauss(sigma, n) {
  let wl = Math.floor(Math.sqrt(12 * sigma * sigma / n + 1)); if (wl % 2 === 0) wl--;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  return Array.from({ length: n }, (_, i) => (i < m ? wl : wl + 2));
}
function boxPass(src, dst, w, h, r, horiz) { // running-sum box blur, transparent outside
  const k = 1 / (2 * r + 1), len = horiz ? w : h, lines = horiz ? h : w, st = horiz ? 1 : w;
  for (let l = 0; l < lines; l++) {
    const o = horiz ? l * w : l; let acc = 0;
    for (let i = 0; i <= r && i < len; i++) acc += src[o + i * st];
    for (let i = 0; i < len; i++) {
      dst[o + i * st] = acc * k;
      if (i + r + 1 < len) acc += src[o + (i + r + 1) * st];
      if (i - r >= 0) acc -= src[o + (i - r) * st];
    }
  }
}
// Gaussian blur (sigma in px) of a canvas, premultiplied so edges do not darken. Big radii run on a
// downscaled copy, which looks the same and stays fast in every browser (no ctx.filter needed).
function blurCanvas(src, sigma) {
  if (sigma < 0.3) return src;
  const f = Math.max(1, sigma / 3), w = Math.max(1, Math.round(src.width / f)), h = Math.max(1, Math.round(src.height / f)), sg = sigma * w / src.width;
  const c = mkCanvas(w, h), x = c.getContext('2d'); x.drawImage(src, 0, 0, w, h);
  const id = x.getImageData(0, 0, w, h), d = id.data, n = w * h;
  const ch = [0, 1, 2, 3].map(() => new Float32Array(n)), tmp = new Float32Array(n);
  for (let i = 0; i < n; i++) { const a = d[i * 4 + 3] / 255; ch[3][i] = a; ch[0][i] = d[i * 4] * a; ch[1][i] = d[i * 4 + 1] * a; ch[2][i] = d[i * 4 + 2] * a; }
  const boxes = boxesForGauss(sg, 3);
  for (const arr of ch) for (const b of boxes) { boxPass(arr, tmp, w, h, (b - 1) / 2, true); boxPass(tmp, arr, w, h, (b - 1) / 2, false); }
  for (let i = 0; i < n; i++) { const a = ch[3][i]; d[i * 4 + 3] = a * 255; for (let k = 0; k < 3; k++) d[i * 4 + k] = a > 1e-4 ? ch[k][i] / a : 0; }
  x.putImageData(id, 0, 0);
  if (f === 1) return c;
  const out = mkCanvas(src.width, src.height), o = out.getContext('2d');
  o.imageSmoothingQuality = 'high'; o.drawImage(c, 0, 0, src.width, src.height);
  return out;
}
function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
let iconSeq = 0;
// -> { canvas, cx, cy (picture centre, fraction of the canvas), w, h (frame fractions) } at up to 2x output
function iconCanvas(I, W, H) {
  const img = media.icon; if (!img) return null;
  const Dout = I.size / 100 * H, q = Math.min(2, 2048 / Math.max(1, Dout)), D = Dout * q;
  const badge = I.badge.trim();
  const pr = ICN.pill * D / 2, pc = [ICN.pillX * D, ICN.pillY * D], gm = 3 * ICN.blurs[2][0] * D;
  let x0 = -D / 2, y0 = -D / 2, x1 = D / 2, y1 = D / 2;
  if (badge) { x0 = Math.min(x0, pc[0] - pr - gm); y0 = Math.min(y0, pc[1] - pr - gm); x1 = Math.max(x1, pc[0] + pr + gm); y1 = Math.max(y1, pc[1] + pr + gm); }
  const ox = Math.ceil(2 - x0), oy = Math.ceil(2 - y0);
  const cv = mkCanvas(ox + x1 + 2, oy + y1 + 2), ctx = cv.getContext('2d');
  // picture: square cover crop, zoomed, through a feathered disc (50% at D/2 - 1.8 sigma, cut at D/2)
  const Dp = Math.ceil(D), pic = mkCanvas(Dp, Dp), px = pic.getContext('2d');
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height, sq = Math.min(iw, ih), z = D * I.zoom / 100;
  px.imageSmoothingQuality = 'high';
  px.drawImage(img, (iw - sq) / 2, (ih - sq) / 2, sq, sq, (Dp - z) / 2, (Dp - z) / 2, z, z);
  const sg = Math.max(0.5, I.edge / 100 * D), R = D / 2, R50 = R - 1.8 * sg, inner = R50 - 3.5 * sg;
  const mask = px.createImageData(Dp, Dp), md = mask.data, c0 = Dp / 2;
  for (let y = 0; y < Dp; y++) for (let x = 0; x < Dp; x++) {
    const r = Math.hypot(x + 0.5 - c0, y + 0.5 - c0);
    let a = r <= inner ? 1 : r > R + 0.5 ? 0 : 0.5 * (1 - erf((r - R50) / (sg * Math.SQRT2)));
    if (r > R - 0.5) a *= Math.max(0, R + 0.5 - r);
    md[(y * Dp + x) * 4 + 3] = a * 255;
  }
  const mc = mkCanvas(Dp, Dp); mc.getContext('2d').putImageData(mask, 0, 0);
  px.globalCompositeOperation = 'destination-in'; px.drawImage(mc, 0, 0);
  ctx.drawImage(pic, ox - Dp / 2, oy - Dp / 2);
  // Badge: grey -> white radial pill with black text, plus two soft copies for the glow. Figma marks the
  // copies Hard light, but its render only matches when they add up inside the group (pill flat white,
  // text grey, glow outside unchanged), so they are added ('lighter') and the group is Hard light.
  if (badge) {
    const Pc = Math.ceil(2 * (pr + gm) + 4), b = mkCanvas(Pc, Pc), bx = b.getContext('2d'), c = Pc / 2;
    const g = bx.createRadialGradient(c, c, 0, c, c, pr);
    g.addColorStop(0, '#999'); g.addColorStop(0.5, '#ccc'); g.addColorStop(1, '#fff');
    bx.fillStyle = g; bx.beginPath(); bx.arc(c, c, pr, 0, Math.PI * 2); bx.fill();
    let fs = ICN.text * 2 * pr;
    setTextFont(bx, fs, TXT.tracking);
    const w1 = bx.measureText(badge).width - TXT.tracking * fs;
    if (w1 > 1.5 * pr) { fs *= 1.5 * pr / w1; setTextFont(bx, fs, TXT.tracking); } // long badges shrink to fit
    const tw = bx.measureText(badge).width - TXT.tracking * fs, cap = bx.measureText('H').actualBoundingBoxAscent;
    bx.fillStyle = '#000'; bx.fillText(badge, c - tw / 2, c + cap / 2);
    ctx.globalCompositeOperation = 'lighter';
    for (const [k, a] of ICN.blurs) { ctx.globalAlpha = a; ctx.drawImage(blurCanvas(b, k * D), ox + pc[0] - c, oy + pc[1] - c); }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }
  return { canvas: cv, cx: ox / cv.width, cy: oy / cv.height, w: cv.width / q / W, h: cv.height / q / H };
}
let iconKey = '';
const iconKeyNow = () => { const I = S.icon; return [S.format, I.size, I.zoom, I.edge, I.badge, textFamily, iconSeq].join('\u0001'); };
function buildIcon() {
  const [W, H] = outDims();
  iconKey = iconKeyNow();
  media.iconBuilt = iconCanvas(S.icon, W, H);
  renderer.setIcon(media.iconBuilt ? media.iconBuilt.canvas : null);
}
function iconRectNow() { // GL frame uv
  const b = media.iconBuilt; if (!b) return [0, 0, 1, 1];
  const top = S.icon.y / 100 - b.cy * b.h;
  return [S.icon.x / 100 - b.cx * b.w, 1 - top - b.h, b.w, b.h];
}
async function useIcon(blob, name, save) {
  const img = new Image(), url = URL.createObjectURL(blob);
  try { await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; }); }
  catch (e) { toast('Could not read that picture', true); return false; }
  media.icon = img; media.iconName = name; iconSeq++;
  if (save) { S.icon.on = true; try { await idbPut('icon', { blob, name }); } catch (e) {} }
  updateIconLabel(); changed();
  return true;
}
function clearIcon() {
  media.icon = null; media.iconName = ''; iconSeq++;
  idb().then((db) => db.transaction('kv', 'readwrite').objectStore('kv').delete('icon')).catch(() => {});
  updateIconLabel(); changed();
}
const iconInput = document.createElement('input');
iconInput.type = 'file'; iconInput.accept = 'image/*'; iconInput.hidden = true;
iconInput.addEventListener('change', (e) => { const f = e.target.files[0]; if (f) useIcon(f, f.name, true); e.target.value = ''; });
document.body.appendChild(iconInput);
let updateIconLabel = () => {};
function buildIconRows(parent) {
  const r = document.createElement('div'); r.className = 'font-row';
  const n = document.createElement('span'); n.className = 'font-name';
  const b = document.createElement('button'); b.className = 'ghost'; b.title = 'Any picture (PNG, JPG). It is cropped round. Stays in this browser.';
  b.addEventListener('click', () => iconInput.click());
  const x = document.createElement('button'); x.className = 'ghost'; x.textContent = 'Remove';
  x.addEventListener('click', clearIcon);
  r.append(n, b, x);
  const bi = document.createElement('input'); bi.className = 'text-in sub'; bi.type = 'text'; bi.spellcheck = false; bi.placeholder = 'Badge, e.g. 5x (optional)';
  bi.addEventListener('input', () => { S.icon.badge = bi.value; changed(); });
  bi.addEventListener('keydown', (e) => e.stopPropagation());
  parent.append(r, bi);
  updateIconLabel = () => {
    n.textContent = media.icon ? media.iconName : 'No picture (round, feathered, badge optional)';
    b.textContent = media.icon ? 'Replace' : 'Add picture';
    x.hidden = !media.icon;
  };
  controls.push(() => { if (document.activeElement !== bi && bi.value !== S.icon.badge) bi.value = S.icon.badge; });
  updateIconLabel();
}
idbGet('icon').then((rec) => { if (rec && rec.blob) useIcon(rec.blob, rec.name, false); }).catch(() => {});

const fontInput = document.createElement('input');
fontInput.type = 'file'; fontInput.accept = '.otf,.ttf,.woff,.woff2'; fontInput.hidden = true;
fontInput.addEventListener('change', () => { const f = fontInput.files[0]; if (f) loadFontFile(f); fontInput.value = ''; });
document.body.appendChild(fontInput);
const tctx = document.createElement('canvas').getContext('2d');
function setTextFont(ctx, px, tracking = TXT.tracking) {
  ctx.font = '500 ' + px + 'px ' + textFamily;
  ctx.letterSpacing = (tracking * px) + 'px';
}
function measureText(text, px, tracking = TXT.tracking, leading = 0.99) {
  setTextFont(tctx, px, tracking);
  const ls = tracking * px;
  const lines = text.replace(/\r/g, '').split('\n');
  const cap = tctx.measureText('H').actualBoundingBoxAscent;
  const lead = leading * px;
  let width = 0, padX = 0, up = 0, down = 0;
  const L = lines.map((s) => {
    const m = tctx.measureText(s);
    const w = s ? m.width - ls : 0; // advance box without the trailing tracking
    if (s.trim()) {
      width = Math.max(width, w);
      padX = Math.max(padX, m.actualBoundingBoxLeft, m.actualBoundingBoxRight - w);
      up = Math.max(up, m.actualBoundingBoxAscent - cap);
      down = Math.max(down, m.actualBoundingBoxDescent);
    }
    return { s, w };
  });
  return { L, cap, lead, width, height: cap + (lines.length - 1) * lead, padX, up, down, tracking, px };
}
// Main text plus optional subtitles, at main font size P. y is relative to the centre of the main text's
// cap box (y down), so the design's X/Y always point at the main text. Subtitles scale with P:
// size = subSize % of P, gaps = % of P (above: subtitle baseline -> main cap top, below: main baseline ->
// subtitle cap top).
function layoutText(d, P) {
  const has = (t) => t && t.trim();
  const items = [];
  const main = has(d.text) ? measureText(d.text, P, TXT.tracking, d.leading / 100) : null;
  const mh = main ? main.height : 0;
  if (main) items.push({ m: main, capTop: -mh / 2, grad: d.fill !== 'solid', alpha: 1, main: true });
  // Subtitles are solid. In Figma the number is the glow group twice (100% + 70%), the subtitle once, so
  // Sub strength 59 (= 100 / 170) makes it as much dimmer as there.
  const sp = P * d.subSize / 100, sa = Math.max(0, Math.min(1, d.subStrength / 100));
  if (has(d.above)) { const m = measureText(d.above, sp, TXT.subTracking, TXT.subLeading); items.push({ m, capTop: -mh / 2 - d.aboveGap / 100 * P - m.height, grad: false, alpha: sa }); }
  if (has(d.below)) { const m = measureText(d.below, sp, TXT.subTracking, TXT.subLeading); items.push({ m, capTop: mh / 2 + d.belowGap / 100 * P, grad: false, alpha: sa }); }
  if (!items.length) return null;
  const capTop = Math.min(...items.map((it) => it.capTop)), capBot = Math.max(...items.map((it) => it.capTop + it.m.height));
  return { items, width: Math.max(...items.map((it) => it.m.width)), height: capBot - capTop };
}
// Text -> transparent canvas. Auto-fit: main text as big as GN in Figma, smaller when the whole group
// needs it to stay inside the frame. Lines align left / centre / right; X / Y place the anchor:
// centre = middle of the main text, left = its left edge and cap top, right = its right edge and cap top.
// Returns the frame-width fraction at Size 100 and the anchor as a fraction of the canvas.
function textCanvas(d, W, H) {
  const l1 = layoutText(d, 100);
  if (!l1) return null;
  const auto = Math.min(TXT.size * Math.min(W, H), TXT.maxW * W / (l1.width / 100), TXT.maxH * H / Math.max(1, l1.height / 100));
  const P = auto * TXT.ss;
  const lay = layoutText(d, P);
  const main = lay.items.find((it) => it.main);
  const mw = main ? main.m.width : 0, mh = main ? main.m.height : 0;
  const al = d.align || 'center';
  const ax = al === 'left' ? -mw / 2 : al === 'right' ? mw / 2 : 0; // anchor, relative to the main text centre
  const ay = al === 'center' ? 0 : -mh / 2;
  const lineX = (w) => (al === 'left' ? -mw / 2 : al === 'right' ? mw / 2 - w : -w / 2); // line start, same frame
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const it of lay.items) {
    for (const ln of it.m.L) { if (!ln.s.trim()) continue; const x = lineX(ln.w); x0 = Math.min(x0, x - it.m.padX); x1 = Math.max(x1, x + ln.w + it.m.padX); }
    y0 = Math.min(y0, it.capTop - it.m.up); y1 = Math.max(y1, it.capTop + it.m.height + it.m.down);
  }
  const pad = 0.08 * P + 4; // transparent margin: coarse mips never reach the edge
  const ox = Math.ceil(pad - x0), oy = Math.ceil(pad - y0); // main text centre in canvas px
  const cw = Math.ceil(ox + x1 + pad), ch = Math.ceil(oy + y1 + pad);
  const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
  const ctx = cv.getContext('2d');
  for (const it of lay.items) {
    const m = it.m;
    setTextFont(ctx, m.px, m.tracking);
    ctx.globalAlpha = it.alpha;
    m.L.forEach((ln, i) => {
      if (!ln.s) return;
      const base = oy + it.capTop + m.cap + i * m.lead;
      if (it.grad) { // GN look: white fading in from the cap top, per line
        const g = ctx.createLinearGradient(0, base - m.cap, 0, base);
        g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(1, '#fff');
        ctx.fillStyle = g;
      } else ctx.fillStyle = '#fff'; // Solid fill (6,316,573, LIVE ON OBOL) and subtitles
      ctx.fillText(ln.s, ox + lineX(ln.w), base);
    });
  }
  const k = 1 / TXT.ss; // canvas px -> output px
  return { canvas: cv, fit: cw / (W * TXT.ss), px: auto, anchor: [(ox + ax) / cw, (oy + ay) / ch], mw: mw * k, mh: mh * k };
}
// Offset of an alignment's anchor from the main text centre, for the text as placed now (% of frame).
function alignOffset(align) {
  const t = media.text; if (!t) return [0, 0];
  const [W, H] = outDims(), sz = S.design.size / 100;
  const hw = t.mw * sz / W * 50, hh = t.mh * sz / H * 50;
  return [align === 'left' ? -hw : align === 'right' ? hw : 0, align === 'center' ? 0 : -hh];
}
function setAlign(al, prev) { // keep the main text where it is
  const a = alignOffset(prev), b = alignOffset(al);
  S.design.x = +(S.design.x - a[0] + b[0]).toFixed(2); S.design.y = +(S.design.y - a[1] + b[1]).toFixed(2);
  S.design.align = al; changed();
}
let textKey = '';
const textKeyNow = () => { const d = S.design; return [S.format, d.text, d.above, d.below, d.fill, d.align, d.leading, d.subSize, d.aboveGap, d.belowGap, d.subStrength, textFamily].join('\u0001'); };
function buildText() {
  const [W, H] = outDims();
  textKey = textKeyNow();
  media.text = textCanvas(S.design, W, H);
  if (S.design.source === 'text') renderer.setDesign(media.text ? media.text.canvas : null, media.text ? media.text.fit : 1, media.text ? media.text.anchor : undefined);
}
// Both Figma posts blur in proportion to the text (halo = 14% of the font size, bloom = 2.2%), so in text
// mode the Halo / Bloom sizes are for GN-sized text and scale with the text actually drawn.
function glowScaleNow() {
  if (S.design.source !== 'text' || !media.text) return 1;
  const [W, H] = outDims();
  return media.text.px * S.design.size / 100 / (TXT.size * Math.min(W, H));
}
function applySource() {
  if (S.design.source === 'text') buildText(); else renderer.setDesign(media.image || null);
  placeDesign(); updateMediaLabels(); changed();
}
// One click to the look of each Figma post (text, layout, aberration, vignette, logo). Size puts the main
// text at the Figma font size (fraction of the frame's short side), or smaller if it would not fit.
const EXAMPLES = {
  gn: { label: 'GN', px: 602.302 / 1350,
    design: { text: 'GN', above: '', below: '', fill: 'fade', align: 'center', leading: 99, subSize: 20, aboveGap: 20, belowGap: 20, subStrength: 59, x: 50, y: 35.9 },
    ca: { on: true, mode: 'radial', style: 'spectral', amount: 3, falloff: 1.5 }, grain: { on: true, amount: 10 }, look: { on: true }, logo: { on: false }, icon: { on: false } },
  burned: { label: '6,316,573', px: 164.825 / 675, // Obol Internal 97:47
    design: { text: '6,316,573', above: '', below: 'OBOL burned', fill: 'solid', align: 'center', leading: 99, subSize: 35, belowGap: 29, subStrength: 59, x: 50.8, y: 35.6 },
    // fringes measured off the Figma render: blue out, yellow-red in, about 19 px x distance from centre
    ca: { on: true, mode: 'radial', style: 'rgb', amount: 17.5, falloff: 1 }, grain: { on: true, amount: 5 }, look: { on: false }, logo: { on: true, size: 6.1, y: 90.2 }, icon: { on: false } },
  live: { label: 'LIVE ON OBOL', px: 262.614 / 1350, // Obol Internal 128:120: left aligned, X / Y = left edge, cap top
    design: { text: 'LIVE ON\nOBOL', above: '', below: '', fill: 'solid', align: 'left', leading: 99.3, x: 43.08, y: 24.44 },
    glow: { haloSize: 97, bloomSize: 15 }, // its blurs are 1.4x the GN ratio (halo 20% of the font size, bloom 3.1%)
    ca: { on: false }, grain: { on: false }, look: { on: false }, logo: { on: false },
    icon: { on: true, badge: '5x', blend: 'hardlight', size: 45, x: 26.78, y: 40.42, zoom: 109.6, edge: 1.7 } },
};
function applyExample(id) {
  const ex = EXAMPLES[id];
  Object.assign(S.design, { source: 'text', blend: 'overlay', strength: 170 }, ex.design);
  S.glow = Object.assign(clone(DEFAULTS.glow), ex.glow || {});
  for (const k of ['ca', 'grain', 'look', 'logo', 'icon']) Object.assign(S[k], ex[k] || {});
  buildText();
  if (media.text) { const [W, H] = outDims(); S.design.size = Math.min(100, +(100 * ex.px * Math.min(W, H) / media.text.px).toFixed(1)); }
  updateMediaLabels(); changed();
  const need = [ex.logo.on && !media.logo && 'a logo (Logo panel)', ex.icon.on && !media.icon && 'a picture (Icon panel)'].filter(Boolean);
  if (need.length) toast('This post also has ' + need.join(' and ') + ': add it once, it stays in this browser');
}
function buildTextRows(parent) {
  const r1 = document.createElement('div'); r1.className = 'row tools';
  buildSeg(r1, { key: 'design.source', opts: [['text', 'Text'], ['image', 'Image']] }, null, () => applySource());
  const r2 = document.createElement('div'); r2.className = 'text-row';
  // fields in the same order as on screen: subtitle above, main text, subtitle below
  const fields = [['above', 'text-in sub', 'Subtitle above (optional)'], ['text', 'text-in', 'Main text (Enter = new line)'], ['below', 'text-in sub', 'Subtitle below (optional)']].map(([key, cls, ph]) => {
    const ta = document.createElement('textarea');
    ta.className = cls; ta.rows = 1; ta.spellcheck = false; ta.placeholder = ph;
    ta.autosize = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
    ta.addEventListener('input', () => { S.design[key] = ta.value; ta.autosize(); changed(); });
    r2.appendChild(ta);
    return [key, ta];
  });
  const fr = document.createElement('div'); fr.className = 'font-row';
  const fn = document.createElement('span'); fn.className = 'font-name';
  const fb = document.createElement('button'); fb.className = 'ghost'; fb.textContent = 'Load font'; fb.title = 'Pick an .otf / .ttf / .woff file (or drop it on the page). It stays in this browser.';
  fb.addEventListener('click', () => fontInput.click());
  fr.append(fn, fb); r2.appendChild(fr);
  const er = document.createElement('div'); er.className = 'font-row';
  const el = document.createElement('span'); el.className = 'font-name'; el.textContent = 'Posts'; el.style.flex = '0 0 auto';
  er.appendChild(el);
  for (const id of Object.keys(EXAMPLES)) {
    const b = document.createElement('button'); b.className = 'ghost'; b.textContent = EXAMPLES[id].label; b.style.cssText = 'padding:0 7px;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis';
    b.title = 'Load the ' + EXAMPLES[id].label + ' post from Figma (text, layout, aberration, logo)';
    b.addEventListener('click', () => applyExample(id));
    er.appendChild(b);
  }
  r2.appendChild(er);
  parent.append(r1, r2);
  controls.push(() => {
    fn.textContent = fontName ? 'Font: ' + fontName : 'Font: Helvetica (load Shin Go or any font)';
    for (const [key, ta] of fields) if (document.activeElement !== ta && ta.value !== S.design[key]) { ta.value = S.design[key]; ta.autosize(); }
    const show = S.design.source === 'text';
    if (show && r2.hidden) { r2.hidden = false; fields.forEach(([, ta]) => ta.autosize()); } else r2.hidden = !show;
  });
  requestAnimationFrame(() => fields.forEach(([, ta]) => ta.autosize()));
}

// ------------------------------------------------------------------ controls

const ICON = {
  dice: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1"><rect x="2.5" y="2.5" width="11" height="11" rx="2.5"/><circle cx="5.6" cy="5.6" r=".9" fill="currentColor" stroke="none"/><circle cx="10.4" cy="10.4" r=".9" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r=".9" fill="currentColor" stroke="none"/></svg>',
  play: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 2.8v10.4c0 .5.5.8.9.5l8-5.2a.6.6 0 0 0 0-1L5.4 2.3c-.4-.3-.9 0-.9.5Z"/></svg>',
  pause: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="3.5" y="2.5" width="3" height="11" rx=".8"/><rect x="9.5" y="2.5" width="3" height="11" rx=".8"/></svg>',
  sound: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6h2.5l3.5-3v10l-3.5-3H2.5z"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4"/></svg>',
  mute: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6h2.5l3.5-3v10l-3.5-3H2.5z"/><path d="m11 6 3.5 4M14.5 6 11 10"/></svg>',
};

const SECTIONS = [
  { key: 'design', title: 'Design', rows: [
    { type: 'custom', build: (p) => buildTextRows(p) },
    { type: 'segs', segs: [{ key: 'design.fill', opts: [['fade', 'Fade in'], ['solid', 'Solid']] }, { key: 'design.align', opts: [['left', 'Left'], ['center', 'Center'], ['right', 'Right']], onChange: setAlign }], show: () => S.design.source === 'text' },
    { type: 'slider', key: 'design.leading', label: 'Line spacing', min: 60, max: 160, step: 1, show: () => S.design.source === 'text' && S.design.text.trim().includes('\n') },
    { type: 'slider', key: 'design.subSize', label: 'Sub size', min: 5, max: 80, step: 1, show: () => S.design.source === 'text' && !!(S.design.above.trim() || S.design.below.trim()) },
    { type: 'slider', key: 'design.subStrength', label: 'Sub strength', min: 0, max: 100, step: 1, show: () => S.design.source === 'text' && !!(S.design.above.trim() || S.design.below.trim()) },
    { type: 'slider', key: 'design.aboveGap', label: 'Above gap', min: -50, max: 200, step: 1, show: () => S.design.source === 'text' && !!S.design.above.trim() },
    { type: 'slider', key: 'design.belowGap', label: 'Below gap', min: -50, max: 200, step: 1, show: () => S.design.source === 'text' && !!S.design.below.trim() },
    { type: 'segs', segs: [{ key: 'design.blend', opts: [['normal', 'Normal'], ['overlay', 'Overlay'], ['screen', 'Screen'], ['add', 'Add']] }] },
    { type: 'slider', key: 'design.strength', label: 'Strength', min: 0, max: 200, step: 1 },
    { type: 'slider', key: 'design.size', label: 'Size', min: 5, max: 200, step: 1 },
    { type: 'slider', key: 'design.x', label: 'X', min: 0, max: 100, step: 0.1 },
    { type: 'slider', key: 'design.y', label: 'Y', min: 0, max: 100, step: 0.1 },
  ] },
  { key: 'icon', title: 'Icon', toggle: true, rows: [
    { type: 'custom', build: (p) => buildIconRows(p) },
    { type: 'segs', segs: [{ key: 'icon.blend', opts: [['hardlight', 'Hard light'], ['normal', 'Normal'], ['screen', 'Screen']] }] },
    { type: 'slider', key: 'icon.size', label: 'Size', min: 5, max: 100, step: 0.1 },
    { type: 'slider', key: 'icon.x', label: 'X', min: 0, max: 100, step: 0.1 },
    { type: 'slider', key: 'icon.y', label: 'Y', min: 0, max: 100, step: 0.1 },
    { type: 'slider', key: 'icon.zoom', label: 'Zoom', min: 50, max: 200, step: 0.1 },
    { type: 'slider', key: 'icon.edge', label: 'Edge', min: 0, max: 10, step: 0.1 },
  ] },
  { key: 'logo', title: 'Logo', toggle: true, rows: [
    { type: 'custom', build: (p) => buildLogoRow(p) },
    { type: 'slider', key: 'logo.size', label: 'Size', min: 1, max: 30, step: 0.1 },
    { type: 'slider', key: 'logo.y', label: 'Y', min: 0, max: 100, step: 0.1 },
  ] },
  { key: 'glow', title: 'Glow', toggle: true, rows: [
    { type: 'slider', key: 'glow.halo', label: 'Halo', min: 0, max: 200, step: 1 },
    { type: 'slider', key: 'glow.haloSize', label: 'Halo size', min: 2, max: 160, step: 1 },
    { type: 'segs', segs: [{ key: 'glow.haloBlend', opts: [['overlay', 'Overlay'], ['screen', 'Screen'], ['add', 'Add']] }] },
    { type: 'slider', key: 'glow.bloom', label: 'Bloom', min: 0, max: 200, step: 1 },
    { type: 'slider', key: 'glow.bloomSize', label: 'Bloom size', min: 0.5, max: 40, step: 0.5 },
  ] },
  { key: 'ca', title: 'Chromatic aberration', toggle: true, rows: [
    { type: 'segs', segs: [
      { key: 'ca.mode', opts: [['radial', 'Radial'], ['linear', 'Linear']] },
      { key: 'ca.style', opts: [['spectral', 'Spectral'], ['rgb', 'RGB']] },
    ] },
    { type: 'slider', key: 'ca.amount', label: 'Amount', min: 0, max: 30, step: 0.5 },
    { type: 'slider', key: 'ca.falloff', label: 'Falloff', min: 0, max: 3, step: 0.1, show: () => S.ca.mode === 'radial' },
    { type: 'slider', key: 'ca.angle', label: 'Angle', min: 0, max: 360, step: 1, snap: 15, show: () => S.ca.mode === 'linear' },
  ] },
  { key: 'grain', title: 'Grain', toggle: true, rows: [
    { type: 'slider', key: 'grain.amount', label: 'Amount', min: 0, max: 100, step: 1 },
    { type: 'slider', key: 'grain.size', label: 'Size', min: 0.5, max: 4, step: 0.1 },
    { type: 'segs', segs: [
      { key: 'grain.color', opts: [['mono', 'Mono'], ['color', 'Color']] },
      { key: 'grain.motion', opts: [['moving', 'Moving'], ['static', 'Static']] },
    ] },
  ] },
  { key: 'look', title: 'Vignette', toggle: true, rows: [
    { type: 'slider', key: 'look.vignette', label: 'Amount', min: 0, max: 100, step: 1 },
    { type: 'slider', key: 'look.spread', label: 'Spread', min: 0, max: 100, step: 1 },
  ] },
  { key: 'video', title: 'Background', rows: [
    { type: 'slider', key: 'video.zoom', label: 'Zoom', min: 100, max: 250, step: 1 },
    { type: 'slider', key: 'video.panX', label: 'Pan X', min: -100, max: 100, step: 1, bipolar: true, snap: 0 },
    { type: 'slider', key: 'video.panY', label: 'Pan Y', min: -100, max: 100, step: 1, bipolar: true, snap: 0 },
    { type: 'slider', key: 'video.exposure', label: 'Exposure', min: -100, max: 100, step: 1, bipolar: true, snap: 0 },
    { type: 'slider', key: 'video.contrast', label: 'Contrast', min: -100, max: 100, step: 1, bipolar: true, snap: 0 },
    { type: 'slider', key: 'video.saturation', label: 'Saturation', min: -100, max: 100, step: 1, bipolar: true, snap: 0 },
  ] },
];

const side = $('side');
const controls = [];
const sectionEls = {};
const decimals = (step) => { const s = String(step); return s.includes('.') ? s.split('.')[1].length : 0; };
const fmt = (v, step) => String(+v.toFixed(decimals(step)));

function buildSlider(row, spec, secKey) {
  const lab = document.createElement('label'); lab.textContent = spec.label;
  const sl = document.createElement('div');
  sl.className = 'slider' + (spec.bipolar ? ' bipolar' : '');
  sl.tabIndex = 0;
  sl.innerHTML = '<div class="rail"></div><div class="zero"></div><div class="fill"></div><div class="thumb"></div>';
  const num = document.createElement('input'); num.className = 'num'; num.type = 'text'; num.spellcheck = false;
  row.append(lab, sl, num);
  const { min, max, step } = spec;
  const toT = (v) => (v - min) / (max - min);
  const toV = (t) => min + t * (max - min);
  const quant = (v) => +(Math.round(Math.min(max, Math.max(min, v)) / step) * step).toFixed(decimals(step));
  const origin = spec.bipolar ? toT(0) : 0;
  sl.style.setProperty('--z', origin);
  function paint(v) {
    const t = Math.min(1, Math.max(0, toT(v)));
    sl.style.setProperty('--t', t);
    sl.style.setProperty('--a', Math.min(t, origin));
    sl.style.setProperty('--b', Math.max(t, origin));
    if (document.activeElement !== num) num.value = fmt(v, step);
  }
  function commit(v) {
    v = quant(v);
    if (v === getP(spec.key)) return;
    setP(spec.key, v);
    if (S[secKey] && 'on' in S[secKey] && !S[secKey].on) { S[secKey].on = true; syncSection(secKey); }
    paint(v);
    changed();
  }
  let dragging = false;
  function valueAt(x) {
    const r = sl.getBoundingClientRect();
    let v = toV(Math.min(1, Math.max(0, (x - r.left - 5) / Math.max(1, r.width - 10))));
    if (spec.snap !== undefined) {
      const tol = (max - min) * 0.012;
      if (spec.snap === 0) { if (Math.abs(v) <= tol * 1.5) v = 0; }
      else { const n = Math.round(v / spec.snap) * spec.snap; if (Math.abs(v - n) <= tol * 1.2) v = n; }
    }
    return v;
  }
  sl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); dragging = true;
    sl.setPointerCapture(e.pointerId); sl.focus({ preventScroll: true });
    commit(valueAt(e.clientX));
  });
  sl.addEventListener('pointermove', (e) => { if (dragging && sl.hasPointerCapture(e.pointerId)) commit(valueAt(e.clientX)); });
  const end = (e) => { if (!dragging) return; dragging = false; if (sl.hasPointerCapture(e.pointerId)) sl.releasePointerCapture(e.pointerId); };
  sl.addEventListener('pointerup', end);
  sl.addEventListener('pointercancel', end);
  sl.addEventListener('dblclick', () => commit(defP(spec.key)));
  sl.addEventListener('keydown', (e) => {
    const big = e.shiftKey ? 10 : 1;
    let v = getP(spec.key);
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v += step * big;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v -= step * big;
    else return;
    e.preventDefault(); e.stopPropagation(); commit(v);
  });
  num.addEventListener('focus', () => num.select());
  num.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') num.blur();
    else if (e.key === 'Escape') { num.value = fmt(getP(spec.key), step); num.blur(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      commit(getP(spec.key) + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
      num.value = fmt(getP(spec.key), step); num.select();
    }
  });
  num.addEventListener('blur', () => {
    const v = parseFloat(num.value.replace(',', '.'));
    if (isFinite(v)) commit(v);
    num.value = fmt(getP(spec.key), step);
  });
  controls.push(() => { paint(getP(spec.key)); if (spec.show) row.classList.toggle('hidden', !spec.show()); });
}

function buildSeg(parent, spec, secKey, onChange) {
  const seg = document.createElement('div'); seg.className = 'seg';
  const btns = spec.opts.map(([v, label]) => {
    const b = document.createElement('button'); b.textContent = label; b.dataset.v = v;
    b.addEventListener('click', () => {
      const prev = getP(spec.key);
      if (prev === v) return;
      setP(spec.key, v);
      if (secKey && S[secKey] && 'on' in S[secKey]) S[secKey].on = true;
      syncAll();
      if (onChange) onChange(v, prev); else changed();
    });
    seg.appendChild(b); return b;
  });
  parent.appendChild(seg);
  controls.push(() => btns.forEach((b) => b.classList.toggle('on', String(b.dataset.v) === String(getP(spec.key)))));
  return seg;
}

function syncSection(key) {
  const el = sectionEls[key]; if (!el) return;
  if (el.sw) el.sw.checked = !!S[key].on;
  el.root.classList.toggle('off', key === 'design' ? (S.design.source === 'image' && !media.image)
    : key === 'logo' ? (!S.logo.on || !media.logo) : key === 'icon' ? (!S.icon.on || !media.icon)
    : ('on' in S[key] ? !S[key].on : false));
}
function syncAll() {
  for (const f of controls) f();
  for (const k of Object.keys(sectionEls)) syncSection(k);
}

// Media section (custom)
function buildMedia() {
  const root = document.createElement('div'); root.className = 'sec';
  root.innerHTML = `
    <div class="sec-head"><div class="t">Media</div></div>
    <div class="slot"><span class="k">Video</span><span class="v" id="vName"></span><button class="ghost" id="vPick">Replace</button></div>
    <div class="slot"><span class="k">Design</span><span class="v" id="dName"></span><button class="ghost" id="dPick">Replace</button><button class="icon-btn" id="dClear" title="Remove design" style="width:24px;height:24px">
      <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M3 3l6 6M9 3l-6 6"/></svg></button></div>`;
  const rowF = document.createElement('div'); rowF.className = 'row tools';
  buildSeg(rowF, { key: 'format', opts: Object.keys(FORMATS).map((k) => [k, k]) }, null, () => { if (S.design.source === 'text') buildText(); layout(); changed(); });
  const rowR = document.createElement('div'); rowR.className = 'row tools';
  buildSeg(rowR, { key: 'fps', opts: [[30, '30 fps'], [60, '60 fps']] }, null, () => changed());
  const au = document.createElement('label');
  au.style.cssText = 'display:flex;align-items:center;gap:6px;color:var(--muted);white-space:nowrap';
  const sw = document.createElement('input'); sw.type = 'checkbox'; sw.className = 'switch';
  sw.addEventListener('change', () => { S.audio = sw.checked; changed(); });
  au.append(sw, 'Audio');
  rowR.appendChild(au);
  controls.push(() => { sw.checked = S.audio; });
  const rowQ = document.createElement('div'); rowQ.className = 'row tools';
  const ql = document.createElement('span'); ql.textContent = 'Export'; ql.style.cssText = 'color:var(--muted);white-space:nowrap';
  rowQ.appendChild(ql);
  buildSeg(rowQ, { key: 'quality', opts: [['high', 'High quality'], ['small', 'Smaller file']] }, null, () => changed());
  root.append(rowF, rowR, rowQ);
  side.appendChild(root);
  // fps seg values are numbers; buildSeg compares as strings and sets string: coerce
  rowR.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => { S.fps = parseInt(b.dataset.v, 10); }));
  $('vPick').addEventListener('click', () => $('fileVideo').click());
  $('dPick').addEventListener('click', () => $('fileDesign').click());
  $('dClear').addEventListener('click', () => setDesign(null));
}

buildMedia();
for (const sec of SECTIONS) {
  const root = document.createElement('div'); root.className = 'sec';
  const head = document.createElement('div'); head.className = 'sec-head';
  const t = document.createElement('div'); t.className = 't'; t.textContent = sec.title;
  head.appendChild(t);
  let sw = null;
  if (sec.toggle) {
    sw = document.createElement('input'); sw.type = 'checkbox'; sw.className = 'switch';
    sw.addEventListener('change', () => { S[sec.key].on = sw.checked; syncSection(sec.key); changed(); });
    head.appendChild(sw);
  } else {
    const reset = document.createElement('button'); reset.className = 'ghost'; reset.textContent = 'Reset';
    reset.style.height = '22px';
    reset.addEventListener('click', () => {
      const keep = sec.key === 'design' ? { source: S.design.source, text: S.design.text, above: S.design.above, below: S.design.below } : {};
      S[sec.key] = Object.assign(clone(DEFAULTS[sec.key]), keep);
      if (sec.key === 'design') placeDesign();
      syncAll(); changed();
    });
    head.appendChild(reset);
  }
  const rows = document.createElement('div'); rows.className = 'rows';
  for (const r of sec.rows) {
    const row = document.createElement('div');
    if (r.type === 'custom') { r.build(rows); continue; }
    if (r.type === 'slider') { row.className = 'row'; buildSlider(row, r, sec.key); }
    else {
      row.className = 'row tools'; for (const s of r.segs) buildSeg(row, s, sec.key, s.onChange);
      if (r.show) controls.push(() => row.classList.toggle('hidden', !r.show()));
    }
    rows.appendChild(row);
  }
  root.append(head, rows);
  side.appendChild(root);
  sectionEls[sec.key] = { root, sw };
}
const resetAll = document.createElement('div');
resetAll.style.cssText = 'padding:12px 16px 20px';
resetAll.innerHTML = '<button class="ghost" style="width:100%;height:30px">Reset all effects</button>';
resetAll.firstChild.addEventListener('click', () => {
  const keep = { format: S.format, fps: S.fps, audio: S.audio, quality: S.quality, design: S.design };
  S = clone(DEFAULTS); Object.assign(S, keep);
  syncAll(); changed();
});
side.appendChild(resetAll);

let saveTimer = null;
function changed() {
  if (S.design.source === 'text' && textKeyNow() !== textKey) buildText(); // text, subtitles, gaps or format changed
  renderer.glowScale = glowScaleNow();
  if (iconKeyNow() !== iconKey) buildIcon();
  renderer.iconRect = iconRectNow();
  syncAll();
  invalidate();
  updateDesignBox();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem('afterglow.settings', JSON.stringify(S)); } catch (e) {} }, 300);
}

// ------------------------------------------------------------------ media

const video = document.createElement('video');
video.playsInline = true; video.preload = 'auto'; video.loop = false;
video.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none';
document.body.appendChild(video);
let bgDirty = false;

function setVideoFile(file) {
  const url = URL.createObjectURL(file);
  if (file.type.startsWith('image/')) {
    const img = new Image();
    img.onload = () => {
      video.pause(); video.removeAttribute('src'); video.load();
      Object.assign(media, { kind: 'image', el: img, file, name: file.name, w: img.naturalWidth, h: img.naturalHeight, duration: 6 });
      clip.in = 0; clip.out = 6; clock.t = 0;
      renderer.setBackground(img, img.naturalWidth, img.naturalHeight);
      updateMediaLabels(); updateTransport(); invalidate();
    };
    img.src = url;
    return;
  }
  setPlaying(false);
  video.src = url;
  video.muted = muted;
  media.file = file; media.name = file.name;
  video.onloadedmetadata = () => {
    Object.assign(media, { kind: 'video', el: video, w: video.videoWidth, h: video.videoHeight, duration: video.duration || 0 });
    clip.in = 0; clip.out = media.duration;
    updateMediaLabels(); updateTransport();
  };
  video.onloadeddata = () => { renderer.setBackground(video, video.videoWidth, video.videoHeight); invalidate(); };
}
video.addEventListener('seeked', () => { bgDirty = true; invalidate(); updateTransport(); });
video.addEventListener('error', () => toast('Could not play that video in this browser', true));

function placeDesign() {
  if (S.design.source === 'text') {
    S.design.size = 100; const o = alignOffset(S.design.align);
    S.design.x = +(50 + o[0]).toFixed(2); S.design.y = +(TXT.y + o[1]).toFixed(2); return;
  }
  const d = media.image; if (!d) return;
  const [W, H] = outDims();
  const ia = d.naturalWidth / d.naturalHeight, fa = W / H;
  S.design.x = 50; S.design.y = 50;
  if (Math.abs(ia - fa) / fa < 0.02) { S.design.size = 100; return; }
  let w = 0.6, h = w * fa / ia;
  if (h > 0.6) w *= 0.6 / h;
  S.design.size = Math.round(w * 100);
}

function setDesign(file, keepPlacement) {
  if (!file) { // remove the image: back to text
    media.image = null; media.imageName = '';
    S.design.source = 'text'; applySource();
    return;
  }
  const img = new Image();
  img.onload = () => {
    media.image = img; media.imageName = file.name || 'Pasted design';
    S.design.source = 'image';
    renderer.setDesign(img);
    if (!keepPlacement) placeDesign();
    updateMediaLabels(); changed();
  };
  img.onerror = () => toast('Could not read that image', true);
  img.src = URL.createObjectURL(file);
}

function fmtTime(t) { t = Math.max(0, t || 0); const m = Math.floor(t / 60); const s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); }

function updateMediaLabels() {
  const v = $('vName'), d = $('dName');
  if (media.kind) { v.className = 'v'; v.innerHTML = ''; v.append(media.name); const sm = document.createElement('small'); sm.textContent = media.kind === 'video' ? fmtTime(media.duration) : 'still'; v.appendChild(sm); }
  else { v.className = 'v empty'; v.textContent = 'Drop a video'; }
  if (S.design.source === 'text') { d.className = 'v'; d.innerHTML = ''; d.append('Text'); const sm = document.createElement('small'); sm.textContent = fontName || 'Helvetica'; d.appendChild(sm); }
  else if (media.image) { d.className = 'v'; d.innerHTML = ''; d.append(media.imageName); const sm = document.createElement('small'); sm.textContent = media.image.naturalWidth + '×' + media.image.naturalHeight; d.appendChild(sm); }
  else { d.className = 'v empty'; d.textContent = 'Drop or ⌘V a PNG'; }
  $('dClear').style.visibility = S.design.source === 'image' && media.image ? 'visible' : 'hidden';
  syncSection('design');
}

$('fileVideo').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) setVideoFile(f); e.target.value = ''; });
$('fileDesign').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) setDesign(f); e.target.value = ''; });

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  for (const f of e.dataTransfer.files) {
    if (isFontFile(f)) loadFontFile(f);
    else if (f.type.startsWith('video/')) setVideoFile(f);
    else if (f.type.startsWith('image/')) setDesign(f);
  }
});
window.addEventListener('paste', (e) => {
  const inField = e.target.closest && e.target.closest('textarea, input');
  if (inField && [...e.clipboardData.items].some((it) => it.type === 'text/plain')) return; // typing text
  for (const it of e.clipboardData.items) {
    if (it.type.startsWith('image/')) { setDesign(it.getAsFile()); toast('Design pasted'); return; }
  }
});

// ------------------------------------------------------------------ stage layout & design box

const stage = $('stage'), frameEl = $('frame'), box = $('designBox');
let cssW = 0, cssH = 0;
function layout() {
  const [W, H] = outDims();
  const r = stage.getBoundingClientRect();
  const aw = Math.max(50, r.width - 56), ah = Math.max(50, r.height - 56);
  const k = Math.min(aw / W, ah / H);
  cssW = Math.floor(W * k); cssH = Math.floor(H * k);
  frameEl.style.width = cssW + 'px'; frameEl.style.height = cssH + 'px';
  updateDesignBox();
  invalidate();
}
new ResizeObserver(layout).observe(stage);

function updateDesignBox() {
  updateIconBox();
  if (!activeDesign()) { box.style.display = 'none'; return; }
  box.style.display = '';
  const [W, H] = outDims();
  const r = renderer.designRect(S, W, H);
  box.style.left = (r[0] * cssW) + 'px';
  box.style.top = ((1 - r[1] - r[3]) * cssH) + 'px';
  box.style.width = (r[2] * cssW) + 'px';
  box.style.height = (r[3] * cssH) + 'px';
}
const iconBox = $('iconBox');
function updateIconBox() { // the round picture only (not the badge glow)
  const ib = $('iconBox');
  if (!(S.icon.on && media.icon)) { ib.style.display = 'none'; return; }
  ib.style.display = '';
  const d = S.icon.size / 100 * cssH;
  ib.style.left = (S.icon.x / 100 * cssW - d / 2) + 'px';
  ib.style.top = (S.icon.y / 100 * cssH - d / 2) + 'px';
  ib.style.width = ib.style.height = d + 'px';
}
let idrag = null;
iconBox.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault(); iconBox.setPointerCapture(e.pointerId); iconBox.classList.add('drag');
  idrag = { x: e.clientX, y: e.clientY, sx: S.icon.x, sy: S.icon.y };
});
iconBox.addEventListener('pointermove', (e) => {
  if (!idrag || !iconBox.hasPointerCapture(e.pointerId)) return;
  S.icon.x = +(idrag.sx + (e.clientX - idrag.x) / cssW * 100).toFixed(1);
  S.icon.y = +(idrag.sy + (e.clientY - idrag.y) / cssH * 100).toFixed(1);
  changed();
});
const endIcon = () => { idrag = null; iconBox.classList.remove('drag'); };
iconBox.addEventListener('pointerup', endIcon);
iconBox.addEventListener('pointercancel', endIcon);
iconBox.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  S.icon.size = Math.min(100, Math.max(5, +(S.icon.size * Math.exp(-e.deltaY * 0.01)).toFixed(1)));
  changed();
}, { passive: false });
let bdrag = null;
box.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault(); box.setPointerCapture(e.pointerId); box.classList.add('drag');
  bdrag = { x: e.clientX, y: e.clientY, sx: S.design.x, sy: S.design.y };
});
box.addEventListener('pointermove', (e) => {
  if (!bdrag || !box.hasPointerCapture(e.pointerId)) return;
  let x = bdrag.sx + (e.clientX - bdrag.x) / cssW * 100;
  let y = bdrag.sy + (e.clientY - bdrag.y) / cssH * 100;
  if (!e.altKey && (S.design.source === 'image' || S.design.align === 'center')) { if (Math.abs(x - 50) < 0.8) x = 50; if (Math.abs(y - 50) < 0.8) y = 50; }
  S.design.x = +x.toFixed(1); S.design.y = +y.toFixed(1);
  changed();
});
const endBox = () => { bdrag = null; box.classList.remove('drag'); };
box.addEventListener('pointerup', endBox);
box.addEventListener('pointercancel', endBox);
box.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  S.design.size = Math.min(200, Math.max(5, +(S.design.size * Math.exp(-e.deltaY * 0.01)).toFixed(1)));
  changed();
}, { passive: false });

// ------------------------------------------------------------------ rendering & modes

let queued = false;
let exporting = false;
let frames = 0, fpsShown = 0, fpsT = performance.now();
function invalidate() {
  if (queued || exporting) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; draw(); });
}
function currentTime() { return media.kind === 'video' ? video.currentTime : clock.t; }

function sizeCanvas() {
  const [W, H] = outDims();
  const dpr = window.devicePixelRatio || 1;
  let w = cssW * dpr, h = cssH * dpr;
  const cap = Math.min(1, W / w);
  w *= cap; h *= cap;
  if (mode === 'edit') { w *= 0.5; h *= 0.5; }
  w = Math.max(16, Math.round(w)); h = Math.max(16, Math.round(w * H / W)); // height from width keeps the exact aspect
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

function draw() {
  if (exporting) return;
  sizeCanvas();
  if (bgDirty) { renderer.uploadBackground(); bgDirty = false; }
  const fi = Math.floor(currentTime() * S.fps);
  renderer.render(S, { caMaxN: mode === 'edit' ? 6 : 32, seed: S.grain.motion === 'moving' ? fi + 1 : 1 });
  frames++;
  const now = performance.now();
  if (now - fpsT > 500) { fpsShown = Math.round(frames * 1000 / (now - fpsT)); frames = 0; fpsT = now; }
  $('stat').textContent = (mode === 'edit' ? 'Edit' : 'Preview') + ' · ' + canvas.width + '×' + canvas.height + (playing ? ' · ' + fpsShown + ' fps' : '');
  updateTransport();
}

function setMode(m) {
  mode = m;
  document.body.classList.toggle('preview', m === 'preview');
  $('modeSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === m));
  $('badge').textContent = m === 'edit' ? 'Edit · half res' : 'Preview · full quality';
  invalidate();
}
$('modeSeg').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.v)));

// playback: video frames drive rendering (requestVideoFrameCallback) so nothing renders twice per frame
const clock = { t: 0, last: 0, raf: 0 };
let lastEditDraw = 0;
function onVideoFrame() {
  if (!playing || media.kind !== 'video') return;
  if (video.currentTime >= clip.out - 0.5 / S.fps) { video.currentTime = clip.in; }
  bgDirty = true;
  const now = performance.now();
  if (mode === 'preview' || now - lastEditDraw > 31) { lastEditDraw = now; draw(); }
  video.requestVideoFrameCallback(onVideoFrame);
}
function stillTick(now) {
  if (!playing || media.kind === 'video') return;
  const dt = (now - clock.last) / 1000; clock.last = now;
  clock.t += dt;
  if (clock.t >= clip.out) clock.t = clip.in;
  draw();
  clock.raf = requestAnimationFrame(stillTick);
}
function setPlaying(p) {
  playing = p;
  $('playBtn').innerHTML = p ? ICON.pause : ICON.play;
  if (media.kind === 'video') {
    if (p) {
      if (video.currentTime < clip.in || video.currentTime >= clip.out - 0.02) video.currentTime = clip.in;
      video.play().catch(() => { playing = false; $('playBtn').innerHTML = ICON.play; });
      video.requestVideoFrameCallback(onVideoFrame);
    } else video.pause();
  } else if (media.kind === 'image') {
    cancelAnimationFrame(clock.raf);
    if (p) { clock.last = performance.now(); clock.raf = requestAnimationFrame(stillTick); }
  }
  invalidate();
}
$('playBtn').addEventListener('click', () => setPlaying(!playing));
$('muteBtn').addEventListener('click', () => { muted = !muted; video.muted = muted; $('muteBtn').innerHTML = muted ? ICON.mute : ICON.sound; });
$('playBtn').innerHTML = ICON.play;
$('muteBtn').innerHTML = ICON.sound;
document.addEventListener('visibilitychange', () => { if (document.hidden && playing) setPlaying(false); });

window.addEventListener('keydown', (e) => {
  if (e.target.closest && e.target.closest('input, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); setPlaying(!playing); }
  else if (e.key === 'p' || e.key === 'P') setMode(mode === 'edit' ? 'preview' : 'edit');
});

// ------------------------------------------------------------------ timeline

const tl = $('timeline');
function updateTransport() {
  const d = media.duration || 1;
  const t = currentTime();
  $('time').innerHTML = '<b>' + fmtTime(t) + '</b> / ' + fmtTime(media.kind ? d : 0);
  $('head').style.left = (t / d * 100) + '%';
  $('trimIn').style.left = (clip.in / d * 100) + '%';
  $('trimOut').style.left = (clip.out / d * 100) + '%';
  $('range').style.left = (clip.in / d * 100) + '%';
  $('range').style.width = ((clip.out - clip.in) / d * 100) + '%';
  $('dur').textContent = fmtTime(clip.out - clip.in) + ' clip';
}
function timeAt(x) { const r = tl.getBoundingClientRect(); return Math.min(1, Math.max(0, (x - r.left) / r.width)) * (media.duration || 0); }
function seek(t) {
  t = Math.min(clip.out, Math.max(clip.in, t));
  if (media.kind === 'video') video.currentTime = t;
  else { clock.t = t; invalidate(); }
}
let tdrag = null;
tl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !media.kind) return;
  e.preventDefault(); tl.setPointerCapture(e.pointerId);
  tdrag = e.target.id === 'trimIn' ? 'in' : e.target.id === 'trimOut' ? 'out' : 'head';
  move(e);
});
function move(e) {
  const t = timeAt(e.clientX);
  const minLen = 0.2;
  if (tdrag === 'in') { clip.in = Math.min(t, clip.out - minLen); seek(clip.in); }
  else if (tdrag === 'out') { clip.out = Math.max(t, clip.in + minLen); seek(clip.out - 0.001); }
  else seek(t);
  updateTransport();
}
tl.addEventListener('pointermove', (e) => { if (tdrag && tl.hasPointerCapture(e.pointerId)) move(e); });
tl.addEventListener('pointerup', () => { tdrag = null; });
tl.addEventListener('pointercancel', () => { tdrag = null; });

// ------------------------------------------------------------------ export

let cancelExport = false;
$('mCancel').addEventListener('click', () => { cancelExport = true; });

// yields to the event loop without setTimeout, which Chrome throttles to 1/s in background tabs
const yieldChan = new MessageChannel();
const yieldQ = [];
yieldChan.port1.onmessage = () => yieldQ.shift()?.();
function yieldTask() { return new Promise((r) => { yieldQ.push(r); yieldChan.port2.postMessage(0); }); }

function seekExact(t) {
  return new Promise((res) => {
    let done = false;
    const fin = () => { if (done) return; done = true; video.removeEventListener('seeked', fin); res(); };
    video.addEventListener('seeked', fin);
    setTimeout(fin, 2000);
    video.currentTime = t;
  });
}

async function decodeAudio(file, t0, t1) {
  try {
    const ab = await file.arrayBuffer();
    const ctx = new OfflineAudioContext(2, 1, 48000);
    const buf = await ctx.decodeAudioData(ab);
    const sr = buf.sampleRate, ch = Math.min(2, buf.numberOfChannels);
    const s0 = Math.floor(t0 * sr), s1 = Math.min(buf.length, Math.floor(t1 * sr));
    if (s1 - s0 < 64) return null;
    const fade = Math.min(Math.floor(sr * 0.012), (s1 - s0) >> 2);
    const data = [];
    for (let c = 0; c < ch; c++) {
      const a = buf.getChannelData(c).slice(s0, s1);
      for (let i = 0; i < fade; i++) { const g = i / fade; a[i] *= g; a[a.length - 1 - i] *= g; }
      data.push(a);
    }
    return { data, sr, ch, frames: s1 - s0 };
  } catch (e) { return null; }
}

// Constant quality (fixed quantizer per frame). Bitrate-targeted modes spend everything on the first
// frames, then starve and smear per-pixel grain into flat blotches. QP 20 is visually close to the render.
const QP = { high: 20, small: 26 };
async function pickVideoConfig(W, H, fps, quality) {
  const base = { width: W, height: H, framerate: fps, latencyMode: 'quality', avc: { format: 'avc' } };
  const codecs = ['avc1.640033', 'avc1.640034', 'avc1.64002A', 'avc1.640028']; // High 5.1 first: allows the high bitrates grain needs
  const ok = async (cfg) => { try { return (await VideoEncoder.isConfigSupported(cfg)).supported; } catch (e) { return false; } };
  for (const codec of codecs) {
    const cfg = { ...base, codec, bitrateMode: 'quantizer' };
    if (await ok(cfg)) return { cfg, qp: QP[quality] ?? QP.high };
  }
  // no quantizer mode (e.g. Safari): fall back to a generous target bitrate
  const bitrate = Math.min(240e6, W * H * fps * (quality === 'small' ? 0.8 : 1.6));
  for (const codec of codecs) {
    const cfg = { ...base, codec, bitrate };
    if (await ok(cfg)) return { cfg, qp: null };
  }
  return null;
}

async function exportMP4() {
  if (exporting) return;
  if (!media.kind && !activeDesign()) { toast('Add a video or design first', true); return; }
  if (!('VideoEncoder' in window)) { toast('This browser cannot encode video (needs Chrome, Edge or Safari 17+)', true); return; }
  const [W, H] = outDims();
  const fps = S.fps;
  const isVideo = media.kind === 'video';
  const t0 = media.kind ? clip.in : 0, t1 = media.kind ? clip.out : 6;
  const N = Math.max(1, Math.round((t1 - t0) * fps));
  const vc = await pickVideoConfig(W, H, fps, S.quality);
  if (!vc) { toast('H.264 encoding is not supported here', true); return; }
  const codec = vc.cfg.codec;

  setPlaying(false);
  exporting = true; cancelExport = false;
  $('modal').classList.add('show');
  $('mTitle').textContent = 'Exporting ' + W + '×' + H + ' · ' + fps + ' fps';
  $('mText').textContent = 'Preparing…';
  $('mBar').style.width = '0%';
  const started = performance.now();
  const resumeAt = currentTime();

  let audio = null, audioNote = '';
  if (S.audio && isVideo && media.file) {
    audio = await decodeAudio(media.file, t0, t1);
    if (audio) {
      const cfg = { codec: 'mp4a.40.2', sampleRate: audio.sr, numberOfChannels: audio.ch, bitrate: 192000 };
      let ok = false;
      try { ok = 'AudioEncoder' in window && (await AudioEncoder.isConfigSupported(cfg)).supported; } catch (e) {}
      if (!ok) { audio = null; audioNote = ' (audio skipped: no AAC encoder in this browser)'; }
    }
  }

  let failure = null;
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width: W, height: H, frameRate: fps },
    audio: audio ? { codec: 'aac', numberOfChannels: audio.ch, sampleRate: audio.sr } : undefined,
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { failure = e; } });
  enc.configure(vc.cfg);
  const encOpts = vc.qp != null ? { avc: { quantizer: vc.qp } } : {};

  canvas.width = W; canvas.height = H;
  // Frames are read back from the GPU. new VideoFrame(webglCanvas) is a snapshot that can catch the
  // frame before the GPU has finished drawing it (seen as wrong corners), readPixels cannot.
  const gl = renderer.gl;
  const px = new Uint8Array(W * H * 4), rowBuf = new Uint8Array(W * 4), stride = W * 4;
  try {
    for (let i = 0; i < N; i++) {
      if (cancelExport || failure) break;
      if (isVideo) {
        await seekExact(Math.min(media.duration - 0.001, t0 + (i + 0.5) / fps));
        renderer.uploadBackground();
      }
      renderer.render(S, { caMaxN: 32, seed: S.grain.motion === 'moving' ? i + 1 : 1 });
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      for (let y = 0, h2 = H >> 1; y < h2; y++) { // GL rows are bottom-up
        const a = y * stride, b = (H - 1 - y) * stride;
        rowBuf.set(px.subarray(a, a + stride)); px.copyWithin(a, b, b + stride); px.set(rowBuf, b);
      }
      const vf = new VideoFrame(px, { format: 'RGBX', codedWidth: W, codedHeight: H, timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      enc.encode(vf, { keyFrame: i % (fps * 2) === 0, ...encOpts });
      vf.close();
      while (enc.encodeQueueSize > 4) await yieldTask();
      if (i % 3 === 0 || i === N - 1) {
        $('mBar').style.width = ((i + 1) / N * 100).toFixed(1) + '%';
        $('mText').textContent = 'Frame ' + (i + 1) + ' of ' + N;
        await yieldTask();
      }
    }
    if (!cancelExport && !failure) {
      await enc.flush();
      if (audio) {
        $('mText').textContent = 'Encoding audio…';
        const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => { failure = e; } });
        aenc.configure({ codec: 'mp4a.40.2', sampleRate: audio.sr, numberOfChannels: audio.ch, bitrate: 192000 });
        const CH = 4096;
        for (let off = 0; off < audio.frames; off += CH) {
          const n = Math.min(CH, audio.frames - off);
          const planar = new Float32Array(n * audio.ch);
          for (let c = 0; c < audio.ch; c++) planar.set(audio.data[c].subarray(off, off + n), c * n);
          const ad = new AudioData({ format: 'f32-planar', sampleRate: audio.sr, numberOfFrames: n, numberOfChannels: audio.ch, timestamp: Math.round(off / audio.sr * 1e6), data: planar });
          aenc.encode(ad); ad.close();
        }
        await aenc.flush(); aenc.close();
      }
    }
  } catch (e) { failure = failure || e; }
  try { enc.close(); } catch (e) {}

  if (!cancelExport && !failure) {
    muxer.finalize();
    const blob = new Blob([target.buffer], { type: 'video/mp4' });
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    a.href = URL.createObjectURL(blob); a.download = 'afterglow-' + stamp + '.mp4';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    window.__lastExport = { bytes: blob.size, frames: N, ms: Math.round(performance.now() - started), audio: !!audio, codec, qp: vc.qp, mbps: +(blob.size * 8 / (t1 - t0) / 1e6).toFixed(1) };
    toast('Exported ' + (t1 - t0).toFixed(1) + ' s in ' + ((performance.now() - started) / 1000).toFixed(1) + ' s · ' + (blob.size / 1e6).toFixed(1) + ' MB' + audioNote);
  } else if (failure) {
    toast('Export failed (' + (failure.message || failure) + ')', true);
  } else toast('Export cancelled');

  exporting = false;
  $('modal').classList.remove('show');
  if (isVideo) { await seekExact(resumeAt); bgDirty = true; }
  invalidate();
}
$('exportBtn').addEventListener('click', exportMP4);

// ------------------------------------------------------------------ misc

function toast(msg, err) {
  const t = $('toast'); t.textContent = msg; t.classList.toggle('err', !!err); t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), err ? 5000 : 3200);
}

async function loadDemo() {
  try {
    const v = await fetch('demo/demo.mp4', { cache: 'no-cache' });
    if (v.ok) setVideoFile(new File([await v.blob()], 'demo.mp4', { type: 'video/mp4' }));
  } catch (e) {}
}

// images are not kept between sessions, so always start from the text design
if (S.design.source === 'image') S.design.source = 'text';
if (!savedHadSource) placeDesign();
syncAll();
updateMediaLabels();
setMode('edit');
layout();
loadDemo();
// Never hold the text back for the font: draw with the fallback after a short wait, swap when it arrives.
const showText = () => { if (S.design.source === 'text') buildText(); updateMediaLabels(); changed(); };
withTimeout(fontReady, 800).then(showText);
fontReady.then(showText);

window.afterglow = { get S() { return S; }, set S(v) { S = merge(DEFAULTS, v); changed(); }, textCanvas, buildText, setDesign, applySource, renderer, media, clip, setMode, exportMP4, draw, video };
