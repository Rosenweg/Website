#!/bin/bash
# rw-web-ausrollen — eine Quelle, alle Frontends
#
# Verwendung:
#   scripts/rw-web-ausrollen.sh [--pruefen] [--neu] [--nur CONTAINER] DATEI…
#   scripts/rw-web-ausrollen.sh --app KURZNAME [--tag vX.Y.Z | --datei ARCHIV]
#                               [--repo OWNER/REPO] [--pruefen] [--nur CONTAINER]
#   scripts/rw-web-ausrollen.sh --app KURZNAME --zurueck
#
#   DATEI      Pfad relativ zum Repo, z. B. noc-fullscreen.html oder js/nav.js
#   --pruefen  nur vergleichen und berichten, nichts schreiben
#   --neu      eine Datei auch dorthin legen, wo sie noch fehlt
#              (ohne --neu wird kein Bestand erweitert — auch fe-www nicht)
#   --nur      nur diesen Container beliefern, z. B. --nur fe-www (mit --neu
#              fuer neue Seiten, die nicht auf alle Frontends gehoeren)
#
#   --app      Web-Version einer Flutter-App ausrollen (docs/plans/flutter-
#              apps-wellen-3-4.md, rosenweg-basis docs/web.md): das Archiv
#              <app>-web.tar.gz aus dem Release (Standard: neuestes Release von
#              Rosenweg/rosenweg-KURZNAME, ueber `gh`; --tag, --repo, oder ein
#              Archiv mit --datei) wird nach /var/www/rosenweg/app/KURZNAME/
#              entpackt, auf fe-www UND fe-isp (mit --nur auf einen).
#              Vorher wird das Archiv geprueft: Pruefsumme aus SHA256SUMS des
#              Releases, nur relative Pfade, index.html mit <base href=
#              "/app/KURZNAME/">, flutter_bootstrap.js und main.dart.js.
#              Die vorige Fassung bleibt fuer den Rueckweg liegen.
#              CanvasKit (Zeichenmotor, ~16 MB) liegt NICHT je App, sondern einmal
#              unter /var/www/rosenweg/app/canvaskit/<flutter-version>/ (die App
#              nennt den Pfad in flutter_bootstrap.js, canvasKitBaseUrl). Das Skript
#              nimmt es aus dem Archiv heraus und legt es nur an, wo es fehlt.
#   --zurueck  die vorige Fassung von /app/KURZNAME/ wiederherstellen
#              (tauscht aktuelle und vorige; ein zweites --zurueck macht es
#              wieder rueckgaengig).
#   Mit --pruefen nur zeigen, was draussen liegt und was ausgerollt wuerde.
#   Ein Frontend-Neuaufbau (frontends-lxc/deploy.sh) laesst /app/ stehen.
#
# Umgebung:  RW_JUMP  Sprunghost      (Standard stefan@10.0.10.149)
#            RW_NODE  ein Cluster-Knoten (Standard root@100.64.2.20)
#            RW_JUMP= (leer) ohne Sprunghost, wenn der Rechner die 100.64-Adressen
#                     selbst erreicht (VPN)
#
# ── Warum es das gibt ───────────────────────────────────────────────────
# Die Frontends laufen als LXC-Container mit nginx, jeder mit einem eigenen
# Bestand unter /var/www/rosenweg. Es gibt keinen Weg vom Push zur Seite;
# ausgerollt wird dateiweise von Hand. Dabei ist zweierlei passiert:
#
#   – noc-fullscreen.html liegt auf fe-www UND auf fe-isp (das Wandbild unter
#     noc.rosenweg4303.ch). Wer nur fe-www beliefert, aendert das Wandbild
#     nicht. Auf fe-isp lag bis 5.9.2026 der Stand vom 15. August.
#   – Auf fe-www lag seit dem 15. August der ganze Repo-Baum — docs/,
#     JOURNAL.md, Compose-Dateien, Skripte — oeffentlich abrufbar.
#
# Dieses Skript kennt die Ziele nicht auswendig. Es fragt den Cluster nach
# allen fe-*-Containern und legt eine Datei dorthin, wo sie schon liegt.
# Was ein Container hat, bekommt er aktuell; was er nicht hat, bekommt er
# nicht — ausser man sagt --neu. So bleibt jeder Bestand, wie er ist, nur
# eben auf dem Stand des Repos.
#
# Eine Ausnahme kennt es doch: fe-isp bekommt js/nav-isp.js als js/nav.js
# und nie das allgemeine js/nav.js — die ISP-Seite hat ihre eigene Leiste.
#
# Vor jedem Ueberschreiben wird eine .alt-Kopie angelegt; nginx liefert
# .alt nicht aus (Regel vom 5.9.2026). Nach dem Schreiben wird die
# Pruefsumme verglichen. Was das Skript meldet, ist das, was draussen ist.
set -u

JUMP=${RW_JUMP-stefan@10.0.10.149}
JOPT=(); [ -z "$JUMP" ] || JOPT=(-J "$JUMP")
NODE=${RW_NODE:-root@100.64.2.20}
WEBROOT=/var/www/rosenweg
PRUEFEN=0; NEU=0; NUR=""; DATEIEN=(); APP=""; REPO_APP=""; TAG=""; ARCHIV=""; ZURUECK=0
while [ $# -gt 0 ]; do
  a=$1; shift
  case "$a" in
    --nur)     NUR=${1:?--nur braucht einen Containernamen}; shift ;;
    --pruefen) PRUEFEN=1 ;;
    --neu)     NEU=1 ;;
    --app)     APP=${1:?--app braucht einen Kurznamen}; shift ;;
    --repo)    REPO_APP=${1:?--repo braucht OWNER/REPO}; shift ;;
    --tag)     TAG=${1:?--tag braucht eine Version, z. B. v1.0.0}; shift ;;
    --datei)   ARCHIV=${1:?--datei braucht ein Archiv}; shift ;;
    --zurueck) ZURUECK=1 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *)         DATEIEN+=("$a") ;;
  esac
done
if [ -n "$APP" ]; then
  [ ${#DATEIEN[@]} -eq 0 ] || { echo "--app und Dateiargumente schliessen sich aus." >&2; exit 2; }
  [[ "$APP" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "Kurzname nur a-z, 0-9, -: $APP" >&2; exit 2; }
  [[ -z "$TAG" || "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "--tag im Format v1.2.3: $TAG" >&2; exit 2; }
  [ -n "$REPO_APP" ] || REPO_APP="Rosenweg/rosenweg-$APP"
  [[ "$REPO_APP" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || { echo "--repo im Format OWNER/REPO" >&2; exit 2; }
  [ -z "$ARCHIV" ] || [ -f "$ARCHIV" ] || { echo "Archiv nicht gefunden: $ARCHIV" >&2; exit 2; }
else
  [ ${#DATEIEN[@]} -gt 0 ] || { echo "Keine Datei angegeben. -h fuer Hilfe." >&2; exit 2; }
fi

REPO=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO" || exit 2
for f in ${DATEIEN[@]+"${DATEIEN[@]}"}; do [ -f "$f" ] || { echo "Nicht im Repo: $f" >&2; exit 2; }; done

md5lokal() { if command -v md5 >/dev/null 2>&1; then md5 -q "$1"; else md5sum "$1" | cut -d' ' -f1; fi; }
# -n: ssh darf nicht von stdin lesen — sonst frisst es in der while-read-Schleife
# die restlichen Zeilen, und der zweite Container kommt nie an die Reihe.
sshj() { ssh -n -o BatchMode=yes -o ConnectTimeout=30 ${JOPT[@]+"${JOPT[@]}"} "$@"; }

# Welcher Repo-Pfad landet auf welchem Container unter welchem Namen?
# Leer heisst: dieser Container bekommt die Datei nicht.
zielpfad() {  # $1 Containername, $2 Repo-Pfad
  case "$1|$2" in
    fe-isp\|js/nav.js)     echo "" ;;
    fe-isp\|js/nav-isp.js) echo "js/nav.js" ;;
    *\|js/nav-isp.js)      echo "" ;;
    # fe-pwa: pwa/ ist dort die Docroot (frontends-lxc/deploy.sh, assemble_pwa)
    fe-pwa\|pwa/*)         echo "${2#pwa/}" ;;
    *\|pwa/*)              echo "" ;;
    *)                     echo "$2" ;;
  esac
}

# ── 1. Frontends und Knoten aus dem Cluster ──────────────────────────────
INVENTAR=$(sshj "$NODE" 'pvesh get /cluster/resources --type vm --output-format json 2>/dev/null; echo "@@"; pvesh get /cluster/status --output-format json 2>/dev/null') || { echo "Cluster nicht erreichbar ueber $NODE" >&2; exit 1; }
CTS=$(printf '%s' "$INVENTAR" | python3 -c '
import sys, json
res, status = sys.stdin.read().split("@@", 1)
ips = {n["name"]: n.get("ip", "") for n in json.loads(status) if n.get("type") == "node"}
for r in sorted(json.loads(res), key=lambda x: x.get("name", "")):
    if r.get("name", "").startswith("fe-") and r.get("status") == "running":
        print(r["vmid"], r["name"], r["node"], ips.get(r["node"], ""))')
[ -n "$CTS" ] || { echo "Keine laufenden fe-*-Container gefunden" >&2; exit 1; }
if [ -n "$NUR" ]; then
  CTS=$(printf '%s\n' "$CTS" | awk -v n="$NUR" '$2==n')
  [ -n "$CTS" ] || { echo "Container $NUR laeuft nicht oder heisst anders" >&2; exit 1; }
fi

# ── 1b. Web-Version einer App (--app) ────────────────────────────────────
if [ -n "$APP" ]; then
  # Standard: die beiden Frontends, auf denen die Website selbst liegt
  [ -n "$NUR" ] || CTS=$(printf '%s\n' "$CTS" | awk '$2=="fe-www" || $2=="fe-isp"')
  [ -n "$CTS" ] || { echo "fe-www/fe-isp laufen nicht" >&2; exit 1; }
  ARBEIT=$(mktemp -d "${TMPDIR:-/tmp}/rw-app.XXXXXXXX"); trap 'rm -rf "$ARBEIT"' EXIT
  APPDIR=/var/www/.rw-app/$APP   # ausserhalb des Web-Roots: .alt/.neu darf nie ausgeliefert werden

  # Version einer ausgerollten App lesen (leer = nicht da)
  fern_version() {  # $1 Knoten-IP, $2 Container-ID
    sshj "root@$1" "pct exec $2 -- sh -c 'cat $WEBROOT/app/$APP/rosenweg-web.json 2>/dev/null || cat $WEBROOT/app/$APP/version.json 2>/dev/null'" \
      | python3 -c 'import sys, json
t = sys.stdin.read().strip()
if t:
    try:
        d = json.loads(t)
        v = d.get("version", "?")
        print(v + " (Lauf " + str(d["lauf"]) + ")" if "lauf" in d else v)
    except Exception:
        print("?")'
  }

  if [ "$ZURUECK" = 1 ]; then
    printf '%-10s %-12s %-22s %s\n' "App" "Container" "Vorher" "Nachher"
    while read -r id name knoten ip; do
      vor=$(fern_version "$ip" "$id"); [ -n "$vor" ] || vor="(nichts)"
      if [ "$PRUEFEN" = 1 ]; then
        da=$(sshj "root@$ip" "pct exec $id -- sh -c '[ -d $APPDIR/alt ] && echo ja || echo nein'" | tr -d '[:space:]')
        printf '%-10s %-12s %-22s %s\n' "$APP" "$name" "$vor" "(Pruefmodus; vorige Fassung: $da)"; continue
      fi
      res=$(sshj "root@$ip" "pct exec $id -- sh -c 'set -e; [ -d $APPDIR/alt ] || { echo KEINE_ALTE; exit 0; }; W=$WEBROOT/app; rm -rf $APPDIR/neu; mv \$W/$APP $APPDIR/neu; mv $APPDIR/alt \$W/$APP; mv $APPDIR/neu $APPDIR/alt; echo OK'" | tr -d '[:space:]')
      if [ "$res" = OK ]; then printf '%-10s %-12s %-22s %s\n' "$APP" "$name" "$vor" "$(fern_version "$ip" "$id") (zurueck)"
      else printf '%-10s %-12s %-22s %s\n' "$APP" "$name" "$vor" "FEHLER/keine vorige Fassung ($res)"; fi
    done <<< "$CTS"
    exit 0
  fi

  # Archiv besorgen und pruefen
  if [ -n "$ARCHIV" ]; then
    cp "$ARCHIV" "$ARBEIT/app.tar.gz"
  else
    command -v gh >/dev/null || { echo "gh fehlt (oder --datei ARCHIV)" >&2; exit 2; }
    mkdir "$ARBEIT/rel"
    gh release download ${TAG:+"$TAG"} -R "$REPO_APP" -p '*-web.tar.gz' -p SHA256SUMS -D "$ARBEIT/rel" --clobber >/dev/null \
      || { echo "Release-Archiv nicht geladen ($REPO_APP ${TAG:-neuestes}): gibt es ein Release mit -web.tar.gz? Ist web: true in der App?" >&2; exit 1; }
    set -- "$ARBEIT"/rel/*-web.tar.gz
    [ $# -eq 1 ] && [ -f "$1" ] || { echo "Genau ein *-web.tar.gz im Release erwartet" >&2; exit 1; }
    if [ -f "$ARBEIT/rel/SHA256SUMS" ]; then
      soll=$(awk -v n="./$(basename "$1")" '$2==n || $2=="*"n || $2==substr(n,3) {print $1}' "$ARBEIT/rel/SHA256SUMS")
      ist=$(shasum -a 256 "$1" | cut -d' ' -f1)
      [ -n "$soll" ] && [ "$soll" = "$ist" ] || { echo "Pruefsumme des Archivs stimmt nicht mit SHA256SUMS ueberein" >&2; exit 1; }
      echo "Pruefsumme laut SHA256SUMS stimmt: $ist"
    else
      echo "Warnung: kein SHA256SUMS im Release" >&2
    fi
    mv "$1" "$ARBEIT/app.tar.gz"
  fi
  # Inhalt: nur relative Pfade, keine Links nach draussen, die drei Dateien da
  tar -tzf "$ARBEIT/app.tar.gz" > "$ARBEIT/liste" || { echo "Kein gueltiges tar.gz" >&2; exit 1; }
  if grep -Eq '(^/|(^|/)\.\.(/|$))' "$ARBEIT/liste"; then echo "Archiv enthaelt absolute oder ..-Pfade — abgebrochen" >&2; exit 1; fi
  for d in index.html flutter_bootstrap.js main.dart.js; do
    grep -qx "\./$d\|$d" "$ARBEIT/liste" || { echo "Archiv ohne $d — kein Flutter-Web-Bau?" >&2; exit 1; }
  done
  tar -tzvf "$ARBEIT/app.tar.gz" | grep -Eq '^[lh]' && { echo "Archiv enthaelt Links — abgebrochen" >&2; exit 1; }
  mkdir "$ARBEIT/x"; tar -xzf "$ARBEIT/app.tar.gz" -C "$ARBEIT/x" --no-same-owner
  grep -q "<base href=\"/app/$APP/\">" "$ARBEIT/x/index.html" \
    || { echo "index.html hat nicht <base href=\"/app/$APP/\"> — mit --base-href /app/$APP/ gebaut? abgebrochen" >&2; exit 1; }
  grep -q 'authentik-auth.js' "$ARBEIT/x/index.html" \
    || { echo "index.html laedt /js/authentik-auth.js nicht — keine gemeinsame Anmeldung, abgebrochen" >&2; exit 1; }
  # CanvasKit gemeinsam: Version aus der App, nur wenn die App darauf zeigt
  CK_VERSION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("flutter",""))' "$ARBEIT/x/rosenweg-web.json" 2>/dev/null || true)
  CK_TAR=""
  if [ -n "$CK_VERSION" ] && [[ "$CK_VERSION" =~ ^[0-9][0-9.]*$ ]] && [ -d "$ARBEIT/x/canvaskit" ] \
     && grep -q "canvasKitBaseUrl: \"/app/canvaskit/$CK_VERSION/\"" "$ARBEIT/x/flutter_bootstrap.js"; then
    [ -f "$ARBEIT/x/canvaskit/canvaskit.wasm" ] || { echo "canvaskit/ ohne canvaskit.wasm — abgebrochen" >&2; exit 1; }
    mv "$ARBEIT/x/canvaskit" "$ARBEIT/ck"
    tar -czf "$ARBEIT/canvaskit.tar.gz" --no-xattrs -C "$ARBEIT/ck" . 2>/dev/null || tar -czf "$ARBEIT/canvaskit.tar.gz" -C "$ARBEIT/ck" .
    tar -czf "$ARBEIT/app.tar.gz" --no-xattrs -C "$ARBEIT/x" . 2>/dev/null || tar -czf "$ARBEIT/app.tar.gz" -C "$ARBEIT/x" .
    CK_TAR="$ARBEIT/canvaskit.tar.gz"
    CK_MD5=$(md5lokal "$ARBEIT/ck/canvaskit.wasm")
    echo "CanvasKit gemeinsam: /app/canvaskit/$CK_VERSION/ (wird nur angelegt, wo es fehlt)"
  fi
  neu_version=$(cat "$ARBEIT/x/rosenweg-web.json" 2>/dev/null | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("version","?")+" (Lauf "+str(d.get("lauf","?"))+")")' 2>/dev/null || echo "?")
  echo "Archiv geprueft: App $APP, Version $neu_version, $(wc -l < "$ARBEIT/liste" | tr -d ' ') Dateien"

  printf '%-10s %-12s %-22s %s\n' "App" "Container" "Vorher" "Nachher"
  FEHLER=0
  while read -r id name knoten ip; do
    vor=$(fern_version "$ip" "$id"); [ -n "$vor" ] || vor="(nichts)"
    ck_da=""
    if [ -n "$CK_TAR" ]; then
      ck_da=$(sshj "root@$ip" "pct exec $id -- sh -c 'md5sum $WEBROOT/app/canvaskit/$CK_VERSION/canvaskit.wasm 2>/dev/null | cut -d\" \" -f1'" | tr -d '[:space:]')
    fi
    if [ "$PRUEFEN" = 1 ]; then
      ck_txt=""; [ -z "$CK_TAR" ] || { [ "$ck_da" = "$CK_MD5" ] && ck_txt=", CanvasKit $CK_VERSION schon da" || ck_txt=", CanvasKit $CK_VERSION kaeme dazu"; }
      printf '%-10s %-12s %-22s %s\n' "$APP" "$name" "$vor" "$neu_version (Pruefmodus$ck_txt)"; continue
    fi
    # Gemeinsames CanvasKit zuerst (die App verweist darauf); nur wenn es fehlt
    if [ -n "$CK_TAR" ] && [ "$ck_da" != "$CK_MD5" ]; then
      ctmp=$(sshj "root@$ip" 'mktemp /tmp/rw-ck.XXXXXXXX' | tr -d '[:space:]')
      scp -q -o BatchMode=yes ${JOPT[@]+"${JOPT[@]}"} "$CK_TAR" "root@$ip:$ctmp" </dev/null || { printf '%-10s %-12s %-22s %s\n' "$APP" "$name" "$vor" "FEHLER: CanvasKit kopieren"; FEHLER=1; continue; }
      cres=$(sshj "root@$ip" "
        pct push $id $ctmp /tmp/rw-ck.tgz >/dev/null && rm -f $ctmp
        pct exec $id -- sh -c 'set -e
          W=$WEBROOT/app; N=/var/www/.rw-app/canvaskit-neu
          mkdir -p \$W/canvaskit /var/www/.rw-app; rm -rf \$N; mkdir \$N
          tar -xzf /tmp/rw-ck.tgz -C \$N --no-same-owner; rm -f /tmp/rw-ck.tgz
          [ -f \$N/canvaskit.wasm ]
          chown -R www-data:www-data \$N; chmod -R u=rwX,go=rX \$N
          rm -rf \$W/canvaskit/$CK_VERSION; mv \$N \$W/canvaskit/$CK_VERSION
          chown www-data:www-data \$W/canvaskit
          echo OK' 2>&1 | tail -1" | tr -d '[:space:]')
      [ "$cres" = OK ] || { printf '%-10s %-12s %-22s %s\n' "$APP" "$name" "$vor" "FEHLER: CanvasKit ($cres)"; FEHLER=1; continue; }
    fi
    tmp=$(sshj "root@$ip" 'mktemp /tmp/rw-app.XXXXXXXX' | tr -d '[:space:]')
    [ -n "$tmp" ] || { printf '%-10s %-12s %-22s %s\n' "$APP" "$name" "$vor" "FEHLER: mktemp"; FEHLER=1; continue; }
    scp -q -o BatchMode=yes ${JOPT[@]+"${JOPT[@]}"} "$ARBEIT/app.tar.gz" "root@$ip:$tmp" </dev/null || { printf '%-10s %-12s %-22s %s\n' "$APP" "$name" "$vor" "FEHLER beim Kopieren"; FEHLER=1; continue; }
    # Entpacken neben dem Ziel (nicht darin), Dateien dem Webserver, dann tauschen;
    # die bisherige Fassung bleibt als alt fuer --zurueck. Schlaegt etwas fehl, bleibt die Seite wie sie war.
    res=$(sshj "root@$ip" "
      pct push $id $tmp /tmp/rw-app.tgz >/dev/null && rm -f $tmp
      pct exec $id -- sh -c 'set -e
        W=$WEBROOT/app; S=$APPDIR
        mkdir -p \$S \$W
        rm -rf \$S/neu; mkdir \$S/neu
        tar -xzf /tmp/rw-app.tgz -C \$S/neu --no-same-owner; rm -f /tmp/rw-app.tgz
        [ -f \$S/neu/index.html ] && [ -f \$S/neu/main.dart.js ]
        chown -R www-data:www-data \$S/neu; chmod -R u=rwX,go=rX \$S/neu
        if [ -d \$W/$APP ]; then rm -rf \$S/alt; mv \$W/$APP \$S/alt; fi
        mv \$S/neu \$W/$APP
        echo OK' 2>&1 | tail -1" | tr -d '[:space:]')
    if [ "$res" != OK ]; then printf '%-10s %-12s %-22s %s\n' "$APP" "$name" "$vor" "FEHLER: $res"; FEHLER=1; continue; fi
    # Pruefsumme der beiden wichtigen Dateien draussen = lokal?
    soll="$(md5lokal "$ARBEIT/x/index.html")|$(md5lokal "$ARBEIT/x/main.dart.js")"
    ist=$(sshj "root@$ip" "pct exec $id -- sh -c 'cd $WEBROOT/app/$APP && md5sum index.html main.dart.js | cut -d\" \" -f1'" | tr '\n' '|' | sed 's/|$//')
    if [ "$soll" = "$ist" ]; then printf '%-10s %-12s %-22s %s\n' "$APP" "$name" "$vor" "$(fern_version "$ip" "$id") ausgerollt"
    else printf '%-10s %-12s %-22s %s\n' "$APP" "$name" "$vor" "FEHLER: Pruefsumme stimmt nicht"; FEHLER=1; fi
  done <<< "$CTS"
  echo
  [ "$PRUEFEN" = 1 ] && echo "Pruefmodus: nichts geschrieben." || echo "Rueckweg: scripts/rw-web-ausrollen.sh --app $APP --zurueck"
  exit $FEHLER
fi

# ── 2. Ist-Zustand: Pruefsumme jeder Datei auf jedem Container ───────────
# Ein ssh je Knoten, darin alle Container und Dateien.
IST=""
for knoten in $(printf '%s\n' "$CTS" | awk '{print $3}' | sort -u); do
  ip=$(printf '%s\n' "$CTS" | awk -v k="$knoten" '$3==k {print $4; exit}')
  auftrag=""
  while read -r id name kn _ip; do
    [ "$kn" = "$knoten" ] || continue
    for f in "${DATEIEN[@]}"; do
      z=$(zielpfad "$name" "$f"); [ -n "$z" ] || continue
      auftrag+="printf '%s|%s|%s|' '$name' '$f' '$z'; pct exec $id -- sh -c 'md5sum $WEBROOT/$z 2>/dev/null | cut -d\" \" -f1 || true'; echo;"$'\n'
    done
  done <<< "$CTS"
  [ -n "$auftrag" ] || continue
  IST+=$(sshj "root@$ip" "$auftrag")$'\n'
done

# ── 3. Vergleichen, ausrollen, berichten ─────────────────────────────────
printf '%-24s %-12s %-10s %s\n' "Datei" "Container" "Vorher" "Nachher"
AUSGEROLLT=0; ABWEICHEND=0
for f in "${DATEIEN[@]}"; do
  lokal=$(md5lokal "$f")
  while read -r id name knoten ip; do
    z=$(zielpfad "$name" "$f"); [ -n "$z" ] || continue
    fern=$(printf '%s\n' "$IST" | awk -F'|' -v n="$name" -v p="$f" '$1==n && $2==p {print $4}' | tr -d '[:space:]')
    if [ -z "$fern" ]; then
      # Fehlende Dateien nur mit --neu anlegen. Die fruehere Ausnahme fuer
      # fe-www hat isp-admin.html dorthin gelegt, wo sie nie war (5.9.2026).
      if [ "$NEU" = 1 ]; then vorher="fehlt"; else continue; fi
    elif [ "$fern" = "$lokal" ]; then
      printf '%-24s %-12s %-10s %s\n' "$f" "$name" "gleich" "—"; continue
    else vorher="anders"; fi
    ABWEICHEND=$((ABWEICHEND+1))
    if [ "$PRUEFEN" = 1 ]; then printf '%-24s %-12s %-10s %s\n' "$f" "$name" "$vorher" "(Pruefmodus)"; continue; fi
    # Zufallsname per mktemp auf dem Knoten: ein vorhersagbarer /tmp-Name (PID)
    # liesse sich dort vorab als Symlink anlegen; root schriebe dann ins Ziel.
    tmp=$(sshj "root@$ip" 'mktemp /tmp/rw-web.XXXXXXXX' | tr -d '[:space:]')
    [ -n "$tmp" ] || { printf '%-24s %-12s %-10s %s\n' "$f" "$name" "$vorher" "FEHLER: mktemp"; continue; }
    scp -q -o BatchMode=yes ${JOPT[@]+"${JOPT[@]}"} "$f" "root@$ip:$tmp" </dev/null || { printf '%-24s %-12s %-10s %s\n' "$f" "$name" "$vorher" "FEHLER beim Kopieren"; continue; }
    nachher=$(sshj "root@$ip" "
      pct exec $id -- sh -c 'cd $WEBROOT && [ -f $z ] && cp -a $z $z.alt; mkdir -p \$(dirname $z)' 2>/dev/null
      pct push $id $tmp $WEBROOT/$z --perms 644 >/dev/null 2>&1 && pct exec $id -- chown www-data:www-data $WEBROOT/$z
      rm -f $tmp
      pct exec $id -- sh -c 'md5sum $WEBROOT/$z | cut -d\" \" -f1'" | tr -d '[:space:]')
    if [ "$nachher" = "$lokal" ]; then printf '%-24s %-12s %-10s %s\n' "$f" "$name" "$vorher" "ausgerollt"; AUSGEROLLT=$((AUSGEROLLT+1))
    else printf '%-24s %-12s %-10s %s\n' "$f" "$name" "$vorher" "FEHLER: Pruefsumme stimmt nicht"; fi
  done <<< "$CTS"
done
echo
if [ "$PRUEFEN" = 1 ]; then echo "Pruefmodus: $ABWEICHEND abweichend, nichts geschrieben."
else echo "Ausgerollt: $AUSGEROLLT von $ABWEICHEND abweichenden Zielen."; fi
