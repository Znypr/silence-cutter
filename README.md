# Silence Cutter

**Open on your phone: https://znypr.github.io/silence-cutter/** then "Add to Home screen" (Chrome menu / Safari Share). Works offline after the first visit.

Phone web app (PWA): pick a video, it finds the dead silences, you tweak and preview, then export an upload-ready MP4. Everything runs on the phone; the video is never uploaded anywhere.

## Use
- **Trim settings**: silence threshold (with a curve showing how much each threshold would remove, tap to pick), shortest pause to cut, padding left in each pause, delete leftover snippets under X s. Presets Gentle / Normal / Tight.
- **Timeline**: green = speech, amber = kept pause (padding), red = removed, dashed = threshold. Tap a piece to select it: cut/keep it, nudge its edges (±0.1 s / ±1 frame), Undo.
- **Hear a cut**: zoomed waveform around one join; play it trimmed vs original, step through every cut.
- **Preview**: Trimmed / Original toggle on the main player.
- **Export**: H.264 High + AAC-LC stereo 192k, constant frame rate (variable-frame-rate phone video is conformed), 8-bit SDR (HDR converted), rotation baked in, keyframe every 2 s, fast-start MP4. Bitrate at YouTube's recommended upload spec (4K30 45 Mbps, 4K60 68, 1080p30 12...). 5-10 ms audio fades at each join. Then Share (straight to TikTok/YouTube/gallery) or Download.

## Tech
- [Mediabunny](https://mediabunny.dev) (MPL-2.0, vendored in `vendor/`) over WebCodecs: hardware decode/encode, streams the file instead of loading it, so 4K and long clips work. AAC wasm fallback for browsers without a native AAC encoder. AAC *decode* fallback (`audio-source.js`): when WebCodecs can't decode the audio (common on phones), packets are wrapped as ADTS and decoded in 30 s chunks with Web Audio `decodeAudioData`; verified bit-identical to the native path. Test it on desktop with `?aacfallback`.
- Needs a secure page (https or localhost) and Chrome (Android) / Safari 16.4+ (iPhone).
- Files: `index.html`, `style.css`, `app.js` (detection, timeline, preview), `export.js` (encode), `sw.js` (offline), `manifest.webmanifest`, icons (`make_icons.py`).

## Updating
This folder is the git working copy of https://github.com/Znypr/silence-cutter (GitHub Pages serves `main`). Bump `CACHE` in `sw.js` when shipping so phones pick up the new version.

## Run on the PC
`python apps/silence-cutter/serve.py` then open http://localhost:8811 (launch config `silence-cutter`).

## Tested (2026-11-24, desktop Chrome, phone-size viewport)
- 4K 2160x3840 rotated H.264: detection correct, export 8 s of 4K in 4 s, High@5.1 yuv420p CFR 30, rotation baked, moov first, 0 decode errors, joins land exactly with planned padding.
- 1080p HEVC 10-bit HLG, 20->30 fps variable: exported as SDR H.264 constant 30 fps, mono 44.1k -> stereo, 0 decode errors.
- Not yet tested on a real phone.
