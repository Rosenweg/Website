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
import hashlib
import hmac
import json
import time
import os
import re
import secrets as pysecrets
from datetime import datetime, timedelta, timezone
from xml.sax.saxutils import escape as xesc
from zoneinfo import ZoneInfo

import requests
import segno
from flask import Flask, Response, jsonify, request, send_file, send_from_directory

import ami
import db
import nummernvergabe
import voicemail

PBX_SHARED_SECRET = os.environ.get("PBX_SHARED_SECRET", "")
# Die Adresse der Hauptanwendung. Sie stand bis zum 4. September 2026 auf
# 100.64.2.27 — dem Eingang des Swarms, den es seit der Entschwarmung nicht
# mehr gibt. Die PBX lief seither ins Leere: keine Anrufernamen, keine
# Benachrichtigungen, und seit dem 9. Juni keine einzige abgelegte
# Sprachnachricht. Aufgefallen ist es erst, als jemand nach der Aufzeichnung
# eines Anrufs fragte.
MAIN_API_BASE = os.environ.get("MAIN_API_BASE", "http://100.64.2.52:3000").rstrip("/")
PUBLIC_HOST = os.environ.get("PBX_PUBLIC_HOST", "pbx.rosenweg4303.ch")
PHONES_CONF = os.environ.get("ASTERISK_PHONES_CONF", "/etc/asterisk/pjsip_phones.conf")
WEB_DIR = os.environ.get("PBX_WEB_DIR", os.path.join(os.path.dirname(__file__), "..", "web"))
PORT = int(os.environ.get("PBX_API_PORT", "8095"))

# ─── Linphone-Provisionierung ───────────────────────────────────────────────
# Der QR-Code am Telefon enthaelt nur eine URL; Linphone laedt darueber eine
# linphonerc-XML (Assistent -> "Fetch Remote Configuration"). Weil in dieser
# XML das SIP-Passwort steht, ist die URL ein Einmal-Token mit kurzer Frist.
PROV_SIP_HOST = os.environ.get("PBX_SIP_HOST", "sip.rosenweg4303.ch")
PROV_TRANSPORT = os.environ.get("PBX_SIP_TRANSPORT", "tcp")
# Anmeldung in den Rosenweg-Apps (Authentik "rosenweg-apps", oeffentlicher Client mit PKCE):
# die Anlage prueft das Token selbst ueber userinfo (die Introspektion der Haupt-API kennt
# nur Tokens ihres eigenen Clients).
AUTHENTIK_USERINFO = os.environ.get("AUTHENTIK_USERINFO_URL",
                                    "https://authentik.rosenweg4303.ch/application/o/userinfo/")  # tcp haelt die Registrierung im Doze
PROV_EXPIRES = os.environ.get("PBX_SIP_REG_EXPIRES", "120")
PROV_TTL_MIN = int(os.environ.get("PBX_PROV_TTL_MIN", "15"))
# CardDAV-Verzeichnis (zentrales Telefonbuch). Leer = nicht mitprovisionieren.
# Sektion und Schluessel stammen aus liblinphone selbst (core.cpp sucht Sektionen
# mit Praefix "carddav_", carddav-params.cpp liest die Schluessel) — nicht aus der
# Doku, die sich hier widerspricht.
PROV_CARDDAV_URL = os.environ.get("PBX_CARDDAV_URL", "")
PROV_CARDDAV_USER = os.environ.get("PBX_CARDDAV_USER", "")
PROV_CARDDAV_PASS = os.environ.get("PBX_CARDDAV_PASS", "")
# Der HTTP-Basic-Realm, den der Server im 401 schickt. liblinphone sucht die
# AuthInfo ueber Realm + Domain, nicht ueber die URL.
PROV_CARDDAV_REALM = os.environ.get("PBX_CARDDAV_REALM", "")
PROV_CARDDAV_NAME = os.environ.get("PBX_CARDDAV_NAME", "Rosenweg")

# ─── SIP-Clients ────────────────────────────────────────────────────────────
# Welche App an einer Nebenstelle haengt, bestimmt zwei Dinge: was Asterisk im
# SDP anbietet und welche Datei die Provisionierung ausliefert.
#
# android-sip (github.com/hell3lazer/Android-SIP, Sipdroid-Fork mit nativer
# Telecom-Anbindung — die Anrufe laufen ueber die normale Telefon-App):
#   * Seine SDP-Antwort fuehrt die DTMF-Payload (101) im m=-Feld, ohne die
#     zugehoerige a=rtpmap-Zeile. pjproject verwirft so eine Antwort mit
#     PJMEDIA_SDP_EMISSINGRTPMAP und bricht JEDEN eingehenden Anruf ab, noch
#     waehrend es klingelt. Bietet Asterisk kein telephone-event an
#     (dtmf_mode=inband), kommt die 101 gar nicht erst zurueck.
#   * Opus kann die App nicht; ohne ihn bleibt das Angebot kuerzer.
#   Getestet am 23.11.2026 mit einem Galaxy A15 (Android 16), App 1.4.
CLIENTS = ("linphone", "android-sip")
ENDPOINT_PROFILE = {
    "linphone": ["allow=opus,g722,alaw,ulaw"],
    "android-sip": ["allow=g722,alaw,ulaw", "dtmf_mode=inband"],
}

# Persoenliche Voicemails (3000er-Nummern), getrennt von der STWEG-Voicemail.
VM_PERSON_DIR = os.environ.get("PBX_VM_PERSON_DIR", "/var/spool/asterisk/voicemail/personen")

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
    # zeitkonstant vergleichen (D-15)
    if not PBX_SHARED_SECRET or not hmac.compare_digest(provided.encode(), PBX_SHARED_SECRET.encode()):
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
            _call_personen(conn, uid, b.get("direction", "inbound"), b.get("caller_id"), b.get("dialed"))
        elif event == "answer":
            conn.execute(
                "UPDATE calls SET answered_at = COALESCE(?, datetime('now')), answered_by = ? WHERE uniqueid = ?",
                (b.get("answered_at"), b.get("answered_by"), uid),
            )
            # eingehend: wer abgenommen hat, ist die Person dieses Anrufs
            if db.ist_nebenstelle(conn, b.get("answered_by")):
                conn.execute("UPDATE calls SET ext = ?, person = ? WHERE uniqueid = ? AND ext IS NULL",
                             (str(b.get("answered_by")), _person_jetzt(conn, b.get("answered_by")), uid))
        elif event == "end":
            conn.execute(
                "UPDATE calls SET ended_at = COALESCE(?, datetime('now')), hangup_cause = ?, "
                "duration_seconds = CASE WHEN answered_at IS NOT NULL THEN "
                "CAST((julianday(COALESCE(?, datetime('now'))) - julianday(answered_at)) * 86400 AS INTEGER) END "
                "WHERE uniqueid = ?",
                (b.get("ended_at"), b.get("hangup_cause"), b.get("ended_at"), uid),
            )
        elif event == "cdr":
            # Komplett-Record aus dem Hangup-Handler (ausgehende + interne Anrufe).
            conn.execute(
                "INSERT INTO calls (direction, caller_id, dialed, uniqueid, started_at, ended_at, "
                "duration_seconds, hangup_cause) VALUES (?,?,?,?, COALESCE(?, datetime('now')), datetime('now'), ?, ?) "
                "ON CONFLICT(uniqueid) DO UPDATE SET direction=excluded.direction, caller_id=excluded.caller_id, "
                "dialed=excluded.dialed, duration_seconds=excluded.duration_seconds, "
                "hangup_cause=excluded.hangup_cause, ended_at=excluded.ended_at",
                (b.get("direction", "internal"), b.get("caller_id"), b.get("dialed"), uid,
                 b.get("started_at"), b.get("duration_seconds"), b.get("hangup_cause")),
            )
            _call_personen(conn, uid, b.get("direction", "internal"), b.get("caller_id"), b.get("dialed"))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


def _person_jetzt(conn, ext):
    """E-Mail der Person, die gerade an `ext` angemeldet ist (geteilte Telefone)."""
    if not ext:
        return None
    r = conn.execute("SELECT email FROM telefon_sitzungen WHERE ext = ?", (str(ext),)).fetchone()
    return r["email"] if r and r["email"] else None


def _nummer_der_person(conn, email, name):
    """Persoenliche Nummer zu E-Mail + Name. Teilen sich mehrere Personen die E-Mail,
    entscheidet der Name; sonst die erste (kleinste) Nummer."""
    rows = conn.execute("SELECT nummer, name FROM personen_nummern WHERE lower(email) = lower(?) AND aktiv = 1 "
                        "ORDER BY nummer", (email or "",)).fetchall()
    for r in rows:
        if _gleiche_person(r["name"], name):
            return r["nummer"]
    return rows[0]["nummer"] if rows else ""


def _person_der_nummer(conn, nummer):
    """E-Mail zu einer persoenlichen Nummer (3HHWWP), sonst None."""
    if not nummer:
        return None
    r = conn.execute("SELECT email FROM personen_nummern WHERE nummer = ?", (str(nummer),)).fetchone()
    return r["email"] if r else None


def _call_personen(conn, uid, direction, caller_id, dialed):
    """Anruf den Personen zuordnen: anrufende Seite (intern/ausgehend) und angerufene
    Seite (intern) — als Nebenstelle (Person aus der Sitzung) oder als persoenliche
    Nummer (3HHWWP). Bereits gesetzte Werte bleiben."""
    ext = person = ziel = ziel_person = None
    if direction in ("internal", "outbound"):
        if db.ist_nebenstelle(conn, caller_id):
            ext, person = str(caller_id), _person_jetzt(conn, caller_id)
        else:
            person = _person_der_nummer(conn, caller_id)
    if direction == "internal":
        if db.ist_nebenstelle(conn, dialed):
            ziel, ziel_person = str(dialed), _person_jetzt(conn, dialed)
        else:
            ziel_person = _person_der_nummer(conn, dialed)
    conn.execute(
        "UPDATE calls SET ext = COALESCE(ext, ?), person = COALESCE(person, ?), "
        "ziel_ext = COALESCE(ziel_ext, ?), ziel_person = COALESCE(ziel_person, ?) WHERE uniqueid = ?",
        (ext, person, ziel, ziel_person, uid))


# ─── Nummernplan im Dialplan (AGI) ──────────────────────────────────────────
_ZIEL_RE = re.compile(r"^(\+[1-9][0-9]{6,14}|0[1-9][0-9]{7,12})$")


@app.get("/api/pbx/person/<nummer>")
def person_agi(nummer):
    """AGI: wohin klingelt eine persoenliche Nummer? Alle Geraete, an denen die
    Person angemeldet ist, plus ein eigenes Endgeraet mit dieser Nummer."""
    err = require_agi()
    if err:
        return err
    conn = db.connect()
    try:
        p = conn.execute("SELECT * FROM personen_nummern WHERE nummer = ? AND aktiv = 1", (nummer,)).fetchone()
        if not p:
            return jsonify({"ok": False})
        sitzungen = [r["ext"] for r in conn.execute(
            "SELECT s.ext FROM telefon_sitzungen s JOIN sip_extensions e ON e.ext = s.ext "
            "WHERE lower(s.email) = lower(?) AND e.enabled = 1 ORDER BY s.ext", (p["email"],))]
        # Rosenweg Telefon mit persoenlichem Zugang (<nummer>-<ext>) klingelt statt der
        # Geraete-App. Ist er (noch) nicht registriert — alte App, kein Netz, AMI weg —,
        # klingelt wie bisher die Nebenstelle des Geraets.
        persoenlich = {r["ext"]: f"{r['nummer']}-{r['ext']}" for r in conn.execute(
            "SELECT ext, nummer FROM telefon_sip_person WHERE nummer = ?", (nummer,))}
        try:
            registriert = ami.registered_aors() if persoenlich else set()
        except Exception:  # noqa: BLE001
            registriert = set()
        ohne = request.args.get("ohne") or ""
        # anrufendes Geraet nicht mitklingeln lassen (Nebenstelle oder persoenlicher Zugang)
        ohne_ext = ohne.split("-", 1)[1] if SIP_PERSON_RE.fullmatch(ohne) else ohne
        ziele = []
        for ext in sitzungen:
            if ext == ohne_ext:
                continue
            pz = persoenlich.get(ext)
            ziele.append(pz if pz and pz in registriert else ext)
        # Rosenweg Telefon auf eigenen Handys (<nummer>-p<id>), nur wenn registriert
        privat = [f"{r['nummer']}-p{r['id']}" for r in conn.execute(
            "SELECT id, nummer FROM telefon_sip_privat WHERE nummer = ? ORDER BY id", (nummer,))]
        if privat:
            try:
                registriert = registriert or ami.registered_aors()
            except Exception:  # noqa: BLE001
                pass
            ziele += [k for k in privat if k in registriert and k != ohne]
        if db.ist_nebenstelle(conn, nummer) and str(nummer) != ohne:
            ziele.append(str(nummer))   # Rosenweg Telefon auf dem privaten Handy
        wl = p["weiterleitung"] if p["weiterleitung"] in ("aus", "immer", "nicht_erreichbar") else "aus"
        ziel = (p["weiterleitung_ziel"] or "").replace(" ", "")
        if wl != "aus" and not _ZIEL_RE.match(ziel):
            wl = "aus"   # ohne gueltiges Ziel keine Weiterleitung
        return jsonify({
            "ok": True, "name": p["name"],
            "dial": "&".join(f"PJSIP/{z}" for z in ziele),
            "weiterleitung": wl, "ziel": ziel if wl != "aus" else "",
            "sekunden": max(5, min(int(p["weiterleitung_sekunden"] or 20), 60)),
            "voicemail": 1 if p["voicemail"] else 0,
        })
    finally:
        conn.close()


@app.get("/api/pbx/verwaltung/<nummer>")
def verwaltung_agi(nummer):
    """AGI: 4000er Kurzwahl der Hausverwaltung -> externe Nummer."""
    err = require_agi()
    if err:
        return err
    conn = db.connect()
    try:
        r = conn.execute("SELECT name, ziel FROM verwaltung_nummern WHERE nummer = ? AND aktiv = 1", (nummer,)).fetchone()
        ziel = (r["ziel"] or "").replace(" ", "") if r else ""
        if not r or not _ZIEL_RE.match(ziel):
            return jsonify({"ok": False})
        return jsonify({"ok": True, "name": r["name"], "ziel": ziel})
    finally:
        conn.close()


@app.post("/api/pbx/voicemail-person")
def voicemail_person_agi():
    """AGI: persoenliche Voicemail aufgenommen. Gehoert nur der Person — nicht in
    die Technik-Gruppe (die Analyse/WhatsApp-Pipeline von /api/pbx/voicemail)."""
    err = require_agi()
    if err:
        return err
    b = request.get_json(silent=True) or {}
    uid, nummer, pfad = str(b.get("uniqueid") or "")[:60], str(b.get("nummer") or ""), str(b.get("pfad") or "")
    if not uid or not re.fullmatch(r"3[0-9]{5}", nummer) or not pfad.startswith(VM_PERSON_DIR + "/"):
        return jsonify({"error": "ungueltig"}), 400
    conn = db.connect()
    try:
        email = _person_der_nummer(conn, nummer)
        if not email:
            return jsonify({"error": "Nummer unbekannt"}), 404
        cur = conn.execute("UPDATE calls SET ziel_person = COALESCE(ziel_person, ?), voicemail_path = ? WHERE uniqueid = ?",
                           (email, pfad, uid))
        if cur.rowcount == 0:
            conn.execute("INSERT INTO calls (direction, caller_id, dialed, uniqueid, ziel_person, voicemail_path) "
                         "VALUES ('internal', ?, ?, ?, ?, ?)", (b.get("caller_id"), nummer, uid, email, pfad))
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


# Ziel-/Namenswerte landen in Dial-Strings, Call-Files und AGI-Befehlen der
# Asterisk-Seite: dort waere ein Zeilenumbruch ein eigener Befehl (D-5). Darum
# hier pruefen — fuer Anlegen UND Aendern (PUT nahm bisher alles ungeprueft).
_STEUERZEICHEN = re.compile(r"[\x00-\x1f\x7f]")
_DATUM = re.compile(r"^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$")


def _ring_member_pruefen(b, kind_bisher=None):
    """Gibt (werte, None) oder (None, fehlertext). Nur uebergebene Felder."""
    out = {}
    if "name" in b:
        name = str(b.get("name") or "").strip()
        if not name or len(name) > 80 or _STEUERZEICHEN.search(name) or any(c in name for c in '"\\<>'):
            return None, "name ungueltig (1-80 Zeichen, keine Steuerzeichen/Anfuehrungszeichen)"
        out["name"] = name
    kind = kind_bisher or "mobile"
    if "kind" in b:
        kind = "sip" if b.get("kind") == "sip" else "mobile"
        out["kind"] = kind
    if "phone" in b or "kind" in b:
        phone = str(b.get("phone") if "phone" in b else (b.get("_phone_bisher") or "")).strip()
        if kind == "sip":
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", phone):
                return None, "SIP-Extension ungueltig"
        else:
            phone = "+" + phone[1:].replace(" ", "") if phone.startswith("+") else phone
            if not re.fullmatch(r"\+[0-9]{6,20}", phone):
                return None, "Telefonnummer im intl. Format (+41...)"
        out["phone"] = phone
    if "priority" in b:
        try:
            prio = int(b.get("priority") if b.get("priority") is not None else 100)
        except (TypeError, ValueError):
            return None, "priority muss eine Zahl sein"
        if not 0 <= prio <= 10000:
            return None, "priority muss 0-10000 sein"
        out["priority"] = prio
    if "valid_until" in b:
        vu = b.get("valid_until")
        if vu not in (None, "") and not _DATUM.match(str(vu)):
            return None, "valid_until muss ein Datum sein (YYYY-MM-DD)"
        out["valid_until"] = vu or None
    if "notiz" in b:
        notiz = b.get("notiz")
        out["notiz"] = None if notiz is None else re.sub(r"[\x00-\x09\x0b-\x1f\x7f]", " ", str(notiz))[:500]
    for f in ("bypass_hours", "enabled", "is_temporary"):
        if f in b:
            out[f] = 1 if b.get(f) else 0
    return out, None


@app.post("/api/pbx/ring-members")
def ring_members_create():
    user, deny = require_admin()
    if deny:
        return deny
    b = request.get_json(silent=True) or {}
    if not (b.get("name") or "").strip() or not (b.get("phone") or "").strip():
        return jsonify({"error": "name + phone erforderlich"}), 400
    werte, fehler = _ring_member_pruefen({**b, "kind": b.get("kind") or "mobile"})
    if fehler:
        return jsonify({"error": fehler}), 400
    name, phone, kind = werte["name"], werte["phone"], werte["kind"]
    b = {**b, **werte}
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
    conn = db.connect()
    try:
        bisher = conn.execute("SELECT kind, phone FROM ring_members WHERE id = ?", (mid,)).fetchone()
        if not bisher:
            return jsonify({"error": "Nicht gefunden"}), 404
        werte, fehler = _ring_member_pruefen(
            {**{f: b[f] for f in allowed if f in b}, "_phone_bisher": bisher["phone"]},
            kind_bisher=bisher["kind"])
        if fehler:
            return jsonify({"error": fehler}), 400
        sets, params = [], []
        for f in allowed:
            if f in werte:
                sets.append(f"{f} = ?")
                params.append(werte[f])
        if not sets:
            return jsonify({"error": "Keine Aenderung"}), 400
        params.append(mid)
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
    allowed = {"hours_open_from", "hours_open_to", "ring_timeout", "weekdays", "telefon_gruppen",
               "telefon_ausblenden", "telefon_unsichtbar"}
    import re as _re
    hhmm = _re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
    for k, v in b.items():
        if k not in allowed:
            return jsonify({"error": f"Unbekannter Key: {k}"}), 400
        if k in ("hours_open_from", "hours_open_to") and not hhmm.match(str(v)):
            return jsonify({"error": f"{k} muss HH:MM sein"}), 400
        if k == "ring_timeout" and not (str(v).isdigit() and 5 <= int(v) <= 120):
            return jsonify({"error": "ring_timeout muss 5-120 sein"}), 400
        if k in ("telefon_ausblenden", "telefon_unsichtbar") and not _re.fullmatch(r"[A-Za-z0-9_.,\s]{0,4000}", str(v)):
            return jsonify({"error": "telefon_ausblenden: Paketnamen durch Komma getrennt"}), 400
        if k == "telefon_gruppen" and not _re.fullmatch(r"[\w äöüÄÖÜ,.-]{0,300}", str(v)):
            return jsonify({"error": "telefon_gruppen: Gruppennamen durch Komma getrennt"}), 400
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
# Kontexte, in die ein internes Telefon gehoeren darf (extensions.conf).
# 'geteilt' = geteiltes Telefon: ohne Anmeldung nur Notrufe (extensions.conf [geteilt]).
SIP_KONTEXTE = {"internal", "geteilt"}


def regenerate_phones_conf(conn):
    """Schreibt /etc/asterisk/pjsip_phones.conf aus der DB + triggert pjsip reload."""
    rows = conn.execute(
        "SELECT ext, name, secret, context, client FROM sip_extensions WHERE enabled = 1 ORDER BY ext"
    ).fetchall()
    lines = [
        "; AUTO-GENERIERT von pbx-api (app.py) aus sip_extensions — NICHT manuell editieren.",
        "; Quelle of truth: SQLite. Aenderungen ueber das pbx-admin Web-UI.",
        "",
    ]
    for r in rows:
        ext, name, secret, ctx = r["ext"], r["name"], r["secret"], r["context"]
        # Altbestand absichern: nichts, was eine neue Zeile oder einen Abschnitt beginnt.
        # Secret nur auf Zeilenumbruch/Steuerzeichen und [ ] pruefen (R2-Df): aeltere
        # Secrets mit anderen Sonderzeichen sollen nicht still wegfallen; neue
        # Secrets prueft sip_ext_create ohnehin streng. ';' leitet in Asterisk-
        # Konfig einen Kommentar ein (R3-De): password=ab;cd ergaebe still "ab".
        if not re.fullmatch(r"[0-9]{2,8}", str(ext)) or not re.fullmatch(r"[^\x00-\x1f\x7f\[\];]{1,128}", str(secret or "")) \
                or ctx not in SIP_KONTEXTE:
            # Laut melden statt still auslassen: sonst faellt ein Telefon ohne Hinweis aus.
            print(f"[pbx-api] SIP-Extension {re.sub(r'[^0-9A-Za-z]', '?', str(ext))[:12]} "
                  "nicht in pjsip_phones.conf geschrieben (ungueltige Extension/Secret/Kontext)", flush=True)
            continue
        name = re.sub(r'[\x00-\x1f\x7f"<>\[\];\\]', " ", str(name or ""))[:60]
        # Kanonisches PJSIP-Muster: endpoint/auth/aor TEILEN den Namen (= Extension).
        # PJSIP-Sorcery unterscheidet per type=; der Registrar findet die AOR ueber
        # den To-User (= Extension). Getrennte -aor/-auth-Namen -> "AOR '' not found".
        lines += [
            f"[{ext}]",
            "type=endpoint",
            f"context={ctx}",
            "disallow=all",
            *ENDPOINT_PROFILE.get(r["client"], ENDPOINT_PROFILE["linphone"]),
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
    lines += _sip_person_abschnitte(conn)
    lines += _sip_privat_abschnitte(conn)
    with open(PHONES_CONF, "w") as f:
        f.write("\n".join(lines))
    try:
        ami.reload_pjsip()
    except Exception:  # noqa: BLE001
        pass  # reload best-effort; Datei ist geschrieben, naechster Asterisk-Reload zieht sie


# ─── Persoenliches SIP-Konto in Rosenweg Telefon ────────────────────────────
# Stefan 25.11.2026: Rosenweg Telefon registriert die persoenliche Nummer der
# angemeldeten Person, die Geraete-App weiter die Nebenstelle des Geraets (2102 ...).
# Pro Sitzung ein eigener Zugang <nummer>-<ext> (endpoint, auth und aor gleichen
# Namens wie bei den Nebenstellen): Abmelden loescht ihn, die Registrierung des
# abgemeldeten Geraets ist damit sofort weg und es klingelt nie mehr fuer die Person.
# Ein gemeinsamer Endpunkt pro Nummer mit mehreren auth-Objekten haette das nicht:
# die Contacts der AOR blieben nach dem Abmelden bis zum Ablauf stehen.
# Gehende Anrufe: Kontext [person] (extensions.conf), Caller-ID "Name <nummer>".
SIP_PERSON_RE = re.compile(r"3[0-9]{5}-[0-9]{2,8}")


def _zugang_abschnitte(kennung, passwort, name, nummer):
    """endpoint/auth/aor eines persoenlichen Zugangs (Kontext [person], Caller-ID der Person)."""
    name = re.sub(r'[\x00-\x1f\x7f"<>\[\];\\]', " ", str(name or ""))[:60]
    return [
        f"[{kennung}]",
        "type=endpoint",
        "context=person",
        "disallow=all",
        # Rosenweg Telefon nutzt denselben Sipdroid-Kern wie die Geraete-App
        *ENDPOINT_PROFILE["android-sip"],
        f"auth={kennung}",
        f"aors={kennung}",
        f"callerid={name} <{nummer}>",
        "direct_media=no",
        "rewrite_contact=yes",
        "force_rport=yes",
        "rtp_symmetric=yes",
        "",
        f"[{kennung}]",
        "type=auth",
        "auth_type=userpass",
        f"username={kennung}",
        f"password={passwort}",
        "",
        f"[{kennung}]",
        "type=aor",
        "max_contacts=1",
        "remove_existing=yes",
        "qualify_frequency=60",
        "",
    ]


_PASSWORT_RE = re.compile(r"[A-Za-z0-9_-]{16,64}")


def _sip_person_abschnitte(conn):
    """pjsip-Abschnitte fuer alle persoenlichen Zugaenge mit gueltiger Sitzung."""
    rows = conn.execute(
        "SELECT p.ext, p.nummer, p.passwort, n.name FROM telefon_sip_person p "
        "JOIN telefon_sitzungen s ON s.ext = p.ext AND lower(s.email) = lower(p.email) "
        "JOIN personen_nummern n ON n.nummer = p.nummer AND n.aktiv = 1 "
        "JOIN sip_extensions e ON e.ext = p.ext AND e.enabled = 1 "
        "ORDER BY p.ext").fetchall()
    lines = ["; Persoenliche Zugaenge (telefon_sip_person): <nummer>-<geraet>, nur waehrend der Sitzung", ""]
    for r in rows:
        kennung = f"{r['nummer']}-{r['ext']}"
        if not SIP_PERSON_RE.fullmatch(kennung) or not _PASSWORT_RE.fullmatch(str(r["passwort"] or "")):
            print(f"[pbx-api] persoenlicher Zugang an {re.sub(r'[^0-9]', '?', str(r['ext']))[:12]} "
                  "nicht geschrieben (ungueltig)", flush=True)
            continue
        lines += _zugang_abschnitte(kennung, r["passwort"], r["name"], r["nummer"])
    return lines


def _sip_person_anlegen(conn, ext):
    """Nach dem Anmelden: neuer Zugang fuer die Person an diesem Geraet (altes Passwort weg).
    Gibt die persoenliche Nummer zurueck oder None (Person ohne Nummer)."""
    conn.execute("DELETE FROM telefon_sip_person WHERE ext = ?", (ext,))
    s = conn.execute("SELECT email, name FROM telefon_sitzungen WHERE ext = ?", (ext,)).fetchone()
    if not s or not s["email"]:
        return None
    nummer = str(_nummer_der_person(conn, s["email"], s["name"]) or "")
    if not re.fullmatch(r"3[0-9]{5}", nummer):
        return None
    conn.execute("INSERT INTO telefon_sip_person (ext, nummer, email, passwort) VALUES (?,?,?,?)",
                 (ext, nummer, str(s["email"]).lower(), pysecrets.token_urlsafe(24)))
    return nummer


def _sip_person_neu_laden():
    """pjsip_phones.conf nach einem Sitzungswechsel neu schreiben (nach dem commit)."""
    try:
        c = db.connect()
        try:
            regenerate_phones_conf(c)
        finally:
            c.close()
    except Exception as e:  # noqa: BLE001
        app.logger.warning("pjsip_phones.conf nicht geschrieben: %s", type(e).__name__)


def sip_person_aufraeumen():
    """Sicherung (stuendlich): Zugaenge ohne passende Sitzung loeschen, z.B. wenn eine
    Abmeldung an einem anderen Weg vorbeiging."""
    conn = db.connect()
    try:
        n = conn.execute(
            "DELETE FROM telefon_sip_person WHERE NOT EXISTS (SELECT 1 FROM telefon_sitzungen s "
            "WHERE s.ext = telefon_sip_person.ext AND lower(s.email) = lower(telefon_sip_person.email))").rowcount
        conn.commit()
    finally:
        conn.close()
    if n:
        app.logger.warning("%d persoenliche SIP-Zugaenge ohne Sitzung entfernt", n)
        _sip_person_neu_laden()


@app.get("/api/pbx/sip-extensions")
def sip_ext_list():
    _, deny = require_admin()
    if deny:
        return deny
    conn = db.connect()
    try:
        rows = conn.execute(
            "SELECT ext, name, secret, context, client, enabled, created_at, updated_at "
            "FROM sip_extensions ORDER BY ext"
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
    if ext and not re.fullmatch(r"[0-9]{2,8}", ext):
        return jsonify({"error": "Extension muss numerisch sein"}), 400
    # name/secret/context landen in pjsip_phones.conf: ein Zeilenumbruch oder
    # "[" haette eigene Abschnitte (Endpunkte, Kontexte) einschleusen koennen (D-5).
    if len(name) > 60 or _STEUERZEICHEN.search(name) or any(c in name for c in '"<>[];\\'):
        return jsonify({"error": "name ungueltig (max. 60 Zeichen, keine Sonderzeichen wie [ ] < > ; \")"}), 400
    secret = str(b.get("secret") or "").strip() or pysecrets.token_urlsafe(12)
    if not re.fullmatch(r"[A-Za-z0-9._~-]{8,64}", secret):
        return jsonify({"error": "secret: 8-64 Zeichen aus A-Z a-z 0-9 . _ ~ -"}), 400
    ctx = str(b.get("context") or "internal").strip()
    if ctx not in SIP_KONTEXTE:
        return jsonify({"error": "context nicht erlaubt"}), 400
    client = str(b.get("client") or "linphone").strip()
    if client not in CLIENTS:
        return jsonify({"error": "Unbekannter Client"}), 400
    conn = db.connect()
    try:
        if not ext:
            ext = str(db.next_ext(conn, "sip_extensions", "ext", 2000))  # fortlaufend ab 2000
        conn.execute(
            "INSERT INTO sip_extensions (ext, name, secret, context, client) VALUES (?,?,?,?,?)",
            (ext, name, secret, ctx, client),
        )
        conn.commit()
        regenerate_phones_conf(conn)
        row = conn.execute("SELECT * FROM sip_extensions WHERE ext = ?", (ext,)).fetchone()
        return jsonify({"extension": dict(row)})
    except db.sqlite3.IntegrityError:
        return jsonify({"error": "Extension existiert bereits"}), 409
    finally:
        conn.close()


@app.put("/api/pbx/sip-extensions/<ext>")
def sip_ext_update(ext):
    """Aendert App (client) und/oder Kontext einer Nebenstelle (Name/Passwort bleiben)."""
    user, deny = require_admin()
    if deny:
        return deny
    b = request.get_json(silent=True) or {}
    felder = {}
    if "client" in b:
        client = str(b.get("client") or "").strip()
        if client not in CLIENTS:
            return jsonify({"error": "Unbekannter Client"}), 400
        felder["client"] = client
    if "context" in b:
        ctx = str(b.get("context") or "").strip()
        if ctx not in SIP_KONTEXTE:
            return jsonify({"error": "context nicht erlaubt"}), 400
        felder["context"] = ctx
    if not felder:
        return jsonify({"error": "nichts zu aendern"}), 400
    conn = db.connect()
    try:
        sets = ", ".join(f"{k} = ?" for k in felder)  # Schluessel stammen aus der Liste oben
        cur = conn.execute(f"UPDATE sip_extensions SET {sets} WHERE ext = ?", (*felder.values(), ext))
        if not cur.rowcount:
            return jsonify({"error": "Nebenstelle unbekannt"}), 404
        db.touch(conn, "sip_extensions", "ext", ext)
        if felder.get("context") == "internal":
            # Kein geteiltes Telefon mehr: eine offene Anmeldung waere sonst Altlast.
            _telefon_abmelden(conn, ext, f"admin:{actor(user)}")
        conn.commit()
        regenerate_phones_conf(conn)
        return jsonify({"ok": True, "ext": ext, **felder})
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
        conn.execute("DELETE FROM telefon_sip_person WHERE ext = ?", (ext,))
        conn.commit()
        regenerate_phones_conf(conn)
        return jsonify({"ok": True})
    finally:
        conn.close()


# ─── Linphone-Provisionierung: QR-Code + XML ────────────────────────────────
def _prov_xml(ext, name, secret):
    """linphonerc im XML-Format, wie Linphone es per Remote Provisioning laedt."""
    host = PROV_SIP_HOST
    ident = f'"{name}" <sip:{ext}@{host}>'
    abschnitte = [
        ("sip", [
            ("default_proxy", "0"),
            ("guess_hostname", "1"),
        ]),
        ("proxy_0", [
            ("reg_proxy", f"<sip:{host};transport={PROV_TRANSPORT}>"),
            ("reg_identity", ident),
            ("reg_expires", PROV_EXPIRES),
            ("reg_sendregister", "1"),
            ("publish", "0"),
        ]),
        ("auth_info_0", [
            ("username", str(ext)),
            ("passwd", secret),
            ("domain", host),
        ]),
        # Video aus: die Geraete sind Sprachtelefone, und ein nicht ausgehandelter
        # Video-Stream kostet nur Aushandlungszeit beim Rufaufbau.
        ("video", [("automatically_initiate", "0"), ("automatically_accept", "0")]),
    ]
    if PROV_CARDDAV_URL:
        # Schluesselnamen wie in CardDavParams::readFromConfigFile().
        abschnitte.append(("carddav_0", [
            ("server_url", PROV_CARDDAV_URL),
            ("results_limit", "0"),
            ("min_characters", "3"),
            ("timeout", "10"),
            ("fields_for_user_input", "FN,N,ORG,IMPP"),
            ("use_exact_match_policy", "0"),
        ]))
        if PROV_CARDDAV_USER:
            # Zweiter auth_info-Block: die CardDAV-Anfrage traegt keine eigenen
            # Zugangsdaten, liblinphone sucht beim 401 eine passende AuthInfo
            # ueber Realm und Host.
            wirt = PROV_CARDDAV_URL.split("://", 1)[-1].split("/", 1)[0].split(":")[0]
            eintraege = [
                ("username", PROV_CARDDAV_USER),
                ("passwd", PROV_CARDDAV_PASS),
                ("domain", wirt),
            ]
            if PROV_CARDDAV_REALM:
                eintraege.append(("realm", PROV_CARDDAV_REALM))
            abschnitte.append(("auth_info_1", eintraege))

    teile = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<config xmlns="http://www.linphone.org/xsds/lpconfig.xsd">']
    for sec, eintraege in abschnitte:
        teile.append(f'  <section name="{xesc(sec)}">')
        for k, v in eintraege:
            teile.append(f'    <entry name="{xesc(k)}" overwrite="true">{xesc(str(v))}</entry>')
        teile.append("  </section>")
    teile.append("</config>")
    return "\n".join(teile) + "\n"


def _androidsip_xml(ext, secret):
    """Einstellungsdatei fuer Android SIP (Menue -> Import).

    Das Format ist das, was die App selbst exportiert: ein SharedPreferences-
    <map>. Schluessel aus Settings.java. Die App kennt keine Abruf-URL, darum
    wird die Datei im Browser geladen und in der App importiert.
    """
    host = PROV_SIP_HOST
    werte = [
        ("boolean", "account_enabled", "true"),
        ("string", "username", str(ext)),
        ("string", "password", secret),
        ("string", "server", host),
        ("string", "domain", host),
        ("string", "port", "5060"),
        # tls schaltet die App intern stillschweigend auf tcp um — also gleich tcp.
        ("string", "protocol", "tcp"),
        ("boolean", "wlan", "true"),
        ("boolean", "vpn", "true"),
        ("string", "pref", "SIP"),
        ("boolean", "MWI_enabled", "false"),
    ]
    teile = ["<?xml version='1.0' encoding='utf-8' standalone='yes' ?>", "<map>"]
    for typ, k, v in werte:
        if typ == "string":
            teile.append(f'<string name="{xesc(k)}">{xesc(v)}</string>')
        else:
            teile.append(f'<{typ} name="{xesc(k)}" value="{xesc(v)}" />')
    teile.append("</map>")
    return "\n".join(teile) + "\n"


@app.post("/api/pbx/sip-extensions/<ext>/provisioning")
def prov_create(ext):
    """Erzeugt einen Einmal-Link + QR-Code fuer die Linphone-Einrichtung."""
    user, deny = require_admin()
    if deny:
        return deny
    conn = db.connect()
    try:
        row = conn.execute("SELECT ext, name, client FROM sip_extensions WHERE ext = ?", (ext,)).fetchone()
        if not row:
            return jsonify({"error": "Nebenstelle unbekannt"}), 404
        token = pysecrets.token_urlsafe(24)
        gueltig_bis = datetime.now(timezone.utc) + timedelta(minutes=PROV_TTL_MIN)
        conn.execute(
            "INSERT INTO prov_tokens (token, ext, expires_at, created_by) VALUES (?,?,?,?)",
            (token, ext, gueltig_bis.isoformat(timespec="seconds"), actor(user)),
        )
        # Abgelaufene und schon benutzte Tokens derselben Nebenstelle raeumen wir
        # gleich mit weg — ein alter QR-Ausdruck soll nicht doch noch ziehen.
        conn.execute(
            "DELETE FROM prov_tokens WHERE ext = ? AND token != ? "
            "AND (used_at IS NOT NULL OR expires_at < ?)",
            (ext, token, datetime.now(timezone.utc).isoformat(timespec="seconds")),
        )
        conn.commit()
    finally:
        conn.close()
    url = f"https://{PUBLIC_HOST}/prov/{token}"
    qr = segno.make(url, error="m").svg_inline(scale=5, dark="#1f2937")
    return jsonify({
        "ext": ext, "name": row["name"], "client": row["client"], "url": url, "qr_svg": qr,
        "expires_at": gueltig_bis.isoformat(timespec="seconds"),
        "ttl_minutes": PROV_TTL_MIN,
        # Fuer das synchronisierte Adressbuch der App: das ist eine FriendList,
        # und die lebt in friends.db, nicht in der linphonerc — sie laesst sich
        # darum NICHT provisionieren. Wir liefern die Werte zum Abtippen mit.
        "carddav": {
            "name": PROV_CARDDAV_NAME,
            "url": PROV_CARDDAV_URL,
            "user": PROV_CARDDAV_USER,
            "pass": PROV_CARDDAV_PASS,
            "realm": PROV_CARDDAV_REALM,
        } if PROV_CARDDAV_URL else None,
    })


@app.get("/prov/<token>")
def prov_fetch(token):
    """Wird vom Telefon geholt — ohne Anmeldung, dafuer einmalig und befristet."""
    conn = db.connect()
    try:
        row = conn.execute(
            "SELECT p.token, p.ext, p.expires_at, p.used_at, e.name, e.secret, e.enabled, e.client "
            "FROM prov_tokens p LEFT JOIN sip_extensions e ON e.ext = p.ext "
            "WHERE p.token = ?", (token,)
        ).fetchone()
        jetzt = datetime.now(timezone.utc).isoformat(timespec="seconds")
        if not row or row["used_at"] or row["expires_at"] < jetzt or row["secret"] is None:
            # Bewusst dieselbe Antwort fuer unbekannt/abgelaufen/verbraucht.
            return jsonify({"error": "Link ungueltig oder abgelaufen"}), 404
        # Atomar verbrauchen: zwei gleichzeitige Abrufe duerfen nicht beide das
        # SIP-Passwort bekommen (D-19) — nur wer die Zeile wirklich umschreibt.
        cur = conn.execute("UPDATE prov_tokens SET used_at = ? WHERE token = ? AND used_at IS NULL AND expires_at >= ?",
                           (jetzt, token, jetzt))
        conn.commit()
        if cur.rowcount != 1:
            return jsonify({"error": "Link ungueltig oder abgelaufen"}), 404
        client = row["client"]
        if client == "android-sip":
            xml = _androidsip_xml(row["ext"], row["secret"])
        else:
            xml = _prov_xml(row["ext"], row["name"], row["secret"])
    finally:
        conn.close()
    headers = {"Cache-Control": "no-store"}
    if client == "android-sip":
        # Der Browser soll die Datei speichern (Downloads), nicht anzeigen —
        # von dort holt sie der Import-Dialog der App.
        headers["Content-Disposition"] = f'attachment; filename="androidsip-{row["ext"]}.xml"'
    return Response(xml, mimetype="application/xml", headers=headers)


# ─── Geteilte Telefone: Anmeldung pro Person ────────────────────────────────
# Ablauf:
#   1. Die Person oeffnet /telefon auf dem EIGENEN Handy, meldet sich mit
#      Authentik an und bekommt einen persoenlichen Anmelde-QR
#      (POST /api/telefon/ausweis): einmalig, 90 s gueltig, Inhalt
#      "RWTEL1:<token>" — bewusst keine URL, eine fremde Kamera-App kann damit
#      nichts anfangen.
#   2. Das gesperrte Telefon scannt den QR mit seiner Kamera und loest ihn ein
#      (POST /api/telefon/einloesen). Es weist sich mit seinen SIP-Zugangsdaten
#      aus (HTTP Basic ext:secret) — die hat es ohnehin.
#   3. Ab dann ist die Person an diesem Geraet angemeldet, bis sie sich von Hand
#      abmeldet (Geraet, /telefon oder Admin).
# Der QR muss physisch vor die Kamera: das belegt, dass die Person davorsteht.
# Der Dialplan ([geteilt]) fragt bei jedem Anruf /api/pbx/telefon/<ext>/sitzung
# ab; ohne Sitzung gehen nur Notrufe.
TELEFON_AUSWEIS_TTL_S = int(os.environ.get("PBX_TELEFON_AUSWEIS_TTL_S", "90"))
# APKs fuer die geteilten Telefone (App-Katalog, art='apk').
TELEFON_APPS_DIR = os.environ.get("PBX_TELEFON_APPS_DIR", "/var/lib/pbx-api/apps")
TELEFON_APK_MAX = 300 * 1024 * 1024
TELEFON_QR_PRAEFIX = "RWTEL1:"


def _jetzt_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _telefon_gruppen(conn):
    roh = _cfg(conn).get("telefon_gruppen", "")
    return {g.strip().lower() for g in roh.split(",") if g.strip()}


def _telefon_darf(conn, user):
    erlaubt = _telefon_gruppen(conn)
    gruppen = {str(g).lower() for g in (user or {}).get("groups", [])}
    return bool(erlaubt & gruppen)


def _geraet():
    """HTTP-Basic ext:secret eines geteilten Telefons. Gibt (ext, None) oder (None, response)."""
    a = request.authorization
    nein = (jsonify({"error": "Geraet nicht berechtigt"}), 401)
    if not a or not a.username or not a.password:
        return None, nein
    conn = db.connect()
    try:
        row = conn.execute(
            "SELECT ext, secret FROM sip_extensions WHERE ext = ? AND enabled = 1 AND context = 'geteilt'",
            (a.username,),
        ).fetchone()
    finally:
        conn.close()
    if not row or not hmac.compare_digest(str(row["secret"]).encode(), a.password.encode()):
        return None, nein
    return row["ext"], None


def _telefon_abmelden(conn, ext, durch):
    s = conn.execute("SELECT email, name FROM telefon_sitzungen WHERE ext = ?", (ext,)).fetchone()
    if not s:
        return False
    conn.execute("DELETE FROM telefon_sitzungen WHERE ext = ?", (ext,))
    # Persoenlicher SIP-Zugang weg (pjsip_phones.conf schreibt der Aufrufer nach dem commit neu)
    conn.execute("DELETE FROM telefon_sip_person WHERE ext = ?", (ext,))
    # Nextcloud-Zugang noch nicht widerrufen: das Telefon laedt erst fertig hoch und meldet
    # dann /api/telefon/nextcloud/fertig (spaetestens nach 24 h widerruft der stuendliche Lauf)
    conn.execute("UPDATE telefon_nextcloud SET abgemeldet_at = datetime('now') WHERE ext = ?", (ext,))
    conn.execute("INSERT INTO telefon_log (ext, ereignis, email, name, durch) VALUES (?,?,?,?,?)",
                 (ext, "ab", s["email"], s["name"], durch))
    return True


# Sperrbild der geteilten Telefone je angemeldeter Person (Stefan 25.11.2026: "prio gruppe
# danach haus"): Technik, dann Ausschuss/Praesident, dann das eigene Haus (rN-...), dann die
# STWEG (stwegN-...), sonst das Rosenweg-Logo. Dateien liegen auf www.rosenweg4303.ch.
_LOGO_HAUS = {
    "1": "logo-stweg6-rosenweg1.png", "2": "logo-stweg7-rosenweg2.png", "4": "logo-stweg7-rosenweg4.png",
    "5": "logo-stweg5-rosenweg5.png", "6": "logo-stweg5-rosenweg6.png", "8": "logo-stweg5-rosenweg8.png",
    "9": "logo-stweg3-rosenweg9.png", "10": "logo-stweg4-rosenweg10.png", "12": "logo-stweg4-rosenweg12.png",
    "13": "logo-stweg2-rosenweg13.png", "14": "logo-stweg2-rosenweg14.png", "16": "logo-stweg2-rosenweg16.png",
    "17": "logo-stweg1-rosenweg17.png", "18": "logo-stweg1-rosenweg18.png",
}
_LOGO_STWEG = {
    "1": "logo-stweg1-rosenweg17-18.png", "2": "logo-stweg2-rosenweg13-14-16.png", "3": "logo-stweg3-rosenweg9.png",
    "4": "logo-stweg4-rosenweg10-12.png", "5": "logo-stweg5-rosenweg5-6-8.png", "6": "logo-stweg6-rosenweg1.png",
    "7": "logo-stweg7-rosenweg2-4.png",
}


def _sperrbild(gruppen):
    g = {str(x).lower() for x in gruppen or []}
    if "technik" in g:
        return "logo-rosenweg-technik.png"
    if g & {"ausschuss", "präsident", "praesident"} or any(x.endswith("-ausschuss") for x in g):
        return "logo-rosenweg-ausschuss.png"
    for x in sorted(g):
        m = re.fullmatch(r"r([0-9]{1,2})-(bewohner|eigentuemer)", x)
        if m and m.group(1) in _LOGO_HAUS:
            return _LOGO_HAUS[m.group(1)]
    for x in sorted(g):
        m = re.fullmatch(r"stweg([0-9])-(bewohner|eigentuemer)", x)
        if m and m.group(1) in _LOGO_STWEG:
            return _LOGO_STWEG[m.group(1)]
    return "logo-rosenweg.png"


def _sitzung_json(row):
    if not row:
        return {"angemeldet": False}
    # Persoenliche interne Nummer der angemeldeten Person (das Geraet zeigt sie neben der
    # Nebenstelle des Geraets an; intern ruft die Person mit dieser Nummer an).
    nummer = ""
    try:
        c = db.connect()
        try:
            nummer = _nummer_der_person(c, row["email"], row["name"]) or ""
        finally:
            c.close()
    except Exception as e:
        app.logger.warning("Nummer der Person: %s", e)
    try:
        gruppen = json.loads(row["gruppen"] or "[]")
    except (ValueError, IndexError, KeyError):
        gruppen = []
    return {"angemeldet": True, "name": row["name"], "email": row["email"], "seit": row["seit"],
            "nummer": str(nummer), "sperrbild": _sperrbild(gruppen)}



@app.get("/api/telefon/status")
def telefon_status():
    ext, deny = _geraet()
    if deny:
        return deny
    conn = db.connect()
    try:
        row = conn.execute("SELECT name, email, seit, gruppen FROM telefon_sitzungen WHERE ext = ?", (ext,)).fetchone()
        geraet = conn.execute("SELECT name FROM sip_extensions WHERE ext = ?", (ext,)).fetchone()
        technik = False
        if row:
            try:
                gr = [str(g).lower() for g in json.loads(row["gruppen"] or "[]")]
                technik = any(g in gr for g in ("technik", "präsident", "praesident"))
            except ValueError:
                pass
        w = conn.execute("SELECT wlan_debug_bis FROM telefon_wartung WHERE ext = ?", (ext,)).fetchone()
        bis = int(w["wlan_debug_bis"]) if w and int(w["wlan_debug_bis"] or 0) > time.time() else 0
        # technik: Geraete-App sperrt die gefaehrlichen Einstellungen nur fuer alle anderen
        # wlan_debug_bis: zentral eingeschaltetes "Debugging ueber WLAN" (epoch s, 0 = aus)
        return jsonify({"ext": ext, "geraet": geraet["name"] if geraet else ext, "technik": technik,
                        "wlan_debug_bis": bis, **_sitzung_json(row), **_apps_fuer(conn, row)})
    finally:
        conn.close()


TELEFON_WLAN_SSID = "Rosenweg"
TELEFON_WLAN_GRUNDNETZ = "RK-Clients"   # Variante 1 (Stefan 25.11.2026)


def _telefon_wlan_netz(conn, ext):
    """Welches PPSK-Netz das Telefon jetzt nutzen soll (Stefan 25.11.2026):
    abgemeldet RK-Clients; angemeldet das Haus, in dem die Person wohnt - aus der persoenlichen
    Nummer 3HHWWP (HH = Hausnummer) -> "RW<HH>-Clients". Auch Technik bekommt das Haus-Netz,
    nie ein Technik-VLAN. Ohne hinterlegten Schluessel fuer das Haus: RK-Clients."""
    s = conn.execute("SELECT email, name FROM telefon_sitzungen WHERE ext = ?", (ext,)).fetchone()
    if not s:
        return TELEFON_WLAN_GRUNDNETZ
    nummer = str(_nummer_der_person(conn, s["email"], s["name"]) or "")
    if not re.fullmatch(r"3[0-9]{5}", nummer):
        return TELEFON_WLAN_GRUNDNETZ
    netz = f"RW{int(nummer[1:3])}-Clients"
    if conn.execute("SELECT 1 FROM telefon_wlan WHERE netz = ?", (netz,)).fetchone():
        return netz
    return TELEFON_WLAN_GRUNDNETZ


@app.get("/api/telefon/wlan")
def telefon_wlan():
    """WLAN "Rosenweg" fuer das geteilte Telefon (Geraete-Token): SSID und PPSK des Netzes,
    in dem es gerade sein soll. 404, solange kein Schluessel hinterlegt ist. Nie loggen."""
    ext, deny = _geraet()
    if deny:
        return deny
    conn = db.connect()
    try:
        netz = _telefon_wlan_netz(conn, ext)
        r = conn.execute("SELECT netz, vlan, passwort FROM telefon_wlan WHERE netz = ?", (netz,)).fetchone()
    finally:
        conn.close()
    if not r:
        return jsonify({"error": "Kein WLAN-Schluessel hinterlegt"}), 404
    res = jsonify({"ssid": TELEFON_WLAN_SSID, "netz": r["netz"], "vlan": r["vlan"], "passwort": r["passwort"]})
    res.headers["Cache-Control"] = "no-store"
    return res


@app.get("/api/telefon/sip-person")
def telefon_sip_person():
    """Persoenlicher SIP-Zugang der angemeldeten Person fuer Rosenweg Telefon (ueber den
    AnlageProvider der Geraete-App). 404, wenn niemand angemeldet ist oder die Person
    keine persoenliche Nummer hat. Das Passwort gilt nur fuer diese Sitzung."""
    ext, deny = _geraet()
    if deny:
        return deny
    conn = db.connect()
    neu = False
    try:
        s = conn.execute("SELECT email, name FROM telefon_sitzungen WHERE ext = ?", (ext,)).fetchone()
        if not s:
            return jsonify({"error": "Niemand angemeldet"}), 404
        sql = "SELECT nummer, passwort FROM telefon_sip_person WHERE ext = ? AND lower(email) = lower(?)"
        r = conn.execute(sql, (ext, s["email"] or "")).fetchone()
        if not r:
            # Sitzung von vor diesem Update: Zugang jetzt anlegen
            neu = bool(_sip_person_anlegen(conn, ext))
            conn.commit()
            r = conn.execute(sql, (ext, s["email"] or "")).fetchone()
        if not r:
            return jsonify({"error": "Keine persoenliche Nummer"}), 404
        kennung = f"{r['nummer']}-{ext}"
        antwort = {
            "server": PROV_SIP_HOST, "port": 5061 if PROV_TRANSPORT == "tls" else 5060,
            "transport": PROV_TRANSPORT, "user": kennung, "auth_user": kennung,
            "password": r["passwort"], "nummer": r["nummer"], "name": s["name"],
        }
    finally:
        conn.close()
    if neu:
        _sip_person_neu_laden()
    res = jsonify(antwort)
    res.headers["Cache-Control"] = "no-store"
    return res


# ─── Rosenweg Telefon auf dem eigenen Handy ─────────────────────────────────
# Stefan 25.11.2026: "wieso kann ich mich auf dem telefon nicht einfach anmelden wie im
# rosenweg". Die App meldet sich mit dem Rosenweg-Konto an (Authentik "rosenweg-apps",
# PKCE) und holt hier einen festen Zugang <nummer>-p<id>. Ohne Sitzung an einem geteilten
# Telefon; er bleibt, bis die App abmeldet, Technik ihn loescht oder die Nummer inaktiv wird.
SIP_PRIVAT_RE = re.compile(r"3[0-9]{5}-p[0-9]{1,6}")
SIP_PRIVAT_MAX = 5   # Handys pro Person


def _sip_privat_abschnitte(conn):
    rows = conn.execute(
        "SELECT p.id, p.nummer, p.passwort, n.name FROM telefon_sip_privat p "
        "JOIN personen_nummern n ON n.nummer = p.nummer AND n.aktiv = 1 "
        "AND lower(n.email) = lower(p.email) ORDER BY p.id").fetchall()
    lines = ["; Eigene Handys (telefon_sip_privat): <nummer>-p<id>, Anmeldung in Rosenweg Telefon", ""]
    for r in rows:
        kennung = f"{r['nummer']}-p{r['id']}"
        if not SIP_PRIVAT_RE.fullmatch(kennung) or not _PASSWORT_RE.fullmatch(str(r["passwort"] or "")):
            print(f"[pbx-api] Handy-Zugang p{int(r['id'])} nicht geschrieben (ungueltig)", flush=True)
            continue
        lines += _zugang_abschnitte(kennung, r["passwort"], r["name"], r["nummer"])
    return lines


def _rosenweg_konto():
    """Person hinter dem Authentik-Token (Bearer) per userinfo; None wenn ungueltig."""
    token = _bearer()
    if not token or len(token) > 4096:
        return None
    try:
        r = requests.get(AUTHENTIK_USERINFO, headers={"Authorization": f"Bearer {token}"}, timeout=6)
        if not r.ok:
            app.logger.warning("Rosenweg-Anmeldung: userinfo %s", r.status_code)
            return None
        u = r.json()
    except (requests.RequestException, ValueError) as e:
        app.logger.warning("Rosenweg-Anmeldung: userinfo %s", type(e).__name__)
        return None
    # email_verified nicht verlangen: Authentik setzt es standardmaessig false, die
    # Adresse stammt aber aus dem Rosenweg-Konto selbst (wie beim Website-Login).
    email = str(u.get("email") or "").strip().lower()
    if not email:
        app.logger.warning("Rosenweg-Anmeldung: keine E-Mail im Konto")
        return None
    return {"email": email, "name": str(u.get("name") or u.get("preferred_username") or "")}


def _privat_antwort(r, name):
    kennung = f"{r['nummer']}-p{r['id']}"
    res = jsonify({
        "server": PROV_SIP_HOST, "port": 5061 if PROV_TRANSPORT == "tls" else 5060,
        "transport": PROV_TRANSPORT, "user": kennung, "auth_user": kennung,
        "password": r["passwort"], "nummer": r["nummer"], "name": name, "id": r["id"],
    })
    res.headers["Cache-Control"] = "no-store"
    return res


@app.post("/api/telefon/privat/anmelden")
def telefon_privat_anmelden():
    """Rosenweg Telefon auf dem eigenen Handy: Bearer = Authentik-Access-Token der App.
    Body {geraet}: Anzeigename des Handys. Antwort wie /api/telefon/sip-person."""
    konto = _rosenweg_konto()
    if not konto:
        return jsonify({"error": "Rosenweg-Anmeldung ungueltig"}), 401
    b = request.get_json(silent=True) or {}
    geraet = re.sub(r"[\x00-\x1f\x7f]", " ", str(b.get("geraet") or ""))[:60].strip()
    conn = db.connect()
    try:
        p = conn.execute("SELECT nummer, name FROM personen_nummern WHERE lower(email) = ? AND aktiv = 1 "
                         "ORDER BY nummer", (konto["email"],)).fetchall()
        nummer = str(_nummer_der_person(conn, konto["email"], konto["name"]) or "")
        if not p or not re.fullmatch(r"3[0-9]{5}", nummer):
            return jsonify({"error": "Keine persoenliche Telefonnummer fuer dieses Rosenweg-Konto"}), 404
        name = next((x["name"] for x in p if x["nummer"] == nummer), konto["name"])
        n = conn.execute("SELECT COUNT(*) FROM telefon_sip_privat WHERE lower(email) = ?",
                         (konto["email"],)).fetchone()[0]
        if n >= SIP_PRIVAT_MAX:
            return jsonify({"error": f"Schon {SIP_PRIVAT_MAX} Handys angemeldet - eines in der "
                                     "Telefon-Verwaltung abmelden"}), 409
        cur = conn.execute("INSERT INTO telefon_sip_privat (nummer, email, geraet, passwort) VALUES (?,?,?,?)",
                           (nummer, konto["email"], geraet, pysecrets.token_urlsafe(24)))
        conn.commit()
        r = conn.execute("SELECT * FROM telefon_sip_privat WHERE id = ?", (cur.lastrowid,)).fetchone()
        app.logger.info("Handy-Zugang %s-p%d angelegt", nummer, r["id"])
    finally:
        conn.close()
    _sip_person_neu_laden()
    return _privat_antwort(r, name)


@app.post("/api/telefon/privat/abmelden")
def telefon_privat_abmelden():
    """Die App meldet ab: Body {user, password} des eigenen Zugangs (kein Token noetig,
    der Zugang selbst ist der Ausweis)."""
    b = request.get_json(silent=True) or {}
    kennung, pw = str(b.get("user") or ""), str(b.get("password") or "")
    if not SIP_PRIVAT_RE.fullmatch(kennung):
        return jsonify({"error": "Unbekannter Zugang"}), 404
    zid = int(kennung.split("-p", 1)[1])
    conn = db.connect()
    try:
        r = conn.execute("SELECT passwort FROM telefon_sip_privat WHERE id = ?", (zid,)).fetchone()
        if not r or not hmac.compare_digest(str(r["passwort"]), pw):
            return jsonify({"error": "Unbekannter Zugang"}), 404
        conn.execute("DELETE FROM telefon_sip_privat WHERE id = ?", (zid,))
        conn.commit()
    finally:
        conn.close()
    _sip_person_neu_laden()
    return jsonify({"ok": True})


@app.get("/api/pbx/sip-privat")
def sip_privat_liste():
    """Technik: angemeldete eigene Handys (ohne Passwort)."""
    _, deny = require_admin()
    if deny:
        return deny
    conn = db.connect()
    try:
        rows = conn.execute("SELECT id, nummer, email, geraet, created_at FROM telefon_sip_privat "
                            "ORDER BY nummer, id").fetchall()
        try:
            regs = ami.registered_aors()
        except Exception:  # noqa: BLE001
            regs = set()
        return jsonify([{**dict(r), "kennung": f"{r['nummer']}-p{r['id']}",
                         "registriert": f"{r['nummer']}-p{r['id']}" in regs} for r in rows])
    finally:
        conn.close()


@app.delete("/api/pbx/sip-privat/<int:zid>")
def sip_privat_loeschen(zid):
    """Technik: Handy-Zugang sperren (z.B. Handy verloren)."""
    _, deny = require_admin()
    if deny:
        return deny
    conn = db.connect()
    try:
        n = conn.execute("DELETE FROM telefon_sip_privat WHERE id = ?", (zid,)).rowcount
        conn.commit()
    finally:
        conn.close()
    if not n:
        return jsonify({"error": "Nicht gefunden"}), 404
    _sip_person_neu_laden()
    return jsonify({"ok": True})


@app.post("/api/telefon/abmelden")
def telefon_abmelden_geraet():
    ext, deny = _geraet()
    if deny:
        return deny
    conn = db.connect()
    try:
        weg = _telefon_abmelden(conn, ext, "geraet")
        conn.commit()
        if weg:
            _sip_person_neu_laden()
        return jsonify({"ok": True, "angemeldet": False})
    finally:
        conn.close()


def _token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


@app.post("/api/telefon/ausweis")
def telefon_ausweis():
    """Persoenlicher Anmelde-QR fuer die Person, die gerade auf /telefon angemeldet ist."""
    user = current_user()
    if not user:
        return jsonify({"error": "Nicht angemeldet"}), 401
    conn = db.connect()
    try:
        if not _telefon_darf(conn, user):
            return jsonify({"error": "Dein Konto ist fuer geteilte Telefone nicht freigeschaltet"}), 403
        jetzt = _jetzt_iso()
        email = user.get("email") or ""
        # Pro Person gilt nur der neueste QR; alte und abgelaufene weg.
        conn.execute("DELETE FROM telefon_ausweise WHERE lower(email) = lower(?) OR expires_at < ?", (email, jetzt))
        token = pysecrets.token_urlsafe(24)
        bis = (datetime.now(timezone.utc) + timedelta(seconds=TELEFON_AUSWEIS_TTL_S)).isoformat(timespec="seconds")
        name = str(user.get("name") or user.get("username") or actor(user))[:80]
        name = re.sub(r'[\x00-\x1f\x7f"<>\\]', "", name) or "Unbekannt"
        gruppen = json.dumps(sorted({str(g).lower() for g in (user.get("groups") or [])}))
        conn.execute("INSERT INTO telefon_ausweise (token_hash, user_id, email, name, durch, expires_at, gruppen) "
                     "VALUES (?,?,?,?,?,?,?)",
                     (_token_hash(token), str(user.get("id") or ""), email, name, actor(user), bis, gruppen))
        conn.commit()
    finally:
        conn.close()
    inhalt = TELEFON_QR_PRAEFIX + token
    qr = segno.make(inhalt, error="m").svg_inline(scale=8, dark="#000000", light="#ffffff", border=2)
    # "inhalt" braucht die Anmeldeseite, wenn sie IM geteilten Telefon laeuft
    # (Login direkt mit Authentik): sie reicht ihn ueber die JS-Bruecke an die App.
    return jsonify({"qr_svg": qr, "inhalt": inhalt, "expires_at": bis, "ttl_seconds": TELEFON_AUSWEIS_TTL_S})


@app.post("/api/telefon/einloesen")
def telefon_einloesen():
    """Das gesperrte Telefon hat einen Anmelde-QR gescannt."""
    ext, deny = _geraet()
    if deny:
        return deny
    roh = str((request.get_json(silent=True) or {}).get("token", "")).strip()
    if roh.startswith(TELEFON_QR_PRAEFIX):
        roh = roh[len(TELEFON_QR_PRAEFIX):]
    if not re.fullmatch(r"[A-Za-z0-9_-]{20,64}", roh):
        return jsonify({"error": "Das ist kein Rosenweg-Anmeldecode"}), 400
    h = _token_hash(roh)
    conn = db.connect()
    try:
        a = conn.execute("SELECT user_id, email, name, durch, expires_at, gruppen FROM telefon_ausweise "
                         "WHERE token_hash = ?", (h,)).fetchone()
        # Atomar verbrauchen: nur wer die Zeile loescht, meldet sich an.
        if not a or conn.execute("DELETE FROM telefon_ausweise WHERE token_hash = ?", (h,)).rowcount != 1:
            return jsonify({"error": "Code unbekannt oder schon benutzt — auf dem Handy neu laden"}), 404
        if a["expires_at"] < _jetzt_iso():
            conn.commit()
            return jsonify({"error": "Code abgelaufen — auf dem Handy neu laden"}), 404
        _telefon_abmelden(conn, ext, f"abgeloest:{a['durch']}")
        conn.execute("INSERT INTO telefon_sitzungen (ext, user_id, email, name, gruppen) VALUES (?,?,?,?,?)",
                     (ext, a["user_id"], a["email"], a["name"], a["gruppen"] or "[]"))
        conn.execute("INSERT INTO telefon_log (ext, ereignis, email, name, durch) VALUES (?,?,?,?,?)",
                     (ext, "an", a["email"], a["name"], a["durch"]))
        _sip_person_anlegen(conn, ext)
        conn.commit()
        _sip_person_neu_laden()
        s = conn.execute("SELECT name, email, seit, gruppen FROM telefon_sitzungen WHERE ext = ?", (ext,)).fetchone()
        return jsonify({"ok": True, "ext": ext, **_sitzung_json(s), **_apps_fuer(conn, s)})
    finally:
        conn.close()


# ─── Anmeldung per NFC-Karte (UniFi Access) ─────────────────────────────────
# Die Karte ALLEIN meldet an (Entscheid Stefan 24.11.2026), ohne PIN. Wem die Karte
# gehoert, steht nur in UniFi Access; die Haupt-API fragt dort bei jeder Anmeldung
# live nach (/api/pbx/karte/<uid>). Entzogene oder unbekannte Karten gelten nicht.
# Sicherheit: die UID ist kopierbar — verlorene Karten sofort entziehen.
KARTE_FEHL_MAX = 10          # Fehlversuche pro Nebenstelle ...
KARTE_FEHL_FENSTER_S = 60    # ... pro Minute
_KARTE_FEHL = {}             # ext -> [Zeitpunkte der Fehlversuche]
KARTEN_VERWALTER = {"technik", "präsident", "praesident"}


def _karten_uid(roh):
    uid = re.sub(r"[^0-9A-Fa-f]", "", str(roh or "")).upper()
    return uid if 8 <= len(uid) <= 20 and len(uid) % 2 == 0 else None


def _karte_gebremst(ext):
    jetzt = time.time()
    liste = [t for t in _KARTE_FEHL.get(ext, []) if jetzt - t < KARTE_FEHL_FENSTER_S]
    _KARTE_FEHL[ext] = liste
    return len(liste) >= KARTE_FEHL_MAX


def _karte_fehlversuch(ext):
    _KARTE_FEHL.setdefault(ext, []).append(time.time())


def _haupt_karte(methode, pfad, daten=None):
    """Haupt-API (Kartenabfrage/-verwaltung). -> (status, json). Wirft requests.RequestException."""
    r = requests.request(methode, f"{MAIN_API_BASE}{pfad}", json=daten,
                         headers={"X-PBX-Secret": PBX_SHARED_SECRET}, timeout=25)
    try:
        body = r.json()
    except ValueError:
        body = {}
    return r.status_code, body if isinstance(body, dict) else {}


def _karten_log(conn, ext, ereignis, email, name, durch):
    conn.execute("INSERT INTO telefon_log (ext, ereignis, email, name, durch) VALUES (?,?,?,?,?)",
                 (ext, ereignis, email, name, durch))


@app.post("/api/telefon/karte")
def telefon_karte():
    """Das gesperrte Telefon hat eine NFC-Karte gelesen: anmelden wie mit dem QR."""
    ext, deny = _geraet()
    if deny:
        return deny
    uid = _karten_uid((request.get_json(silent=True) or {}).get("uid"))
    if not uid:
        return jsonify({"error": "Karte nicht lesbar", "grund": "unlesbar"}), 400
    if _karte_gebremst(ext):
        return jsonify({"error": "Zu viele Versuche — bitte kurz warten", "grund": "gebremst"}), 429
    try:
        status, k = _haupt_karte("GET", f"/api/pbx/karte/{uid}")
    except requests.RequestException as e:
        app.logger.warning("Karte %s: Website nicht erreichbar (%s)", ext, type(e).__name__)
        return jsonify({"error": "Keine Verbindung zur Anlage", "grund": "verbindung"}), 502
    if status != 200:
        return jsonify({"error": "Keine Verbindung zur Anlage", "grund": "verbindung"}), 502
    karte = f"karte:{k.get('display_id') or uid[-6:]}"
    person = k.get("person") or {}
    conn = db.connect()
    try:
        fehler = None
        if not k.get("found"):
            fehler = ({"error": "Karte nicht bekannt", "grund": "unbekannt"}, 404)
        elif not k.get("assigned") or not person.get("email"):
            fehler = ({"error": "Karte gesperrt", "grund": "gesperrt"}, 403)
        elif not _telefon_darf(conn, {"groups": person.get("groups") or []}):
            fehler = ({"error": "Dein Konto ist für geteilte Telefone nicht freigeschaltet",
                       "grund": "nicht_freigeschaltet"}, 403)
        if fehler:
            _karte_fehlversuch(ext)
            _karten_log(conn, ext, "karte-abgelehnt", person.get("email"), person.get("name"),
                        f"{karte}:{fehler[0]['grund']}")
            conn.commit()
            return jsonify(fehler[0]), fehler[1]
        email = str(person["email"]).lower()
        name = str(person.get("name") or email)[:80]
        name = re.sub(r'[\x00-\x1f\x7f"<>\\]', "", name) or "Unbekannt"
        gruppen = json.dumps(sorted({str(g).lower() for g in (person.get("groups") or [])}))
        _telefon_abmelden(conn, ext, f"abgeloest:{karte}")
        conn.execute("INSERT INTO telefon_sitzungen (ext, user_id, email, name, gruppen) VALUES (?,?,?,?,?)",
                     (ext, str(person.get("user_id") or ""), email, name, gruppen))
        _karten_log(conn, ext, "an", email, name, karte)
        _sip_person_anlegen(conn, ext)
        conn.commit()
        _sip_person_neu_laden()
        s = conn.execute("SELECT name, email, seit, gruppen FROM telefon_sitzungen WHERE ext = ?", (ext,)).fetchone()
        return jsonify({"ok": True, "ext": ext, **_sitzung_json(s), **_apps_fuer(conn, s)})
    finally:
        conn.close()


def _karten_verwalter():
    """Geraet + angemeldete Person mit Technik/Praesident. -> (ext, sitzung, None) oder (.., .., response)."""
    ext, deny = _geraet()
    if deny:
        return None, None, deny
    conn = db.connect()
    try:
        s = conn.execute("SELECT name, email, gruppen FROM telefon_sitzungen WHERE ext = ?", (ext,)).fetchone()
    finally:
        conn.close()
    try:
        gruppen = {str(g).lower() for g in json.loads((s["gruppen"] if s else None) or "[]")}
    except ValueError:
        gruppen = set()
    if not s or not (gruppen & KARTEN_VERWALTER):
        return ext, None, (jsonify({"error": "nicht berechtigt"}), 403)
    return ext, s, None


def _karten_durch(ext, s):
    return f"Telefon {ext} ({s['name']} <{s['email']}>)"


def _karten_weiter(ext, s, ereignis, methode, pfad, daten, ziel_email=None):
    try:
        status, body = _haupt_karte(methode, pfad, daten)
    except requests.RequestException as e:
        app.logger.warning("Karten %s: Website nicht erreichbar (%s)", ext, type(e).__name__)
        return jsonify({"error": "Keine Verbindung zur Anlage"}), 502
    conn = db.connect()
    try:
        ziel = ziel_email or (body.get("person") or {}).get("email") or ""
        karte = body.get("display_id") or (daten or {}).get("nfc_id") or pfad.rsplit("/", 1)[-1]
        _karten_log(conn, ext, ereignis, s["email"], s["name"],
                    f"karte:{karte}" + (f"->{ziel}" if ziel else "") + ("" if status == 200 else f":{status}"))
        conn.commit()
    finally:
        conn.close()
    return jsonify(body), status


@app.post("/api/telefon/karten/info")
def telefon_karten_info():
    ext, s, deny = _karten_verwalter()
    if deny:
        return deny
    uid = _karten_uid((request.get_json(silent=True) or {}).get("uid"))
    if not uid:
        return jsonify({"error": "Karte nicht lesbar"}), 400
    resp, status = _karten_weiter(ext, s, "karte-info", "GET", f"/api/pbx/karte/{uid}", None)
    if status == 200:
        # Gruppen und Website-ID braucht das Telefon nicht
        d = resp.get_json() or {}
        p = d.get("person")
        if p:
            d["person"] = {"name": p.get("name"), "email": p.get("email")}
        d["uid"] = uid
        return jsonify(d)
    return resp, status


@app.post("/api/telefon/karten/zuordnen")
def telefon_karten_zuordnen():
    ext, s, deny = _karten_verwalter()
    if deny:
        return deny
    d = request.get_json(silent=True) or {}
    uid = _karten_uid(d.get("uid"))
    email = str(d.get("email") or "").strip().lower()
    if not uid or not re.fullmatch(r"[^\s@]+@[^\s@]+", email):
        return jsonify({"error": "Karte oder E-Mail fehlt"}), 400
    return _karten_weiter(ext, s, "karte-zu", "POST", "/api/pbx/karte/zuordnen",
                          {"nfc_id": uid, "email": email, "durch": _karten_durch(ext, s)}, ziel_email=email)


@app.post("/api/telefon/karten/entziehen")
def telefon_karten_entziehen():
    ext, s, deny = _karten_verwalter()
    if deny:
        return deny
    uid = _karten_uid((request.get_json(silent=True) or {}).get("uid"))
    if not uid:
        return jsonify({"error": "Karte nicht lesbar"}), 400
    return _karten_weiter(ext, s, "karte-weg", "POST", "/api/pbx/karte/entziehen",
                          {"nfc_id": uid, "durch": _karten_durch(ext, s)})


@app.post("/api/telefon/karten/loeschen")
def telefon_karten_loeschen():
    """Entzogene Karte aus dem Bestand von UniFi Access loeschen (defekt/verloren)."""
    ext, s, deny = _karten_verwalter()
    if deny:
        return deny
    uid = _karten_uid((request.get_json(silent=True) or {}).get("uid"))
    if not uid:
        return jsonify({"error": "Karte nicht lesbar"}), 400
    return _karten_weiter(ext, s, "karte-geloescht", "POST", "/api/pbx/karte/loeschen",
                          {"nfc_id": uid, "durch": _karten_durch(ext, s)})


@app.get("/api/telefon/karten/personen")
def telefon_karten_personen():
    """Auswahlliste fuer "Einer Person zuordnen": Personen aus dem Personen-Abgleich."""
    _, _, deny = _karten_verwalter()
    if deny:
        return deny
    conn = db.connect()
    try:
        rows = conn.execute("SELECT lower(email) AS email, MIN(name) AS name FROM personen_nummern "
                            "WHERE aktiv = 1 AND email <> '' GROUP BY lower(email)").fetchall()
    finally:
        conn.close()
    personen = sorted(({"name": r["name"], "email": r["email"]} for r in rows),
                      key=lambda p: (p["name"] or "").lower())
    return jsonify({"personen": personen})


# ─── App-Katalog der geteilten Telefone ─────────────────────────────────────
_PAKET = re.compile(r"(web\.[a-z0-9_]{1,40}|[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*){1,10})")


def _app_json(r, mit_intern=False):
    d = {"paket": r["paket"], "name": r["name"], "art": r["art"], "persoenlich": bool(r["persoenlich"]),
         "immer": bool(r["immer"]), "reihenfolge": r["reihenfolge"]}
    if r["art"] == "web":
        d["url"] = r["url"]
    else:
        d.update({"sha256": r["sha256"], "groesse": r["groesse"],
                  "download": f"/api/telefon/apk/{r['paket']}" if r["apk_datei"] else None})
    if mit_intern:
        d.update({"gruppen": r["gruppen"], "konfig": r["konfig"], "aktiv": bool(r["aktiv"]),
                  "apk_datei": r["apk_datei"], "updated_at": r["updated_at"]})
    return d


def _konfig_fuer(roh, sitzung):
    """Platzhalter {email} {name} {benutzer} in den Werten der Managed Configuration fuellen."""
    try:
        k = json.loads(roh or "{}")
    except ValueError:
        return {}
    email = sitzung["email"] or ""
    werte = {"email": email, "name": sitzung["name"] or "", "benutzer": email.split("@")[0]}
    out = {}
    for key, v in (k.items() if isinstance(k, dict) else []):
        if isinstance(v, str):
            for ph, w in werte.items():
                v = v.replace("{" + ph + "}", w)
        out[str(key)] = v
    return out


def _apps_fuer(conn, sitzung):
    """Welche Katalog-Apps die angemeldete Person sieht (+ ihre Einstellungen)."""
    if not sitzung:
        return {"apps": []}
    try:
        gruppen = {str(g).lower() for g in json.loads(sitzung["gruppen"] or "[]")}
    except (ValueError, IndexError, KeyError):
        gruppen = set()
    out = []
    for r in conn.execute("SELECT * FROM telefon_apps WHERE aktiv = 1 ORDER BY reihenfolge, name"):
        erlaubt = {g.strip().lower() for g in (r["gruppen"] or "").split(",") if g.strip()}
        if erlaubt and not (erlaubt & gruppen):
            continue
        d = _app_json(r)
        d["konfig"] = _konfig_fuer(r["konfig"], sitzung)
        out.append(d)
    return {"apps": out}


@app.get("/api/telefon/katalog")
def telefon_katalog():
    """Alle aktiven Apps — das Geraet installiert die APKs vorab und haelt sie versteckt."""
    ext, deny = _geraet()
    if deny:
        return deny
    conn = db.connect()
    try:
        rows = conn.execute("SELECT * FROM telefon_apps WHERE aktiv = 1 ORDER BY reihenfolge, name").fetchall()
        cfg = _cfg(conn)
        aus = [p.strip() for p in re.split(r"[,\s]+", cfg.get("telefon_ausblenden", "")) if p.strip()]
        unsichtbar = [p.strip() for p in re.split(r"[,\s]+", cfg.get("telefon_unsichtbar", "")) if p.strip()]
        return jsonify({"apps": [_app_json(r) for r in rows], "ausblenden": aus, "unsichtbar": unsichtbar})
    finally:
        conn.close()


@app.get("/api/telefon/apk/<paket>")
def telefon_apk(paket):
    ext, deny = _geraet()
    if deny:
        return deny
    conn = db.connect()
    try:
        r = conn.execute("SELECT apk_datei FROM telefon_apps WHERE paket = ? AND art = 'apk' AND aktiv = 1",
                         (paket,)).fetchone()
    finally:
        conn.close()
    if not r or not r["apk_datei"]:
        return jsonify({"error": "unbekannt"}), 404
    return send_from_directory(TELEFON_APPS_DIR, r["apk_datei"],
                               mimetype="application/vnd.android.package-archive")


# ─── Seite rosenweg4303.ch/smartphones (Stefan 25.11.2026) ───────────────────
# Die Seite liegt auf www und ruft die Anlage direkt (Bearer-Token des Rosenweg-Logins,
# keine Cookies). Erlaubt nur fuer die Website-Adressen und nur /api/telefon/* und /api/pbx/*.
SEITEN_HERKUNFT = {"https://www.rosenweg4303.ch", "https://rosenweg4303.ch"}


@app.after_request
def _cors_seite(res):
    herkunft = request.headers.get("Origin", "")
    if herkunft in SEITEN_HERKUNFT and (request.path.startswith("/api/telefon/")
                                        or request.path.startswith("/api/pbx/")):
        res.headers["Access-Control-Allow-Origin"] = herkunft
        res.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
        res.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
        res.headers["Access-Control-Max-Age"] = "600"
        res.headers.add("Vary", "Origin")
    return res


# ─── Oeffentliche Downloads (Apps-Seite, Updater der Apps auf privaten Handys) ───
# Stefan 25.11.2026: "auf die apps seite die releases zum download anbieten" und "alle apps
# brauchen updater wenn geraet nicht da ist". Quelle ist der App-Katalog der geteilten Telefone;
# Rosenweg Geraet gehoert nur auf verwaltete Telefone und ist darum nicht dabei.
APPS_OEFFENTLICH_OHNE = {"ch.rosenweg4303.telefon"}
APPS_HERKUNFT = {"https://www.rosenweg4303.ch", "https://rosenweg4303.ch"}


def _oeffentlich(res):
    herkunft = request.headers.get("Origin", "")
    if herkunft in APPS_HERKUNFT:
        res.headers["Access-Control-Allow-Origin"] = herkunft
        res.headers["Vary"] = "Origin"
    res.headers["Cache-Control"] = "public, max-age=300"
    return res


@app.get("/api/apps/index.json")
def apps_index():
    conn = db.connect()
    try:
        rows = conn.execute("SELECT paket, name, sha256, groesse, version_code, version_name, updated_at "
                            "FROM telefon_apps WHERE art = 'apk' AND aktiv = 1 AND apk_datei IS NOT NULL "
                            "ORDER BY reihenfolge, name").fetchall()
    finally:
        conn.close()
    apps = [{"paket": r["paket"], "name": r["name"], "sha256": r["sha256"], "groesse": r["groesse"],
             "version_code": r["version_code"], "version_name": r["version_name"], "stand": r["updated_at"],
             "url": f"/api/apps/{r['paket']}.apk"}
            for r in rows if r["paket"] not in APPS_OEFFENTLICH_OHNE]
    return _oeffentlich(jsonify({"apps": apps, "signatur_sha256": "7b3bac26e82b6103546b96861dcf1bb89b3239424ff11fdf684975cf78c5a5ae"}))


@app.get("/api/apps/<paket>.apk")
def apps_download(paket):
    if not re.fullmatch(r"[a-z][a-z0-9_]*(\.[a-z0-9_]+)+", paket) or paket in APPS_OEFFENTLICH_OHNE:
        return jsonify({"error": "unbekannt"}), 404
    conn = db.connect()
    try:
        r = conn.execute("SELECT name, apk_datei, version_name FROM telefon_apps "
                         "WHERE paket = ? AND art = 'apk' AND aktiv = 1", (paket,)).fetchone()
    finally:
        conn.close()
    if not r or not r["apk_datei"]:
        return jsonify({"error": "unbekannt"}), 404
    name = re.sub(r"[^A-Za-z0-9]+", "-", f"{r['name']}-{r['version_name'] or ''}").strip("-").lower()
    return _oeffentlich(send_from_directory(TELEFON_APPS_DIR, r["apk_datei"], as_attachment=True,
                                            download_name=f"{name}.apk",
                                            mimetype="application/vnd.android.package-archive"))


@app.get("/api/pbx/telefon-apps")
def telefon_apps_liste():
    _, deny = require_admin()
    if deny:
        return deny
    conn = db.connect()
    try:
        rows = conn.execute("SELECT * FROM telefon_apps ORDER BY reihenfolge, name").fetchall()
        return jsonify({"apps": [_app_json(r, True) for r in rows]})
    finally:
        conn.close()


@app.put("/api/pbx/telefon-apps/<paket>")
def telefon_app_speichern(paket):
    """Anlegen oder aendern (ohne APK-Datei; die kommt per POST .../apk)."""
    user, deny = require_admin()
    if deny:
        return deny
    if not _PAKET.fullmatch(paket):
        return jsonify({"error": "Paketname ungueltig (z.B. com.nextcloud.client oder web.portal)"}), 400
    b = request.get_json(silent=True) or {}
    art = "web" if paket.startswith("web.") else "apk"
    name = str(b.get("name") or "").strip()
    if not name or len(name) > 60 or _STEUERZEICHEN.search(name):
        return jsonify({"error": "name ungueltig"}), 400
    url = str(b.get("url") or "").strip() if art == "web" else None
    if art == "web" and not re.fullmatch(r"https://[A-Za-z0-9.-]+(:[0-9]+)?(/[^\s]*)?", url or ""):
        return jsonify({"error": "url muss mit https:// beginnen"}), 400
    gruppen = str(b.get("gruppen") or "").strip()
    if not re.fullmatch(r"[\w äöüÄÖÜ,.-]{0,300}", gruppen):
        return jsonify({"error": "gruppen: Namen durch Komma getrennt"}), 400
    konfig = b.get("konfig", {})
    if isinstance(konfig, str):
        try:
            konfig = json.loads(konfig or "{}")
        except ValueError:
            return jsonify({"error": "konfig ist kein gueltiges JSON"}), 400
    if not isinstance(konfig, dict) or not all(isinstance(v, (str, int, bool)) for v in konfig.values()):
        return jsonify({"error": "konfig: flaches JSON-Objekt mit Text/Zahl/Ja-Nein"}), 400
    try:
        reihenfolge = int(b.get("reihenfolge", 100))
    except (TypeError, ValueError):
        return jsonify({"error": "reihenfolge muss eine Zahl sein"}), 400
    conn = db.connect()
    try:
        conn.execute(
            "INSERT INTO telefon_apps (paket, name, art, url, gruppen, persoenlich, konfig, reihenfolge, aktiv, immer) "
            "VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(paket) DO UPDATE SET name=excluded.name, url=excluded.url, "
            "gruppen=excluded.gruppen, persoenlich=excluded.persoenlich, konfig=excluded.konfig, "
            "reihenfolge=excluded.reihenfolge, aktiv=excluded.aktiv, immer=excluded.immer, updated_at=datetime('now')",
            (paket, name, art, url, gruppen, 1 if b.get("persoenlich", True) else 0,
             json.dumps(konfig, ensure_ascii=False), reihenfolge, 1 if b.get("aktiv", True) else 0,
             1 if b.get("immer", False) else 0))
        conn.commit()
        r = conn.execute("SELECT * FROM telefon_apps WHERE paket = ?", (paket,)).fetchone()
        return jsonify({"app": _app_json(r, True)})
    finally:
        conn.close()


@app.post("/api/pbx/telefon-apps/<paket>/apk")
def telefon_app_apk_hochladen(paket):
    """APK hochladen (Rohdaten im Body oder multipart 'apk'). Ersetzt die bisherige Datei."""
    _, deny = require_admin()
    if deny:
        return deny
    f = request.files.get("apk")
    daten = f.read(TELEFON_APK_MAX + 1) if f else request.get_data(cache=False)
    if not daten or len(daten) > TELEFON_APK_MAX or daten[:2] != b"PK":
        return jsonify({"error": "keine APK-Datei (ZIP) oder zu gross"}), 400
    conn = db.connect()
    try:
        r = conn.execute("SELECT art, apk_datei FROM telefon_apps WHERE paket = ?", (paket,)).fetchone()
        if not r or r["art"] != "apk":
            return jsonify({"error": "zuerst die App (art apk) anlegen"}), 404
        sha = hashlib.sha256(daten).hexdigest()
        os.makedirs(TELEFON_APPS_DIR, exist_ok=True)
        datei = f"{paket}-{sha[:12]}.apk"
        tmp = os.path.join(TELEFON_APPS_DIR, datei + ".tmp")
        with open(tmp, "wb") as out:
            out.write(daten)
        os.replace(tmp, os.path.join(TELEFON_APPS_DIR, datei))
        conn.execute("UPDATE telefon_apps SET apk_datei=?, sha256=?, groesse=?, updated_at=datetime('now') "
                     "WHERE paket=?", (datei, sha, len(daten), paket))
        conn.commit()
        alt = r["apk_datei"]
        if alt and alt != datei:
            try:
                os.remove(os.path.join(TELEFON_APPS_DIR, alt))
            except OSError:
                pass
        return jsonify({"ok": True, "paket": paket, "sha256": sha, "groesse": len(daten)})
    finally:
        conn.close()


@app.delete("/api/pbx/telefon-apps/<paket>")
def telefon_app_loeschen(paket):
    _, deny = require_admin()
    if deny:
        return deny
    conn = db.connect()
    try:
        r = conn.execute("SELECT apk_datei FROM telefon_apps WHERE paket = ?", (paket,)).fetchone()
        conn.execute("DELETE FROM telefon_apps WHERE paket = ?", (paket,))
        conn.commit()
        if r and r["apk_datei"]:
            try:
                os.remove(os.path.join(TELEFON_APPS_DIR, r["apk_datei"]))
            except OSError:
                pass
        return jsonify({"ok": True})
    finally:
        conn.close()


# ─── Telefonbuch fuer die geteilten Telefone ────────────────────────────────
# Die Geraete bekommen das Rosenweg-Verzeichnis (Nextcloud, contacts-sync) als
# schlanke Liste und schreiben es ins Android-Adressbuch (eigenes Konto
# "Rosenweg"). Die CardDAV-Zugangsdaten bleiben hier auf der Anlage.
_KONTAKTE_CACHE = {"zeit": 0.0, "daten": None}
_KONTAKTE_TTL_S = 600


def _vcard_wert(v):
    return (v.replace("\\n", " ").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\")).strip()


def _vcards_lesen(text):
    """Minimaler vCard-Leser: FN, ORG, TEL (mit TYPE), EMAIL. Gefaltete Zeilen werden zusammengesetzt."""
    zeilen = []
    for z in text.replace("\r\n", "\n").split("\n"):
        if z[:1] in (" ", "\t") and zeilen:
            zeilen[-1] += z[1:]
        else:
            zeilen.append(z)
    karten, k = [], None
    for z in zeilen:
        if z.upper() == "BEGIN:VCARD":
            k = {"name": "", "org": "", "nummern": [], "emails": []}
        elif z.upper() == "END:VCARD" and k is not None:
            if k["name"] and (k["nummern"] or k["emails"]):
                karten.append(k)
            k = None
        elif k is not None and ":" in z:
            kopf, wert = z.split(":", 1)
            teile = kopf.split(";")
            feld = teile[0].split(".")[-1].upper()   # "item1.TEL" -> TEL
            params = ";".join(teile[1:]).upper()
            if feld == "FN":
                k["name"] = _vcard_wert(wert)[:120]
            elif feld == "ORG":
                k["org"] = _vcard_wert(wert.replace(";", " ")).strip()[:120]
            elif feld == "TEL":
                nummer = re.sub(r"[^0-9+*#]", "", wert)
                if 3 <= len(nummer) <= 25:
                    typ = ("mobil" if "CELL" in params else "arbeit" if "WORK" in params
                           else "privat" if "HOME" in params else "andere")
                    k["nummern"].append({"nummer": nummer, "typ": typ})
            elif feld == "EMAIL":
                mail = _vcard_wert(wert)
                if "@" in mail and len(mail) <= 200:
                    k["emails"].append(mail)
    karten.sort(key=lambda x: x["name"].lower())
    return karten


@app.get("/api/telefon/kontakte")
def telefon_kontakte():
    ext, deny = _geraet()
    if deny:
        return deny
    if not PROV_CARDDAV_URL:
        return jsonify({"version": "", "kontakte": []})
    jetzt = time.time()
    if _KONTAKTE_CACHE["daten"] is None or jetzt - _KONTAKTE_CACHE["zeit"] > _KONTAKTE_TTL_S:
        try:
            r = requests.get(PROV_CARDDAV_URL.rstrip("/") + "/?export",
                             auth=(PROV_CARDDAV_USER, PROV_CARDDAV_PASS), timeout=20)
            r.raise_for_status()
            r.encoding = "utf-8"
            karten = _vcards_lesen(r.text)
        except requests.RequestException as e:
            if _KONTAKTE_CACHE["daten"] is None:
                return jsonify({"error": f"Verzeichnis nicht erreichbar: {type(e).__name__}"}), 502
        else:
            roh = json.dumps(karten, ensure_ascii=False, sort_keys=True)
            _KONTAKTE_CACHE.update(zeit=jetzt, daten={
                "version": hashlib.sha256(roh.encode()).hexdigest()[:16], "kontakte": karten})
    d = _mit_internen_nummern(_KONTAKTE_CACHE["daten"])
    if request.args.get("version") == d["version"]:
        return jsonify({"version": d["version"], "unveraendert": True})
    return jsonify(d)


def _name_teile(n):
    return {t for t in re.split(r"[\s\-]+", (n or "").lower()) if len(t) > 1}


def _gleiche_person(a, b):
    """'Atesci Remzi' = 'Remzi Atesci', 'Claude Koller' = 'Claude Alexandre Koller':
    die Namensteile des kuerzeren Namens stecken alle im laengeren."""
    ta, tb = _name_teile(a), _name_teile(b)
    if len(ta) < 2 or len(tb) < 2:
        return False
    firma = {"ag", "gmbh", "sa", "gemeinde", "einwohnergemeinde", "stiftung", "genossenschaft"}
    if bool(ta & firma) != bool(tb & firma):
        return False   # "Mehmet Peker AG" ist nicht "Mehmet Peker"
    kurz, lang = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
    return kurz <= lang


def _mit_internen_nummern(d):
    """Telefonbuch um die internen Nummern ergaenzen (Nummernplan 24.11.2026):
    persoenliche Nummer (3HHWWP) bei der Person mit derselben E-Mail, Kurzwahl der
    Verwaltung (4XXX) beim Kontakt mit der Ziel-Nummer. typ 'rosenweg' — das Telefon
    beschriftet sie als 'Rosenweg'. Die Version enthaelt die Nummern, damit die
    Telefone eine Aenderung sofort holen."""
    conn = db.connect()
    try:
        personen = {}
        for r in conn.execute("SELECT email, nummer, name FROM personen_nummern WHERE aktiv = 1"):
            personen.setdefault(r["email"].lower(), []).append((r["nummer"], r["name"]))
        verwaltung = {}
        for r in conn.execute("SELECT nummer, ziel FROM verwaltung_nummern WHERE aktiv = 1"):
            verwaltung.setdefault(re.sub(r"[^0-9+]", "", r["ziel"] or ""), []).append(r["nummer"])
    finally:
        conn.close()
    if not personen and not verwaltung:
        return d
    karten = []
    for k in d["kontakte"]:
        intern = []
        for m in k.get("emails") or []:
            # Paare teilen sich oft eine E-Mail: nur die Nummer mit passendem Namen
            for nr, name in personen.get(m.lower(), []):
                if nr not in intern and _gleiche_person(name, k.get("name")):
                    intern.append(nr)
        for n in k.get("nummern") or []:
            for kurz in verwaltung.get(n.get("nummer"), []):
                if kurz not in intern:
                    intern.append(kurz)
        if intern:
            vorhanden = {n.get("nummer") for n in k["nummern"]}
            k = dict(k, nummern=[{"nummer": nr, "typ": "rosenweg"} for nr in intern if nr not in vorhanden] + k["nummern"])
        karten.append(k)
    roh = json.dumps(karten, ensure_ascii=False, sort_keys=True)
    return {"version": hashlib.sha256(roh.encode()).hexdigest()[:16], "kontakte": karten}


# ─── Rosenweg Telefon: Daten der Person aus der Anlage (Regel 6/7) ───────────
def _nebenstelle():
    """HTTP-Basic ext:secret irgendeiner aktiven Nebenstelle (nicht nur geteilt):
    Rosenweg Telefon weist sich mit seinem SIP-Zugang aus. -> (ext, None) | (None, response)"""
    a = request.authorization
    nein = (jsonify({"error": "Nebenstelle nicht berechtigt"}), 401)
    if not a or not a.username or not a.password:
        return None, nein
    conn = db.connect()
    try:
        row = conn.execute("SELECT ext, secret FROM sip_extensions WHERE ext = ? AND enabled = 1",
                           (a.username,)).fetchone()
    finally:
        conn.close()
    if not row or not hmac.compare_digest(str(row["secret"]).encode(), a.password.encode()):
        return None, nein
    return row["ext"], None


def _person_der_nebenstelle(conn, ext):
    """Person hinter einer Nebenstelle: Sitzung (geteilte Telefone). Persoenliche
    3000er-Nummern kommen mit dem Nummernplan (docs/plans/telefon-nummernplan.md)."""
    r = conn.execute("SELECT email, name FROM telefon_sitzungen WHERE ext = ?", (ext,)).fetchone()
    return (r["email"], r["name"]) if r and r["email"] else (None, None)


@app.get("/api/telefon/anrufliste")
def telefon_anrufliste():
    """Anrufe der Person, die an dieser Nebenstelle angemeldet ist — ueber alle Geraete."""
    ext, deny = _nebenstelle()
    if deny:
        return deny
    limit = min(int(request.args.get("limit", 200) or 200), 500)
    conn = db.connect()
    try:
        email, name = _person_der_nebenstelle(conn, ext)
        if not email:
            return jsonify({"angemeldet": False, "anrufe": []})
        rows = conn.execute(
            "SELECT id, direction, caller_id, dialed, ext, person, ziel_ext, ziel_person, started_at, "
            "answered_at, duration_seconds, hangup_cause, voicemail_summary, voicemail_path "
            "FROM calls WHERE lower(person) = lower(?) OR lower(ziel_person) = lower(?) "
            "ORDER BY started_at DESC LIMIT ?", (email, email, limit)).fetchall()
        anrufe = []
        for r in rows:
            ich_rufe = (r["person"] or "").lower() == email.lower() and r["direction"] in ("internal", "outbound")
            angenommen = bool(r["answered_at"]) or (r["hangup_cause"] or "").upper() == "ANSWERED"
            anrufe.append({
                "id": r["id"],
                # aus Sicht der Person
                "richtung": "ausgehend" if ich_rufe else ("eingehend" if angenommen else "verpasst"),
                "nummer": r["dialed"] if ich_rufe else r["caller_id"],
                "ueber": r["ext"] if ich_rufe else (r["ziel_ext"] or r["ext"]),
                "beginn": r["started_at"],
                "dauer": r["duration_seconds"],
                "voicemail": r["voicemail_summary"],
                "voicemail_audio": bool(r["voicemail_path"]) and (r["ziel_person"] or "").lower() == email.lower(),
            })
        return jsonify({"angemeldet": True, "name": name, "anrufe": anrufe})
    finally:
        conn.close()


@app.get("/api/telefon/voicemail/<int:call_id>")
def telefon_voicemail(call_id):
    """Persoenliche Voicemail anhoeren — nur die Person, der sie gehoert."""
    ext, deny = _nebenstelle()
    if deny:
        return deny
    conn = db.connect()
    try:
        email, _ = _person_der_nebenstelle(conn, ext)
        r = conn.execute("SELECT voicemail_path, ziel_person FROM calls WHERE id = ?", (call_id,)).fetchone()
        if not email or not r or not r["voicemail_path"] or (r["ziel_person"] or "").lower() != email.lower():
            return jsonify({"error": "Nicht gefunden"}), 404
        pfad = os.path.realpath(r["voicemail_path"])
        if not pfad.startswith(VM_PERSON_DIR + "/") or not os.path.isfile(pfad):
            return jsonify({"error": "Nicht gefunden"}), 404
        return send_file(pfad, mimetype="audio/wav")
    finally:
        conn.close()


@app.route("/api/telefon/einstellungen", methods=["GET", "PUT"])
def telefon_einstellungen():
    """Einstellungen einer App pro Person (?paket=...). PUT {geaendert, werte}:
    gespeichert, wenn neuer als die Fassung auf der Anlage."""
    ext, deny = _nebenstelle()
    if deny:
        return deny
    paket = (request.args.get("paket") or "").strip()
    if not paket or len(paket) > 100:
        return jsonify({"error": "paket fehlt"}), 400
    conn = db.connect()
    try:
        email, _ = _person_der_nebenstelle(conn, ext)
        if not email:
            return jsonify({"error": "Niemand angemeldet"}), 409
        alt = conn.execute("SELECT werte, geaendert FROM telefon_einstellungen WHERE email = ? AND paket = ?",
                           (email.lower(), paket)).fetchone()
        if request.method == "GET":
            if not alt:
                return jsonify({"geaendert": 0, "werte": {}})
            return jsonify({"geaendert": alt["geaendert"], "werte": json.loads(alt["werte"])})
        b = request.get_json(silent=True) or {}
        werte, geaendert = b.get("werte"), int(b.get("geaendert") or 0)
        if not isinstance(werte, dict) or len(json.dumps(werte)) > 64_000:
            return jsonify({"error": "werte ungueltig"}), 400
        if alt and alt["geaendert"] >= geaendert:
            return jsonify({"ok": True, "uebernommen": False, "geaendert": alt["geaendert"]})
        conn.execute(
            "INSERT INTO telefon_einstellungen (email, paket, werte, geaendert, updated_at) "
            "VALUES (?,?,?,?, datetime('now')) ON CONFLICT(email, paket) DO UPDATE SET "
            "werte = excluded.werte, geaendert = excluded.geaendert, updated_at = excluded.updated_at",
            (email.lower(), paket, json.dumps(werte, ensure_ascii=False), geaendert))
        conn.commit()
        return jsonify({"ok": True, "uebernommen": True, "geaendert": geaendert})
    finally:
        conn.close()


def _pin_fernet():
    """Fernet mit PBX_PIN_KEY, oder None wenn nicht eingerichtet."""
    key = os.environ.get("PBX_PIN_KEY", "")
    if not key:
        return None
    from cryptography.fernet import Fernet
    return Fernet(key.encode())


def _pin_zu_einfach(pin):
    if len(set(pin)) == 1:
        return True
    ziffern = [int(z) for z in pin]
    schritte = {b - a for a, b in zip(ziffern, ziffern[1:])}
    return schritte in ({1}, {-1})


@app.route("/api/telefon/pin", methods=["GET", "PUT", "DELETE"])
def telefon_pin():
    """Persoenliche PIN der auf diesem Geraet angemeldeten Person (Bildschirmsperre).
    GET -> {gesetzt, pin}; PUT {pin}: 4-12 Ziffern; DELETE: PIN entfernen.
    Nur die Nebenstelle, auf der die Person gerade angemeldet ist, bekommt sie."""
    ext, deny = _nebenstelle()
    if deny:
        return deny
    f = _pin_fernet()
    if f is None:
        return jsonify({"error": "PIN nicht eingerichtet"}), 503
    conn = db.connect()
    try:
        email, _ = _person_der_nebenstelle(conn, ext)
        if not email:
            return jsonify({"error": "Niemand angemeldet"}), 409
        email = email.lower()
        if request.method == "GET":
            r = conn.execute("SELECT pin_enc FROM telefon_pin WHERE email = ?", (email,)).fetchone()
            if not r:
                return jsonify({"gesetzt": False})
            return jsonify({"gesetzt": True, "pin": f.decrypt(r["pin_enc"].encode()).decode()})
        if request.method == "DELETE":
            conn.execute("DELETE FROM telefon_pin WHERE email = ?", (email,))
            conn.commit()
            app.logger.info("PIN entfernt (Nebenstelle %s)", ext)
            return jsonify({"ok": True})
        pin = str((request.get_json(silent=True) or {}).get("pin") or "")
        if not re.fullmatch(r"\d{4,12}", pin):
            return jsonify({"error": "Die PIN braucht 4 bis 12 Ziffern."}), 400
        if _pin_zu_einfach(pin):
            return jsonify({"error": "Die PIN ist zu einfach (gleiche Ziffern oder Reihe)."}), 400
        conn.execute("INSERT INTO telefon_pin (email, pin_enc, updated_at) VALUES (?,?, datetime('now')) "
                     "ON CONFLICT(email) DO UPDATE SET pin_enc = excluded.pin_enc, updated_at = excluded.updated_at",
                     (email, f.encrypt(pin.encode()).decode()))
        conn.commit()
        app.logger.info("PIN gesetzt (Nebenstelle %s)", ext)
        return jsonify({"ok": True})
    finally:
        conn.close()


def personen_abgleichen(probe=False):
    """Neue Personen (Website: Wohnungen + Kontakte) bekommen eine persoenliche Nummer.
    Vergebene Nummern bleiben. -> {neu: [...], probleme: [...]}"""
    r = requests.get(f"{MAIN_API_BASE}/api/pbx/personen",
                     headers={"X-PBX-Secret": PBX_SHARED_SECRET}, timeout=20)
    r.raise_for_status()
    conn = db.connect()
    try:
        bestehende = db.rows_to_dicts(conn.execute(
            "SELECT nummer, email, name, wohnung, haus FROM personen_nummern").fetchall())
        neu, probleme = nummernvergabe.neue_nummern(r.json(), bestehende)
        if not probe:
            for n in neu:
                conn.execute("INSERT INTO personen_nummern (nummer, email, name, wohnung, haus, art) "
                             "VALUES (?,?,?,?,?,?)",
                             (n["nummer"], n["email"], n["name"], n["wohnung"], n["haus"], n["art"]))
                app.logger.info("Neue persoenliche Nummer %s (%s)", n["nummer"], n["art"])
            conn.commit()
        for p in probleme:
            app.logger.warning("Nummernvergabe: %s", p)
        return {"neu": neu, "probleme": probleme, "probe": probe}
    finally:
        conn.close()


def _personen_abgleich_schleife():
    """Stuendlich: neue Personen bekommen ihre Nummer (erster Lauf 2 Minuten nach dem Start)."""
    time.sleep(120)
    while True:
        try:
            personen_abgleichen()
        except Exception as e:
            app.logger.warning("Personen-Abgleich: %s", e)
        try:
            nextcloud_nachlauf_aufraeumen()
        except Exception as e:
            app.logger.warning("Nextcloud-Nachlauf: %s", e)
        try:
            sip_person_aufraeumen()
        except Exception as e:
            app.logger.warning("SIP-Zugaenge aufraeumen: %s", e)
        time.sleep(3600)


@app.post("/api/pbx/nummernplan/abgleich")
def nummernplan_abgleich():
    """Admin: Abgleich sofort ausloesen. ?probe=1 zeigt nur, was vergeben wuerde."""
    _, deny = require_admin()
    if deny:
        return deny
    try:
        return jsonify(personen_abgleichen(probe=request.args.get("probe") == "1"))
    except requests.RequestException as e:
        return jsonify({"error": f"Website nicht erreichbar: {e}"}), 502


NC_TOKEN_URL = os.environ.get("NC_TOKEN_URL", "").rstrip("/")
NC_TOKEN_SECRET = os.environ.get("NC_TOKEN_SECRET", "")
NEXTCLOUD_SERVER = "https://nextcloud.rosenweg4303.ch"


def _nc_name(ext):
    return f"Rosenweg Geraet {ext}"


def _nextcloud_widerrufen(conn, ext):
    """App-Passwort der Person auf diesem Geraet loeschen (beim Abmelden). Im Hintergrund."""
    r = conn.execute("SELECT email FROM telefon_nextcloud WHERE ext = ?", (ext,)).fetchone()
    if not r:
        return
    conn.execute("DELETE FROM telefon_nextcloud WHERE ext = ?", (ext,))
    email = r["email"]

    def los():
        try:
            requests.post(f"{NC_TOKEN_URL}/widerrufen", json={"email": email, "name": _nc_name(ext)},
                          headers={"X-NC-Token-Secret": NC_TOKEN_SECRET}, timeout=60)
        except Exception as e:
            app.logger.warning("Nextcloud-Widerruf %s: %s", ext, type(e).__name__)
    if NC_TOKEN_URL:
        import threading
        threading.Thread(target=los, daemon=True).start()


@app.get("/api/telefon/nextcloud")
def telefon_nextcloud():
    """Nextcloud-Zugang der Person, die auf diesem Geraet angemeldet ist (fuer die
    Rosenweg-Apps ueber die Geraete-App). -> {server, benutzer, app_passwort}"""
    ext, deny = _nebenstelle()
    if deny:
        return deny
    f = _pin_fernet()
    if f is None or not NC_TOKEN_URL:
        return jsonify({"error": "Nextcloud-Zugang nicht eingerichtet"}), 503
    conn = db.connect()
    try:
        email, _ = _person_der_nebenstelle(conn, ext)
        r = conn.execute("SELECT email, benutzer, pw_enc, abgemeldet_at FROM telefon_nextcloud WHERE ext = ?", (ext,)).fetchone()
        if not email:
            # Nachlauf: abgemeldet, aber noch nicht alles hochgeladen (hoechstens 24 h)
            if r and r["abgemeldet_at"] and conn.execute(
                    "SELECT datetime('now', '-24 hours') < ?", (r["abgemeldet_at"],)).fetchone()[0]:
                return jsonify({"server": NEXTCLOUD_SERVER, "benutzer": r["benutzer"], "nachlauf": True,
                                "app_passwort": f.decrypt(r["pw_enc"].encode()).decode()})
            return jsonify({"error": "Niemand angemeldet"}), 409
        email = email.lower()
        if r and r["email"] == email:
            conn.execute("UPDATE telefon_nextcloud SET abgemeldet_at = NULL WHERE ext = ?", (ext,))
            conn.commit()
            return jsonify({"server": NEXTCLOUD_SERVER, "benutzer": r["benutzer"],
                            "app_passwort": f.decrypt(r["pw_enc"].encode()).decode()})
        if r:   # andere Person: altes Passwort weg
            _nextcloud_widerrufen(conn, ext)
        try:
            a = requests.post(f"{NC_TOKEN_URL}/ausstellen", json={"email": email, "name": _nc_name(ext)},
                              headers={"X-NC-Token-Secret": NC_TOKEN_SECRET}, timeout=60)
        except requests.RequestException:
            return jsonify({"error": "Nextcloud nicht erreichbar"}), 502
        if a.status_code == 404:
            return jsonify({"error": "Kein Nextcloud-Konto mit dieser E-Mail"}), 404
        if a.status_code != 200:
            return jsonify({"error": "Nextcloud-Zugang fehlgeschlagen"}), 502
        d = a.json()
        conn.execute("INSERT INTO telefon_nextcloud (ext, email, benutzer, pw_enc, updated_at) "
                     "VALUES (?,?,?,?, datetime('now')) ON CONFLICT(ext) DO UPDATE SET email = excluded.email, "
                     "benutzer = excluded.benutzer, pw_enc = excluded.pw_enc, updated_at = excluded.updated_at",
                     (ext, email, d["benutzer"], f.encrypt(d["app_passwort"].encode()).decode()))
        conn.commit()
        app.logger.info("Nextcloud-Zugang ausgestellt (Nebenstelle %s)", ext)
        return jsonify({"server": NEXTCLOUD_SERVER, "benutzer": d["benutzer"], "app_passwort": d["app_passwort"]})
    finally:
        conn.close()


@app.post("/api/telefon/nextcloud/fertig")
def telefon_nextcloud_fertig():
    """Das Telefon hat nach dem Abmelden alles hochgeladen: Nextcloud-Zugang jetzt widerrufen."""
    ext, deny = _nebenstelle()
    if deny:
        return deny
    conn = db.connect()
    try:
        if conn.execute("SELECT 1 FROM telefon_sitzungen WHERE ext = ?", (ext,)).fetchone():
            return jsonify({"ok": True, "widerrufen": False})   # wieder jemand angemeldet
        _nextcloud_widerrufen(conn, ext)
        conn.commit()
        return jsonify({"ok": True, "widerrufen": True})
    finally:
        conn.close()


def nextcloud_nachlauf_aufraeumen():
    """Sicherung: Zugaenge, deren Abmeldung laenger als 24 h her ist, widerrufen."""
    conn = db.connect()
    try:
        alt = [r["ext"] for r in conn.execute(
            "SELECT ext FROM telefon_nextcloud WHERE abgemeldet_at IS NOT NULL "
            "AND abgemeldet_at < datetime('now', '-24 hours')")]
        for ext in alt:
            _nextcloud_widerrufen(conn, ext)
            app.logger.warning("Nextcloud-Zugang %s nach 24 h Nachlauf widerrufen", ext)
        conn.commit()
    finally:
        conn.close()


MESSENGER_ANLAGE_SECRET = os.environ.get("MESSENGER_ANLAGE_SECRET", "")
MESSENGER_TOKEN_STUNDEN = 12


def _b64url(b):
    import base64
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


@app.get("/api/telefon/messenger")
def telefon_messenger():
    """Messenger-Zugang (Rosenweg Messenger) der Person, die auf diesem Geraet angemeldet ist:
    kurzlebiges HS256-Token, das der message-store (CT 131) annimmt (iss rosenweg-anlage)."""
    ext, deny = _nebenstelle()
    if deny:
        return deny
    if not MESSENGER_ANLAGE_SECRET:
        return jsonify({"error": "Messenger-Zugang nicht eingerichtet"}), 503
    conn = db.connect()
    try:
        s = conn.execute("SELECT user_id, email, name, gruppen FROM telefon_sitzungen WHERE ext = ?", (ext,)).fetchone()
    finally:
        conn.close()
    if not s or not s["user_id"]:
        return jsonify({"error": "Niemand angemeldet"}), 409
    try:
        gruppen = [str(g) for g in json.loads(s["gruppen"] or "[]")]
    except ValueError:
        gruppen = []
    uid = int(s["user_id"]) if str(s["user_id"]).isdigit() else s["user_id"]
    jetzt = int(time.time())
    kopf = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    inhalt = _b64url(json.dumps({
        "iss": "rosenweg-anlage", "sub": uid, "email": s["email"] or "", "name": s["name"] or "",
        "groups": gruppen, "ext": ext, "iat": jetzt, "exp": jetzt + MESSENGER_TOKEN_STUNDEN * 3600,
    }, separators=(",", ":"), ensure_ascii=False).encode())
    sig = _b64url(hmac.new(MESSENGER_ANLAGE_SECRET.encode(), f"{kopf}.{inhalt}".encode(), hashlib.sha256).digest())
    return jsonify({"token": f"{kopf}.{inhalt}.{sig}", "gueltig_bis": jetzt + MESSENGER_TOKEN_STUNDEN * 3600,
                    "server": os.environ.get("MESSENGER_URL", "https://chat.rosenweg4303.ch")})


@app.get("/api/pbx/nummernplan")
def nummernplan_liste():
    """Admin: persoenliche Nummern (3000er) und Verwaltung (4000er)."""
    _, deny = require_admin()
    if deny:
        return deny
    conn = db.connect()
    try:
        p = conn.execute("SELECT nummer, name, email, wohnung, haus, art, weiterleitung, voicemail, aktiv "
                         "FROM personen_nummern ORDER BY nummer").fetchall()
        v = conn.execute("SELECT nummer, name, ziel, notiz, aktiv FROM verwaltung_nummern ORDER BY nummer").fetchall()
        return jsonify({"personen": db.rows_to_dicts(p), "verwaltung": db.rows_to_dicts(v)})
    finally:
        conn.close()


@app.get("/api/telefon/meine")
def telefon_meine():
    """Geraete, an denen die angemeldete Person gerade angemeldet ist."""
    user = current_user()
    if not user:
        return jsonify({"error": "Nicht angemeldet"}), 401
    conn = db.connect()
    try:
        rows = conn.execute(
            "SELECT s.ext, e.name AS geraet, s.seit FROM telefon_sitzungen s "
            "JOIN sip_extensions e ON e.ext = s.ext WHERE lower(s.email) = lower(?) ORDER BY s.ext",
            (user.get("email") or "",)).fetchall()
        # eigene Handys mit Rosenweg Telefon (telefon_sip_privat): ueber die E-Mail oder die Nummer
        email = (user.get("email") or "").lower()
        nummer = str(_nummer_der_person(conn, email, user.get("name")) or "")
        try:
            regs = ami.registered_aors()
        except Exception:  # noqa: BLE001
            regs = set()
        privat = [{"id": r["id"], "kennung": f"{r['nummer']}-p{r['id']}", "geraet": r["geraet"], "seit": r["created_at"],
                   "registriert": f"{r['nummer']}-p{r['id']}" in regs}
                  for r in conn.execute("SELECT id, nummer, geraet, created_at FROM telefon_sip_privat "
                                        "WHERE lower(email) = ? OR (? <> '' AND nummer = ?) ORDER BY id",
                                        (email, nummer, nummer))]
        return jsonify({"name": user.get("name"), "darf": _telefon_darf(conn, user),
                        "sitzungen": db.rows_to_dicts(rows), "privat": privat})
    finally:
        conn.close()


@app.delete("/api/telefon/privat/<int:zid>")
def telefon_privat_entfernen(zid):
    """Aus dem Browser: eigenes Handy abmelden (Zugang sperren), Technik/Praesident jedes."""
    user = current_user()
    if not user:
        return jsonify({"error": "Nicht angemeldet"}), 401
    conn = db.connect()
    try:
        r = conn.execute("SELECT email, nummer FROM telefon_sip_privat WHERE id = ?", (zid,)).fetchone()
        if not r:
            return jsonify({"error": "Nicht gefunden"}), 404
        email = (user.get("email") or "").lower()
        eigene = (r["email"] or "").lower() == email or str(_nummer_der_person(conn, email, user.get("name")) or "") == r["nummer"]
        if not eigene and not is_admin(user):
            return jsonify({"error": "Nur das eigene Handy"}), 403
        conn.execute("DELETE FROM telefon_sip_privat WHERE id = ?", (zid,))
        conn.commit()
    finally:
        conn.close()
    app.logger.info("Handy-Zugang p%d entfernt durch %s", zid, actor(user))
    _sip_person_neu_laden()
    return jsonify({"ok": True})


@app.post("/api/telefon/<ext>/abmelden")
def telefon_abmelden_web(ext):
    """Abmelden aus dem Browser: die eigene Sitzung, oder jede fuer Technik/Praesident."""
    user = current_user()
    if not user:
        return jsonify({"error": "Nicht angemeldet"}), 401
    conn = db.connect()
    try:
        s = conn.execute("SELECT email FROM telefon_sitzungen WHERE ext = ?", (ext,)).fetchone()
        if not s:
            return jsonify({"ok": True, "angemeldet": False})
        eigene = (s["email"] or "").lower() == (user.get("email") or "").lower() and s["email"]
        if not eigene and not is_admin(user):
            return jsonify({"error": "Nur die eigene Anmeldung"}), 403
        _telefon_abmelden(conn, ext, ("person:" if eigene else "admin:") + actor(user))
        conn.commit()
        _sip_person_neu_laden()
        return jsonify({"ok": True, "angemeldet": False})
    finally:
        conn.close()


# Laufende Suchen (nur im Speicher): ext -> {start, durch, gefunden, gefunden_von}
_SUCHEN = {}


def _suche_darf(ext):
    """(user, None) wenn die Person dieses Telefon suchen darf, sonst (None, Antwort)."""
    user = current_user()
    if not user:
        return None, (jsonify({"error": "Nicht angemeldet"}), 401)
    if not re.fullmatch(r"[0-9]{2,8}", ext or ""):
        return None, (jsonify({"error": "Nebenstelle ungueltig"}), 400)
    conn = db.connect()
    try:
        if not conn.execute("SELECT 1 FROM sip_extensions WHERE ext = ? AND enabled = 1", (ext,)).fetchone():
            return None, (jsonify({"error": "Unbekanntes Telefon"}), 404)
        s = conn.execute("SELECT email FROM telefon_sitzungen WHERE ext = ?", (ext,)).fetchone()
        eigene = bool(s and s["email"] and s["email"].lower() == (user.get("email") or "").lower())
        if not eigene and not is_admin(user):
            return None, (jsonify({"error": "Nur das eigene Telefon"}), 403)
    finally:
        conn.close()
    return user, None


@app.get("/api/telefon/<ext>/suchen")
def telefon_suchen_stand(ext):
    """Stand der letzten Suche: {laeuft, start, gefunden, gefunden_von} — fuer "Gefunden um …"."""
    _, deny = _suche_darf(ext)
    if deny:
        return deny
    s = _SUCHEN.get(ext) or {}
    return jsonify({"start": s.get("start"), "gefunden": s.get("gefunden"), "gefunden_von": s.get("gefunden_von")})


@app.post("/api/telefon/gefunden")
def telefon_gefunden():
    """Das gesuchte Telefon meldet "Gefunden" (Knopf im Suchfenster von Rosenweg Geraet)."""
    ext, deny = _geraet()
    if deny:
        return deny
    jetzt = _jetzt_iso()
    conn = db.connect()
    try:
        s = conn.execute("SELECT name, email FROM telefon_sitzungen WHERE ext = ?", (ext,)).fetchone()
        wer = (s["name"] if s else "") or ""
        conn.execute("INSERT INTO telefon_log (ext, ereignis, email, name, durch) VALUES (?,?,?,?,?)",
                     (ext, "gefunden", s["email"] if s else None, wer, "Telefon suchen"))
        conn.commit()
    finally:
        conn.close()
    eintrag = _SUCHEN.setdefault(ext, {})
    eintrag.update({"gefunden": jetzt, "gefunden_von": wer})
    app.logger.info("Telefon gefunden: %s", ext)
    return jsonify({"ok": True})


@app.post("/api/telefon/<ext>/suchen")
def telefon_suchen(ext):
    """Verlegtes Telefon klingeln lassen: die Anlage ruft es mit 2099 "Telefon suchen" an,
    die Geraete-App klingelt laut und zeigt "Gefunden". Die eigene Sitzung,
    oder jedes Telefon fuer Technik/Praesident (auch ohne Anmeldung)."""
    user, deny = _suche_darf(ext)
    if deny:
        return deny
    _SUCHEN[ext] = {"start": _jetzt_iso(), "durch": actor(user), "gefunden": None, "gefunden_von": None}
    try:
        ami.originate(f"PJSIP/{ext}", "suchen", "s", callerid='"Telefon suchen" <2099>', timeout_ms=45000)
    except Exception as e:
        return jsonify({"error": f"Anlage: {type(e).__name__}"}), 502
    app.logger.info("Telefon suchen: %s durch %s", ext, actor(user))
    return jsonify({"ok": True})


@app.route("/api/telefon/<ext>/wlan-debug", methods=["GET", "POST"])
def telefon_wlan_debug(ext):
    """Technik/Praesident: "Debugging ueber WLAN" an einem geteilten Telefon zentral ein-
    (Body {minuten: 1..240}) oder ausschalten ({minuten: 0}). Weckt das Telefon mit einem
    kurzen Anruf von 2098 "Wartung" - die Geraete-App lehnt ihn lautlos ab und fragt den
    Status ab. GET: aktueller Stand."""
    user, deny = require_admin()
    if deny:
        return deny
    if not re.fullmatch(r"[0-9]{2,8}", ext):
        return jsonify({"error": "Nebenstelle ungueltig"}), 400
    conn = db.connect()
    try:
        if not conn.execute("SELECT 1 FROM sip_extensions WHERE ext = ?", (ext,)).fetchone():
            return jsonify({"error": "Unbekannte Nebenstelle"}), 404
        if request.method == "GET":
            w = conn.execute("SELECT wlan_debug_bis, durch FROM telefon_wartung WHERE ext = ?", (ext,)).fetchone()
            bis = int(w["wlan_debug_bis"]) if w and int(w["wlan_debug_bis"] or 0) > time.time() else 0
            return jsonify({"ext": ext, "wlan_debug_bis": bis, "durch": w["durch"] if (w and bis) else None})
        b = request.get_json(silent=True) or {}
        try:
            minuten = max(0, min(int(b.get("minuten", 60)), 240))
        except (TypeError, ValueError):
            return jsonify({"error": "minuten: Zahl 0..240"}), 400
        bis = int(time.time()) + minuten * 60 if minuten else 0
        conn.execute("INSERT INTO telefon_wartung (ext, wlan_debug_bis, durch, geaendert) VALUES (?,?,?,datetime('now')) "
                     "ON CONFLICT(ext) DO UPDATE SET wlan_debug_bis = excluded.wlan_debug_bis, "
                     "durch = excluded.durch, geaendert = excluded.geaendert", (ext, bis, actor(user)))
        conn.execute("INSERT INTO telefon_log (ext, ereignis, durch) VALUES (?,?,?)",
                     (ext, f"wlan-debug {minuten} min" if minuten else "wlan-debug aus", actor(user)))
        conn.commit()
    finally:
        conn.close()
    geweckt = True
    try:
        ami.originate(f"PJSIP/{ext}", "suchen", "s", callerid='"Wartung" <2098>', timeout_ms=15000)
    except Exception as e:  # noqa: BLE001
        geweckt = False   # Telefon holt den Stand spaetestens beim naechsten Status
        app.logger.warning("Wartung wecken %s: %s", ext, type(e).__name__)
    app.logger.info("WLAN-Debugging %s: %s durch %s", ext, f"{minuten} min" if minuten else "aus", actor(user))
    return jsonify({"ok": True, "wlan_debug_bis": bis, "geweckt": geweckt})


@app.get("/api/pbx/smartphones")
def smartphones_uebersicht():
    """Technik/Praesident: alles fuer rosenweg4303.ch/smartphones in einer Antwort, ohne
    Geheimnisse - geteilte Telefone (Registrierung, Anmeldung, WLAN-Debugging), eigene Handys
    mit Rosenweg Telefon, Verlauf und die erlaubten Gruppen."""
    _, deny = require_admin()
    if deny:
        return deny
    try:
        regs = ami.registered_aors()
    except Exception:  # noqa: BLE001
        regs = set()
    jetzt = time.time()
    conn = db.connect()
    try:
        sitz = {r["ext"]: r for r in conn.execute("SELECT ext, name, seit FROM telefon_sitzungen")}
        wart = {r["ext"]: r for r in conn.execute("SELECT ext, wlan_debug_bis, durch FROM telefon_wartung")}
        telefone = []
        for e in conn.execute("SELECT ext, name, client, enabled FROM sip_extensions "
                              "WHERE context = 'geteilt' ORDER BY ext"):
            s, w = sitz.get(e["ext"]), wart.get(e["ext"])
            bis = int(w["wlan_debug_bis"] or 0) if w else 0
            telefone.append({
                "ext": e["ext"], "name": e["name"], "client": e["client"], "aktiv": bool(e["enabled"]),
                "registriert": str(e["ext"]) in regs,
                "angemeldet": s["name"] if s else None, "seit": s["seit"] if s else None,
                "wlan_debug_bis": bis if bis > jetzt else 0,
            })
        privat = [{"id": r["id"], "kennung": f"{r['nummer']}-p{r['id']}", "nummer": r["nummer"],
                   "geraet": r["geraet"], "seit": r["created_at"],
                   "registriert": f"{r['nummer']}-p{r['id']}" in regs}
                  for r in conn.execute("SELECT id, nummer, geraet, created_at FROM telefon_sip_privat ORDER BY nummer, id")]
        log = db.rows_to_dicts(conn.execute("SELECT ext, ereignis, name, durch, zeit FROM telefon_log "
                                            "ORDER BY id DESC LIMIT 40").fetchall())
        return jsonify({"telefone": telefone, "privat": privat, "log": log,
                        "gruppen": sorted(_telefon_gruppen(conn))})
    finally:
        conn.close()


@app.get("/api/pbx/telefon-sitzungen")
def telefon_sitzungen_admin():
    _, deny = require_admin()
    if deny:
        return deny
    conn = db.connect()
    try:
        sitz = conn.execute("SELECT ext, name, email, seit FROM telefon_sitzungen ORDER BY ext").fetchall()
        log = conn.execute("SELECT ext, ereignis, name, durch, zeit FROM telefon_log "
                           "ORDER BY id DESC LIMIT 30").fetchall()
        return jsonify({"sitzungen": db.rows_to_dicts(sitz), "log": db.rows_to_dicts(log),
                        "gruppen": sorted(_telefon_gruppen(conn)),
                        "ausblenden": _cfg(conn).get("telefon_ausblenden", ""),
                        "unsichtbar": _cfg(conn).get("telefon_unsichtbar", "")})
    finally:
        conn.close()


@app.get("/api/pbx/telefon/<ext>/sitzung")
def telefon_sitzung_agi(ext):
    """AGI (Dialplan [geteilt]): wer ist an diesem Geraet angemeldet?"""
    err = require_agi()
    if err:
        return err
    conn = db.connect()
    try:
        row = conn.execute("SELECT name, email, seit FROM telefon_sitzungen WHERE ext = ?", (ext,)).fetchone()
        d = _sitzung_json(row)
        if row and row["email"]:
            d["nummer"] = _nummer_der_person(conn, row["email"], row["name"])
        return jsonify(d)
    finally:
        conn.close()


@app.get("/telefon")
def serve_telefon():
    return send_from_directory(os.path.abspath(WEB_DIR), "telefon.html")


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
    # Segmentgrenze statt startswith: "/api/meg…" oder "/api/authx" sind nicht gemeint;
    # keine Punkt-Segmente/Kodierungen, die upstream anders aufgeloest werden (D-19).
    if not any(full == p or full.startswith(p + "/") for p in PROXY_PREFIXES) \
            or ".." in full or "%" in full or "\\" in full:
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
    if PBX_SHARED_SECRET:
        import threading
        threading.Thread(target=_personen_abgleich_schleife, daemon=True, name="personen-abgleich").start()
    from waitress import serve
    serve(app, host="0.0.0.0", port=PORT)
