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
# Zusaetzlich meldet er pro Lauf dreimal (alle ~20 s) Zustand, aktuellen Job samt
# Fortschritt, Warteschlange und Auslastung ans NOC. API-Last: Laufliste je
# Repo mit ETag (304 zaehlt nicht), nur laufende Laeufe holen Jobs.
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
# Bericht ans NOC (api/routes/nocrunner.js); ohne Token kein Bericht
export BERICHT_BASE="${BERICHT_BASE:-}" BERICHT_TOKEN="${BERICHT_TOKEN:-}"
# Ein Lauf = eine Entscheidung + weitere Messungen im Abstand MESS_S (NOC-Anzeige alle ~20 s)
export MESS_S="${MESS_S:-20}" MESSUNGEN="${MESSUNGEN:-3}" WIN_VM="${WIN_VM:-142}"
# Release-Warteschlange (Flutter-Apps, app.yml): erst mit RELEASE_QUEUE=1 aktiv. Dann startet der
# Waechter faellige Releases per workflow_dispatch (veroeffentlichen=true), hoechstens
# RELEASE_PARALLEL_MAX (2) gleichzeitig, ein weiteres nur bei mindestens 2 freien macOS-Plaetzen (von 5).
export RELEASE_QUEUE="${RELEASE_QUEUE:-0}" RELEASE_PARALLEL_MAX="${RELEASE_PARALLEL_MAX:-2}" RELEASE_PRUEF_S="${RELEASE_PRUEF_S:-300}"
export RELEASE_WORKFLOW="${RELEASE_WORKFLOW:-app.yml}" RELEASE_BRANCH="${RELEASE_BRANCH:-main}" STAU_S="${STAU_S:-1200}"
export LOKAL_IP="${LOKAL_IP:-100.64.2.21}"
[ -r "$APP_KEY" ] || { echo "rw-runner-waechter: App-Schluessel $APP_KEY fehlt" >&2; exit 1; }
mkdir -p "$(dirname "$STATE")"

exec python3 -I - <<'PY'
import base64, calendar, json, os, re, shlex, subprocess, sys, time, urllib.request, urllib.error, syslog

E = os.environ
TROCKEN = E["TROCKEN"] == "1"
ORG, LABEL = E["ORG"], E["LABEL"]
IDLE_S = int(E["IDLE_MIN"]) * 60
LAST_MAX = float(E["LAST_MAX"])
now = int(time.time())
calls = {"gesamt": 0, "304": 0}

def log(msg, err=False):
    pre = "TROCKEN: " if TROCKEN else ""
    print(pre + msg, flush=True)
    syslog.syslog(syslog.LOG_ERR if err else syslog.LOG_INFO, "rw-runner-waechter: " + pre + msg)

def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=60, **kw)

# ── GitHub-App-Token (JWT per openssl, kein Schluessel in Argumenten) ──
def b64(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
def app_token():
    """Installationstoken, bis kurz vor Ablauf wiederverwendet: ETags gelten je
    Zugangsdaten (Vary: Authorization), mit jedem neuen Token waere der Cache leer."""
    ablage = os.path.join(os.path.dirname(E["STATE"]), "token.json")
    try:
        c = json.load(open(ablage))
        if c["ablauf"] > time.time() + 300: return c["token"]
    except Exception:
        pass
    token, ablauf = app_token_neu()
    try:
        ende = calendar.timegm(time.strptime(ablauf[:19], "%Y-%m-%dT%H:%M:%S")) if ablauf else time.time() + 1800
        fd = os.open(ablage + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f: json.dump({"token": token, "ablauf": ende}, f)
        os.replace(ablage + ".tmp", ablage)
    except Exception:
        pass
    return token

def app_token_neu():
    kopf = b64(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    nutz = b64(json.dumps({"iat": now - 60, "exp": now + 540, "iss": E["APP_ID"]}).encode())
    sig = subprocess.run(["openssl", "dgst", "-sha256", "-sign", E["APP_KEY"]],
                         input=(kopf + "." + nutz).encode(), capture_output=True, timeout=20)
    if sig.returncode: raise RuntimeError("JWT signieren fehlgeschlagen")
    jwt = kopf + "." + nutz + "." + b64(sig.stdout)
    inst = api("/orgs/%s/installation" % ORG, jwt)
    tok = api("/app/installations/%d/access_tokens" % inst["id"], jwt, post=True)
    return tok["token"], tok.get("expires_at", "")

etags = {}   # pfad -> (etag, daten); ueberlebt nur diesen Lauf plus Zustandsdatei
def api(pfad, token, post=False, etag=False):
    kopf = {"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "rw-runner-waechter"}
    if etag and pfad in etags: kopf["If-None-Match"] = etags[pfad][0]
    r = urllib.request.Request("https://api.github.com" + pfad, method="POST" if post else "GET", headers=kopf)
    for versuch in (1, 2):
        calls["gesamt"] += 1
        try:
            with urllib.request.urlopen(r, timeout=30) as f:
                d = json.load(f)
                if etag and f.headers.get("ETag"): etags[pfad] = (f.headers["ETag"], d)
                return d
        except urllib.error.HTTPError as e:
            if e.code == 304 and pfad in etags:
                calls["304"] += 1
                return etags[pfad][1]
            if e.code >= 500 and versuch == 1:
                time.sleep(2); continue   # GitHub haengt manchmal kurz
            raise RuntimeError("GitHub %s fuer %s" % (e.code, pfad.split("?")[0]))

def seiten(pfad, token, feld):
    out, n = [], 1
    while True:
        d = api(pfad + ("&" if "?" in pfad else "?") + "per_page=100&page=%d" % n, token)
        out += d[feld]
        if len(d[feld]) < 100: return out
        n += 1

# ── Bericht ans NOC (api/routes/nocrunner.js) - Fehler hier stoeren den Lauf nie ──
def bericht_senden(daten):
    if not (E.get("BERICHT_BASE") and E.get("BERICHT_TOKEN")):
        return
    try:
        r = urllib.request.Request(E["BERICHT_BASE"].rstrip("/") + "/api/isp/noc/runner",
            data=json.dumps(daten).encode(), method="POST",
            headers={"Content-Type": "application/json", "X-Runner-Token": E["BERICHT_TOKEN"]})
        urllib.request.urlopen(r, timeout=15).read()
    except Exception as e:
        syslog.syslog(syslog.LOG_WARNING, "rw-runner-waechter: Bericht ans NOC fehlgeschlagen: %s" % e)

# ── Runner-Tabelle ──
runner = []
for z in E["RUNNER"].strip().splitlines():
    name, ip, ct = z.strip().split("|")
    runner.append({"name": name, "ip": ip, "ct": ct, "unit": "actions.runner.%s.%s.service" % (ORG, name)})

def ssh(ip, cmd):
    return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "root@" + ip] + cmd

def ctl(r, *args):
    """systemctl im Container des Runners (lokal per pct, sonst per ssh zum Knoten)."""
    cmd = ["pct", "exec", r["ct"], "--", "systemctl"] + list(args)
    if r["ip"] != E["LOKAL_IP"]:
        cmd = ssh(r["ip"], [" ".join(cmd)])
    return run(cmd)

def knoten_last(ip):
    cmd = ["cat", "/proc/loadavg"]
    if ip != E["LOKAL_IP"]: cmd = ssh(ip, cmd)
    return float(run(cmd).stdout.split()[0])

# ── Auslastung: CT-Last/RAM und Anteil je Runner-Dienst (cgroup), Windows-VM ──
MESS_SH = r"""
echo L $(cut -d' ' -f1 /proc/loadavg) $(nproc)
awk '/MemTotal/{t=$2}/MemAvailable/{a=$2}END{print "M",t,a}' /proc/meminfo
for u in "$@"; do
  cg=$(systemctl show "$u" -p ControlGroup --value 2>/dev/null)
  [ -n "$cg" ] && [ -r /sys/fs/cgroup$cg/memory.current ] && echo "U $u $(cat /sys/fs/cgroup$cg/memory.current) $(awk '/usage_usec/{print $2}' /sys/fs/cgroup$cg/cpu.stat)"
done
"""
def messen_ct(ip, ct, units):
    cmd = ["pct", "exec", ct, "--", "sh", "-c", MESS_SH, "x"] + units
    if ip != E["LOKAL_IP"]:
        cmd = ssh(ip, [" ".join(shlex.quote(x) for x in cmd)])
    p = run(cmd)
    aus = {"last": None, "kerne": None, "ram_gesamt": None, "ram_frei": None, "dienste": {}}
    for z in p.stdout.splitlines():
        t = z.split()
        try:
            if t[0] == "L": aus["last"], aus["kerne"] = float(t[1]), int(t[2])
            elif t[0] == "M": aus["ram_gesamt"], aus["ram_frei"] = int(t[1]) * 1024, int(t[2]) * 1024
            elif t[0] == "U": aus["dienste"][t[1]] = (int(t[2]), int(t[3]) if len(t) > 3 else None)
        except (ValueError, IndexError):
            pass
    return aus

def messen_vm(vmid):
    p = run(["qm", "status", vmid, "--verbose"])
    w = dict(z.split(": ", 1) for z in p.stdout.splitlines() if ": " in z)
    try:
        return {"cpu": float(w.get("cpu", 0)), "kerne": int(w.get("cpus", 0) or 0),
                "ram": int(w.get("mem", 0)), "ram_gesamt": int(w.get("maxmem", 0))}
    except ValueError:
        return None

# ── Jobs: laufende und wartende, mit Fortschritt ──
def iso(t):
    return calendar.timegm(time.strptime(t, "%Y-%m-%dT%H:%M:%SZ")) if t else None

mac_laeuft = [0]
lauf_zaehler = {}

def jobs_lesen(tok, laeufe, dauern):
    """laeufe: [(repo, lauf)] -> (laufend {runner_name: info}, wartend [info])"""
    laufend, wartend = {}, []
    mac_laeuft[0] = 0
    lauf_zaehler.clear()
    jetzt = time.time()
    for repo, lauf in laeufe:
        d = api("/repos/%s/%s/actions/runs/%d/jobs?filter=latest&per_page=100" % (ORG, repo, lauf["id"]), tok, etag=True)
        pr = (lauf.get("pull_requests") or [{}])[0].get("number")
        # offene Laeufe der ganzen Organisation fuers NOC: je Lauf Jobs nach Ort
        z = {"repo": repo, "workflow": lauf.get("name", ""), "branch": lauf.get("head_branch", ""), "pr": pr,
             "status": lauf.get("status", ""), "url": lauf.get("html_url", ""),
             "alter_s": int(jetzt - iso(lauf["created_at"])) if lauf.get("created_at") else None,
             "eigen": 0, "github": 0, "mac": 0, "wartend": 0, "fertig": 0, "gesamt": 0}
        for j in d["jobs"]:
            z["gesamt"] += 1
            lab = j.get("labels", [])
            if j["status"] == "completed": z["fertig"] += 1
            elif j["status"] == "in_progress":
                if "self-hosted" in lab: z["eigen"] += 1
                elif any("macos" in l for l in lab): z["mac"] += 1
                else: z["github"] += 1
            elif j["status"] in ("queued", "waiting", "pending"): z["wartend"] += 1
        lauf_zaehler[lauf["id"]] = z
        for j in d["jobs"]:
            schluessel = "%s/%s/%s" % (repo, lauf.get("name", ""), re.sub(r"\(.*\)", "", j["name"]).strip())
            if j["status"] == "completed" and j.get("conclusion") == "success" and j.get("started_at") and j.get("completed_at"):
                dauer = int(iso(j["completed_at"]) - iso(j["started_at"]))
                l = dauern.setdefault(schluessel, [])
                if j["id"] not in [x[0] for x in l]:
                    l.append([j["id"], dauer]); del l[:-5]
            elif j["status"] == "in_progress" and any("macos" in l for l in j.get("labels", [])):
                mac_laeuft[0] += 1
            elif j["status"] == "in_progress" and j.get("runner_name"):
                schritte = j.get("steps") or []
                fertig = sum(1 for x in schritte if x["status"] == "completed")
                akt = next((x["name"] for x in schritte if x["status"] == "in_progress"), None)
                lauf_s = int(jetzt - iso(j["started_at"])) if j.get("started_at") else 0
                mediane = sorted(x[1] for x in dauern.get(schluessel, []))
                med = mediane[len(mediane) // 2] if mediane else None
                info = {"repo": repo, "workflow": lauf.get("name", ""), "job": j["name"],
                        "branch": lauf.get("head_branch", ""), "pr": pr, "url": j["html_url"],
                        "schritt": akt, "schritte_fertig": fertig, "schritte_gesamt": len(schritte),
                        "laufzeit_s": lauf_s, "schaetzung_gesamt_s": med}
                if med: info["prozent"] = min(99, int(100 * lauf_s / med)); info["rest_s"] = max(0, med - lauf_s)
                else: info["prozent"] = int(100 * fertig / len(schritte)) if schritte else None
                laufend[j["runner_name"]] = info
            elif j["status"] == "queued" and LABEL in j.get("labels", []):
                wartend.append({"repo": repo, "workflow": lauf.get("name", ""), "job": j["name"], "url": j["html_url"],
                                "wartezeit_s": int(jetzt - iso(j["created_at"])) if j.get("created_at") else None})
    return laufend, wartend

def laeufe_lesen(tok, repos):
    laeufe = []
    for repo in repos:
        for status in ("queued", "in_progress"):
            d = api("/repos/%s/%s/actions/runs?status=%s&per_page=50" % (ORG, repo, status), tok, etag=True)
            laeufe += [(repo, x) for x in d["workflow_runs"]]
    return laeufe


# ── Release-Warteschlange ──
def b64dec(t): return base64.b64decode(t).decode("utf-8", "replace")

def tag_da(tok, repo, tag):
    d = api("/repos/%s/%s/git/matching-refs/tags/%s" % (ORG, repo, tag), tok, etag=True)
    return any(x["ref"] == "refs/tags/" + tag for x in d)

def release_schritt(tok, zustand, frei_eigene, laeuft_runner_voll):
    """Fuehrt die Warteschlange. Gibt den Bericht fuer das NOC zurueck (oder None)."""
    rel = zustand.setdefault("_rel", {"apps": {}, "laeuft": {}, "uebersprungen": {}, "letzte": None, "repos": [], "repos_zeit": 0, "pruef_zeit": 0})
    aktiv = E["RELEASE_QUEUE"] == "1"
    # 1. Flutter-App-Repos (Aufrufer von basis app.yml), stuendlich neu bestimmen
    if now - rel["repos_zeit"] > 3600 or not rel["repos"]:
        liste = []
        for repo in repos:
            try:
                d = api("/repos/%s/%s/contents/.github/workflows/%s" % (ORG, repo, E["RELEASE_WORKFLOW"]), tok, etag=True)
                if "rosenweg-basis/.github/workflows/app.yml@" in b64dec(d.get("content", "")): liste.append(repo)
            except RuntimeError:
                pass   # 404: kein solcher Workflow
        rel["repos"], rel["repos_zeit"] = liste, now
    # 2. Faellige Versionen (alle RELEASE_PRUEF_S): pubspec-Version ohne Tag
    if now - rel["pruef_zeit"] >= int(E["RELEASE_PRUEF_S"]):
        rel["pruef_zeit"] = now
        for repo in rel["repos"]:
            try:
                f = api("/repos/%s/%s/contents/pubspec.yaml?ref=%s" % (ORG, repo, E["RELEASE_BRANCH"]), tok, etag=True)
                m = re.search(r"^version:\s*([0-9]+\.[0-9]+\.[0-9]+)", b64dec(f["content"]), re.M)
                if not m: continue
                tag = "v" + m.group(1)
                if tag_da(tok, repo, tag):
                    rel["apps"].pop(repo, None); continue
                c = api("/repos/%s/%s/commits?path=pubspec.yaml&sha=%s&per_page=1" % (ORG, repo, E["RELEASE_BRANCH"]), tok, etag=True)
                seit = c[0]["commit"]["committer"]["date"] if c else time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))
                rel["apps"][repo] = {"tag": tag, "seit": seit}
            except RuntimeError as e:
                log("Release-Pruefung %s: %s" % (repo, e), err=False)
    # 3. Laufende Releases beobachten
    for repo, l in list(rel["laeuft"].items()):
        try:
            d = api("/repos/%s/%s/actions/workflows/%s/runs?event=workflow_dispatch&per_page=5" % (ORG, repo, E["RELEASE_WORKFLOW"]), tok)
            seit_t = iso(l["seit"])
            lauf = next((x for x in d["workflow_runs"] if x["id"] == l.get("run_id")), None) or \
                   next((x for x in d["workflow_runs"] if iso(x["created_at"]) >= seit_t - 30), None)
            if lauf: l["run_id"], l["url"] = lauf["id"], lauf["html_url"]
            if lauf and lauf["status"] == "completed":
                ok = tag_da(tok, repo, l["tag"])
                if ok:
                    rel["letzte"] = {"repo": repo, "tag": l["tag"], "ergebnis": "fertig", "seit": l["seit"]}
                    log("Release fertig: %s %s" % (repo, l["tag"]))
                    del rel["laeuft"][repo]
                elif l.get("versuche", 0) < 1 and not TROCKEN:
                    log("Release %s %s fehlgeschlagen -> ein neuer Versuch" % (repo, l["tag"]))
                    release_starten(tok, repo, l["tag"], rel, versuche=1)
                else:
                    rel["uebersprungen"]["%s %s" % (repo, l["tag"])] = {"repo": repo, "tag": l["tag"], "seit": l["seit"], "url": l.get("url")}
                    rel["letzte"] = {"repo": repo, "tag": l["tag"], "ergebnis": "fehlgeschlagen", "seit": l["seit"]}
                    log("Release %s %s uebersprungen (zweimal fehlgeschlagen)" % (repo, l["tag"]), err=True)
                    del rel["laeuft"][repo]
            elif not lauf and now - iso(l["seit"]) > 900:
                # nach 15 Minuten kein Lauf zu sehen: Start ist ins Leere gegangen
                log("Release %s %s: kein Lauf gefunden -> zurueck in die Warteschlange" % (repo, l["tag"]), err=True)
                del rel["laeuft"][repo]
        except RuntimeError as e:
            log("Release-Lauf %s: %s" % (repo, e))
    # 4. Naechstes starten, nach Merge-Zeit
    wartend = sorted(((v["seit"], r, v["tag"]) for r, v in rel["apps"].items()
                      if r not in rel["laeuft"] and "%s %s" % (r, v["tag"]) not in rel["uebersprungen"]))
    # 5 macOS-Plaetze je Organisation, ein Release belegt 2 (macOS + iOS): ein weiteres nur,
    # wenn noch 2 frei sind. Linux, Android und Windows haben keine eigene Grenze.
    parallel = int(E["RELEASE_PARALLEL_MAX"]) if mac_laeuft[0] <= 3 else max(1, len(rel["laeuft"]))
    hinweis = None
    if aktiv:
        while wartend and len(rel["laeuft"]) < parallel:
            seit, repo, tag = wartend.pop(0)
            if TROCKEN:
                log("Release wuerde starten: %s %s (faellig seit %s)" % (repo, tag, seit)); break
            if not release_starten(tok, repo, tag, rel):
                hinweis = "Start nicht moeglich (Berechtigung Actions: Write der GitHub-App?)"; break
    else:
        hinweis = "Warteschlange ausgeschaltet (RELEASE_QUEUE=0): Releases starten wie bisher beim Merge"
    return {"aktiv": aktiv, "parallel_max": parallel, "hinweis": hinweis,
            "laeuft": [{"repo": r, "tag": l["tag"], "seit": l["seit"], "versuche": l.get("versuche", 0), "url": l.get("url")} for r, l in rel["laeuft"].items()],
            "wartend": [{"repo": r, "tag": t, "seit": s_} for s_, r, t in wartend][:20],
            "uebersprungen": list(rel["uebersprungen"].values())[-10:],
            "letzte": rel["letzte"]}

def release_starten(tok, repo, tag, rel, versuche=0):
    """workflow_dispatch mit veroeffentlichen=true am Zweig main. False bei Fehler."""
    daten = json.dumps({"ref": E["RELEASE_BRANCH"], "inputs": {"veroeffentlichen": "true"}}).encode()
    r = urllib.request.Request("https://api.github.com/repos/%s/%s/actions/workflows/%s/dispatches" % (ORG, repo, E["RELEASE_WORKFLOW"]),
        data=daten, method="POST", headers={"Authorization": "Bearer " + tok, "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "rw-runner-waechter", "Content-Type": "application/json"})
    calls["gesamt"] += 1
    try:
        urllib.request.urlopen(r, timeout=30).read()
    except urllib.error.HTTPError as e:
        log("Release-Start %s %s: HTTP %s" % (repo, tag, e.code), err=True)
        return False
    rel["laeuft"][repo] = {"tag": tag, "seit": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time())), "versuche": versuche, "run_id": None}
    schalten("Release gestartet: %s %s%s" % (repo, tag, " (zweiter Versuch)" if versuche else ""))
    return True

try:
    tok = app_token()
    api_runner = {r["name"]: r for r in seiten("/orgs/%s/actions/runners" % ORG, tok, "runners")}
    repos, n = [], 1
    while True:
        d = api("/orgs/%s/repos?per_page=100&page=%d" % (ORG, n), tok)
        repos += [x["name"] for x in d if not x.get("archived")]
        if len(d) < 100: break
        n += 1

    try: zustand = json.load(open(E["STATE"]))
    except Exception: zustand = {}
    dauern = zustand.setdefault("_dauern", {})
    for pfad, (et, daten) in (zustand.get("_etags") or {}).items(): etags[pfad] = (et, daten)

    laeufe = laeufe_lesen(tok, repos)
    laufend, wartend_liste = jobs_lesen(tok, laeufe, dauern)
    offen = sorted(lauf_zaehler.values(), key=lambda z: -(z["alter_s"] or 0))[:60]
    wartend = len(wartend_liste)
    stau = {"wartend": wartend, "lange": sum(1 for w in wartend_liste if (w.get("wartezeit_s") or 0) > int(E["STAU_S"])),
            "aeltester_s": max([w.get("wartezeit_s") or 0 for w in wartend_liste], default=0)}

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

    letzter = zustand.get("_letzter")
    def schalten(text):
        global letzter
        letzter = {"zeit": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "text": text}
        zustand["_letzter"] = letzter
        log(text)

    # Runner 1 immer an
    r1 = runner[0]
    if not r1["aktiv"]:
        schalten("Runner 1 ist aus -> starte %s" % r1["name"])
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
                schalten("Zuschalten %s (Vorgaenger busy, %d Job(s) warten, Last %.1f)" % (r["name"], wartend, last))
                if not TROCKEN:
                    p = ctl(r, "start", r["unit"])
                    if p.returncode: raise RuntimeError("Start %s: %s" % (r["name"], p.stderr.strip()))
                    zustand[r["name"]] = {"aktiv_seit": now, "zuletzt_busy": now}
                    r["aktiv"] = True
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
                        schalten("Abschalten %s (idle seit %d Min, keine Jobs wartend)" % (r["name"], leer // 60))
                        if not TROCKEN:
                            p = ctl(r, "stop", r["unit"])
                            if p.returncode: raise RuntimeError("Stopp %s: %s" % (r["name"], p.stderr.strip()))
                            r["aktiv"] = False

    release = None
    try:
        voll = all(r["aktiv"] and r["busy"] for r in runner)
        release = release_schritt(tok, zustand, not voll, voll)
    except Exception as e:
        log("Release-Warteschlange: %s" % e, err=True)

    zustand["_etags"] = {p: [et, d] for p, (et, d) in etags.items()}
    if not TROCKEN:
        tmp = E["STATE"] + ".tmp"
        json.dump(zustand, open(tmp, "w")); os.replace(tmp, E["STATE"])

    # ── Bericht ans NOC: dreimal je Lauf, dazwischen frische Messung ──
    vorher = {}
    for i in range(int(E["MESSUNGEN"])):
        if i:
            time.sleep(int(E["MESS_S"]))
            # nur Jobs der laufenden Laeufe neu, Laufliste bleibt vom Anfang des Laufs
            laufend, _ = jobs_lesen(tok, [x for x in laeufe if x[1]["status"] != "queued"], dauern)
            api_runner = {r["name"]: r for r in seiten("/orgs/%s/actions/runners" % ORG, tok, "runners")}
        cts = {}
        eintraege = []
        for r in runner:
            ck = (r["ip"], r["ct"])
            if ck not in cts:
                cts[ck] = messen_ct(r["ip"], r["ct"], [x["unit"] for x in runner if (x["ip"], x["ct"]) == ck])
            m = cts[ck]
            ram_dienst, cpu_dienst = None, None
            if r["unit"] in m["dienste"]:
                ram_dienst, usec = m["dienste"][r["unit"]]
                alt = vorher.get(r["unit"])
                if alt and usec is not None and alt[1] is not None and time.time() > alt[0]:
                    cpu_dienst = round(100 * (usec - alt[1]) / 1e6 / (time.time() - alt[0]), 1)
                vorher[r["unit"]] = (time.time(), usec)
            info = api_runner.get(r["name"], {})
            on, bz = info.get("status") == "online", bool(info.get("busy")) and info.get("status") == "online"
            eintraege.append({"name": r["name"], "art": "linux", "knoten": "pve2" if r["ip"] == E["LOKAL_IP"] else "pve3",
                              "ct": r["ct"], "online": on, "busy": bz, "dienst_aktiv": r["aktiv"],
                              "soll_an": r["aktiv"] or r is runner[0],
                              "job": laufend.get(r["name"]) if bz else None,
                              "dienst_cpu_pct": cpu_dienst, "dienst_ram_b": ram_dienst})
        ctinfo = [{"ct": ck[1], "knoten": "pve2" if ck[0] == E["LOKAL_IP"] else "pve3", "last": m["last"], "kerne": m["kerne"],
                   "ram_gesamt_b": m["ram_gesamt"], "ram_frei_b": m["ram_frei"]} for ck, m in cts.items()]
        for n_, inf in api_runner.items():
            if "rosenweg-windows" in [l["name"] for l in inf.get("labels", [])]:
                vm = messen_vm(E["WIN_VM"])
                on, bz = inf.get("status") == "online", bool(inf.get("busy")) and inf.get("status") == "online"
                eintraege.append({"name": n_, "art": "windows", "knoten": "pve2", "ct": "VM " + E["WIN_VM"], "online": on, "busy": bz,
                                  "dienst_aktiv": True, "soll_an": True, "job": laufend.get(n_) if bz else None,
                                  "vm": vm})
        bericht_senden({"runner": eintraege, "cts": ctinfo, "wartend": wartend, "warteschlange": wartend_liste[:10],
                        "trocken": TROCKEN, "letzter_schaltvorgang": letzter, "api_aufrufe": dict(calls),
                        "release": release, "stau": stau, "offen": offen})
    log("API-Aufrufe in diesem Lauf: %d (davon 304: %d)" % (calls["gesamt"], calls["304"]))
except Exception as e:
    log("FEHLER: %s" % e, err=True)
    try:
        bericht_senden({"runner": [{"name": r["name"], "online": r.get("online", False), "busy": r.get("busy", False),
                                    "dienst_aktiv": r.get("aktiv", False), "soll_an": r.get("aktiv", False)} for r in runner],
                        "fehler": str(e)})
    except Exception: pass
    sys.exit(1)
PY
