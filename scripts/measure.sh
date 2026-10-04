#!/bin/bash
# Usage: scripts/measure.sh <label> <steps> [VAR=value ...]
#
# Runs the SCREC end-to-end selftest with REAL OS-level input injection (keybd_event/mouse_event) while a page plays
# in a separate Chrome profile underneath the recorded region, then prints the per-second mean luminance (0-255) of the
# video area of the resulting mp4 and a verdict.
#
#   steps    comma list from: lmb,wheel,arrow,draw,beacon,digits,none   ('none' = hold the chord only, do nothing else)
#   env      CHROMEURL   page to play (default: YouTube Big Buck Bunny; local pattern:
#                        C:/Users/Drope/AppData/Local/Temp/pb/bright.mp4 -- mean ~131 when healthy)
#            SCREC_NOCHORD=1  (selftest) skip holding the chord entirely = control run
#            any other VAR=value pairs given as extra args are exported for the app (e.g. SCREC_NOCHORD=1)
#
# Verdict (meaningful for steps=none / nochord, where nothing should change the picture):
#   GLITCH  if any sample after the 4th second is >=225 (video area went white) or <=25 (black)
#   OK      otherwise
# For steps with zoom/draw the area legitimately changes -- inspect frames visually instead.
#
# WARNING: takes over keyboard + mouse for ~60-80s. Never run two of these at once. ~1 min per run.
label=$1; steps=$2; shift 2
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1
powershell -NoProfile -File "$(cygpath -w "$ROOT/scripts/killchrome.ps1")" >/dev/null 2>&1; sleep 2
rm -rf ~/Videos/SCREC
URL="${CHROMEURL:-https://www.youtube.com/watch?v=aqz-KE-bpKQ}"
env "$@" SCREC_SELFTEST=1 SCREC_SELFTEST_REAL=1 SCREC_STEPS="$steps" SCREC_SELFTEST_CHROME="$URL" timeout 170 npx electron . >"$ROOT/.measure.log" 2>&1
FF="$ROOT/node_modules/ffmpeg-static/ffmpeg.exe"
OUT=$(ls ~/Videos/SCREC/*.mp4 2>/dev/null | head -1)
if [ -z "$OUT" ]; then echo "RESULT $label ERROR no mp4 produced (see .measure.log)"; exit 2; fi
SAMPLES=$("$FF" -v error -i "$OUT" -vf "fps=1,crop=700:350:100:60,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-" -f null - 2>&1 | grep YAVG | sed 's/.*YAVG=//;s/\..*//' | tr '\n' ' ')
VERDICT=OK; i=0
for v in $SAMPLES; do i=$((i+1)); if [ $i -gt 4 ] && { [ "$v" -ge 225 ] || [ "$v" -le 25 ]; }; then VERDICT=GLITCH; fi; done
echo "RESULT $label [$VERDICT] $SAMPLES"
