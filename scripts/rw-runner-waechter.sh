#!/bin/bash
# Runner-Waechter: schaltet die selbst gehosteten GitHub-Runner nach Bedarf zu
#
# Auf einem Proxmox-Knoten (pve2) als root, ueber rw-runner-waechter.timer,
# installiert als /usr/local/bin/rw-runner-waechter.
#
# Kaskade (Linux-Runner, Gruppe rosenweg-privat):
#   1 (pve2) - 2 (pve3) - 3 (pve2) - 4 (pve3)
#   * Runner 1 laeuft immer.
#   * Runner N+1 wird nur gestartet, wenn ALLE Vorgaenger laufen und busy
#     sind (busy-Flag der GitHub-API), mindestens ein Job mit unserem Label
#     wartet und die Last des Zielknotens unter LAST_MAX liegt.
#     Pro Durchlauf hoechstens einer.
#   * Abgeschaltet wird rueckwaerts: nur der hoechste laufende Runner, und
#     nur wenn er nicht busy ist, seit IDLE_MIN Minuten nichts zu tun hatte
#     und kein Job wartet. Pro Durchlauf hoechstens einer.
#   * Ein Runner mit laufendem Job wird nie gestoppt (busy wird unmittelbar
#     vor dem Stoppen nochmals geprueft).
#   * Gestartet/gestoppt werden nur die systemd-Dienste im Container, nie der
#     Container und nie die Windows-VM (win-runner bleibt dauerhaft an).
#
# Aufruf: rw-runner-waechter [--trocken]   (Trockenlauf: nur ausgeben)
# Fehler -> Exit 1 + Journal; das failed-Unit faellt der Dienstwacht auf.
set -euo pipefail

KONF=${RW_WAECHTER_KONF:-/etc/rosenweg-runner-waechter.conf}
[ -r "$KONF" ] || { echo "rw-runner-waechter: $KONF fehlt" >&2; exit 1; }
# shellcheck disable=SC1090
. "$KONF"
export TROCKEN="${TROCKEN:-0}"
[ "${1:-}" = "--trocken" ] && TROCKEN=1
export ORG="${ORG:-Rosenweg}" APP_ID="${APP_ID:-5960072}" APP_KEY="${APP_KEY:-/etc/rosenweg-github-app.pem}"
export LABEL="${LABEL:-rosenweg}" IDLE_MIN="${IDLE_MIN:-15}" LAST_MAX="${LAST_MAX:-12}"
export STATE="${STATE:-/var/lib/rw-runner-waechter/state.json}"
# Runner in Kaskaden-Reihenfolge: name|knoten-ip|ct|verzeichnis-suffix (Dienstname)
export RUNNER="${RUNNER:-rosenweg-runner-1|100.64.2.21|140
rosenweg-runner-2|100.64.2.22|145
rosenweg-runner-3|100.64.2.21|140
rosenweg-runner-4|100.64.2.22|145}"
export LOKAL_IP="${LOKAL_IP:-100.64.2.21}"
[ -r "$APP_KEY" ] || { echo "rw-runner-waechter: App-Schluessel $APP_KEY fehlt" >&2; exit 1; }
mkdir -p "$(dirname "$STATE")"

exec python3 -I - <<'PY'
import base64, json, os, subprocess, sys, time, urllib.request, urllib.error, syslog

E = os.environ
TROCKEN = E["TROCKEN"] == "1"
ORG, LABEL = E["ORG"], E["LABEL"]
IDLE_S = int(E["IDLE_MIN"]) * 60
LAST_MAX = float(E["LAST_MAX"])
now = int(time.time())

def log(msg, err=False):
    pre = "TROCKEN: " if TROCKEN else ""
    print(pre + msg, flush=True)
    syslog.syslog(syslog.LOG_ERR if err else syslog.LOG_INFO, "rw-runner-waechter: " + pre + msg)

def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=60, **kw)

# ── GitHub-App-Token (JWT per openssl, kein Schluessel in Argumenten) ──
def b64(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
def app_token():
    kopf = b64(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    nutz = b64(json.dumps({"iat": now - 60, "exp": now + 540, "iss": E["APP_ID"]}).encode())
    sig = subprocess.run(["openssl", "dgst", "-sha256", "-sign", E["APP_KEY"]],
                         input=(kopf + "." + nutz).encode(), capture_output=True, timeout=20)
    if sig.returncode: raise RuntimeError("JWT signieren fehlgeschlagen")
    jwt = kopf + "." + nutz + "." + b64(sig.stdout)
    inst = api("/orgs/%s/installation" % ORG, jwt)
    tok = api("/app/installations/%d/access_tokens" % inst["id"], jwt, post=True)
    return tok["token"]

def api(pfad, token, post=False):
    r = urllib.request.Request("https://api.github.com" + pfad, method="POST" if post else "GET",
        headers={"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "rw-runner-waechter"})
    with urllib.request.urlopen(r, timeout=30) as f:
        return json.load(f)

def seiten(pfad, token, feld):
    out, n = [], 1
    while True:
        d = api(pfad + ("&" if "?" in pfad else "?") + "per_page=100&page=%d" % n, token)
        out += d[feld]
        if len(d[feld]) < 100: return out
        n += 1

# ── Runner-Tabelle ──
runner = []
for z in E["RUNNER"].strip().splitlines():
    name, ip, ct = z.strip().split("|")
    runner.append({"name": name, "ip": ip, "ct": ct, "unit": "actions.runner.%s.%s.service" % (ORG, name)})

def ctl(r, *args):
    """systemctl im Container des Runners (lokal per pct, sonst per ssh zum Knoten)."""
    cmd = ["pct", "exec", r["ct"], "--", "systemctl"] + list(args)
    if r["ip"] != E["LOKAL_IP"]:
        cmd = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "root@" + r["ip"], " ".join(cmd)]
    return run(cmd)

def knoten_last(ip):
    cmd = ["cat", "/proc/loadavg"]
    if ip != E["LOKAL_IP"]:
        cmd = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "root@" + ip] + cmd
    p = run(cmd)
    return float(p.stdout.split()[0])

try:
    tok = app_token()
    api_runner = {r["name"]: r for r in seiten("/orgs/%s/actions/runners" % ORG, tok, "runners")}

    # wartende Jobs mit unserem Label (queued, auch in laufenden Laeufen)
    wartend = 0
    repos = []
    n = 1
    while True:
        d = api("/orgs/%s/repos?per_page=100&page=%d" % (ORG, n), tok)
        repos += [x["name"] for x in d if not x.get("archived")]
        if len(d) < 100: break
        n += 1
    for repo in repos:
        for status in ("queued", "in_progress"):
            d = api("/repos/%s/%s/actions/runs?status=%s&per_page=50" % (ORG, repo, status), tok)
            for lauf in d["workflow_runs"]:
                jobs = api("/repos/%s/%s/actions/runs/%d/jobs?filter=latest&per_page=100" % (ORG, repo, lauf["id"]), tok)
                wartend += sum(1 for j in jobs["jobs"] if j["status"] == "queued"
                               and LABEL in j.get("labels", []))

    try: zustand = json.load(open(E["STATE"]))
    except Exception: zustand = {}

    for r in runner:
        a = ctl(r, "is-active", r["unit"])
        r["aktiv"] = a.stdout.strip() == "active"
        info = api_runner.get(r["name"], {})
        r["online"] = info.get("status") == "online"
        r["busy"] = bool(info.get("busy")) and r["online"]
        z = zustand.setdefault(r["name"], {"aktiv_seit": now, "zuletzt_busy": now})
        if r["busy"] or not r["aktiv"]:
            z["zuletzt_busy"] = now
        if not r["aktiv"]: z["aktiv_seit"] = now

    log("Zustand: wartend=%d; %s" % (wartend, ", ".join(
        "%s=%s" % (r["name"][-1], "busy" if r["busy"] else ("idle" if r["aktiv"] else "aus")) for r in runner)))

    # Runner 1 immer an
    r1 = runner[0]
    if not r1["aktiv"]:
        log("Runner 1 ist aus -> starte %s" % r1["name"])
        if not TROCKEN: ctl(r1, "start", r1["unit"])
    else:
        # ── Zuschalten: niedrigster ausgeschalteter, alle Vorgaenger an und busy ──
        ziel = next((i for i, r in enumerate(runner) if not r["aktiv"]), None)
        if ziel is not None and wartend > 0 and all(r["aktiv"] and r["busy"] for r in runner[:ziel]):
            r = runner[ziel]
            last = knoten_last(r["ip"])
            if last >= LAST_MAX:
                log("Zuschalten %s verzichtet: Last %s %.1f >= %.1f" % (r["name"], r["ip"], last, LAST_MAX))
            else:
                log("Zuschalten %s (Vorgaenger busy, %d Job(s) warten, Last %.1f)" % (r["name"], wartend, last))
                if not TROCKEN:
                    p = ctl(r, "start", r["unit"])
                    if p.returncode: raise RuntimeError("Start %s: %s" % (r["name"], p.stderr.strip()))
                    zustand[r["name"]] = {"aktiv_seit": now, "zuletzt_busy": now}
        else:
            # ── Abschalten: nur der hoechste laufende Runner > 1 ──
            hoch = max((i for i, r in enumerate(runner) if r["aktiv"]), default=0)
            if hoch > 0:
                r = runner[hoch]; z = zustand[r["name"]]
                leer = now - max(z["zuletzt_busy"], z["aktiv_seit"])
                if r["busy"] or wartend > 0:
                    pass
                elif leer < IDLE_S:
                    log("%s idle seit %d Min, Frist %d Min" % (r["name"], leer // 60, IDLE_S // 60))
                else:
                    # unmittelbar vor dem Stoppen busy nochmals pruefen
                    neu = api("/orgs/%s/actions/runners" % ORG, tok)["runners"]
                    if any(x["name"] == r["name"] and x["busy"] for x in neu):
                        log("%s inzwischen busy -> bleibt" % r["name"])
                    else:
                        log("Abschalten %s (idle seit %d Min, keine Jobs wartend)" % (r["name"], leer // 60))
                        if not TROCKEN:
                            p = ctl(r, "stop", r["unit"])
                            if p.returncode: raise RuntimeError("Stopp %s: %s" % (r["name"], p.stderr.strip()))

    if not TROCKEN:
        tmp = E["STATE"] + ".tmp"
        json.dump(zustand, open(tmp, "w")); os.replace(tmp, E["STATE"])
except Exception as e:
    log("FEHLER: %s" % e, err=True)
    sys.exit(1)
PY
