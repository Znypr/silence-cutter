// Audio reading with a fallback for browsers whose WebCodecs can't decode the track (often AAC on phones).
// Native path: Mediabunny AudioSampleSink. Fallback: wrap the AAC packets as ADTS frames and decode them
// with Web Audio's decodeAudioData (uses the phone's own media decoder), in chunks to keep memory low.
import { AudioSampleSink, EncodedPacketSink } from 'mediabunny';

const CHUNK_S = 30;       // seconds decoded per fallback chunk
const PREROLL_PKTS = 3;   // extra packets decoded before each chunk and thrown away (decoder warm-up)
const FORCE_FALLBACK = new URLSearchParams(location.search).has('aacfallback'); // for testing

// Yields { timestamp, sampleRate, planes: Float32Array[] } covering [start, end).
export async function makeAudioReader(track) {
  const codec = await track.getCodec();
  if (!FORCE_FALLBACK && (await track.canDecode())) return nativeReader(track);
  if (codec !== 'aac') throw new Error(`This phone can't decode the audio (${codec}).`);
  const reader = await adtsReader(track);
  reader.fallback = true;
  return reader;
}

function nativeReader(track) {
  return {
    fallback: false,
    async *chunks(start, end) {
      const sink = new AudioSampleSink(track);
      for await (const s of sink.samples(start, end)) {
        const planes = [];
        for (let c = 0; c < s.numberOfChannels; c++) {
          const p = new Float32Array(s.numberOfFrames);
          s.copyTo(p, { planeIndex: c, format: 'f32-planar' });
          planes.push(p);
        }
        const out = { timestamp: s.timestamp, sampleRate: s.sampleRate, planes };
        s.close();
        yield out;
      }
    },
  };
}

// AudioSpecificConfig -> what an ADTS header needs
function parseAsc(bytes) {
  let bit = 0;
  const read = (n) => { let v = 0; for (let i = 0; i < n; i++, bit++) v = (v << 1) | ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1); return v; };
  let obj = read(5); if (obj === 31) obj = 32 + read(6);
  let freqIdx = read(4); if (freqIdx === 15) { read(24); freqIdx = 3; }
  const chan = read(4);
  if (obj === 5 || obj === 29) { // HE-AAC: ADTS carries the AAC-LC core, SBR/PS are detected implicitly
    let ext = read(4); if (ext === 15) read(24);
    obj = read(5);
  }
  return { profile: Math.max(1, Math.min(4, obj)) - 1, freqIdx, chan };
}

async function adtsReader(track) {
  const cfg = await track.getDecoderConfig();
  const desc = cfg?.description;
  if (!desc) throw new Error("This phone can't decode the audio (aac, no config).");
  const asc = parseAsc(desc instanceof ArrayBuffer ? new Uint8Array(desc) : new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength));
  const sampleRate = await track.getSampleRate();
  const channels = await track.getNumberOfChannels();
  const sink = new EncodedPacketSink(track);
  const ctx = new OfflineAudioContext({ numberOfChannels: Math.max(1, Math.min(2, channels)), length: 1, sampleRate });

  const header = (len) => {
    const L = len + 7;
    return new Uint8Array([
      0xff, 0xf1,
      (asc.profile << 6) | (asc.freqIdx << 2) | (asc.chan >> 2),
      ((asc.chan & 3) << 6) | (L >> 11),
      (L >> 3) & 0xff,
      ((L & 7) << 5) | 0x1f,
      0xfc,
    ]);
  };

  return {
    async *chunks(start, end) {
      for (let t = start; t < end - 1e-6; t += CHUNK_S) {
        const tEnd = Math.min(end, t + CHUNK_S);
        // collect packets from a little before t to just past tEnd
        let first = await sink.getPacket(t);
        if (!first) first = await sink.getFirstPacket();
        if (!first) return;
        for (let i = 0; i < PREROLL_PKTS; i++) {
          let prev = null;
          // walk back one packet (getPacket returns the last packet at or before a time)
          prev = await sink.getPacket(first.timestamp - 1e-6);
          if (!prev) break; first = prev;
        }
        const parts = []; let firstTs = null, size = 0;
        for await (const p of sink.packets(first)) {
          if (firstTs === null) firstTs = p.timestamp;
          const h = header(p.data.length); parts.push(h, p.data); size += h.length + p.data.length;
          if (p.timestamp >= tEnd + 0.05) break;
        }
        if (!parts.length) return;
        const buf = new Uint8Array(size); let o = 0;
        for (const part of parts) { buf.set(part, o); o += part.length; }
        const ab = await ctx.decodeAudioData(buf.buffer);
        // sample 0 of the decoded buffer = first packet's timestamp
        const i0 = Math.max(0, Math.round((t - firstTs) * sampleRate));
        const i1 = Math.min(ab.length, Math.round((tEnd - firstTs) * sampleRate));
        if (i1 <= i0) continue;
        const planes = [];
        for (let c = 0; c < ab.numberOfChannels; c++) planes.push(ab.getChannelData(c).slice(i0, i1));
        yield { timestamp: firstTs + i0 / sampleRate, sampleRate, planes };
      }
    },
  };
}
