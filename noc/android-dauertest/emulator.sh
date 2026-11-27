#!/bin/bash
# Emulator headless starten/stoppen (als android). emulator.sh start|kalt|stopp|neu
#   start = aus Schnappschuss "dauer", sonst "sauber" (gemessen 27.11.2026 auf pve2: 8-21 s);
#           stopp sichert den Stand als "dauer". So bleiben Anmeldungen der Apps (Konto apptest, Refresh-Token)
#           von Lauf zu Lauf erhalten - Apps ohne Anmeldung installiert lauf.sh frisch.
#   kalt  = ohne Schnappschuss (~31 s bis boot_completed); stopp sichert danach "dauer"
#   neu   = "dauer" verwerfen und vom Schnappschuss "sauber" (frisch, nichts installiert) neu
set -euo pipefail
exec </dev/null   # adb/emulator lesen sonst stdin des Aufrufers (z. B. bash -s)
export ANDROID_HOME=$HOME/android-sdk
PATH=$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH
LOG=$HOME/emulator.log
GEMEINSAM=(-avd dauertest -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -accel on -cores 3)

laeuft() { pgrep -u "$(id -u)" -f 'qemu-system-x86_64.*-avd dauertest' >/dev/null; }

warten() {
  local t0=$SECONDS
  timeout 180 adb wait-for-device
  until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; do
    [ $((SECONDS - t0)) -gt 240 ] && { echo "Emulator bootet nicht (Log: $LOG)"; return 1; }
    sleep 1
  done
  adb shell settings put global window_animation_scale 0
  adb shell settings put global transition_animation_scale 0
  adb shell settings put global animator_duration_scale 0
  adb shell svc power stayon true
  # Chrome ohne Erststart-Dialoge (Kontoanmeldung im Browser, flows/anmelden.yaml)
  adb shell 'echo "_ --disable-fre --no-default-browser-check --no-first-run" > /data/local/tmp/chrome-command-line'
  adb shell am set-debug-app --persistent com.android.chrome >/dev/null
  echo "bereit nach $((SECONDS - t0)) s"
}

case "${1:-start}" in
  start)
    laeuft && { echo "laeuft schon"; exit 0; }
    # "dauer" = Stand des letzten Laufs (stopp sichert ihn), sonst der saubere Grundstand
    snap=sauber; [ -d "$HOME/.android/avd/dauertest.avd/snapshots/dauer" ] && snap=dauer
    nohup emulator "${GEMEINSAM[@]}" -snapshot "$snap" -no-snapshot-save >"$LOG" 2>&1 </dev/null &
    warten ;;
  kalt)
    laeuft && { echo "laeuft schon"; exit 0; }
    nohup emulator "${GEMEINSAM[@]}" -no-snapshot-load -no-snapshot-save >"$LOG" 2>&1 </dev/null &
    warten ;;
  neu)
    "$0" stopp
    rm -rf "$HOME/.android/avd/dauertest.avd/snapshots/dauer"
    echo "dauer verworfen - naechster Start vom Schnappschuss sauber" ;;
  stopp)
    laeuft || exit 0
    # Stand sichern (Anmeldungen der Apps); ohne Erfolg bleibt der vorige "dauer"
    timeout 120 adb emu avd snapshot save dauer >/dev/null 2>&1 || echo "Schnappschuss dauer nicht gesichert"
    adb emu kill >/dev/null 2>&1 || true
    for _ in $(seq 30); do laeuft || exit 0; sleep 1; done
    pkill -u "$(id -u)" -f 'qemu-system-x86_64.*-avd dauertest' || true ;;
  *) echo "emulator.sh start|kalt|stopp|neu"; exit 2 ;;
esac
