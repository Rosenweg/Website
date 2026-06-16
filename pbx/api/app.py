#!/usr/bin/env python3
"""
Standalone-PBX-API — laeuft IN CT 220 neben Asterisk (systemd, waitress).

Eigenstaendig wie das WhatsApp-Gateway: eigene SQLite, eigene Endpoints, keine
Abhaengigkeit zur Haupt-API fuer den Betrieb. Zwei Auth-Welten:

  * AGI-Endpoints (von Asterisk auf localhost aufgerufen): Shared-Secret
    X-PBX-Secret == PBX_SHARED_SECRET (steht schon in /etc/default/asterisk-env).
  * Admin-Endpoints (Web-UI): Reverse-Proxy-Auth gegen die Haupt-API
    (Bearer -> MAIN_API_BASE/api/auth/me, Gruppen Technik/Praesident). Nicht-
    eigene /api/*-Pfade (Login/Callback) werden an die Haupt-API durchgereicht,
    damit der Authentik-Flow auf pbx.rosenweg4303.ch funktioniert.

SIP-Telefone (LAN/VPN): aus der sip_extensions-Tabelle generiert die API
/etc/asterisk/pjsip_phones.conf und triggert 'pjsip reload' via AMI.
"""
import json
import os
import secrets as pysecrets
from datetime import datetime
from zoneinfo import ZoneInfo

import requests
from flask import Flask, jsonify, request, send_from_directory

import ami
import db
import voicemail

PBX_SHARED_SECRET = os.environ.get("PBX_SHARED_SECRET", "")
MAIN_API_BASE = os.environ.get("MAIN_API_BASE", "http://100.64.2.27:3000").rstrip("/")
PUBLIC_HOST = os.environ.get("PBX_PUBLIC_HOST", "pbx.rosenweg4303.ch")
PHONES_CONF = os.environ.get("ASTERISK_PHONES_CONF", "/etc/asterisk/pjsip_phones.conf")
WEB_DIR = os.environ.get("PBX_WEB_DIR", os.path.join(os.path.dirname(__file__), "..", "web"))
PORT = int(os.environ.get("PBX_API_PORT", "8095"))

app = Flask(__name__)


# ─── Auth-Helfer ────────────────────────────────────────────────────────────
def _bearer():
    h = request.headers.get("Authorization", "")
    return h[7:].strip() if h.lower().startswith("bearer ") else None


def current_user():
    """Validiert den Bearer-Token gegen die Haupt-API. None wenn ungueltig."""
    token = _bearer()
    if not token:
        return None
    try:
        r = requests.get(
            f"{MAIN_API_BASE}/api/auth/me",
            headers={"Authorization": f"Bearer {token}"},
            timeout=5,
        )
        if r.ok:
            return r.json().get("user")
    except requests.RequestException:
        return None
    return None


def is_admin(user):
    groups = [str(g).lower() for g in (user or {}).get("groups", [])]
    return "technik" in groups or "präsident" in groups or "praesident" in groups


def require_admin():
    """Gibt (user, None) bei Erfolg, sonst (None, flask-response)."""
    user = current_user()
    if not user:
        return None, (jsonify({"error": "Nicht angemeldet"}), 401)
    if not is_admin(user):
        return None, (jsonify({"error": "Nur fuer Technik / Praesident"}), 403)
    return user, None


def require_agi():
    provided = request.headers.get("X-PBX-Secret", "")
    if not PBX_SHARED_SECRET or provided != PBX_SHARED_SECRET:
        return jsonify({"error": "Unauthorized"}), 401
    return None


def actor(user):
    return user.get("email") or user.get("name") or "unbekannt"


# ─── Geschaeftszeit-Logik (Europe/Zurich) ───────────────────────────────────
def _cfg(conn):
    return {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM config")}


def is_open_now(conn):
    cfg = _cfg(conn)
    frm = cfg.get("hours_open_from", "06:00")
    to = cfg.get("hours_open_to", "20:00")
    now = datetime.now(ZoneInfo("Europe/Zurich"))
    hm = now.strftime("%H:%M")
    return frm <= hm < to, hm, frm, to


# ─── AGI-Endpoints (Asterisk -> localhost) ──────────────────────────────────
@app.get("/api/pbx/hours/check")
def hours_check():
    err = require_agi()
    if err:
        return err
    conn = db.connect()
    try:
        opn, hm, frm, to = is_open_now(conn)
        cfg = _cfg(conn)
        return jsonify({
            "is_open": opn, "now_local": hm, "from": frm, "to": to,
            "ring_timeout": int(cfg.get("ring_timeout", "30")),
        })
    finally:
        conn.close()


def _active_members(conn, is_open):
    sql = (
        "SELECT id, name, phone, kind, bypass_hours, priority FROM ring_members "
        "WHERE enabled = 1 AND (valid_until IS NULL OR valid_until > datetime('now')) "
        "AND (? = 1 OR bypass_hours = 1) ORDER BY priority, name"
    )
    return db.rows_to_dicts(conn.execute(sql, (1 if is_open else 0,)).fetchall())


@app.get("/api/pbx/ring-members/active")
def ring_members_active():
    err = require_agi()
    if err:
        return err
    q = request.args.get("open")
    is_open = True if q is None else q not in ("0", "false")
    conn = db.connect()
    try:
        return jsonify({"members": _active_members(conn, is_open), "open": is_open})
    finally:
        conn.close()


@app.get("/api/pbx/conference/members")
def conference_members():
    """Wer in die Technik-Konferenz geholt wird (alle aktiven, ohne Zeitsperre-Filter)."""
    err = require_agi()
    if err:
        return err
    conn = db.connect()
    try:
        return jsonify({"members": _active_members(conn, True)})
    finally:
        conn.close()


@app.get("/api/pbx/ring-members/by-ext/<int:ext>")
def ring_member_by_ext(ext):
    """AGI: interne Direktwahl (ab 1000) -> Ziel des Ring-Mitglieds."""
    err = require_agi()
    if err:
        return err
    conn = db.connect()
    try:
        row = conn.execute(
            "SELECT name, phone, kind FROM ring_members WHERE internal_ext = ? AND enabled = 1",
            (ext,),
        ).fetchone()
        if not row:
            return jsonify({"found": False}), 404
        return jsonify({"found": True, **dict(row)})
    finally:
        conn.close()


@app.post("/api/pbx/call-event")
def call_event():
    err = require_agi()
    if err:
        return err
    b = request.get_json(silent=True) or {}
    event, uid = b.get("event"), b.get("uniqueid")
    if not event or not uid:
        return jsonify({"error": "event + uniqueid erforderlich"}), 400
    conn = db.connect()
    try:
        if event == "start":
            conn.execute(
                "INSERT INTO calls (direction, caller_id, dialed, uniqueid, started_at, meta_json) "
                "VALUES (?,?,?,?, COALESCE(?, datetime('now')), ?) ON CONFLICT(uniqueid) DO NOTHING",
                (b.get("direction", "inbound"), b.get("caller_id"), b.get("dialed"), uid,
                 b.get("started_at"), json.dumps(b.get("meta") or {})),
            )
        elif event == "answer":
            conn.execute(
                "UPDATE calls SET answered_at = COALESCE(?, datetime('now')), answered_by = ? WHERE uniqueid = ?",
                (b.get("answered_at"), b.get("answered_by"), uid),
            )
        elif event == "end":
            conn.execute(
                "UPDATE calls SET ended_at = COALESCE(?, datetime('now')), hangup_cause = ?, "
                "duration_seconds = CASE WHEN answered_at IS NOT NULL THEN "
                "CAST((julianday(COALESCE(?, datetime('now'))) - julianday(answered_at)) * 86400 AS INTEGER) END "
                "WHERE uniqueid = ?",
                (b.get("ended_at"), b.get("hangup_cause"), b.get("ended_at"), uid),
            )
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


@app.post("/api/pbx/voicemail")
def voicemail_ingest():
    """Asterisk (transcribe_voicemail.py) postet die WAV roh. KI-Pipeline lokal:
    Transkript -> Analyse -> WhatsApp direkt via Gateway -> Speicherung."""
    err = require_agi()
    if err:
        return err
    audio = request.get_data()
    if not audio or len(audio) < 1024:
        return jsonify({"error": "Audio-Body fehlt oder zu klein"}), 400
    caller = str(request.headers.get("X-Caller-Id", "unbekannt"))[:50]
    uniqueid = str(request.headers.get("X-Unique-Id", ""))[:60]
    result = voicemail.process(audio, caller, uniqueid)
    # Transkript + Zusammenfassung am Call-Log-Eintrag speichern (per uniqueid).
    conn = db.connect()
    try:
        summary = result["analysis"].get("summary") or ""
        cur = conn.execute(
            "UPDATE calls SET voicemail_transcript = ?, voicemail_summary = ? WHERE uniqueid = ?",
            (result["transcript"], summary, uniqueid),
        )
        if cur.rowcount == 0:
            conn.execute(
                "INSERT INTO calls (direction, caller_id, uniqueid, voicemail_transcript, voicemail_summary) "
                "VALUES ('inbound', ?, ?, ?, ?)",
                (caller, uniqueid, result["transcript"], summary),
            )
        conn.commit()
    finally:
        conn.close()
    return jsonify({
        "ok": True,
        "transcript_len": len(result["transcript"]),
        "summary_present": bool(result["analysis"].get("summary")),
        "whatsapp_ok": result["whatsapp_ok"],
        "defekt": result["analysis"].get("is_defekt"),
        "reklamation_id": result.get("reklamation_id"),
    })


# ─── Admin-Endpoints (Web-UI, Reverse-Proxy-Auth) ───────────────────────────
@app.get("/api/pbx/trunk-status")
def trunk_status():
    _, deny = require_admin()
    if deny:
        return deny
    try:
        return jsonify(ami.trunk_status())
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": f"PBX nicht erreichbar (AMI): {e}"}), 503


@app.post("/api/pbx/test-call")
def test_call():
    _, deny = require_admin()
    if deny:
        return deny
    phone = str((request.get_json(silent=True) or {}).get("phone", "")).strip()
    if not phone.startswith("+") or not phone[1:].isdigit():
        return jsonify({"error": "phone im intl. Format erforderlich (+41...)"}), 400
    try:
        out = ami.originate(f"PJSIP/{phone}@peoplefone", "internal", "1000",
                            callerid="Rosenweg <90765821559>")
        return jsonify({"ok": True, "dialed": phone, "raw": out[:500]})
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": f"AMI-Fehler: {e}"}), 503


@app.get("/api/pbx/ring-members")
def ring_members_list():
    _, deny = require_admin()
    if deny:
        return deny
    conn = db.connect()
    try:
        rows = conn.execute(
            "SELECT id, name, phone, kind, bypass_hours, enabled, is_temporary, valid_until, "
            "priority, internal_ext, notiz, added_by, created_at, updated_at FROM ring_members ORDER BY priority, name"
        ).fetchall()
        return jsonify({"members": db.rows_to_dicts(rows)})
    finally:
        conn.close()


@app.post("/api/pbx/ring-members")
def ring_members_create():
    user, deny = require_admin()
    if deny:
        return deny
    b = request.get_json(silent=True) or {}
    name, phone = (b.get("name") or "").strip(), (b.get("phone") or "").strip()
    if not name or not phone:
        return jsonify({"error": "name + phone erforderlich"}), 400
    kind = "sip" if b.get("kind") == "sip" else "mobile"
    if kind == "sip":
        if not phone.replace("_", "").replace("-", "").isalnum():
            return jsonify({"error": "SIP-Extension ungueltig"}), 400
    else:
        if not phone.startswith("+") or not phone[1:].replace(" ", "").isdigit():
            return jsonify({"error": "Telefonnummer im intl. Format (+41...)"}), 400
        phone = "+" + phone[1:].replace(" ", "")
    conn = db.connect()
    try:
        iext = db.next_ext(conn, "ring_members", "internal_ext", 1000)
        cur = conn.execute(
            "INSERT INTO ring_members (name, phone, kind, bypass_hours, is_temporary, valid_until, priority, internal_ext, notiz, added_by) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (name, phone, kind, 1 if b.get("bypass_hours") else 0, 1 if b.get("is_temporary") else 0,
             b.get("valid_until"), int(b.get("priority") or 100), iext, b.get("notiz"), actor(user)),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM ring_members WHERE id = ?", (cur.lastrowid,)).fetchone()
        return jsonify({"member": dict(row)})
    finally:
        conn.close()


@app.put("/api/pbx/ring-members/<int:mid>")
def ring_members_update(mid):
    _, deny = require_admin()
    if deny:
        return deny
    b = request.get_json(silent=True) or {}
    allowed = ["name", "phone", "kind", "bypass_hours", "enabled", "is_temporary", "valid_until", "priority", "notiz"]
    sets, params = [], []
    for f in allowed:
        if f in b:
            val = b[f]
            if f in ("bypass_hours", "enabled", "is_temporary"):
                val = 1 if val else 0
            sets.append(f"{f} = ?")
            params.append(val)
    if not sets:
        return jsonify({"error": "Keine Aenderung"}), 400
    params.append(mid)
    conn = db.connect()
    try:
        conn.execute(f"UPDATE ring_members SET {', '.join(sets)}, updated_at = datetime('now') WHERE id = ?", params)
        conn.commit()
        row = conn.execute("SELECT * FROM ring_members WHERE id = ?", (mid,)).fetchone()
        if not row:
            return jsonify({"error": "Nicht gefunden"}), 404
        return jsonify({"member": dict(row)})
    finally:
        conn.close()


@app.delete("/api/pbx/ring-members/<int:mid>")
def ring_members_delete(mid):
    _, deny = require_admin()
    if deny:
        return deny
    conn = db.connect()
    try:
        conn.execute("DELETE FROM ring_members WHERE id = ?", (mid,))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


@app.get("/api/pbx/config")
def config_get():
    _, deny = require_admin()
    if deny:
        return deny
    conn = db.connect()
    try:
        cfg = {r["key"]: {"value": r["value"], "updated_at": r["updated_at"], "updated_by": r["updated_by"]}
               for r in conn.execute("SELECT key, value, updated_at, updated_by FROM config")}
        return jsonify({"config": cfg})
    finally:
        conn.close()


@app.put("/api/pbx/config")
def config_put():
    user, deny = require_admin()
    if deny:
        return deny
    b = request.get_json(silent=True) or {}
    allowed = {"hours_open_from", "hours_open_to", "ring_timeout", "weekdays"}
    import re as _re
    hhmm = _re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
    for k, v in b.items():
        if k not in allowed:
            return jsonify({"error": f"Unbekannter Key: {k}"}), 400
        if k in ("hours_open_from", "hours_open_to") and not hhmm.match(str(v)):
            return jsonify({"error": f"{k} muss HH:MM sein"}), 400
        if k == "ring_timeout" and not (str(v).isdigit() and 5 <= int(v) <= 120):
            return jsonify({"error": "ring_timeout muss 5-120 sein"}), 400
    conn = db.connect()
    try:
        for k, v in b.items():
            conn.execute(
                "INSERT INTO config (key, value, updated_by) VALUES (?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now'), updated_by=excluded.updated_by",
                (k, str(v), actor(user)),
            )
        conn.commit()
        return jsonify({"ok": True, "updated": list(b.keys())})
    finally:
        conn.close()


@app.get("/api/pbx/calls")
def calls_list():
    _, deny = require_admin()
    if deny:
        return deny
    limit = min(int(request.args.get("limit", 50) or 50), 200)
    conn = db.connect()
    try:
        rows = conn.execute(
            "SELECT id, direction, caller_id, dialed, started_at, answered_at, ended_at, answered_by, "
            "duration_seconds, hangup_cause, voicemail_transcript, voicemail_summary "
            "FROM calls ORDER BY started_at DESC LIMIT ?", (limit,)
        ).fetchall()
        return jsonify({"calls": db.rows_to_dicts(rows)})
    finally:
        conn.close()


# ─── SIP-Extensions (interne Telefone, LAN/VPN) ─────────────────────────────
def regenerate_phones_conf(conn):
    """Schreibt /etc/asterisk/pjsip_phones.conf aus der DB + triggert pjsip reload."""
    rows = conn.execute("SELECT ext, name, secret, context FROM sip_extensions WHERE enabled = 1 ORDER BY ext").fetchall()
    lines = [
        "; AUTO-GENERIERT von pbx-api (app.py) aus sip_extensions — NICHT manuell editieren.",
        "; Quelle of truth: SQLite. Aenderungen ueber das pbx-admin Web-UI.",
        "",
    ]
    for r in rows:
        ext, name, secret, ctx = r["ext"], r["name"], r["secret"], r["context"]
        # Kanonisches PJSIP-Muster: endpoint/auth/aor TEILEN den Namen (= Extension).
        # PJSIP-Sorcery unterscheidet per type=; der Registrar findet die AOR ueber
        # den To-User (= Extension). Getrennte -aor/-auth-Namen -> "AOR '' not found".
        lines += [
            f"[{ext}]",
            "type=endpoint",
            f"context={ctx}",
            "disallow=all",
            "allow=opus,g722,alaw,ulaw",
            f"auth={ext}",
            f"aors={ext}",
            f"callerid={name} <{ext}>",
            "direct_media=no",
            "rewrite_contact=yes",
            "force_rport=yes",
            "rtp_symmetric=yes",
            "",
            f"[{ext}]",
            "type=auth",
            "auth_type=userpass",
            f"username={ext}",
            f"password={secret}",
            "",
            f"[{ext}]",
            "type=aor",
            "max_contacts=2",
            "remove_existing=yes",
            "qualify_frequency=60",
            "",
        ]
    with open(PHONES_CONF, "w") as f:
        f.write("\n".join(lines))
    try:
        ami.reload_pjsip()
    except Exception:  # noqa: BLE001
        pass  # reload best-effort; Datei ist geschrieben, naechster Asterisk-Reload zieht sie


@app.get("/api/pbx/sip-extensions")
def sip_ext_list():
    _, deny = require_admin()
    if deny:
        return deny
    conn = db.connect()
    try:
        rows = conn.execute(
            "SELECT ext, name, secret, context, enabled, created_at, updated_at FROM sip_extensions ORDER BY ext"
        ).fetchall()
        exts = db.rows_to_dicts(rows)
        try:
            regs = ami.registered_aors()
        except Exception:  # noqa: BLE001
            regs = set()
        for e in exts:
            e["registered"] = str(e["ext"]) in regs
        return jsonify({"extensions": exts})
    finally:
        conn.close()


@app.post("/api/pbx/sip-extensions")
def sip_ext_create():
    _, deny = require_admin()
    if deny:
        return deny
    b = request.get_json(silent=True) or {}
    ext, name = str(b.get("ext", "")).strip(), str(b.get("name", "")).strip()
    if not name:
        return jsonify({"error": "name erforderlich"}), 400
    if ext and not ext.isdigit():
        return jsonify({"error": "Extension muss numerisch sein"}), 400
    secret = str(b.get("secret") or "").strip() or pysecrets.token_urlsafe(12)
    ctx = str(b.get("context") or "internal").strip()
    conn = db.connect()
    try:
        if not ext:
            ext = str(db.next_ext(conn, "sip_extensions", "ext", 2000))  # fortlaufend ab 2000
        conn.execute(
            "INSERT INTO sip_extensions (ext, name, secret, context) VALUES (?,?,?,?)",
            (ext, name, secret, ctx),
        )
        conn.commit()
        regenerate_phones_conf(conn)
        row = conn.execute("SELECT * FROM sip_extensions WHERE ext = ?", (ext,)).fetchone()
        return jsonify({"extension": dict(row)})
    except db.sqlite3.IntegrityError:
        return jsonify({"error": "Extension existiert bereits"}), 409
    finally:
        conn.close()


@app.delete("/api/pbx/sip-extensions/<ext>")
def sip_ext_delete(ext):
    _, deny = require_admin()
    if deny:
        return deny
    conn = db.connect()
    try:
        conn.execute("DELETE FROM sip_extensions WHERE ext = ?", (ext,))
        conn.commit()
        regenerate_phones_conf(conn)
        return jsonify({"ok": True})
    finally:
        conn.close()


# ─── Web-UI + Reverse-Proxy fuer den Login-Flow ─────────────────────────────
@app.get("/")
@app.get("/pbx-admin")
@app.get("/pbx-admin.html")
def serve_ui():
    return send_from_directory(os.path.abspath(WEB_DIR), "pbx-admin.html")


@app.get("/health")
def health():
    return jsonify({"ok": True, "service": "pbx-api"})


PROXY_PREFIXES = ("/api/auth", "/api/me")


@app.route("/api/<path:subpath>", methods=["GET", "POST", "PUT", "DELETE"])
def proxy_main_api(subpath):
    """Nicht-eigene /api/*-Pfade (Login/Callback/Userinfo) an die Haupt-API."""
    full = "/api/" + subpath
    if not full.startswith(PROXY_PREFIXES):
        return jsonify({"error": "Not found"}), 404
    url = f"{MAIN_API_BASE}{full}"
    headers = {k: v for k, v in request.headers if k.lower() not in ("host", "content-length")}
    headers["X-Forwarded-Host"] = PUBLIC_HOST
    headers["X-Forwarded-Proto"] = "https"
    try:
        resp = requests.request(
            request.method, url, headers=headers, params=request.args,
            data=request.get_data(), timeout=15, allow_redirects=False,
        )
        # Hop-by-hop-Header (PEP 3333 / RFC 2616) MUESSEN raus — waitress wirft
        # sonst AssertionError (z.B. bei "Keep-Alive" vom direkt erreichten Node-API).
        excluded = {"content-encoding", "content-length", "transfer-encoding", "connection",
                    "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
                    "trailer", "trailers", "upgrade"}
        out_headers = [(k, v) for k, v in resp.headers.items() if k.lower() not in excluded]
        return (resp.content, resp.status_code, out_headers)
    except requests.RequestException as e:
        return jsonify({"error": f"Upstream-Fehler: {e}"}), 502


if __name__ == "__main__":
    db.init_db()
    from waitress import serve
    serve(app, host="0.0.0.0", port=PORT)
