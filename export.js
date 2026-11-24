// Export engine: re-encodes only the kept pieces into an upload-safe MP4.
// H.264 (High) + AAC-LC stereo, constant frame rate, yuv420p 8-bit SDR, rotation baked in,
// keyframe every 2 s, metadata at the front (fast start) so YouTube/TikTok/IG can process it while uploading.
import {
  Output, Mp4OutputFormat, StreamTarget, VideoSampleSink,
  VideoSampleSource, AudioSampleSource, AudioSample, Quality, canEncodeVideo, canEncodeAudio,
} from 'mediabunny';

const STD_RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
// Video bitrate in Mbps by short side, [<=30 fps, >30 fps]. "high" sits at the top of YouTube's
// recommended upload range (the platforms re-encode anyway, so feed them plenty).
const BITRATES = {
  high: { 2160: [45, 68], 1440: [24, 36], 1080: [12, 18], 720: [7.5, 10], 480: [4, 5] },
  std:  { 2160: [30, 45], 1440: [14, 20], 1080: [8, 12], 720: [5, 7.5], 480: [2.5, 4] },
};
const AUDIO_BPS = 192_000;

export function pickFps(info, choice) {
  if (choice !== 'auto') return +choice;
  const f = Math.min(60, info.fps || 30);
  let best = 30, bd = Infinity;
  for (const r of STD_RATES) { const d = Math.abs(r - f); if (d < bd) { bd = d; best = r; } }
  return best;
}

export function pickSize(info, res) {
  const w = info.width, h = info.height; // display size (rotation applied)
  const short = Math.min(w, h);
  const target = res === 'src' ? short : Math.min(short, +res); // never upscale
  const k = target / short;
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);
  return { width: even(w * k), height: even(h * k) };
}

function pickBitrate(size, fps, quality) {
  const short = Math.min(size.width, size.height);
  const table = BITRATES[quality] || BITRATES.high;
  const keys = Object.keys(table).map(Number).sort((a, b) => a - b);
  const key = keys.find((k) => short <= k) ?? keys[keys.length - 1];
  const mbps = table[key][fps > 31 ? 1 : 0];
  return Math.round(mbps * 1e6);
}

export function describeExport(info, opts, keptSeconds) {
  const fps = pickFps(info, opts.fps);
  const size = pickSize(info, opts.res);
  const vbps = pickBitrate(size, fps, opts.quality);
  const mb = ((vbps + AUDIO_BPS) * keptSeconds) / 8 / 1e6;
  const fpsTxt = Number.isInteger(fps) ? fps : fps.toFixed(2);
  const src = `Source: ${info.width}×${info.height}, ${info.vcodec}, ${info.fpsMin && info.fpsMax && info.fpsMax - info.fpsMin > 1 ? `variable ${Math.round(info.fpsMin)}–${Math.round(info.fpsMax)} fps` : `${Math.round(info.fps)} fps`}${info.hdr ? ', HDR' : ''}.`;
  return `${src} Output: MP4 · H.264 + AAC stereo 192k ·${size.width}×${size.height} · ${fpsTxt} fps constant · ${(vbps / 1e6).toFixed(1)} Mbps · ≈ ${mb < 1000 ? mb.toFixed(0) + ' MB' : (mb / 1000).toFixed(2) + ' GB'} · fast start. Ready for YouTube, TikTok, Instagram, X.`;
}

export async function checkSupport() {
  if (!window.isSecureContext) return 'Open this page over https:// (or localhost) — phones only allow video encoding on secure pages.';
  if (!('VideoEncoder' in window) || !('VideoDecoder' in window)) return 'This browser cannot encode video. Use Chrome (Android) or Safari 16.4+ (iPhone).';
  return '';
}

// Collects StreamTarget writes into Blob parts so a multi-GB export doesn't have to sit in JS memory.
// The first HOT bytes stay patchable (the MP4 header is reserved there and filled in at the end).
class BlobCollector {
  static HOT = 32 * 1024 * 1024;
  constructor() { this.parts = []; this.end = 0; }
  write({ data, position }) {
    if (position > this.end) this.append(new Uint8Array(position - this.end));
    if (position === this.end) { this.append(data); return; }
    // overwrite of earlier bytes
    let src = 0;
    for (const p of this.parts) {
      const pEnd = p.pos + p.len;
      const from = Math.max(position + src, p.pos);
      if (pEnd <= position || from >= position + data.length) continue;
      if (!(p.data instanceof Uint8Array)) throw new Error('Internal: tried to patch a sealed region');
      const to = Math.min(position + data.length, pEnd);
      p.data.set(data.subarray(from - position, to - position), from - p.pos);
    }
    if (position + data.length > this.end) this.append(data.subarray(this.end - position));
  }
  append(data) {
    const pos = this.end;
    const part = pos + data.length <= BlobCollector.HOT
      ? { pos, len: data.length, data: data.slice() }
      : { pos, len: data.length, data: new Blob([data]) };
    this.parts.push(part); this.end += data.length;
  }
  blob() { return new Blob(this.parts.map((p) => p.data), { type: 'video/mp4' }); }
}

let aacFallbackRegistered = false;
async function ensureAac(sampleRate) {
  if (await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate, bitrate: AUDIO_BPS })) return;
  if (aacFallbackRegistered) return;
  const { registerAacEncoder } = await import('./vendor/mediabunny-aac-encoder.min.mjs');
  registerAacEncoder(); aacFallbackRegistered = true;
}

async function pickEncodableSize(info, opts, fps) {
  // Try the requested size; if this phone's encoder can't do it, step down.
  const wanted = pickSize(info, opts.res);
  const wantedShort = Math.min(wanted.width, wanted.height);
  const sizes = [wanted, ...[1440, 1080, 720].filter((r) => r < wantedShort).map((r) => pickSize(info, String(r)))];
  for (const size of sizes) {
    const bitrate = pickBitrate(size, fps, opts.quality);
    if (await canEncodeVideo('avc', { width: size.width, height: size.height, bitrate, frameRate: fps })) {
      return { size, bitrate, downgraded: size !== wanted };
    }
  }
  throw new Error('This device has no H.264 encoder that works for this video.');
}

export async function exportVideo({ info, keeps, options, signal, onProgress }) {
  if (!info.canDecodeVideo) throw new Error(`This device can't decode ${info.vcodec} video.`);
  const fps = pickFps(info, options.fps);
  const { size, bitrate, downgraded } = await pickEncodableSize(info, options, fps);
  if (downgraded) onProgress(0, `Encoder can't do the chosen size here, using ${size.width}×${size.height}…`);

  const sr = [44100, 48000].includes(info.sampleRate) ? info.sampleRate : 48000;
  await ensureAac(sr);

  const totalOut = keeps.reduce((a, [s, e]) => a + (e - s), 0);
  const collector = new BlobCollector();
  const writable = new WritableStream({ write: (chunk) => collector.write(chunk) });
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'reserve' }),
    target: new StreamTarget(writable, { chunked: true, chunkSize: 4 * 1024 * 1024 }),
  });

  const videoSource = new VideoSampleSource({
    codec: 'avc',
    quality: new Quality({ bitrate }),
    keyFrameInterval: 2,
    latencyMode: 'quality',
    // always transform: bakes rotation, scales, and converts HDR/10-bit to 8-bit SDR
    transform: { width: size.width, height: size.height, fit: 'fill', force: true },
  });
  const audioSource = new AudioSampleSource({ codec: 'aac', quality: new Quality({ bitrate: AUDIO_BPS }) });
  const maxV = Math.ceil(totalOut * fps) + keeps.length * 2 + 16;
  const maxA = Math.ceil((totalOut * sr) / 1024) + keeps.length * 4 + 64;
  output.addVideoTrack(videoSource, { frameRate: fps, maximumPacketCount: maxV });
  output.addAudioTrack(audioSource, { maximumPacketCount: maxA });
  await output.start();

  let vDone = 0, aDone = 0;
  const report = () => onProgress(Math.min(vDone, aDone) / totalOut, 'Exporting');
  const onAbort = () => output.cancel().catch(() => {});
  signal.addEventListener('abort', onAbort);

  const videoJob = async () => {
    const sink = new VideoSampleSink(info.vt);
    let outStart = 0;
    for (const [s, e] of keeps) {
      const dur = e - s;
      const nEnd = Math.ceil((outStart + dur) * fps - 1e-6);
      let n = Math.ceil(outStart * fps - 1e-6);
      const srcTime = (k) => s + (k / fps - outStart);
      const emit = async (sample) => {
        const c = sample.clone();
        c.setTimestamp(n / fps); c.setDuration(1 / fps);
        try { await videoSource.add(c); } finally { c.close(); }
        n++; vDone = Math.min(totalOut, n / fps); report();
      };
      let prev = null;
      for await (const sample of sink.samples(s, e)) {
        if (signal.aborted) { sample.close(); break; }
        if (prev) {
          // constant frame rate: each output tick shows the source frame on screen at that moment
          while (n < nEnd && srcTime(n) < sample.timestamp - 1e-6) await emit(prev);
          prev.close();
        }
        prev = sample;
      }
      if (prev) { while (n < nEnd && !signal.aborted) await emit(prev); prev.close(); }
      if (signal.aborted) return;
      outStart += dur;
    }
    vDone = totalOut; report();
    videoSource.close();
  };

  const audioJob = async () => {
    const fadeN = Math.round((options.fade || 0) * sr);
    let outFrames = 0, outStart = 0;
    const push = async (L, R) => {
      const data = new Float32Array(L.length * 2);
      data.set(L, 0); data.set(R, L.length);
      const a = new AudioSample({ data, format: 'f32-planar', numberOfChannels: 2, sampleRate: sr, timestamp: outFrames / sr });
      try { await audioSource.add(a); } finally { a.close(); }
      outFrames += L.length;
    };
    for (const [s, e] of keeps) {
      const fs = Math.round(s * info.sampleRate), fe = Math.round(e * info.sampleRate);
      for await (const chunk of info.audio.chunks(s, e)) {
        if (signal.aborted) break;
        const srcSr = chunk.sampleRate, n = chunk.planes[0].length;
        const a0 = Math.round(chunk.timestamp * srcSr);
        const from = Math.max(a0, fs), to = Math.min(a0 + n, fe);
        if (to <= from) continue;
        const count = to - from, off = from - a0;
        const L = chunk.planes[0].slice(off, off + count);
        const R = (chunk.planes[1] || chunk.planes[0]).slice(off, off + count);
        // short fades at every cut edge so joins don't click
        if (fadeN > 0) for (let i = 0; i < count; i++) {
          const p = from + i, g = Math.min(1, (p - fs) / fadeN, (fe - p) / fadeN);
          if (g < 1) { L[i] *= g; R[i] *= g; }
        }
        let outL = L, outR = R;
        if (srcSr !== sr) { outL = resample(L, srcSr, sr); outR = resample(R, srcSr, sr); }
        await push(outL, outR);
        aDone = Math.min(totalOut, outFrames / sr); report();
      }
      if (signal.aborted) return;
      // keep audio locked to video: pad any missing samples at the end of each piece
      outStart += e - s;
      const target = Math.round(outStart * sr);
      while (outFrames < target) {
        const k = Math.min(4096, target - outFrames);
        await push(new Float32Array(k), new Float32Array(k));
      }
    }
    aDone = totalOut; report();
    audioSource.close();
  };

  try {
    await Promise.all([videoJob(), audioJob()]);
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    onProgress(1, 'Finishing');
    await output.finalize();
    return collector.blob();
  } catch (err) {
    if (output.state !== 'canceled' && output.state !== 'finalized') await output.cancel().catch(() => {});
    throw err;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function resample(x, from, to) {
  const n = Math.round((x.length * to) / from), y = new Float32Array(n), k = from / to;
  for (let i = 0; i < n; i++) {
    const p = i * k, j = Math.floor(p), f = p - j;
    y[i] = (x[j] ?? 0) * (1 - f) + (x[j + 1] ?? x[j] ?? 0) * f;
  }
  return y;
}
