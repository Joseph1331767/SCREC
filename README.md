# SCREC
Tiny screen recorder bar. Image / Video buttons → drag an area → record. Pause, stop, then move the file where you want.

- Device audio (loopback) + mic (auto-picks devices labelled headset / wireless)
- Resolution: auto (selection size) or 720p–4K; scale-to-fit / stretch / fill
- Starts with Windows, tray icon, auto-updates from GitHub Releases

## Director hotkeys — hold `Alt+Shift` (configurable in settings)
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

### Input handling (safe to use next to games and browsers)
- Keys, mouse buttons and the wheel are **swallowed only while `Ctrl+Alt+Shift` is held** (arrows, `1`-`9`, all mouse buttons, wheel). When the chord is not held SCREC passes every input straight through and puts nothing over the screen.
- This is done with in-process Windows low-level hooks (via `koffi`), no helper executable. The mouse hook exists only while the chord is held.
- Safety nets: the real keyboard state is polled while the chord is held, so a lost key-up (UAC, Win+L, Ctrl+Alt+Del) releases the chord within ~0.3 s instead of leaving the mouse swallowed. A key or button is always swallowed or passed as a whole press, so nothing sticks in the app underneath.
- With "Director hotkeys" switched off in settings nothing is ever swallowed and no overlay is shown (the keyboard hook is then a pure pass-through listener).
- Chrome / YouTube: the aim-box overlay is a single click-through, capture-excluded window, so playing video (hardware-decoded YouTube etc.) is not covered or blanked while you hold the chord, and it never appears in the recording.

## Dev
`npm i && npm start` · build installer: `npm run dist` · e2e test: `SCREC_SELFTEST=1 npm start`

Capture-glitch regression test (real keyboard/mouse injection, takes over input for ~1 min, run one at a time): `bash scripts/measure.sh <label> <steps> [VAR=val ...]`. It records a Chrome-hosted video (YouTube by default, `CHROMEURL=` for a local file) while the chord is held and prints the per-second luminance of the recording plus an OK/GLITCH verdict. `steps=none` holds the chord only; `SCREC_NOCHORD=1` is the control run. See the header of `scripts/measure.sh`.

## Release
Bump `version` in package.json, `npm run dist`, then upload `dist/latest.yml`, `SCREC-Setup-X.Y.Z.exe` and its `.blockmap` to a GitHub release tagged `vX.Y.Z`.

> **Why not Ctrl+Alt+Shift?** On at least one PC, holding all three modifiers makes screen capture return black frames (the real screen is fine) even with SCREC not involved. Any two of them are fine, so the default is Alt+Shift; Ctrl+Alt and Ctrl+Shift are available too.
