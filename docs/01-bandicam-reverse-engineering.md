# Bandicam 2027 — Reverse-Engineering Findings

Target: `bdcamsetup.exe` — "Bandicam 2027 Setup File", v27.0.7.2687, build date 2026-10-15
SHA-256 `C9FAB702F00DC71BFD07C54BF04E8135423479D17BE51A78B53CBCDD95CF8133`, Authenticode valid (Bandicam Company Corp., Seoul, KR).

## Method and evidence boundaries

Everything here comes from **static** analysis. Nothing was installed and the program was never run.

| Source | What it gives | Confidence |
|---|---|---|
| NSIS payload extracted with 7-Zip (154 files, 238 MB) | File layout, components, assets | Observed |
| `lang/English.ini` (2,133 lines: `[TEXT]`, `[SKIN]`, `[DIALOG]`, `[MENU]`) | Every UI string, so effectively the complete feature surface | Observed |
| PE import/export tables of every binary | Which OS APIs each component uses | Observed |
| ASCII/UTF-16 strings and MSVC RTTI class names | Codec names, file patterns, internal class model, endpoints | Observed (strings) / Inferred (behaviour) |
| `THIRD_PARTY_NOTICES.txt` | Embedded libraries | Observed |

**Limitation:** `bdcam.exe` (main UI) and `bdcap64/32.dll` (capture and encode core) are packed with **Themida/WinLicense**. They have `.themida`/`.boot` sections, one stub import per DLL, and `Software\WinLicense` keys. Their code can't be disassembled statically, so the internal algorithms are **not** observed. This document describes *what* the product does and *which OS facilities* it relies on, not their exact code. The helper DLLs are unprotected.

## Architecture (observed components)

```
bdcam.exe (UI, MFC + custom skin "data/skin.dat", D2D/DWrite, Themida)
 ├─ bdcap64.dll  CreateBandiCapture / CreateCoreInterface / CreateDrawEffect
 │     IBandiCapture → IBandiEncproc → IBandiMuxer{Avi,Mp4,Mp3,Wav,Mpeg} → IBandiWriter
 │     Encoders: x86 CPU H.264 (Intel IPP), NVENC API, Intel Media SDK (MFX*), AMD AMF, VfW (external codecs)
 │     Audio: WASAPI/DirectSound/waveIn, AAC/MP3/MP2/PCM
 ├─ encap64.dll  Encap_CreateCapture: Windows.Graphics.Capture (GraphicsCaptureItem,
 │                Direct3D11CaptureFramePool, DispatcherQueue) = "Enhanced capture Method 2 (Win10+)"
 ├─ bdcam64.dll / bdcam32.dll   Game hook injected into target processes. Hooks D3D9/10/11/12,
 │                DDraw, OpenGL (wglSwapBuffers), DXGI Present; shared memory section ".hkshare";
 │                draws FPS overlay, limits FPS, copies back-buffer. (MinHook in notices)
 ├─ bdcam32.bin   32-bit helper, used to inject into 32-bit games
 ├─ bdcamvk64/32.dll   Vulkan implicit layer "VK_LAYER_bandicam_helper", registered via RegVulkanLayer.bat
 ├─ bdcamih.dll   Global input hook (SetWindowsHookEx/CallNextHookEx): mouse clicks + keystrokes
 ├─ bdapi.dll     WinINet HTTPS + CryptoAPI signature verify: licence, update, entitlement
 ├─ whisper.dll + ggml-{base,cpu,vulkan}-whisper.dll   Local AI transcription (whisper.cpp)
 ├─ onnxruntime.dll + DirectML.dll + data/bg/model.dat  Webcam background removal (U-2-Net)
 ├─ WebView2Loader.dll   Embedded web UI (account pages, AI HTML results)
 └─ bdfix.exe     "BandiFix": corrupt AVI/MP4 recovery (CBandiParserMp4)
```

Assets: 31 virtual backgrounds (`data/bg/bg1..31.jpg`), click/highlight effect sprite sheets (`data/effects/*.dat` at 10/15/20/30 sizes), sounds (`start/stop/camera/lclick/rclick.wav`), a cursor PNG, and 50+ UI languages. These are Bandicam's copyrighted assets. **Do not reuse them.**

Embedded third-party code (from notices): ggml/whisper.cpp, JsonCpp, `half`, AMD AMF, Khronos/Vulkan SDK, U-2-Net, ONNX Runtime, zlib, libpng, libjpeg, MinHook, Zstandard, RSA MD5, MS runtime.

## Feature inventory

### 1. Recording modes
- **Screen – Rectangle area**: movable/resizable capture frame, control bar (move up/down), keyboard nudge (arrows, Shift+arrows resize), fit to 4:3/16:9, custom size (Ctrl+U), size presets (add/edit/rename/reorder, Shift+R-click), recently used size (Ctrl+S), "Select a recording area" window-snap (Ctrl+F), opacity, always-on-top, show/hide (Ctrl+Alt+H), copy to clipboard (Ctrl+C).
- **Screen – Fullscreen**: Display 1–8 or All displays; option to always show or hide the control bar.
- **Screen – Specific window**: records a window even when covered; can select a sub-area of that window; can capture audio **only from that window's process**.
- **Screen – Around mouse**: capture area follows the cursor, custom size.
- **Game recording**: DirectX/OpenGL/Vulkan hook. Shows a green FPS counter in the game (red while recording); "Waiting for a game".
- **Device recording**: webcam, HDMI capture cards, Xbox/PlayStation, IPTV. Options for device, format, video and audio input, deinterlacing (odd/even/blend), rotate, flip, zoom 25/50/100/200 %, aspect ratio, fullscreen preview.
- **Audio-only**: computer sound and/or microphone, to MP3/WAV.

### 2. Recording control
- Record/Stop, Pause, **Cancel** recording, image capture, mute speaker or mic. All are hotkey-configurable, and duplicate hotkeys are detected.
- Status bar: state (Ready/Recording/Pause), elapsed time, file size / free disk space, volume meter.
- Countdown timer 1–10 s before recording starts.
- **Auto-Pause Recording** after 5–60 s of user inactivity.
- Hide the main window during recording; exclude Bandicam's own windows from capture.
- Start and stop sound effects.
- Open the video player after recording.
- Disk-full auto-stop. If the target window stops responding, Bandicam offers to force-stop.
- Recording priority: Normal / High / Highest.
- "Skip recording while frame is not updated" (Game mode).
- Enhanced capture: Auto / Method 1 (DXGI Desktop Duplication, Win8+) / Method 2 (Windows.Graphics.Capture, Win10+).

### 3. Automation
- **Auto Complete Recording**: stop by time (h:m:s), by file size (MB/GB), or by silence duration, with an optional "silent state" warning popup and countdown. After it stops: do nothing / start a new recording / exit / shut down / hibernate (with a shutdown countdown dialog).
- **Timer Recording**: start in N minutes (1–1440) or at a set time; can minimise to tray.
- **Scheduled Recording** list: name, active flag, one-time/daily/weekly (choose days), start and end time or duration (crossing midnight: "Day after"), target (last used / fullscreen display N / rectangle), after-recording action, overlap detection, status (Waiting/Recording/Passed/Inactive). The free version limits the number of schedules.
- Run on Windows startup, start minimised to tray, start fullscreen recording on startup.

### 4. Video overlays and effects (Recording settings pages: Sound · Webcam · Logo · Mouse · Keystroke · Text · Options)
- **Webcam overlay (PIP)**: device and format, size, X/Y position, preset positions, flip, rotate 90/180/270, border (solid or faded, N px). Shapes: original, square, rounded square, rect 4:3/3:4, rounded rect, circle, ellipse 4:3/3:4, star, 10-point star, heart, pentagon, hexagon, flat hexagon, arched top, diamond, clover, squircle. Background: original / blur / blur more / transparent / custom image / 31 presets (AI segmentation) / **chroma key** (colour, similarity, blend). Webcam preview on screen with a toggle hotkey and a maximise hotkey. "Save webcam recording as MP4" writes a separate `<name>.webcam.mp4`.
- **Logo overlay**: PNG, opacity, position, L/R and T/B margins. Separate setting for images.
- **Mouse**: show cursor and cursor size; click effect (size, left and right colours); highlight effect (size, colour, opacity); click sounds (left/right); preview.
- **Keystroke overlay**: Screen mode only; small/medium/large size, position.
- **Text overlay**: up to 10 items. Font, size, margin, alpha, colour, shadow, outline, timestamp, text macros (date, time…).
- **Real-time drawing** (Ctrl+Alt+D): cursor (no drawing), whiteboard (fill background), pen, highlighter, line, arrow, box, ellipse, numbering, text, eraser, clear all, colour, line width, undo/redo. Each tool has a hotkey.
- **Blur region** (add/remove blur effect on the capture frame).
- Show FPS in captured video (Game mode).

### 5. Audio
- Primary device (speakers, i.e. loopback) and Secondary device (microphone), each with volume, mono, and a filter.
- Filters: Convert to Mono, **Noise Suppression** (Off/Low/Medium/High).
- Mix both into one track, or keep separate tracks.
- "Save audio tracks while recording" also writes separate `.1.wav`/`.2.wav` (or `.mp3`) files.
- Push-To-Talk / Push-To-Mute hotkey.
- Save as original PCM (multi-channel, 96 kHz+).
- Per-process audio capture (window mode).
- Errors handled: device invalidated mid-recording; no device selected.

### 6. Output formats and encoding
- Containers: **MP4**, **AVI**. Audio-only: **MP3**, **WAV**. Images: **BMP, PNG, JPG** (normal, high, custom 20–100).
- Video codecs: **H.264 / HEVC / AV1** on CPU, NVIDIA NVENC (also CUDA H.264), Intel Quick Sync, or AMD VCE/VCN; plus **MPEG-1**, **Xvid** (MPEG-4 ASP), **Motion JPEG**, and **external VfW codecs** (FourCC, quality, data rate, keyframe interval, prefer RGB, configure/about).
- Per-codec settings: VBR (quality) or CBR (bitrate), optimisation (speed/balanced/size), keyframe interval, colourspace, GPU device, GPU or GPU+CPU, profile.
- Size: full / half / fit width / fit height / custom. FPS with **CFR or VFR** mode. Quality or bitrate.
- Audio codecs: AAC, MP3, MP2, PCM. Channels stereo/mono, frequency, bitrate.
- Presets: Default, Half Size, HEVC/H.264 60 fps (QSV/NVENC/CUDA/AMD), Ultrafast 60 fps, Low-end PC, YouTube 360p/480p/720p/1080p, smartphone, editing (Vegas/Premiere), PowerPoint, Fit Width 320/640/800/1280, plus user presets (add/edit/rename/reorder).
- Hardware encoder auto-detect pop-ups ("NVENC available", "QSV available"). If the codec fails to initialise, Bandicam offers to retry with H.264 (CPU).

### 7. Image capture
Hotkey; repeat capture every N seconds; show cursor; logo overlay; shutter sound; copy to clipboard.

### 8. Game mode specifics
- FPS overlay: show/hide hotkey, position hotkey (cycles corners).
- FPS limit with hotkey, optionally only while capturing.
- Hooking targets: OpenGL, DirectDraw, DX7/8/9/10/11/12, Vulkan, UWP apps. Options to disable DX10/11 hooking in browsers and to block DirectX video overlay. Blocked-process list.
- Run as admin: never / always / only for Game mode (restart with the new privilege).

### 9. Output management (Home → Videos / Images / Audios)
- Thumbnail list; sort by date/name/size; play, open, edit, rename (F2), delete (Del), select all, open folder.
- Output folder; auto subfolder by target name, by type (Videos/Images/Audios), or by date (YYYY-MM-DD); write caching.
- File naming: prefix (target name / custom / none) and suffix (date-time / sequence number), with a live example.

### 10. Built-in player and editor (2027)
- Player: play/pause/stop, fullscreen, maximise, media info, right-hand panel.
- **Edit mode**: trim/cut ranges, export (hardware or CPU encoder, falls back to CPU), "Basic edit" vs "High-speed lossless edit" (Bandicut).
- **Smart Zoom**: generates zoom metadata, then applies it on export. Inferred to auto-zoom around clicks and cursor.
- Burned-in subtitles on export.

### 11. AI transcription and AI tools
- Local: whisper.cpp models tiny/base/small/medium/large-v3-turbo plus Silero VAD, downloaded on demand. Six stages: prepare model, extract audio, load model, VAD, detect language, transcribe. Model cache management.
- Cloud ("Bandicam AI", credit-based): standard or best quality, speaker diarization.
- Transcript panel: search, edit text, rename or correct speakers, delete or restore a speaker's dialogue, copy (selection/sentence/with time/all), save as .txt or .srt, show subtitles on video, undo/redo, reset edits.
- AI actions: translate subtitles (12 languages, keeps timing), summarise (short/medium/detailed; key points/chapters/meeting notes), create quiz (count, difficulty, type, explanations), **auto-edit** (remove silence/filler words/a speaker, keep N s padding), **create highlights** (target length).

### 12. Upload and sharing
YouTube (OAuth; public/unlisted/private), Vimeo, Google Drive (share link), and Facebook (disabled: "no longer available due to Facebook's policy"). At most 5 concurrent uploads. Shows link and embed code.

### 13. Utilities and app shell
- **BandiFix**: repair corrupt AVI/MP4. Bandicam offers this automatically if the last recording is corrupt.
- Simple/extended UI, DPI scaling, always on top, tray icon with balloon tips, 50+ languages (restart required), update checker (auto plus a major-update popup), safe mode, reset all settings, anonymous analytics opt-in.
- Licensing: free version allows 5 minutes per recording, and edited exports carry a watermark. Paid licences activate by email + serial or via a browser flow to a localhost callback; there are perpetual and subscription licences with PC limits, and a "My Bandicam Space" account with AI credits. *These describe Bandicam's own business model. They are not cloned.*

## Unknowns (not determinable statically)
- Exact default hotkeys and default settings values. These live inside the protected binary or registry defaults.
- Internal capture-timing, VFR and A/V sync algorithms, and the CPU H.264 implementation details.
- Smart Zoom heuristics.
- Bandicam AI server API contracts. They're proprietary, and out of scope for a clone anyway.
