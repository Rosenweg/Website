#!/bin/bash
# Ein Dauertest-Lauf (als android im CT): Emulator aus Schnappschuss, je aktive App aus apps.json
#   1. APK holen (/apps-Index oder Datei), Pruefsumme und Signaturzertifikat pruefen
#   2. frisch installieren, Maestro-Ablauf, Schirmbild, Absturz-Puffer lesen
#   3. ergebnis/<kennung>.json + .png, ergebnis/stand.json
# danach Emulator stoppen (laeuft nicht dauernd: pve2 ist ausgelastet).
#
#   lauf.sh              alle aktiven Apps
#   lauf.sh --nur-neu    nur wenn sich im /apps-Index eine Version geaendert hat (fuer die
#                        5-Minuten-Abfrage nach einem Release); sonst still beenden
#   lauf.sh bausteine    nur diese App
#
# Melden (aus, bis die API-Seite gebaut ist): in /etc/android-dauertest.env
#   MELDE_URL=https://www.rosenweg4303.ch/api/isp/noc/android-dauertest  MELDE_TOKEN=...
set -uo pipefail
HIER=$(cd "$(dirname "$0")" && pwd)
export ANDROID_HOME=$HOME/android-sdk MAESTRO_CLI_NO_ANALYTICS=1 MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true
PATH=$ANDROID_HOME/platform-tools:$ANDROID_HOME/build-tools/35.0.0:$HOME/maestro/bin:$PATH
INDEX_URL=${INDEX_URL:-https://pbx.rosenweg4303.ch/api/apps/index.json}
BASIS=${INDEX_URL%/api/apps/index.json}
ERG=$HOME/ergebnis; mkdir -p "$ERG" "$HOME/apks"
[ -r /etc/android-dauertest.env ] && . /etc/android-dauertest.env

exec 9>"$HOME/.lauf.sperre"; flock -n 9 || { echo "Lauf laeuft schon"; exit 0; }

NUR_NEU=0; NUR=""
for a in "$@"; do case "$a" in --nur-neu) NUR_NEU=1 ;; *) NUR=$a ;; esac; done

curl -fsS --max-time 30 -o "$ERG/index.json.neu" "$INDEX_URL" || { echo "Index nicht lesbar: $INDEX_URL"; exit 1; }
if [ $NUR_NEU = 1 ]; then
  stempel() { jq -c '[.apps[] | {paket, version_code, sha256}] | sort_by(.paket)' "$1" 2>/dev/null; }
  if [ -f "$ERG/index.json" ] && [ "$(stempel "$ERG/index.json")" = "$(stempel "$ERG/index.json.neu")" ]; then
    rm -f "$ERG/index.json.neu"; exit 0
  fi
fi
mv "$ERG/index.json.neu" "$ERG/index.json"
SIG_INDEX=$(jq -r '.signatur_sha256 // empty' "$ERG/index.json")

"$HIER/emulator.sh" start || { echo "Emulator startet nicht"; exit 1; }

pruefe_app() {   # $1 = JSON-Eintrag aus apps.json; schreibt $ERG/<kennung>.json
  local e=$1 k paket quelle flow sig apk soll_sha ist_sha ist_sig version="" grund="" t0=$SECONDS
  k=$(jq -r .kennung <<<"$e"); paket=$(jq -r .paket <<<"$e"); quelle=$(jq -r .quelle <<<"$e")
  flow="$HIER/$(jq -r .flow <<<"$e")"; sig=$(jq -r .signatur <<<"$e")
  [ "$sig" = index ] && sig=$SIG_INDEX
  apk="$HOME/apks/$k.apk"

  if [ "$quelle" = index ]; then
    local z; z=$(jq -c --arg p "$paket" '.apps[] | select(.paket == $p)' "$ERG/index.json")
    if [ -z "$z" ]; then grund="nicht im /apps-Index"; else
      soll_sha=$(jq -r .sha256 <<<"$z"); version=$(jq -r .version_name <<<"$z")
      if ! curl -fsS --max-time 300 -o "$apk.neu" "$BASIS$(jq -r .url <<<"$z")"; then grund="Download fehlgeschlagen"
      else
        ist_sha=$(sha256sum "$apk.neu" | cut -c1-64)
        if [ "$ist_sha" != "$soll_sha" ]; then grund="Pruefsumme passt nicht zum Index"; rm -f "$apk.neu"
        else mv "$apk.neu" "$apk"; fi
      fi
    fi
  else
    apk="$HOME/$(jq -r .datei <<<"$e")"
    [ -f "$apk" ] || grund="APK fehlt: $apk"
  fi

  if [ -z "$grund" ]; then
    ist_sig=$(apksigner verify --print-certs "$apk" 2>/dev/null | sed -n 's/^Signer #1 certificate SHA-256 digest: //p')
    if [ -z "$ist_sig" ]; then grund="Signatur ungueltig"
    elif [ "$ist_sig" != "$sig" ]; then grund="fremdes Signaturzertifikat ($ist_sig)"; fi
    [ -z "$version" ] && version=$(aapt2 dump badging "$apk" 2>/dev/null | sed -n "s/.*versionName='\([^']*\)'.*/\1/p")
  fi

  if [ -z "$grund" ]; then
    adb uninstall "$paket" >/dev/null 2>&1
    adb logcat -b crash -c >/dev/null 2>&1
    if ! adb install -r "$apk" >"$ERG/$k.install.log" 2>&1; then grund="Installation fehlgeschlagen: $(tail -1 "$ERG/$k.install.log")"
    elif ! timeout 600 maestro test "$flow" --no-ansi --format junit --output "$ERG/$k.junit.xml" >"$ERG/$k.maestro.log" 2>&1; then
      grund="Ablauf: $(grep -m1 -E 'FAILED|Assertion is false|Element not found' "$ERG/$k.maestro.log" | cut -c1-200)"
      [ "$grund" = "Ablauf: " ] && grund="Ablauf fehlgeschlagen (Log $ERG/$k.maestro.log)"
    fi
    adb exec-out screencap -p >"$ERG/$k.png" 2>/dev/null
    if adb logcat -b crash -d 2>/dev/null | grep -q "Process: $paket"; then
      [ -z "$grund" ] && grund="Absturz im Hintergrund (logcat crash)"
    fi
  fi

  jq -n --arg k "$k" --arg name "$(jq -r .name <<<"$e")" --arg paket "$paket" --arg version "$version" \
        --arg grund "$grund" --argjson dauer $((SECONDS - t0)) --arg zeit "$(date -Iseconds)" \
        '{kennung:$k, name:$name, paket:$paket, version:$version, ok:($grund == ""), grund:(if $grund == "" then null else $grund end), dauer_s:$dauer, zeit:$zeit}' \
        >"$ERG/$k.json"
  echo "$k: $([ -z "$grund" ] && echo gruen || echo "rot - $grund") ($((SECONDS - t0)) s)"
}

# adb und maestro lesen stdin - darum die Liste auf fd 3 und die App ohne stdin
while read -r e <&3; do
  [ -n "$NUR" ] && [ "$(jq -r .kennung <<<"$e")" != "$NUR" ] && continue
  pruefe_app "$e" </dev/null
done 3< <(jq -c '.apps[] | select(.aktiv)' "$HIER/apps.json")

"$HIER/emulator.sh" stopp
STAND=()
for k in $(jq -r '.apps[] | select(.aktiv) | .kennung' "$HIER/apps.json"); do
  [ -f "$ERG/$k.json" ] && STAND+=("$ERG/$k.json")
done
jq -s '{zeit: (now | todate), apps: .}' "${STAND[@]}" >"$ERG/stand.json"

# Melden: ein POST je Lauf mit Ergebnissen und Schirmbildern (base64). Entscheidet die API
# (Zustandswechsel, zweimal rot in Folge -> Technik), nicht dieses Skript.
if [ -n "${MELDE_URL:-}" ] && [ -n "${MELDE_TOKEN:-}" ]; then
  python3 - "$ERG" <<'PY' | curl -fsS --max-time 60 -H "X-Dauertest-Token: $MELDE_TOKEN" -H 'Content-Type: application/json' --data-binary @- "$MELDE_URL" >/dev/null \
    || echo "Melden fehlgeschlagen"
import base64, json, os, sys
erg = sys.argv[1]
stand = json.load(open(os.path.join(erg, 'stand.json')))
for a in stand['apps']:
    p = os.path.join(erg, a['kennung'] + '.png')
    a['schirmbild_png'] = base64.b64encode(open(p, 'rb').read()).decode() if os.path.exists(p) else None
print(json.dumps(stand))
PY
fi
