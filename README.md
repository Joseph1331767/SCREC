# SCREC
Tiny screen recorder bar. Image / Video buttons → drag an area → record. Pause, stop, then move the file where you want.

- Device audio (loopback) + mic (auto-picks devices labelled headset / wireless)
- Resolution: auto (selection size) or 720p–4K; scale-to-fit / stretch / fill
- Starts with Windows, tray icon, auto-updates from GitHub Releases

## Director hotkeys — hold `Ctrl+Alt+Shift`
Live, no freeze-frames. Effects are baked into the recording for viewers.

| Input | Effect |
|---|---|
| Move mouse | A viewport box (region ÷ zoom) follows the cursor — only you see it |
| + hold LMB | The recording zooms into the box (eased in/out) |
| + wheel | Change zoom amount (also in settings) |
| + arrows | Nudge the box |
| + hold RMB | Draw marks (color / style / size in settings) |
| + tap RMB | Attention beacon |
| + `1`–`9` | Baked playback speed: 1 = 0.25×, 5 = normal, 9 = 4× (rendered with ffmpeg on stop) |

## Dev
`npm i && npm start` · build installer: `npm run dist` · e2e test: `SCREC_SELFTEST=1 npm start`

## Release
Bump `version` in package.json, `npm run dist`, then upload `dist/latest.yml`, `SCREC-Setup-X.Y.Z.exe` and its `.blockmap` to a GitHub release tagged `vX.Y.Z`.
