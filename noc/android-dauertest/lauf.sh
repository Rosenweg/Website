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
# Melden: in /etc/android-dauertest.env (600 root:android) - direkt an die Haupt-API, nicht
# ueber den Proxy (die API prueft die Absender-Adresse 100.64.2.69):
#   MELDE_URL=http://100.64.2.52:3000/api/isp/noc/android-dauertest  MELDE_TOKEN=...
#   (= ANDROID_DAUERTEST_TOKEN in /opt/rosenweg-core/.env auf CT 128)
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
# Stand der Quellen: /apps-Index (Paket, Version, Pruefsumme) und je GitHub-Quelle das
# neueste Release-Tag. --nur-neu testet nur, wenn sich daran etwas geaendert hat.
{
  jq -c '[.apps[] | {paket, version_code, sha256}] | sort_by(.paket)' "$ERG/index.json.neu"
  jq -r '.apps[] | select(.aktiv and .quelle == "github") | "\(.repo) \(.tag_praefix)"' "$HIER/apps.json" | sort -u |
    while read -r repo praefix; do
      curl -fsS --max-time 30 "https://api.github.com/repos/$repo/releases?per_page=20" \
        | jq -r --arg p "$praefix" '[.[] | select(.draft | not) | .tag_name | select(startswith($p))][0] // ""' | sed "s|^|$repo |"
    done
} >"$ERG/quellen.neu" 2>/dev/null
if [ $NUR_NEU = 1 ] && [ -f "$ERG/quellen" ] && cmp -s "$ERG/quellen" "$ERG/quellen.neu"; then
  rm -f "$ERG/index.json.neu" "$ERG/quellen.neu"; exit 0
fi
mv "$ERG/index.json.neu" "$ERG/index.json"; mv "$ERG/quellen.neu" "$ERG/quellen"
SIG_INDEX=$(jq -r '.signatur_sha256 // empty' "$ERG/index.json")

"$HIER/emulator.sh" start || { echo "Emulator startet nicht"; exit 1; }
timeout 300 maestro test "$HIER/flows/aufwaermen.yaml" --no-ansi >"$ERG/aufwaermen.log" 2>&1 </dev/null \
  || timeout 300 maestro test "$HIER/flows/aufwaermen.yaml" --no-ansi >>"$ERG/aufwaermen.log" 2>&1 </dev/null || true
rm -rf "$HOME/.maestro/tests"

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
        if [ "$ist_sha" != "$soll_sha" ]; then
          # Erschien gerade ein Release (Index am Laufanfang geholt)? Einmal neu fragen.
          z=$(curl -fsS --max-time 30 "$INDEX_URL" | jq -c --arg p "$paket" '.apps[] | select(.paket == $p)')
          soll_sha=$(jq -r '.sha256 // empty' <<<"$z"); version=$(jq -r '.version_name // empty' <<<"$z")
          [ "$ist_sha" != "$soll_sha" ] && curl -fsS --max-time 300 -o "$apk.neu" "$BASIS$(jq -r .url <<<"$z")" \
            && ist_sha=$(sha256sum "$apk.neu" | cut -c1-64)
        fi
        if [ "$ist_sha" != "$soll_sha" ]; then grund="Pruefsumme passt nicht zum Index"; rm -f "$apk.neu"
        else mv "$apk.neu" "$apk"; fi
      fi
    fi
  elif [ "$quelle" = github ]; then
    # Neuestes Release mit Tag-Praefix (z. B. beispiel-v) aus einem oeffentlichen Repo:
    # APK und .sha256 daneben; Signatur wie bei index gegen das Rosenweg-Zertifikat.
    local repo praefix rel url
    repo=$(jq -r .repo <<<"$e"); praefix=$(jq -r .tag_praefix <<<"$e")
    rel=$(curl -fsS --max-time 30 "https://api.github.com/repos/$repo/releases?per_page=20" \
      | jq -c --arg p "$praefix" '[.[] | select(.draft | not) | select(.tag_name | startswith($p))][0] // empty')
    if [ -z "$rel" ]; then grund="kein Release $praefix* in $repo"; else
      version=$(jq -r --arg p "$praefix" '.tag_name | ltrimstr($p)' <<<"$rel")
      url=$(jq -r '[.assets[] | select(.name | endswith(".apk"))][0].browser_download_url // empty' <<<"$rel")
      if [ -z "$url" ] || ! curl -fsSL --max-time 300 -o "$apk.neu" "$url" \
         || ! soll_sha=$(curl -fsSL --max-time 30 "$url.sha256" | cut -c1-64); then
        grund="Download fehlgeschlagen"; rm -f "$apk.neu"
      else
        ist_sha=$(sha256sum "$apk.neu" | cut -c1-64)
        if [ "$ist_sha" != "$soll_sha" ]; then grund="Pruefsumme passt nicht zum Release"; rm -f "$apk.neu"
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
    # Ohne Anmeldung: immer frisch. Mit Anmeldung: als Update installieren, damit die
    # Anmeldung von apptest erhalten bleibt (sonst stuendlich eine neue Anmeldung).
    # Passt die Signatur der installierten App nicht (install -r scheitert), frisch.
    if [ "$(jq -r .anmeldung <<<"$e")" != true ]; then adb uninstall "$paket" >/dev/null 2>&1; fi
    adb logcat -b crash -c >/dev/null 2>&1
    if ! adb install -r "$apk" >"$ERG/$k.install.log" 2>&1 \
       && ! { adb uninstall "$paket" >/dev/null 2>&1; adb install "$apk" >>"$ERG/$k.install.log" 2>&1; }; then
      grund="Installation fehlgeschlagen: $(tail -1 "$ERG/$k.install.log")"
    else
      # Einmal wiederholen, bevor rot gilt: Maestro meldet beim ersten Kontakt mit dem
      # Treiber gelegentlich "Unknown error" nach 1 s (27.11.2026). Echte Fehler kommen zweimal.
      local versuch
      for versuch in 1 2; do
        if timeout 600 maestro test "$flow" -e BENUTZER="${APPTEST_BENUTZER:-}" -e PASSWORT="${APPTEST_PASSWORT:-}" \
             --no-ansi --format junit --output "$ERG/$k.junit.xml" >"$ERG/$k.maestro.log" 2>&1; then
          grund=""
          [ "$versuch" = 2 ] && echo "(im 2. Versuch gruen)" >>"$ERG/$k.maestro.log"
          break
        fi
        grund="Ablauf: $(grep -m1 -E 'FAILED|Assertion is false|Element not found' "$ERG/$k.maestro.log" | cut -c1-200)"
        [ "$grund" = "Ablauf: " ] && grund="Ablauf: $(grep -m1 -oE '<failure>[^<]*' "$ERG/$k.junit.xml" | sed 's/<failure>//' | cut -c1-200)"
        [ "$grund" = "Ablauf: " ] && grund="Ablauf fehlgeschlagen (Log $ERG/$k.maestro.log)"
      done
      # Maestro legt unter ~/.maestro/tests Protokolle MIT den -e-Werten (Passwort) ab
      rm -rf "$HOME/.maestro/tests"
    fi
    local _
    for _ in 1 2 3; do
      adb exec-out screencap -p >"$ERG/$k.png" 2>/dev/null
      [ "$(head -c 4 "$ERG/$k.png" | od -An -tx1 | tr -d ' ')" = 89504e47 ] && break
      sleep 2
    done
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
    b = open(p, 'rb').read() if os.path.exists(p) else b''
    a['schirmbild_png'] = base64.b64encode(b).decode() if b.startswith(b'\x89PNG\r\n\x1a\n') else None
print(json.dumps(stand))
PY
fi
