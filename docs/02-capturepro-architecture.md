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

| Phase | Scope | Status |
|---|---|---|
| 1. Core recorder | App shell, settings, rectangle/fullscreen/window/game/audio-only modes, encoder auto-detection (NVENC/QSV/AMF/CPU), H.264/HEVC/AV1/MPEG-1/Xvid/MJPEG in MP4/AVI/MKV, presets, pause/resume, hotkeys, tray, output library, screenshots, file naming, own-window exclusion | **Done** |
| 2. Overlays | Webcam overlay (21 shapes, flip/rotate, border, chroma key, separate .webcam.mp4), click effects, highlight, keystrokes, drawing mode, countdown, logo, text | **Done** |
| 3. Automation | Auto-complete (time/size/silence and after-actions), timer, scheduled recording, auto-pause, push-to-talk, startup options, device recording, around-mouse following | **Done** |
| 4. Player, editor, AI | Built-in player, trim/export, repair tool, whisper.cpp transcription (.srt/.txt, burn-in), AI webcam background removal | Next |
| 5. Sharing and release | YouTube/Vimeo/Drive upload (needs your own OAuth client IDs), translations, installer and bundled FFmpeg | Planned |

Known differences from the reference product:
- There is no in-game FPS counter or FPS limiter, because both need code injection into games.
- Click effects and the webcam overlay are visible on screen while recording, because they are composited by the screen capture.
