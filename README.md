# CapturePro

A Windows screen, game, webcam and audio recorder. It is a clean-room, feature-equivalent rebuild of the behaviour documented in [docs/01-bandicam-reverse-engineering.md](docs/01-bandicam-reverse-engineering.md). The architecture and roadmap are in [docs/02-capturepro-architecture.md](docs/02-capturepro-architecture.md).

## Requirements
- Windows 10 2004 or later (Windows 11 recommended)
- Node.js 20 or later
- FFmpeg 8 or later on `PATH` (`winget install Gyan.FFmpeg`). Capture uses its `gfxcapture`, `ddagrab` and `zmq` filters.
- The .NET Framework 4.x C# compiler that ships with Windows (used to build `native/CaptureProHelper.exe`)

## Run
```
npm install
npm start
```
`npm start` compiles the native helper if needed and launches the app with a clean Electron environment.

## Test
```
npm test          # unit tests (codec/argument builders, naming, scheduler, device transcode) + a real capture integration test
npm run test:e2e  # drives the real UI with Playwright; uses a fake camera/microphone, never your real devices
```
The E2E tests record your screen for a few seconds and inject harmless input: a click on CapturePro's own title bar and the F13 key.

## Default hotkeys
| Action | Key |
|---|---|
| Record / Stop | F12 |
| Pause / Resume | Shift+F12 |
| Capture image | F11 |
| Drawing mode | Ctrl+Alt+D |
| Show/hide capture frame | Ctrl+Alt+H |

## Build the Windows installer
```
npm run dist
```
This produces `dist/CapturePro-Setup-<version>.exe` (an installer with Start-menu and desktop shortcuts and a choice of install folder) and `dist/CapturePro-Portable-<version>.exe` (runs without installing). Both bundle FFmpeg and the native helper, so the target PC needs nothing else installed.

The builds are not code-signed, so Windows SmartScreen shows "Windows protected your PC" on first run (More info → Run anyway). Signing with a code-signing certificate removes that warning.

FFmpeg is GPL-licensed. Its license ships in `resources/ffmpeg/LICENSE.txt`.

## macOS
CapturePro also runs on macOS 11 or later, on both Apple-silicon and Intel Macs.

**Download:** every push to `main` builds the Mac version on GitHub (Actions → "Build macOS" → artifact **CapturePro-macOS**). Pushing a tag such as `v0.1.0` also publishes the files as a GitHub Release.
- `CapturePro-<version>-mac-arm64.dmg` — Apple-silicon Macs (M1–M4)
- `CapturePro-<version>-mac-x64.dmg` — Intel Macs

**Install:** open the `.dmg` and drag CapturePro into Applications. The app is not notarized by Apple, so the first launch is blocked: open System Settings → Privacy & Security and click **Open Anyway** (on older macOS, right-click the app → Open).

**Permissions** (macOS asks for them on first use; restart CapturePro after granting):
| Permission | Needed for |
|---|---|
| Screen Recording | recording the screen, window titles |
| Microphone / Camera | microphone, webcam overlay, device recording |
| Input Monitoring | hotkeys, click effects, keystroke overlay |

**Recording computer sound:** macOS does not let apps capture system audio directly. Install the free [BlackHole 2ch](https://github.com/ExistentialAudio/BlackHole) (`brew install blackhole-2ch`). Then, in Audio MIDI Setup, create a **Multi-Output Device** containing your speakers and BlackHole, and select it as the sound output. CapturePro records from BlackHole automatically.

**Differences from Windows:**
- Window and Game modes record the window's area of the screen, so keep the window in front.
- "All displays" records the main display.
- Hardware encoding uses Apple VideoToolbox (H.264 and HEVC).

**Build on a Mac:** `npm ci && npm run dist:mac`. This needs Xcode command-line tools (`xcode-select --install`).
