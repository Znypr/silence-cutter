// Silence Cutter: pick a video, detect dead air, tweak, preview, export.
import { Input, ALL_FORMATS, BlobSource, AudioSampleSink } from 'mediabunny';
import { exportVideo, describeExport, checkSupport } from './export.js';

const $ = (id) => document.getElementById(id);
const HOP = 0.01; // envelope resolution: 10 ms

const PRESETS = {
  gentle: { minSil: 0.8, keepPause: 0.25, minClip: 0.2 },
  normal: { minSil: 0.5, keepPause: 0.12, minClip: 0.35 },
  tight:  { minSil: 0.3, keepPause: 0.06, minClip: 0.5 },
};

const S = {
  file: null, input: null, info: null,
  db: null,           // Float32Array, dB per HOP
  duration: 0,
  params: { thr: -40, ...PRESETS.normal },
  overrides: [],      // [{s, e, keep}] manual edits, applied in order over the auto result
  keeps: [],          // final keep intervals [[s, e], ...]
  segs: [],           // [{s, e, keep}] covering [0, duration]
  selected: null,     // time anchor inside the selected segment
  mode: 'cut',        // 'cut' = trimmed preview, 'orig' = original
  view: { start: 0, zoom: 1 },
  exportAbort: null,
  outBlob: null, outName: '',
};

// ---------- utils ----------
const fmt = (t) => {
  t = Math.max(0, t);
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
};
const fmtLong = (t) => {
  const m = Math.floor(t / 60), s = Math.round(t - m * 60);
  return m ? `${m}m ${s}s` : `${s}s`;
};
let toastTimer;
function toast(msg, ms = 3500) {
  const el = $('toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), ms);
}
const show = (id, on) => ($(id).hidden = !on);

// ---------- interval maths ----------
function normalize(list) {
  const a = list.filter(([s, e]) => e - s > 1e-4).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [s, e] of a) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + 1e-6) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}
function subtract(list, s, e) {
  const out = [];
  for (const [a, b] of list) {
    if (b <= s || a >= e) { out.push([a, b]); continue; }
    if (a < s) out.push([a, s]);
    if (b > e) out.push([e, b]);
  }
  return out;
}

// ---------- detection ----------
function computeAuto(p = S.params) {
  const { db } = S; const { thr, minSil, keepPause, minClip } = p;
  const dur = S.duration;
  // 1. loud runs
  let regions = [];
  let start = -1;
  for (let i = 0; i < db.length; i++) {
    const loud = db[i] >= thr;
    if (loud && start < 0) start = i;
    if (!loud && start >= 0) { regions.push([start * HOP, i * HOP]); start = -1; }
  }
  if (start >= 0) regions.push([start * HOP, db.length * HOP]);
  // 2. pauses shorter than minSil are kept (merge across them)
  const merged = [];
  for (const r of regions) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] < minSil) last[1] = r[1];
    else merged.push([...r]);
  }
  // 3. leave some of each pause around speech
  let padded = normalize(merged.map(([s, e]) => [Math.max(0, s - keepPause), Math.min(dur, e + keepPause)]));
  // 4. delete leftover snippets that are too short to matter
  if (minClip > 0) padded = padded.filter(([s, e]) => e - s >= minClip);
  return { keeps: padded, speech: merged };
}

function recompute() {
  if (!S.db) return;
  const auto = computeAuto();
  S.speech = auto.speech;
  let keeps = auto.keeps;
  for (const o of S.overrides) {
    const s = Math.max(0, o.s), e = Math.min(S.duration, o.e);
    keeps = o.keep ? normalize([...keeps, [s, e]]) : subtract(keeps, s, e);
  }
  S.keeps = normalize(keeps);
  // segments covering the whole video
  const segs = []; let t = 0;
  for (const [s, e] of S.keeps) {
    if (s > t + 1e-6) segs.push({ s: t, e: s, keep: false });
    segs.push({ s, e, keep: true }); t = e;
  }
  if (t < S.duration - 1e-6) segs.push({ s: t, e: S.duration, keep: false });
  S.segs = segs;
  // per-10ms class for drawing: 0 removed, 1 speech, 2 kept pause (padding / short pause)
  const cls = new Uint8Array(S.db.length);
  for (const [s, e] of S.keeps) cls.fill(2, Math.floor(s / HOP), Math.ceil(e / HOP));
  for (let i = 0; i < cls.length; i++) if (cls[i] === 2 && S.db[i] >= S.params.thr) cls[i] = 1;
  S.cls = cls;
  $('resetManual').hidden = S.overrides.length === 0;
  $('undoBtn').disabled = S.overrides.length === 0;
  updateStats(); updatePiece(); draw(); updateExportSpec(); updateCut(); scheduleCurve();
}

function autoThreshold() {
  const vals = Array.from(S.db).filter((v) => v > -100).sort((a, b) => a - b);
  if (vals.length < 10) return -40;
  const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
  const floor = q(0.1), speech = q(0.9);
  // a third of the way from the noise floor to typical speech
  return Math.round(Math.min(-12, Math.max(-65, floor + (speech - floor) * 0.33)));
}

// ---------- loading ----------
async function loadFile(file) {
  resetExportUI();
  S.file = file; S.cls = null; S.overrides = []; S.selected = null; S.cutIdx = 0; S.cutAnchor = null; S.audition = null; curve = null; S.view = { start: 0, zoom: 1 }; $('zoom').value = 1;
  show('pick', false); show('editor', false); show('analysing', true); $('newBtn').hidden = false;
  $('analyseLabel').textContent = 'Reading video…'; $('analyseBar').style.width = '0%';
  try {
    if (S.input) S.input.dispose?.();
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    S.input = input;
    const vt = await input.getPrimaryVideoTrack();
    const at = await input.getPrimaryAudioTrack();
    if (!vt) throw new Error('No video track found in this file.');
    if (!at) throw new Error('This video has no sound, so there is no silence to find.');
    if (!(await at.canDecode())) throw new Error(`This phone can't decode the audio (${await at.getCodec()}).`);
    const duration = await input.computeDuration();
    const fr = await vt.computeFrameRateMetrics().catch(() => null);
    S.info = {
      vt, at, duration,
      width: await vt.getDisplayWidth(), height: await vt.getDisplayHeight(),
      codedWidth: await vt.getCodedWidth?.(), rotation: await vt.getRotation(),
      fps: fr?.bestGuessFrameRate || 30, fpsMin: fr?.minFrameRate, fpsMax: fr?.maxFrameRate,
      hdr: await vt.hasHighDynamicRange?.().catch(() => false),
      vcodec: await vt.getCodec(), acodec: await at.getCodec(),
      sampleRate: await at.getSampleRate(), channels: await at.getNumberOfChannels(),
      canDecodeVideo: await vt.canDecode(),
    };
    S.duration = duration;
    $('video').src = URL.createObjectURL(file);
    await analyse(at, duration);
    S.params.thr = autoThreshold();
    syncControls();
    show('analysing', false); show('editor', true);
    resizeCanvas(); recompute();
    if (!S.info.canDecodeVideo) toast(`Heads up: this phone can't decode ${S.info.vcodec} video, so export won't work for this file.`, 7000);
    else if (S.info.hdr) toast('HDR video: export converts it to standard colour (what most apps show anyway).', 6000);
  } catch (err) {
    console.error(err);
    show('analysing', false); show('pick', true);
    toast(err.message || String(err), 7000);
  }
}

async function analyse(at, duration) {
  $('analyseLabel').textContent = 'Listening for silence…';
  const sr = await at.getSampleRate();
  const hopN = Math.max(1, Math.round(sr * HOP));
  const total = Math.ceil(duration / HOP) + 2;
  const db = new Float32Array(total).fill(-120);
  const sink = new AudioSampleSink(at);
  let acc = 0, accN = 0, idx = -1, lastUi = 0;
  let plane = new Float32Array(0), mono = new Float32Array(0);
  for await (const sample of sink.samples()) {
    const n = sample.numberOfFrames, ch = sample.numberOfChannels;
    if (mono.length < n) { mono = new Float32Array(n); plane = new Float32Array(n); }
    mono.fill(0, 0, n);
    for (let c = 0; c < ch; c++) {
      sample.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
      for (let i = 0; i < n; i++) mono[i] += plane[i] / ch;
    }
    let pos = Math.round(sample.timestamp * sr);
    for (let i = 0; i < n; i++, pos++) {
      const bin = Math.floor(pos / hopN);
      if (bin !== idx) {
        if (idx >= 0 && idx < total && accN) db[idx] = 10 * Math.log10(acc / accN + 1e-12);
        idx = bin; acc = 0; accN = 0;
      }
      acc += mono[i] * mono[i]; accN++;
    }
    const t = sample.timestamp; sample.close();
    if (performance.now() - lastUi > 100) {
      lastUi = performance.now();
      $('analyseBar').style.width = `${Math.min(100, (t / duration) * 100)}%`;
      await new Promise((r) => setTimeout(r));
    }
  }
  if (idx >= 0 && idx < total && accN) db[idx] = 10 * Math.log10(acc / accN + 1e-12);
  S.db = db.subarray(0, Math.ceil(duration / HOP));
}

// ---------- controls ----------
const CTL = {
  thr: { el: 'thr', fmt: (v) => `${v} dB` },
  minSil: { el: 'minSil', fmt: (v) => `${(+v).toFixed(2)} s` },
  keepPause: { el: 'keepPause', fmt: (v) => `${(+v).toFixed(2)} s` },
  minClip: { el: 'minClip', fmt: (v) => (+v === 0 ? 'off' : `${(+v).toFixed(2)} s`) },
};
function syncControls() {
  for (const [k, c] of Object.entries(CTL)) {
    $(c.el).value = S.params[k];
    $(c.el + 'V').textContent = c.fmt(S.params[k]);
  }
}
for (const [k, c] of Object.entries(CTL)) {
  $(c.el).addEventListener('input', (e) => {
    S.params[k] = +e.target.value;
    $(c.el + 'V').textContent = c.fmt(S.params[k]);
    if (k !== 'thr') document.querySelectorAll('.chip').forEach((b) => b.classList.remove('on'));
    scheduleRecompute();
  });
}
let rcRaf = 0;
function scheduleRecompute() { cancelAnimationFrame(rcRaf); rcRaf = requestAnimationFrame(recompute); }

document.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => {
  Object.assign(S.params, PRESETS[b.dataset.preset]);
  document.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === b));
  syncControls(); recompute();
}));
$('autoThr').addEventListener('click', () => { S.params.thr = autoThreshold(); syncControls(); recompute(); toast(`Threshold set to ${S.params.thr} dB`); });
$('undoBtn').addEventListener('click', () => { S.overrides.pop(); recompute(); });
$('resetManual').addEventListener('click', () => { S.overrides = []; recompute(); toast('Manual edits removed'); });

// ---------- stats ----------
function keptDuration() { return S.keeps.reduce((a, [s, e]) => a + (e - s), 0); }
function updateStats() {
  const kept = keptDuration();
  const removed = S.duration - kept;
  const cuts = Math.max(0, S.keeps.length - 1); // joins in the finished video
  $('stats').innerHTML =
    `<span>Original <b>${fmtLong(S.duration)}</b></span>` +
    `<span>Trimmed <b>${fmtLong(kept)}</b></span>` +
    `<span>Removed <b>${fmtLong(removed)}</b> (${S.duration ? Math.round((removed / S.duration) * 100) : 0}%)</span>` +
    `<span>Cuts <b>${cuts}</b></span>`;
}

// ---------- selected piece ----------
function segAt(t) { return S.segs.find((x) => t >= x.s && t < x.e) || S.segs[S.segs.length - 1]; }
function updatePiece() {
  if (S.selected == null || !S.segs.length) { show('piece', false); return; }
  const g = segAt(S.selected);
  show('piece', true);
  $('pieceTitle').textContent = g.keep ? 'Kept piece' : 'Cut piece';
  $('pieceTitle').style.color = g.keep ? 'var(--keep)' : 'var(--cut)';
  $('pieceRange').textContent = `${fmt(g.s)} → ${fmt(g.e)}  (${(g.e - g.s).toFixed(2)} s)`;
  $('toggleBtn').textContent = g.keep ? 'Cut this piece' : 'Keep this piece';
}
$('toggleBtn').addEventListener('click', () => {
  const g = segAt(S.selected);
  S.overrides.push({ s: g.s, e: g.e, keep: !g.keep });
  recompute();
});
$('playPieceBtn').addEventListener('click', () => {
  const g = segAt(S.selected); const v = $('video');
  v.currentTime = Math.max(0, g.s - 1); v.play();
});
document.querySelectorAll('[data-nudge]').forEach((b) => b.addEventListener('click', () => {
  const [edge, amt] = b.dataset.nudge.split(',');
  const d = amt.endsWith('f') ? parseFloat(amt) / (S.info?.fps || 30) : parseFloat(amt);
  const g = segAt(S.selected);
  // moving an edge outward grows this piece, inward shrinks it
  if (edge === 'start') {
    if (g.s <= 0 && d < 0) return;
    if (d < 0) S.overrides.push({ s: g.s + d, e: g.s, keep: g.keep });
    else S.overrides.push({ s: g.s, e: g.s + d, keep: !g.keep });
    S.selected = Math.max(g.s + d + 1e-3, Math.min(S.selected, g.e - 1e-3));
  } else {
    if (g.e >= S.duration && d > 0) return;
    if (d > 0) S.overrides.push({ s: g.e, e: g.e + d, keep: g.keep });
    else S.overrides.push({ s: g.e + d, e: g.e, keep: !g.keep });
    S.selected = Math.min(g.e + d - 1e-3, Math.max(S.selected, g.s + 1e-3));
  }
  recompute();
  $('video').currentTime = edge === 'start' ? segAt(S.selected).s : Math.max(0, segAt(S.selected).e - 0.5);
}));

// ---------- playback ----------
const video = $('video');
$('playBtn').addEventListener('click', () => { S.audition = null; video.paused ? video.play() : video.pause(); });
video.addEventListener('play', () => { $('playBtn').textContent = '❚❚'; loop(); });
video.addEventListener('pause', () => ($('playBtn').textContent = '▶'));
video.addEventListener('ended', () => ($('playBtn').textContent = '▶'));
$('modeCut').addEventListener('click', () => setMode('cut'));
$('modeOrig').addEventListener('click', () => setMode('orig'));
function setMode(m) {
  S.mode = m;
  $('modeCut').classList.toggle('on', m === 'cut'); $('modeOrig').classList.toggle('on', m === 'orig');
}
function skipCuts() {
  if (S.mode !== 'cut' || video.paused || !S.segs.length) return;
  const t = video.currentTime;
  const g = segAt(t);
  if (g && !g.keep) {
    const next = S.keeps.find(([s]) => s >= g.e - 1e-6);
    if (next) video.currentTime = next[0];
    else { video.pause(); video.currentTime = S.duration; }
  }
}
function runAudition() {
  const a = S.audition; if (!a || video.paused) return;
  const t = video.currentTime, [, end] = a.ranges[a.i];
  if (t >= end - 0.01) {
    a.i++;
    if (a.i >= a.ranges.length) { video.pause(); S.audition = null; return; }
    video.currentTime = a.ranges[a.i][0];
  }
}
// jump logic runs on a timer too, so cuts land on time even when frames are throttled
let tickTimer = 0;
const tick = () => { if (S.audition) runAudition(); else skipCuts(); };
video.addEventListener('play', () => { clearInterval(tickTimer); tickTimer = setInterval(tick, 15); });
video.addEventListener('pause', () => clearInterval(tickTimer));
function loop() {
  tick();
  draw(); drawCut(); $('timeLabel').textContent = `${fmt(video.currentTime)} / ${fmt(S.duration)}`;
  if (!video.paused) requestAnimationFrame(loop);
}
video.addEventListener('seeked', () => { draw(); drawCut();$('timeLabel').textContent = `${fmt(video.currentTime)} / ${fmt(S.duration)}`; });

// ---------- timeline ----------
const cv = $('timeline'); const ctx = cv.getContext('2d');
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(cv.clientWidth * dpr); cv.height = Math.round(cv.clientHeight * dpr);
  draw();
}
window.addEventListener('resize', resizeCanvas);
const CLS_COLORS = ['#a2524f', '#7fd3ae', '#e0b45a'];
const STRIP_COLORS = ['#d9534f', '#4fb38a', '#e0b45a'];
// coloured bar: green speech, amber kept pause (padding), red removed
function drawStrip(c, y, h, W, xToTime) {
  let runStart = 0, runCls = -1;
  const flush = (x) => { if (runCls >= 0) { c.fillStyle = STRIP_COLORS[runCls]; c.fillRect(runStart, y, x - runStart, h); } };
  for (let x = 0; x <= W; x++) {
    const t = xToTime(x);
    const k = x === W || t < 0 || t >= S.duration ? -1 : S.cls[Math.min(S.cls.length - 1, Math.floor(t / HOP))];
    if (k !== runCls) { flush(x); runStart = x; runCls = k; }
  }
}
const viewLen = () => S.duration / S.view.zoom;
function clampView() { S.view.start = Math.max(0, Math.min(S.duration - viewLen(), S.view.start)); }
const tToX = (t) => ((t - S.view.start) / viewLen()) * cv.width;
const xToT = (x) => S.view.start + (x / cv.width) * viewLen();

function draw() {
  if (!S.db || !S.cls || !cv.width) return;
  const W = cv.width, H = cv.height, dpr = window.devicePixelRatio || 1;
  const t = video.currentTime;
  // follow the playhead while playing
  if (!video.paused && S.view.zoom > 1 && (t > S.view.start + viewLen() * 0.9 || t < S.view.start)) {
    S.view.start = t - viewLen() * 0.1; clampView();
  }
  ctx.clearRect(0, 0, W, H);
  const waveTop = 6 * dpr, waveH = H - 26 * dpr;
  // segment backgrounds
  for (const g of S.segs) {
    const x0 = tToX(g.s), x1 = tToX(g.e);
    if (x1 < 0 || x0 > W) continue;
    ctx.fillStyle = g.keep ? 'rgba(79,179,138,.16)' : 'rgba(217,83,79,.22)';
    ctx.fillRect(x0, 0, x1 - x0, H);
  }
  // waveform (dB scaled -70..0)
  const dbToY = (v) => waveTop + waveH * (1 - Math.max(0, Math.min(1, (v + 70) / 70)));
  const t0 = S.view.start, perPx = viewLen() / W;
  for (let x = 0; x < W; x += Math.max(1, Math.round(dpr))) {
    const a = Math.floor((t0 + x * perPx) / HOP), b = Math.max(a + 1, Math.floor((t0 + (x + dpr) * perPx) / HOP));
    let m = -120; for (let i = a; i < b && i < S.db.length; i++) if (S.db[i] > m) m = S.db[i];
    if (m <= -70) continue;
    const y = dbToY(m), base = waveTop + waveH;
    ctx.fillStyle = CLS_COLORS[S.cls?.[Math.min(a, S.cls.length - 1)] ?? 0];
    ctx.fillRect(x, y, Math.max(1, dpr), base - y);
  }
  // threshold line
  const ty = dbToY(S.params.thr);
  ctx.strokeStyle = '#ff6b6b'; ctx.setLineDash([4 * dpr, 4 * dpr]); ctx.lineWidth = dpr;
  ctx.beginPath(); ctx.moveTo(0, ty); ctx.lineTo(W, ty); ctx.stroke(); ctx.setLineDash([]);
  // keep/cut strip
  drawStrip(ctx, H - 16 * dpr, 10 * dpr, W, (x) => xToT(x));
  // selection
  if (S.selected != null && S.segs.length) {
    const g = segAt(S.selected);
    ctx.strokeStyle = '#f2c14e'; ctx.lineWidth = 2 * dpr;
    ctx.strokeRect(tToX(g.s) + dpr, dpr, tToX(g.e) - tToX(g.s) - 2 * dpr, H - 2 * dpr);
  }
  // playhead
  const px = tToX(t);
  ctx.fillStyle = '#fff'; ctx.fillRect(px - dpr * 0.75, 0, 1.5 * dpr, H);
}

// tap = select + seek, drag = pan (when zoomed)
let drag = null;
cv.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, start: S.view.start, moved: false };
  cv.setPointerCapture(e.pointerId);
});
cv.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  if (Math.abs(dx) > 6) drag.moved = true;
  if (drag.moved && S.view.zoom > 1) {
    S.view.start = drag.start - (dx / cv.clientWidth) * viewLen(); clampView(); draw();
  }
});
cv.addEventListener('pointerup', (e) => {
  if (drag && !drag.moved) {
    const r = cv.getBoundingClientRect();
    const t = xToT(((e.clientX - r.left) / r.width) * cv.width);
    S.selected = Math.max(0, Math.min(S.duration - 1e-3, t));
    video.currentTime = S.selected;
    const g = segAt(S.selected);
    if (!g.keep) { S.cutAnchor = (g.s + g.e) / 2; updateCut(); }
    updatePiece(); draw();
  }
  drag = null;
});
$('zoom').addEventListener('input', (e) => {
  const center = S.view.start + viewLen() / 2;
  S.view.zoom = +e.target.value;
  S.view.start = (S.selected ?? video.currentTime ?? center) - viewLen() / 2; clampView(); draw();
});

// ---------- hear one cut ----------
const CTX_S = 2.0; // seconds of context on each side of the cut
const cc = $('cutCanvas'); const cctx = cc.getContext('2d');
S.cutIdx = 0;
function cutsList() {
  // the joins: removed pieces with kept material on both sides (fall back to any removed piece)
  const inner = S.segs.filter((g) => !g.keep && g.s > 0.001 && g.e < S.duration - 0.001);
  return inner.length ? inner : S.segs.filter((g) => !g.keep);
}
function currentCut() {
  const list = cutsList(); if (!list.length) return null;
  S.cutIdx = Math.max(0, Math.min(list.length - 1, S.cutIdx));
  return { cut: list[S.cutIdx], n: list.length };
}
function updateCut() {
  // keep looking at roughly the same spot while settings change
  if (S.cutAnchor != null) {
    const list = cutsList();
    let best = 0, bd = Infinity;
    list.forEach((g, i) => { const d = Math.abs((g.s + g.e) / 2 - S.cutAnchor); if (d < bd) { bd = d; best = i; } });
    S.cutIdx = best;
  }
  const c = currentCut();
  $('cutPlayBtn').disabled = $('cutOrigBtn').disabled = !c;
  if (!c) { $('cutIdx').textContent = ''; $('cutInfo').textContent = 'No cuts with these settings.'; drawCut(); return; }
  const { cut, n } = c;
  const before = S.keeps.find(([, e]) => Math.abs(e - cut.s) < 1e-6);
  const after = S.keeps.find(([s]) => Math.abs(s - cut.e) < 1e-6);
  const padIn = before ? padLen(before[1], -1) : 0, padOut = after ? padLen(after[0], 1) : 0;
  $('cutIdx').textContent = `cut ${S.cutIdx + 1} of ${n} · ${fmt(cut.s)}`;
  $('cutInfo').textContent = `Removes ${(cut.e - cut.s).toFixed(2)} s. Pause left before the cut ${padIn.toFixed(2)} s, after ${padOut.toFixed(2)} s. The preview jump can stutter a little; the export is seamless with soft audio fades.`;
  drawCut();
}
function padLen(edge, dir) {
  // how much quiet (below threshold) sits between the cut edge and the nearest speech
  let i = Math.round(edge / HOP) + (dir < 0 ? -1 : 0), k = 0;
  while (i >= 0 && i < S.db.length && S.db[i] < S.params.thr && k < 500) { i += dir; k++; }
  return k * HOP;
}
// piecewise x mapping: [2 s before] 38% | [removed part] 24% | [2 s after] 38%
function cutMap(cut) {
  const W = cc.width, a = cut.s - CTX_S, b = cut.e + CTX_S, L = 0.38 * W, M = 0.24 * W;
  return {
    a, b,
    x: (t) => t < cut.s ? ((t - a) / CTX_S) * L
      : t < cut.e ? L + ((t - cut.s) / Math.max(1e-6, cut.e - cut.s)) * M
      : L + M + ((t - cut.e) / CTX_S) * L,
    t: (x) => x < L ? a + (x / L) * CTX_S
      : x < L + M ? cut.s + ((x - L) / M) * (cut.e - cut.s)
      : cut.e + ((x - L - M) / L) * CTX_S,
    L, M,
  };
}
function drawCut() {
  const dpr = window.devicePixelRatio || 1;
  if (cc.width !== Math.round(cc.clientWidth * dpr)) { cc.width = Math.round(cc.clientWidth * dpr); cc.height = Math.round(cc.clientHeight * dpr); }
  const W = cc.width, H = cc.height; cctx.clearRect(0, 0, W, H);
  if (!S.db || !S.cls) return;
  const c = currentCut(); if (!c) return;
  const { cut } = c, m = cutMap(cut);
  const top = 18 * dpr, wh = H - top - 20 * dpr;
  drawStrip(cctx, H - 12 * dpr, 10 * dpr, W, (x) => m.t(x));
  const dbToY = (v) => top + wh * (1 - Math.max(0, Math.min(1, (v + 70) / 70)));
  // removed zone
  cctx.fillStyle = 'rgba(217,83,79,.18)'; cctx.fillRect(m.L, 0, m.M, H);
  // waveform
  const step = Math.max(1, Math.round(dpr * 1.5));
  for (let x = 0; x < W; x += step) {
    const t0 = m.t(x), t1 = m.t(x + step);
    const a = Math.max(0, Math.floor(t0 / HOP)), b = Math.max(a + 1, Math.floor(t1 / HOP));
    if (t0 < 0 || a >= S.db.length) continue;
    let mx = -120; for (let i = a; i < b && i < S.db.length; i++) if (S.db[i] > mx) mx = S.db[i];
    if (mx <= -70) continue;
    const y = dbToY(mx);
    cctx.fillStyle = CLS_COLORS[S.cls[a] ?? 0];
    cctx.fillRect(x, y, Math.max(1, step - dpr * 0.5), top + wh - y);
  }
  // threshold
  const ty = dbToY(S.params.thr);
  cctx.strokeStyle = '#ff6b6b'; cctx.lineWidth = dpr; cctx.setLineDash([4 * dpr, 4 * dpr]);
  cctx.beginPath(); cctx.moveTo(0, ty); cctx.lineTo(W, ty); cctx.stroke(); cctx.setLineDash([]);
  // cut lines + labels
  cctx.strokeStyle = '#fff'; cctx.lineWidth = 1.5 * dpr;
  for (const x of [m.L, m.L + m.M]) { cctx.beginPath(); cctx.moveTo(x, top - 4 * dpr); cctx.lineTo(x, H); cctx.stroke(); }
  cctx.fillStyle = '#e9eaec'; cctx.font = `${11 * dpr}px system-ui, sans-serif`; cctx.textAlign = 'center';
  cctx.fillText(`− ${(cut.e - cut.s).toFixed(2)} s`, m.L + m.M / 2, 12 * dpr);
  cctx.fillStyle = '#9097a1';
  cctx.fillText('before', m.L / 2, 12 * dpr); cctx.fillText('after', m.L + m.M + m.L / 2, 12 * dpr);
  // playhead while auditioning / playing near this cut
  const t = video.currentTime;
  if (t >= m.a && t <= m.b) { cctx.fillStyle = '#f2c14e'; cctx.fillRect(m.x(t) - dpr, 0, 2 * dpr, H); }
}
function audition(trimmed) {
  const c = currentCut(); if (!c) return;
  const { cut } = c;
  S.audition = {
    i: 0,
    ranges: trimmed
      ? [[Math.max(0, cut.s - CTX_S), cut.s], [cut.e, Math.min(S.duration, cut.e + CTX_S)]]
      : [[Math.max(0, cut.s - CTX_S), Math.min(S.duration, cut.e + CTX_S)]],
  };
  video.currentTime = S.audition.ranges[0][0];
  video.play();
}
$('cutPlayBtn').addEventListener('click', () => audition(true));
$('cutOrigBtn').addEventListener('click', () => audition(false));
for (const [id, d] of [['cutPrevBtn', -1], ['cutNextBtn', 1]]) {
  $(id).addEventListener('click', () => {
    const list = cutsList(); if (!list.length) return;
    S.cutIdx = (S.cutIdx + d + list.length) % list.length;
    const g = list[S.cutIdx]; S.cutAnchor = (g.s + g.e) / 2;
    updateCut();
  });
}
cc.addEventListener('click', () => audition(true));

// ---------- threshold curve: what each threshold would remove ----------
const tc = $('thrCurve'); const tctx = tc.getContext('2d');
const THR_MIN = -70, THR_MAX = -10;
let curve = null, curveTimer = 0;
function scheduleCurve() { clearTimeout(curveTimer); curveTimer = setTimeout(buildCurve, 120); }
function buildCurve() {
  if (!S.db) return;
  const key = `${S.params.minSil}|${S.params.keepPause}|${S.params.minClip}`;
  if (!curve || curve.key !== key) {
    const pts = [];
    for (let thr = THR_MIN; thr <= THR_MAX; thr++) {
      const { keeps } = computeAuto({ ...S.params, thr });
      const kept = keeps.reduce((a, [s, e]) => a + (e - s), 0);
      pts.push({ thr, removed: 1 - kept / S.duration, cuts: Math.max(0, keeps.length - 1) });
    }
    curve = { key, pts };
  }
  drawCurve();
}
function drawCurve() {
  if (!curve) return;
  const dpr = window.devicePixelRatio || 1;
  tc.width = Math.round(tc.clientWidth * dpr); tc.height = Math.round(tc.clientHeight * dpr);
  const W = tc.width, H = tc.height, pad = 4 * dpr;
  const x = (thr) => ((thr - THR_MIN) / (THR_MAX - THR_MIN)) * W;
  const y = (r) => H - pad - r * (H - 2 * pad);
  tctx.clearRect(0, 0, W, H);
  tctx.fillStyle = 'rgba(217,83,79,.25)'; tctx.strokeStyle = '#d9534f'; tctx.lineWidth = 1.5 * dpr;
  tctx.beginPath(); tctx.moveTo(0, H);
  curve.pts.forEach((p) => tctx.lineTo(x(p.thr), y(p.removed)));
  tctx.lineTo(W, H); tctx.closePath(); tctx.fill();
  tctx.beginPath(); curve.pts.forEach((p, i) => (i ? tctx.lineTo : tctx.moveTo).call(tctx, x(p.thr), y(p.removed))); tctx.stroke();
  const cur = curve.pts.find((p) => p.thr === Math.round(S.params.thr)) || curve.pts[0];
  tctx.fillStyle = '#f2c14e'; tctx.fillRect(x(cur.thr) - dpr, 0, 2 * dpr, H);
  tctx.font = `${11 * dpr}px system-ui, sans-serif`; tctx.fillStyle = '#9097a1';
  tctx.textAlign = 'left'; tctx.fillText('cuts little', pad, 12 * dpr);
  tctx.textAlign = 'right'; tctx.fillText('cuts a lot', W - pad, 12 * dpr);
  $('thrInfo').textContent = `At ${cur.thr} dB: removes ${Math.round(cur.removed * 100)}% (${fmtLong(cur.removed * S.duration)}), ${cur.cuts} cuts. Drag the slider or tap the curve; drag back if words get clipped.`;
}
function curvePick(e) {
  const r = tc.getBoundingClientRect();
  const thr = Math.round(THR_MIN + ((e.clientX - r.left) / r.width) * (THR_MAX - THR_MIN));
  S.params.thr = Math.max(THR_MIN, Math.min(THR_MAX, thr)); syncControls(); scheduleRecompute();
}
tc.addEventListener('pointerdown', (e) => { tc.setPointerCapture(e.pointerId); curvePick(e); });
tc.addEventListener('pointermove', (e) => { if (e.buttons) curvePick(e); });
window.addEventListener('resize', () => { drawCurve(); drawCut(); });

// ---------- export ----------
function exportOptions() {
  return { res: $('outRes').value, fps: $('outFps').value, quality: $('outQ').value, fade: +$('outFade').value };
}
function updateExportSpec() {
  if (!S.info) return;
  $('exportSpec').textContent = describeExport(S.info, exportOptions(), keptDuration());
}
['outRes', 'outFps', 'outQ', 'outFade'].forEach((id) => $(id).addEventListener('change', updateExportSpec));

function resetExportUI() {
  show('exporting', false); show('done', false); $('exportBtn').disabled = false;
  if (S.outBlob) { URL.revokeObjectURL($('dlLink').href); S.outBlob = null; }
}

$('exportBtn').addEventListener('click', async () => {
  if (!S.keeps.length) { toast('Everything is cut. Lower the threshold or keep some pieces.'); return; }
  resetExportUI();
  video.pause();
  $('exportBtn').disabled = true; show('exporting', true);
  $('exportBar').style.width = '0%'; $('exportLabel').textContent = 'Starting…';
  const abort = new AbortController(); S.exportAbort = abort;
  const t0 = performance.now();
  try {
    const blob = await exportVideo({
      input: S.input, info: S.info, keeps: S.keeps, options: exportOptions(), signal: abort.signal,
      onProgress: (p, label) => {
        $('exportBar').style.width = `${(p * 100).toFixed(1)}%`;
        const el = (performance.now() - t0) / 1000;
        const eta = p > 0.03 ? ` · ~${fmtLong((el / p) * (1 - p))} left` : '';
        $('exportLabel').textContent = `${label} ${Math.round(p * 100)}%${eta}`;
      },
    });
    S.outBlob = blob;
    S.outName = S.file.name.replace(/\.[^.]+$/, '') + '-trimmed.mp4';
    $('dlLink').href = URL.createObjectURL(blob); $('dlLink').download = S.outName;
    $('doneLabel').textContent = `Done in ${fmtLong((performance.now() - t0) / 1000)} · ${(blob.size / 1e6).toFixed(1)} MB · ${S.outName}`;
    show('exporting', false); show('done', true);
    $('shareBtn').hidden = !(navigator.canShare && navigator.canShare({ files: [new File([blob], S.outName, { type: 'video/mp4' })] }));
  } catch (err) {
    console.error(err);
    show('exporting', false);
    toast(abort.signal.aborted ? 'Export cancelled' : `Export failed: ${err.message || err}`, 8000);
  } finally {
    $('exportBtn').disabled = false; S.exportAbort = null;
  }
});
$('cancelBtn').addEventListener('click', () => S.exportAbort?.abort());
$('shareBtn').addEventListener('click', async () => {
  try {
    await navigator.share({ files: [new File([S.outBlob], S.outName, { type: 'video/mp4' })], title: S.outName });
  } catch (e) { if (e.name !== 'AbortError') toast('Share failed, use Download instead'); }
});

// ---------- file pick ----------
for (const id of ['fileInput', 'fileInput2']) {
  $(id).addEventListener('change', (e) => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ''; });
}
// drag & drop on desktop
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) loadFile(f); });

checkSupport().then((msg) => { if (msg) $('supportNote').textContent = msg; });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');

// test hook (used by the automated check, harmless otherwise)
window.__sc = { S, loadFile, recompute };
