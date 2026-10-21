# CapturePro — Architecture and Roadmap

CapturePro is a clean-room, feature-equivalent rebuild of the behaviour documented in
[01-bandicam-reverse-engineering.md](01-bandicam-reverse-engineering.md). It has its own name, UI, sounds and assets.

## How each Bandicam component maps to ours

| Bandicam component (observed) | CapturePro equivalent |
|---|---|
| `bdcam.exe` UI (MFC + skin) | Electron main process + HTML/CSS renderer (`src/renderer/main`) |
| `bdcap64.dll` capture + encoder core | `ffmpeg.exe` child process driven by `src/main/recorder.js` |
| DXGI Duplication ("Method 1") | FFmpeg `ddagrab` |
| `encap64.dll` Windows.Graphics.Capture ("Method 2") | FFmpeg `gfxcapture` (also used for Specific window and Game mode) |
| NVENC / QSV / AMF / CPU H.264, HEVC, AV1 | FFmpeg `*_nvenc`, `*_qsv`, `*_amf`, `libx264/libx265/libsvtav1`, probed at startup |
| MPEG-1, Xvid, MJPEG | `mpeg1video`, `mpeg4` (tag `XVID`), `mjpeg` |
| WASAPI speaker loopback + mic, mixing, mono, noise suppression | Hidden audio-engine renderer: Chromium loopback + `getUserMedia` with a WebAudio graph, streaming PCM over named pipes |
| `bdcamih.dll` global input hook | `native/CaptureProHelper.exe` (C#, `SetWindowsHookEx` LL hooks), streaming JSON over stdio |
| Click effects, keystrokes, drawing, countdown | Click-through, transparent, topmost overlay window that the screen capture records |
| Webcam overlay (shapes, chroma key, background) | Frameless, shaped, topmost webcam window (canvas/WebGL) |
| Logo and text overlay | FFmpeg `overlay` + `drawtext` filters (burned into the video only) |
| "Exclude Bandicam windows from recording" | `BrowserWindow.setContentProtection(true)`, i.e. `WDA_EXCLUDEFROMCAPTURE` |
| `bdcam64.dll` DirectX/GL/Vulkan injection | **Not replicated.** Game mode captures the foreground game window through WGC. There's no in-game FPS counter or FPS limiter, because those need code injection. |
| BandiFix | Recordings are written as crash-safe MKV segments and remuxed on stop; a repair tool remuxes leftovers or damaged files |
| whisper.cpp local transcription | whisper.cpp CLI + ggml models downloaded on demand (phase 4) |
| Upload to YouTube / Vimeo / Drive | OAuth with user-supplied client IDs (phase 5) |
| Licensing, watermark, 5-minute limit, AI credits | Out of scope. That's Bandicam's business model, not product behaviour. |

## Recording pipeline

```
mode + settings ──► capture-args.js ──► ffmpeg (segment N, .mkv)
                                          ▲ video: ddagrab | gfxcapture | dshow
                                          ▲ audio: \\.\pipe\capturepro-<id>-a{1,2}  (f32le 48 kHz stereo)
                                          ▲ filters: crop/scale, logo overlay, drawtext
pause  = gracefully end segment ('q' on stdin)        resume = start segment N+1
stop   = concat segments (-c copy) ──► final .mp4/.avi/.mkv  (+ separate .1.wav/.2.wav if enabled)
```

## Roadmap
1. **Core recorder**: app shell, settings, all screen modes, audio-only, encoder detection, codecs and presets, pause/resume, hotkeys, tray, outputs list, image capture, file naming.
2. **Overlays**: webcam PIP (shapes, flip/rotate, border, chroma key), click/highlight effects, keystrokes, drawing mode, countdown, logo and text.
3. **Automation**: auto-complete (time/size/silence + after-actions), timer and scheduled recording, auto-pause on idle, push-to-talk, startup options.
4. **Player, editor and AI**: built-in player, trim/export, repair tool, whisper transcription (.srt/.txt, burn-in), background removal.
5. **Sharing and extras**: YouTube/Vimeo/Drive upload, device recording extras (deinterlace/zoom), translations.
