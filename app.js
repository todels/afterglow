import { Renderer } from './gl.js';
import { Muxer, ArrayBufferTarget } from './vendor/mp4-muxer.mjs';

// ------------------------------------------------------------------ state

const DEFAULTS = {
  format: '16:9', fps: 30, audio: true, quality: 'high',
  design: { source: 'text', text: 'GN', above: '', below: '', subSize: 20, aboveGap: 20, belowGap: 20, blend: 'overlay', strength: 170, size: 100, x: 50, y: 35.9 },
  glow:   { on: true, halo: 170, haloSize: 69, haloBlend: 'overlay', bloom: 120, bloomSize: 10.5 },
  ca:     { on: true, mode: 'radial', style: 'spectral', amount: 3, falloff: 1.5, angle: 0 },
  grain:  { on: true, amount: 10, size: 1, color: 'mono', motion: 'moving' },
  video:  { zoom: 100, panX: 0, panY: 0, exposure: 0, contrast: 0, saturation: 0 },
  look:   { on: true, vignette: 80, spread: 53 },
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
  leading: 1.12,          // baseline-to-baseline for extra lines, in em
  maxW: 0.84, maxH: 0.66, // auto-fit box, fraction of the frame
  ss: 2,                  // rendered at 2x output so scaling up stays sharp
  y: 35.9,                // GN centre in the Figma frame: 484.5 / 1350
  subTracking: -0.02, subLeading: 1.25,
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
const fontReady = (async () => {
  const sources = [
    async () => { const rec = await idbGet('font'); return rec ? [rec.buf.slice(0), rec.name] : null; }, // font the user dropped
    async () => { const r = await fetch('fonts/AOTFShinGoProMedium.otf'); return r.ok ? [await r.arrayBuffer(), 'Shin Go Pro M'] : null; }, // local copy (gitignored)
    async () => ['local("ShinGoPro-Medium"), local("A-OTF Shin Go Pro M")', 'Shin Go Pro M'], // installed on this machine
  ];
  for (const get of sources) {
    try { const v = await get(); if (v && await useFontSource(v[0], v[1])) return true; } catch (e) {}
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
const fontInput = document.createElement('input');
fontInput.type = 'file'; fontInput.accept = '.otf,.ttf,.woff,.woff2'; fontInput.hidden = true;
fontInput.addEventListener('change', () => { const f = fontInput.files[0]; if (f) loadFontFile(f); fontInput.value = ''; });
document.body.appendChild(fontInput);
const tctx = document.createElement('canvas').getContext('2d');
function setTextFont(ctx, px, tracking = TXT.tracking) {
  ctx.font = '500 ' + px + 'px ' + textFamily;
  ctx.letterSpacing = (tracking * px) + 'px';
}
function measureText(text, px, tracking = TXT.tracking, leading = TXT.leading) {
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
  const main = has(d.text) ? measureText(d.text, P) : null;
  const mh = main ? main.height : 0;
  if (main) items.push({ m: main, capTop: -mh / 2, grad: true });
  const sp = P * d.subSize / 100;
  if (has(d.above)) { const m = measureText(d.above, sp, TXT.subTracking, TXT.subLeading); items.push({ m, capTop: -mh / 2 - d.aboveGap / 100 * P - m.height, grad: false }); }
  if (has(d.below)) { const m = measureText(d.below, sp, TXT.subTracking, TXT.subLeading); items.push({ m, capTop: mh / 2 + d.belowGap / 100 * P, grad: false }); }
  if (!items.length) return null;
  const capTop = Math.min(...items.map((it) => it.capTop)), capBot = Math.max(...items.map((it) => it.capTop + it.m.height));
  return { items, width: Math.max(...items.map((it) => it.m.width)), height: capBot - capTop };
}
// Text -> transparent canvas centred on the main text. Auto-fit: main text as big as GN in Figma, smaller
// when the whole group needs it to stay inside the frame. Returns the frame-width fraction at Size 100.
function textCanvas(d, W, H) {
  const l1 = layoutText(d, 100);
  if (!l1) return null;
  const auto = Math.min(TXT.size * Math.min(W, H), TXT.maxW * W / (l1.width / 100), TXT.maxH * H / Math.max(1, l1.height / 100));
  const P = auto * TXT.ss;
  const lay = layoutText(d, P);
  const pad = 0.08 * P + 4; // transparent margin: coarse mips never reach the edge
  let halfW = 0, halfH = 0;
  for (const it of lay.items) {
    halfW = Math.max(halfW, it.m.width / 2 + it.m.padX);
    halfH = Math.max(halfH, -(it.capTop - it.m.up), it.capTop + it.m.height + it.m.down);
  }
  const cw = 2 * Math.ceil(halfW + pad), ch = 2 * Math.ceil(halfH + pad);
  const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
  const ctx = cv.getContext('2d');
  for (const it of lay.items) {
    const m = it.m;
    setTextFont(ctx, m.px, m.tracking);
    m.L.forEach((ln, i) => {
      if (!ln.s) return;
      const base = ch / 2 + it.capTop + m.cap + i * m.lead;
      if (it.grad) { // GN look: white fading in from the cap top, per line
        const g = ctx.createLinearGradient(0, base - m.cap, 0, base);
        g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(1, '#fff');
        ctx.fillStyle = g;
      } else ctx.fillStyle = '#fff'; // subtitles: solid, so small text stays readable
      ctx.fillText(ln.s, (cw - ln.w) / 2, base);
    });
  }
  return { canvas: cv, fit: cw / (W * TXT.ss), px: auto };
}
let textKey = '';
const textKeyNow = () => { const d = S.design; return [S.format, d.text, d.above, d.below, d.subSize, d.aboveGap, d.belowGap, textFamily].join('\u0001'); };
function buildText() {
  const [W, H] = outDims();
  textKey = textKeyNow();
  media.text = textCanvas(S.design, W, H);
  if (S.design.source === 'text') renderer.setDesign(media.text ? media.text.canvas : null, media.text ? media.text.fit : 1);
}
function applySource() {
  if (S.design.source === 'text') buildText(); else renderer.setDesign(media.image || null);
  placeDesign(); updateMediaLabels(); changed();
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
    { type: 'slider', key: 'design.subSize', label: 'Sub size', min: 5, max: 80, step: 1, show: () => S.design.source === 'text' && !!(S.design.above.trim() || S.design.below.trim()) },
    { type: 'slider', key: 'design.aboveGap', label: 'Above gap', min: -50, max: 200, step: 1, show: () => S.design.source === 'text' && !!S.design.above.trim() },
    { type: 'slider', key: 'design.belowGap', label: 'Below gap', min: -50, max: 200, step: 1, show: () => S.design.source === 'text' && !!S.design.below.trim() },
    { type: 'segs', segs: [{ key: 'design.blend', opts: [['normal', 'Normal'], ['overlay', 'Overlay'], ['screen', 'Screen'], ['add', 'Add']] }] },
    { type: 'slider', key: 'design.strength', label: 'Strength', min: 0, max: 200, step: 1 },
    { type: 'slider', key: 'design.size', label: 'Size', min: 5, max: 200, step: 1 },
    { type: 'slider', key: 'design.x', label: 'X', min: 0, max: 100, step: 0.1 },
    { type: 'slider', key: 'design.y', label: 'Y', min: 0, max: 100, step: 0.1 },
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
      if (getP(spec.key) === v) return;
      setP(spec.key, v);
      if (secKey && S[secKey] && 'on' in S[secKey]) S[secKey].on = true;
      syncAll();
      if (onChange) onChange(v); else changed();
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
  el.root.classList.toggle('off', key === 'design' ? (S.design.source === 'image' && !media.image) : ('on' in S[key] ? !S[key].on : false));
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
    else { row.className = 'row tools'; for (const s of r.segs) buildSeg(row, s, sec.key); }
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
  if (S.design.source === 'text') { S.design.x = 50; S.design.y = TXT.y; S.design.size = 100; return; }
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
  if (!activeDesign()) { box.style.display = 'none'; return; }
  box.style.display = '';
  const [W, H] = outDims();
  const r = renderer.designRect(S, W, H);
  box.style.left = (r[0] * cssW) + 'px';
  box.style.top = ((1 - r[1] - r[3]) * cssH) + 'px';
  box.style.width = (r[2] * cssW) + 'px';
  box.style.height = (r[3] * cssH) + 'px';
}
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
  if (!e.altKey) { if (Math.abs(x - 50) < 0.8) x = 50; if (Math.abs(y - 50) < 0.8) y = 50; }
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
fontReady.then((ok) => {
  if (S.design.source === 'text') buildText();
  updateMediaLabels(); changed();
});

window.afterglow = { get S() { return S; }, set S(v) { S = merge(DEFAULTS, v); changed(); }, textCanvas, buildText, setDesign, applySource, renderer, media, clip, setMode, exportMP4, draw, video };
