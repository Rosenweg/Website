#!/bin/bash
# Emulator headless starten/stoppen (als android). emulator.sh start|kalt|stopp
#   start = aus Schnappschuss "sauber" (gemessen 27.11.2026 auf pve2: ~21 s), Aenderungen verwerfen
#   kalt  = ohne Schnappschuss (gemessen: ~31 s bis boot_completed)
set -euo pipefail
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
  echo "bereit nach $((SECONDS - t0)) s"
}

case "${1:-start}" in
  start)
    laeuft && { echo "laeuft schon"; exit 0; }
    nohup emulator "${GEMEINSAM[@]}" -snapshot sauber -no-snapshot-save >"$LOG" 2>&1 </dev/null &
    warten ;;
  kalt)
    laeuft && { echo "laeuft schon"; exit 0; }
    nohup emulator "${GEMEINSAM[@]}" -no-snapshot-load >"$LOG" 2>&1 </dev/null &
    warten ;;
  stopp)
    laeuft || exit 0
    adb emu kill >/dev/null 2>&1 || true
    for _ in $(seq 30); do laeuft || exit 0; sleep 1; done
    pkill -u "$(id -u)" -f 'qemu-system-x86_64.*-avd dauertest' || true ;;
  *) echo "emulator.sh start|kalt|stopp"; exit 2 ;;
esac
