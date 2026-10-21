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
