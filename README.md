# SCREC
Tiny screen recorder bar. Image / Video buttons → drag an area → record. Pause, stop, then move the file where you want.

- Device audio (loopback) + mic (auto-picks devices labelled headset / wireless)
- Resolution: auto (selection size) or 720p–4K; scale-to-fit / stretch / fill
- **Zoom:** hold `Ctrl+Alt+Shift`, then hold left mouse → 2× zoom around the cursor (also baked into recordings)
- Starts with Windows, tray icon, auto-updates from GitHub Releases

## Dev
`npm i && npm start` · build installer: `npm run dist`

## Release
Bump `version` in package.json, then `npm run release` (needs `GH_TOKEN`), or upload `dist/latest.yml`, the Setup exe and `.blockmap` to a GitHub release tagged `vX.Y.Z`.
