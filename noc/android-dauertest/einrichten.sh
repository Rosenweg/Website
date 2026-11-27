#!/bin/bash
# Richtet den Dauertest-CT ein (im CT als root): Pakete, Benutzer android, Android-SDK,
# Maestro, AVD "dauertest" und Schnappschuss "sauber". Feste Versionen mit Pruefsumme
# (wie rosenweg-basis .github/workflows/beispiel.yml). Mehrfach ausfuehrbar.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive LC_ALL=C
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl unzip jq python3 \
  openjdk-21-jre-headless libgl1 libegl1 libnss3 libxcomposite1 libxcursor1 libxi6 libxtst6 \
  libxdamage1 libxrandr2 libxkbfile1 libxkbcommon0 libdbus-1-3 libasound2t64 libpulse0 \
  libx11-xcb1 libxcb-cursor0 libfontconfig1 libbsd0 >/dev/null
id android >/dev/null 2>&1 || useradd -m -s /bin/bash -G kvm android

HIER=$(cd "$(dirname "$0")" && pwd)
install -d -o android -g android /home/android/dauertest
cp -r "$HIER"/. /home/android/dauertest/ && chown -R android:android /home/android/dauertest

su - android -c 'bash -s' <<'EOF'
set -euo pipefail
export ANDROID_HOME=$HOME/android-sdk LC_ALL=C
CT=13114758; CT_SHA=7ec965280a073311c339e571cd5de778b9975026cfcbe79f2b1cdcb1e15317ee
MAESTRO=2.12.1; MAESTRO_SHA=54dbb0716425626604973cbb374c585ca30272375d9ce15177a1152765ddd9d7
BILD="system-images;android-35;google_apis;x86_64"

if [ ! -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]; then
  curl -fsSL -o /tmp/ct.zip "https://dl.google.com/android/repository/commandlinetools-linux-${CT}_latest.zip"
  echo "$CT_SHA  /tmp/ct.zip" | sha256sum -c -
  rm -rf /tmp/ct && unzip -q /tmp/ct.zip -d /tmp/ct
  mkdir -p "$ANDROID_HOME/cmdline-tools" && mv /tmp/ct/cmdline-tools "$ANDROID_HOME/cmdline-tools/latest"
  rm -rf /tmp/ct /tmp/ct.zip
fi
S="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
(yes || true) | "$S" --licenses >/dev/null
"$S" "platform-tools" "emulator" "build-tools;35.0.0" "$BILD" >/dev/null
"$ANDROID_HOME/emulator/emulator" -accel-check | grep -q "is installed and usable" \
  || { echo "KVM im CT nicht nutzbar (dev0 /dev/kvm, gid kvm?)"; exit 1; }

if [ ! -x "$HOME/maestro/bin/maestro" ]; then
  curl -fsSL -o /tmp/m.zip "https://github.com/mobile-dev-inc/maestro/releases/download/cli-$MAESTRO/maestro.zip"
  echo "$MAESTRO_SHA  /tmp/m.zip" | sha256sum -c -
  rm -rf "$HOME/maestro" && unzip -q /tmp/m.zip -d "$HOME" && rm /tmp/m.zip
fi

if [ ! -d "$HOME/.android/avd/dauertest.avd" ]; then
  echo no | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd -n dauertest -k "$BILD" -d pixel_6 >/dev/null
  C=$HOME/.android/avd/dauertest.avd/config.ini
  sed -i 's/^hw.ramSize=.*/hw.ramSize=3072/' "$C"; grep -q '^hw.ramSize' "$C" || echo hw.ramSize=3072 >> "$C"
  printf 'disk.dataPartition.size=6G\nhw.keyboard=yes\n' >> "$C"
fi

# Schnappschuss "sauber": einmal kalt starten, nichts installiert, sichern.
if ! ls "$HOME/.android/avd/dauertest.avd/snapshots/sauber" >/dev/null 2>&1; then
  "$HOME/dauertest/emulator.sh" kalt
  "$ANDROID_HOME/platform-tools/adb" emu avd snapshot save sauber
  "$HOME/dauertest/emulator.sh" stopp
fi
echo "eingerichtet"
EOF
