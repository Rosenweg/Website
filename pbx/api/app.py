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
import base64
import binascii
import hashlib
import hmac
import ipaddress
import json
import time
import os
import re
import secrets as pysecrets
import shutil
import tempfile
import threading
import urllib.parse
from datetime import datetime, timedelta, timezone
from xml.sax.saxutils import escape as xesc
from zoneinfo import ZoneInfo

import requests
import segno
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from flask import Flask, Response, g as flask_g, jsonify, request, send_file, send_from_directory

import adb_updater
import ami
import apk
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
# Eigene Handys (Rosenweg Telefon ohne Geraet) sind auch ausserhalb: SIP ueber TLS 5061 (Stefan
# 25.11.2026: "SIP von aussen ja, via TLS"). sip.rosenweg4303.ch zeigt oeffentlich auf die WAN-
# Adresse (UniFi leitet 5061 an CT 220), intern auf CT 220; das Zertifikat passt fuer beides.
PROV_TRANSPORT_PRIVAT = os.environ.get("PBX_SIP_TRANSPORT_PRIVAT", "tls")
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


# ─── Im Auftrag der Haupt-API: Rosenweg Mein Telefon auf geteilten Telefonen ─────
# Auf einem geteilten Telefon hat die App kein Token; Rosenweg Geraet reicht ihre
# Anfragen nur an die Haupt-API (Anlage-Token), und die reicht die Anfragen von
# Mein Telefon hierher weiter (api/routes/telefonanlage.js, Entscheid Stefan
# 27.11.2026): mit X-PBX-Secret und der Person am Telefon im Kopf
# X-Rosenweg-Im-Auftrag (base64url-JSON {id, email, name, groups}).
# Angenommen nur mit dem Geheimnis und nur fuer genau diese Pfade; die Person
# bekommt hier keine Technik-Rechte (is_admin False) - nur die eigene Nummer und
# die eigenen Geraete.
IM_AUFTRAG_KOPF = "X-Rosenweg-Im-Auftrag"
_IM_AUFTRAG_PFADE = re.compile(
    r"/api/telefon/(ich|ich/erreichbarkeit|meine|ausweis|privat/[0-9]{1,9}|[0-9]{2,8}/(abmelden|suchen))")


def _im_auftrag():
    """Person aus dem Kopf der Haupt-API, sonst None (auch bei falschem Geheimnis oder Pfad)."""
    roh = request.headers.get(IM_AUFTRAG_KOPF, "")
    geheim = request.headers.get("X-PBX-Secret", "")
    if not roh or not PBX_SHARED_SECRET or not hmac.compare_digest(geheim.encode(), PBX_SHARED_SECRET.encode()):
        return None
    if not _IM_AUFTRAG_PFADE.fullmatch(request.path) or len(roh) > 4096:
        return None
    try:
        d = json.loads(base64.urlsafe_b64decode(roh + "=" * (-len(roh) % 4)).decode("utf-8"))
    except (ValueError, binascii.Error, UnicodeDecodeError):
        return None
    email = d.get("email") if isinstance(d, dict) else None
    if not isinstance(email, str) or "@" not in email or len(email) > 254:
        return None
    gruppen = d.get("groups") if isinstance(d.get("groups"), list) else []
    return {"id": d.get("id"), "email": email, "name": str(d.get("name") or "")[:120],
            "groups": [str(g) for g in gruppen][:100], "im_auftrag": True}


def current_user():
    """Validiert den Bearer-Token gegen die Haupt-API. None wenn ungueltig.
    Mit dem Kopf X-Rosenweg-Im-Auftrag gilt nur er (siehe _im_auftrag)."""
    if IM_AUFTRAG_KOPF in request.headers:
        return _im_auftrag()
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
    if (user or {}).get("im_auftrag"):
        return False  # geteiltes Telefon ueber die Haupt-API: nur fuer sich selbst
    groups = [str(g).lower() for g in (user or {}).get("groups", [])]
    return "technik" in groups or "präsident" in groups or "praesident" in groups


def require_admin():
    """Gibt (user, None) bei Erfolg, sonst (None, flask-response)."""
    user = current_user()
    if not user:
        return None, (jsonify({"error": "Nicht angemeldet"}), 401)
    if not is_admin(user):
        return None, (jsonify({"error": "Nur fuer Technik / Praesident"}), 403)
    flask_g.karten_vermerk = True  # Befund W26: schreibende Admin-Aktion nach der Antwort melden
    return user, None


# Befund W26 ("Karte wie Schluessel"): Mit der Rosenweg-Karte (rw_app_) hat man hier
# volle Admin-Rechte. Jede schreibende Admin-Aktion meldet die Anlage der Haupt-API
# (POST /api/karten-admin/vermerk, Bearer der Person); dort entsteht der Eintrag im
# Kartenprotokoll und die Quittung per Mail. Gesperrt wird nichts, Fehler stoeren nicht.
def _karten_vermerk_senden(token, methode, pfad, status):
    try:
        requests.post(f"{MAIN_API_BASE}/api/karten-admin/vermerk",
                      headers={"Authorization": f"Bearer {token}"},
                      json={"dienst": "pbx", "methode": methode, "pfad": pfad, "status": status}, timeout=5)
    except requests.RequestException:
        pass


@app.after_request
def _karten_vermerk(res):
    token = _bearer() or ""
    if (getattr(flask_g, "karten_vermerk", False) and token.startswith("rw_app_")
            and request.method in ("POST", "PUT", "PATCH", "DELETE")):
        threading.Thread(target=_karten_vermerk_senden,
                         args=(token, request.method, request.path, res.status_code), daemon=True).start()
    return res


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
        # person (Stefan 25.11.2026): persoenliche Nummer 3HHWWP - klingelt auf allen Geraeten der
        # Person (Telefon-App, geteilte Telefone), ihre Weiterleitung gilt, ihre Voicemail nicht
        kind = b.get("kind") if b.get("kind") in ("sip", "person") else "mobile"
        out["kind"] = kind
    if "phone" in b or "kind" in b:
        phone = str(b.get("phone") if "phone" in b else (b.get("_phone_bisher") or "")).strip()
        if kind == "sip":
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", phone):
                return None, "SIP-Extension ungueltig"
        elif kind == "person":
            if not re.fullmatch(r"3[0-9]{5}", phone):
                return None, "Persoenliche Nummer: 6 Ziffern, beginnt mit 3 (3HHWWP)"
            conn = db.connect()
            try:
                if not conn.execute("SELECT 1 FROM personen_nummern WHERE nummer = ?", (phone,)).fetchone():
                    return None, "Persoenliche Nummer nicht vergeben"
            finally:
                conn.close()
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
               "telefon_ausblenden", "telefon_unsichtbar", "portal_pfade"}
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
        if k == "portal_pfade":
            try:
                r = json.loads(str(v))
            except ValueError:
                return jsonify({"error": "portal_pfade ist kein gueltiges JSON"}), 400
            if not isinstance(r, dict) or not all(
                    isinstance(e, list) and all(isinstance(x, str) and "/api/" in x and len(x) < 200 for x in e)
                    for e in r.values()):
                return jsonify({"error": "portal_pfade: {paket: [\"/api/...\", \"GET /api/...\"]}"}), 400
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
    _geraet_boot(row["ext"])
    return row["ext"], None


def _geraet_boot(ext):
    """Neustart des geteilten Telefons erkennen (Header X-Rosenweg-Boot = Boot-Zaehler des
    Geraets) und dann dessen Sitzung beenden - Stefan 27.11.2026: "Jede Sitzung endet direkt
    beim Neustart", auch fuer Technik. Die App meldet nach dem Neustart selbst ab; das hier
    sichert ab, falls sie es nicht schafft. Laeuft vor der eigentlichen Anfrage: kommt nach
    dem Neustart zuerst eine Anmeldung (Karte/QR), ist die alte Sitzung schon weg.
    Ohne Header (aeltere App) aendert sich nichts."""
    boot = (request.headers.get("X-Rosenweg-Boot") or "").strip()
    if not boot or len(boot) > 40:
        return
    conn = db.connect()
    try:
        alt = conn.execute("SELECT boot FROM telefon_boot WHERE ext = ?", (ext,)).fetchone()
        if alt and alt["boot"] == boot:
            return
        weg = bool(alt) and _telefon_abmelden(conn, ext, "neustart")
        conn.execute("INSERT INTO telefon_boot (ext, boot, gesehen) VALUES (?,?,datetime('now')) "
                     "ON CONFLICT(ext) DO UPDATE SET boot = excluded.boot, gesehen = excluded.gesehen",
                     (ext, boot))
        conn.commit()
        if weg:
            app.logger.info("Geteiltes Telefon %s neu gestartet: Sitzung beendet", ext)
            _sip_person_neu_laden()
    except Exception as e:  # noqa: BLE001 - die Anfrage selbst soll nicht daran scheitern
        app.logger.warning("Boot von %s: %s", ext, type(e).__name__)
    finally:
        conn.close()


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
    # Hintergrund des Startbildschirms der Person ("" = Standard); Rosenweg Geraet laedt ihn
    # bei einer neuen Fassung mit GET /api/telefon/hintergrund
    hintergrund = ""
    try:
        c = db.connect()
        try:
            hintergrund = _hintergrund_version(c, row["email"])
        finally:
            c.close()
    except Exception as e:  # noqa: BLE001 - Status soll daran nicht scheitern
        app.logger.warning("Hintergrund der Person: %s", type(e).__name__)
    return {"angemeldet": True, "name": row["name"], "email": row["email"], "seit": row["seit"],
            "nummer": str(nummer), "sperrbild": _sperrbild(gruppen), "hintergrund": hintergrund}



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
        # adb_dienst: Updater-Schluessel jetzt zulassen (ab Geraet v237 bestaetigt die
        # Bedienungshilfe "USB-Debugging zulassen?" nur fuer genau diesen Fingerabdruck)
        extra = {}
        u = conn.execute("SELECT freigabe_bis, zugelassen FROM telefon_updater WHERE ext = ?", (ext,)).fetchone()
        if u and not u["zugelassen"] and int(u["freigabe_bis"] or 0) > time.time() and bis:
            fp = adb_updater.fingerabdruck()
            if fp:
                extra["adb_dienst"] = {"fingerabdruck": fp, "bis": int(u["freigabe_bis"])}
        # fernwartung: dauerhafter adb-Tunnel (pbx/adb-zentrale) - neu | wartet | bereit | aus
        fw = _fw_status(conn, ext)
        if fw is not None:
            extra["fernwartung"] = fw
        return jsonify({"ext": ext, "geraet": geraet["name"] if geraet else ext, "technik": technik,
                        "wlan_debug_bis": bis, **extra, **_sitzung_json(row), **_apps_fuer(conn, row)})
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
SIP_PRIVAT_MAX = int(os.environ.get("SIP_PRIVAT_MAX", "20"))   # Handys pro Person (Stefan 26.11.2026: 20, jede App meldet sich einzeln an)


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
    if token.startswith("rw_app_"):
        # Karten-Anmeldung einer App auf einem privaten Handy (Website api/routes/app-karte.js):
        # kein Authentik-Token, die Haupt-API kennt es (/api/auth/me).
        u = current_user()
        email = str((u or {}).get("email") or "").strip().lower()
        if not email:
            return None
        return {"email": email, "name": str(u.get("name") or ""),
                "groups": [str(g) for g in (u.get("groups") or [])]}
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
    return {"email": email, "name": str(u.get("name") or u.get("preferred_username") or ""),
            "groups": [str(g) for g in (u.get("groups") or [])]}


def _privat_antwort(r, name):
    kennung = f"{r['nummer']}-p{r['id']}"
    res = jsonify({
        "server": PROV_SIP_HOST, "port": 5061 if PROV_TRANSPORT_PRIVAT == "tls" else 5060,
        "transport": PROV_TRANSPORT_PRIVAT, "user": kennung, "auth_user": kennung,
        "password": r["passwort"], "nummer": r["nummer"], "name": name, "id": r["id"],
    })
    res.headers["Cache-Control"] = "no-store"
    return res


# Gemeinsame Geraetekennung der Rosenweg-Apps (Stefan 26.11.2026: im Portal jedes Handy genau einmal,
# darunter seine Apps). Die App schickt sha256("rosenweg:" + ANDROID_ID) als Hex - derselbe Wert wie
# bei den Karten-Sitzungen (Website api/routes/app-karte.js) und im Messenger (messenger_privat).
# Nach aussen nie die Kennung selbst, nur der Gruppenschluessel je Person: dieselbe Formel wie
# api/lib/geraet-gruppe.js der Website, damit der Browser Telefon, Messenger und Karten-Apps
# zusammenlegen kann. Zwei Personen auf demselben Handy bekommen verschiedene Schluessel.
GERAET_KENNUNG_RE = re.compile(r"[0-9a-f]{64}")


def _geraet_kennung(v):
    k = str(v or "").strip().lower()
    return k if GERAET_KENNUNG_RE.fullmatch(k) else ""


def _geraet_gruppe(email, kennung):
    if not kennung:
        return None
    return hashlib.sha256(f"{str(email or '').strip().lower()}|{kennung}".encode()).hexdigest()[:16]


@app.post("/api/telefon/privat/anmelden")
def telefon_privat_anmelden():
    """Rosenweg Telefon auf dem eigenen Handy: Bearer = Authentik-Access-Token der App.
    Body {geraet, geraet_kennung?}: Anzeigename und Kennung des Handys. Antwort wie /api/telefon/sip-person.
    Gibt es fuer diese Person auf demselben Handy (gleiche Kennung) schon einen Zugang - App neu
    installiert oder Daten geloescht -, ersetzt der neue ihn (sonst stuende das Handy doppelt da)."""
    konto = _rosenweg_konto()
    if not konto:
        return jsonify({"error": "Rosenweg-Anmeldung ungueltig"}), 401
    b = request.get_json(silent=True) or {}
    geraet = re.sub(r"[\x00-\x1f\x7f]", " ", str(b.get("geraet") or ""))[:60].strip()
    kennung = _geraet_kennung(b.get("geraet_kennung"))
    conn = db.connect()
    try:
        p = conn.execute("SELECT nummer, name FROM personen_nummern WHERE lower(email) = ? AND aktiv = 1 "
                         "ORDER BY nummer", (konto["email"],)).fetchall()
        nummer = str(_nummer_der_person(conn, konto["email"], konto["name"]) or "")
        if not p or not re.fullmatch(r"3[0-9]{5}", nummer):
            return jsonify({"error": "Keine persoenliche Telefonnummer fuer dieses Rosenweg-Konto"}), 404
        name = next((x["name"] for x in p if x["nummer"] == nummer), konto["name"])
        if kennung:
            alt = [r["id"] for r in conn.execute("SELECT id FROM telefon_sip_privat WHERE lower(email) = ? "
                                                 "AND geraet_kennung = ?", (konto["email"], kennung))]
            if alt:
                conn.execute(f"DELETE FROM telefon_sip_privat WHERE id IN ({','.join('?' * len(alt))})", alt)
                app.logger.info("Handy-Zugang %s ersetzt (gleiches Handy)", ", ".join(f"p{i}" for i in alt))
        n = conn.execute("SELECT COUNT(*) FROM telefon_sip_privat WHERE lower(email) = ?",
                         (konto["email"],)).fetchone()[0]
        if n >= SIP_PRIVAT_MAX:
            return jsonify({"error": f"Schon {SIP_PRIVAT_MAX} Handys angemeldet - eines in der "
                                     "Telefon-Verwaltung abmelden"}), 409
        cur = conn.execute("INSERT INTO telefon_sip_privat (nummer, email, geraet, geraet_kennung, passwort) "
                           "VALUES (?,?,?,?,?)", (nummer, konto["email"], geraet, kennung, pysecrets.token_urlsafe(24)))
        conn.commit()
        r = conn.execute("SELECT * FROM telefon_sip_privat WHERE id = ?", (cur.lastrowid,)).fetchone()
        app.logger.info("Handy-Zugang %s-p%d angelegt", nummer, r["id"])
    finally:
        conn.close()
    _sip_person_neu_laden()
    return _privat_antwort(r, name)


# Nextcloud-Zugang fuer Rosenweg-Apps auf dem eigenen Handy (Stefan 26.11.2026): wer in der App
# angemeldet ist (Anmeldeschirm aus commons-rosenweg: Rosenweg-Karte oder Rosenweg-Konto), bekommt
# das App-Passwort ueber denselben Token-Dienst wie die geteilten Telefone (/api/telefon/nextcloud).
# Ein App-Passwort je App und Handy; die App widerruft es beim Abmelden selbst (Nextcloud OCS).
NC_PRIVAT_MAX_STUNDE = 10
_NC_PRIVAT = {}   # email -> [Zeitpunkte]


@app.post("/api/telefon/privat/nextcloud")
def telefon_privat_nextcloud():
    """Bearer = Zugang der App (Authentik rosenweg-apps oder Karten-Sitzung rw_app_).
    Body {app, app_name, geraet}. -> {server, benutzer, app_passwort}"""
    konto = _rosenweg_konto()
    if not konto:
        return jsonify({"error": "Rosenweg-Anmeldung ungueltig"}), 401
    if not NC_TOKEN_URL:
        return jsonify({"error": "Nextcloud-Zugang nicht eingerichtet"}), 503
    jetzt = time.time()
    liste = [t for t in _NC_PRIVAT.get(konto["email"], []) if jetzt - t < 3600]
    if len(liste) >= NC_PRIVAT_MAX_STUNDE:
        return jsonify({"error": "Zu viele Anfragen - bitte spaeter nochmals"}), 429
    _NC_PRIVAT[konto["email"]] = liste + [jetzt]
    b = request.get_json(silent=True) or {}
    sauber = lambda v, n: re.sub(r"[\x00-\x1f\x7f<>]", " ", str(v or ""))[:n].strip()
    app_name = sauber(b.get("app_name") or b.get("app"), 60) or "Rosenweg-App"
    geraet = sauber(b.get("geraet"), 60) or "Handy"
    # eindeutig je Anmeldung: der Token-Dienst widerruft nach Name
    # nc-token (CT 104) erlaubt im Namen nur [A-Za-z0-9 ._äöüÄÖÜ-]{3,64} - keine Klammern
    # (sonst 400 -> "Nextcloud-Zugang fehlgeschlagen" bei jeder App auf dem eigenen Handy).
    roh = re.sub(r"[^A-Za-z0-9 ._äöüÄÖÜ-]", " ", f"{app_name} auf {geraet}")
    name = re.sub(r"\s+", " ", roh).strip()[:55] + " - " + pysecrets.token_hex(3)
    try:
        a = requests.post(f"{NC_TOKEN_URL}/ausstellen", json={"email": konto["email"], "name": name},
                          headers={"X-NC-Token-Secret": NC_TOKEN_SECRET}, timeout=60)
    except requests.RequestException:
        return jsonify({"error": "Nextcloud nicht erreichbar"}), 502
    if a.status_code == 404:
        return jsonify({"error": "Kein Nextcloud-Konto mit dieser E-Mail"}), 404
    if a.status_code != 200:
        return jsonify({"error": "Nextcloud-Zugang fehlgeschlagen"}), 502
    d = a.json()
    app.logger.info("Nextcloud-Zugang fuer eine App auf dem eigenen Handy ausgestellt")
    res = jsonify({"server": NEXTCLOUD_SERVER, "benutzer": d["benutzer"], "app_passwort": d["app_passwort"]})
    res.headers["Cache-Control"] = "no-store"
    return res


@app.post("/api/telefon/privat/stand")
def telefon_privat_stand():
    """Rosenweg Telefon fragt regelmaessig nach ({user, password} des eigenen Zugangs): 200 mit
    den aktuellen Zugangsdaten (z.B. Wechsel auf TLS), 401 wenn es den Zugang nicht mehr gibt -
    dann wurde das Handy im Web (/smartphones) abgemeldet, und die App meldet sich auch ab.
    Die App fragt nach einem 401 nicht weiter (CrowdSec zaehlt 401).
    Optional {geraet_kennung}: so bekommen Zugaenge aelterer App-Versionen die Kennung nachgetragen."""
    b = request.get_json(silent=True) or {}
    kennung, pw = str(b.get("user") or ""), str(b.get("password") or "")
    if not SIP_PRIVAT_RE.fullmatch(kennung):
        return jsonify({"error": "Unbekannter Zugang"}), 401
    zid = int(kennung.split("-p", 1)[1])
    geraet_k = _geraet_kennung(b.get("geraet_kennung"))
    conn = db.connect()
    try:
        r = conn.execute("SELECT id, nummer, passwort, geraet_kennung FROM telefon_sip_privat WHERE id = ?",
                         (zid,)).fetchone()
        if r and hmac.compare_digest(str(r["passwort"]), pw) and geraet_k and r["geraet_kennung"] != geraet_k:
            conn.execute("UPDATE telefon_sip_privat SET geraet_kennung = ? WHERE id = ?", (geraet_k, zid))
            conn.commit()
    finally:
        conn.close()
    if not r or not hmac.compare_digest(str(r["passwort"]), pw):
        return jsonify({"error": "Unbekannter Zugang"}), 401
    return _privat_antwort(r, "")


@app.post("/api/telefon/privat/abmelden")
def telefon_privat_abmelden():
    """Die App meldet ab: Body {user, password} des eigenen Zugangs (kein Token noetig,
    der Zugang selbst ist der Ausweis)."""
    b = request.get_json(silent=True) or {}
    kennung, pw = str(b.get("user") or ""), str(b.get("password") or "")
    # 401 (nicht 404): falsche Zugangsdaten zaehlen fuer CrowdSec (rosenweg/anmeldung-bf)
    if not SIP_PRIVAT_RE.fullmatch(kennung):
        return jsonify({"error": "Unbekannter Zugang"}), 401
    zid = int(kennung.split("-p", 1)[1])
    conn = db.connect()
    try:
        r = conn.execute("SELECT passwort FROM telefon_sip_privat WHERE id = ?", (zid,)).fetchone()
        if not r or not hmac.compare_digest(str(r["passwort"]), pw):
            return jsonify({"error": "Unbekannter Zugang"}), 401
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
        rows = conn.execute("SELECT id, nummer, email, geraet, geraet_kennung, created_at FROM telefon_sip_privat "
                            "ORDER BY nummer, id").fetchall()
        try:
            regs = ami.registered_aors()
        except Exception:  # noqa: BLE001
            regs = set()
        return jsonify([{**{k: r[k] for k in ("id", "nummer", "email", "geraet", "created_at")},
                         "kennung": f"{r['nummer']}-p{r['id']}",
                         "geraet_gruppe": _geraet_gruppe(r["email"], r["geraet_kennung"]),
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


# ─── Kartenverwaltung: umgezogen in die Haupt-API (Entscheid Stefan 27.11.2026) ──
# "Karten gehoeren nicht in die Telefonanlage." Nachschlagen, Zuordnen, Entziehen,
# Loeschen, die Personenliste und das Kartenprotokoll liegen jetzt in der Haupt-API
# unter /api/karten/* (api/routes/karten.js, Logik api/lib/kartenverwaltung.js) und
# werden dort mit der normalen Anmeldung geprueft (Technik/Praesident, Karte = Schluessel,
# Admin-Aktionen mit der Karte protokolliert und quittiert).
#
# UEBERGANG: Die alte App Rosenweg Karten (Java 1.6.3, ANLAGE_WEB=https://pbx.rosenweg4303.ch)
# und Rosenweg Geraet (AnlageProvider karten_*, HTTP-Basic des Telefons) rufen noch
# /api/telefon/karten/*. Diese Pfade reichen hier nur noch weiter:
#   - mit "Authorization: Bearer ..." (App auf dem eigenen Handy): Kopf unveraendert an
#     die Haupt-API, die den Ausweis selbst prueft;
#   - mit HTTP-Basic (geteiltes Telefon): die am Telefon angemeldete Person bekommt ein
#     Anlage-Token fuer genau diese eine Anfrage (wie /api/telefon/portal, HS256,
#     PORTAL_ANLAGE_SECRET, 60 s, einmal). Die Haupt-API sieht "anlage" = Karte.
# Antworten haben dieselbe Form wie vorher; dazu "Deprecation: true" und ein Link auf den
# neuen Pfad. Entfernen, sobald Rosenweg Karten von den Telefonen ist (Rosenweg Zutritt
# ersetzt sie, ch.rosenweg4303.zutritt) - siehe pbx/GETEILTE-TELEFONE.md.
KARTEN_UMZUG = {
    "personen": ("GET", "/api/karten/personen"),
    "info": ("POST", "/api/karten/info"),
    "zuordnen": ("POST", "/api/karten/zuordnen"),
    "entziehen": ("POST", "/api/karten/entziehen"),
    "loeschen": ("POST", "/api/karten/loeschen"),
}
# Paket im Anlage-Token: die alte App (fuer Protokoll und App-Kennung der Haupt-API)
KARTEN_ALT_PAKET = "ch.rosenweg4303.karten"


def _karten_weiterreichen(was):
    methode, ziel = KARTEN_UMZUG[was]
    kopf = {"Accept": "application/json"}
    if _bearer():
        kopf["Authorization"] = request.headers.get("Authorization", "")
        wer = "App"
    else:
        ext, deny = _geraet()
        if deny:
            return deny
        conn = db.connect()
        try:
            s = conn.execute("SELECT user_id, email, name, seit FROM telefon_sitzungen WHERE ext = ?", (ext,)).fetchone()
        finally:
            conn.close()
        if not s or not s["email"]:
            return jsonify({"error": "nicht berechtigt"}), 403
        if not PORTAL_ANLAGE_SECRET:
            return jsonify({"error": "Portal-Zugang der Telefone nicht eingerichtet"}), 503
        kopf["Authorization"] = f"Bearer {_portal_token(s, ext, KARTEN_ALT_PAKET, methode, ziel)}"
        kopf["X-Rosenweg-Telefon"] = ext
        wer = ext
    daten = None
    if methode == "POST":
        d = request.get_json(silent=True) or {}
        daten = {k: d[k] for k in ("uid", "email") if k in d}
    app.logger.info("Kartenverwaltung ueber den alten Pfad (%s): %s %s -> %s", wer, methode, request.path, ziel)
    try:
        r = requests.request(methode, f"{MAIN_API_BASE}{ziel}", headers=kopf, json=daten, timeout=25,
                             allow_redirects=False)
    except requests.RequestException as e:
        app.logger.warning("Karten %s: Haupt-API nicht erreichbar (%s)", wer, type(e).__name__)
        return jsonify({"error": "Keine Verbindung zur Anlage"}), 502
    try:
        body = r.json()
    except ValueError:
        body = {"error": "Antwort der Haupt-API unlesbar"}
    antwort = jsonify(body)
    antwort.status_code = r.status_code
    antwort.headers["Deprecation"] = "true"
    antwort.headers["Link"] = f'<https://www.rosenweg4303.ch{ziel}>; rel="successor-version"'
    return antwort


@app.post("/api/telefon/karten/info")
def telefon_karten_info():
    return _karten_weiterreichen("info")


@app.post("/api/telefon/karten/zuordnen")
def telefon_karten_zuordnen():
    return _karten_weiterreichen("zuordnen")


@app.post("/api/telefon/karten/entziehen")
def telefon_karten_entziehen():
    return _karten_weiterreichen("entziehen")


@app.post("/api/telefon/karten/loeschen")
def telefon_karten_loeschen():
    return _karten_weiterreichen("loeschen")


@app.get("/api/telefon/karten/personen")
def telefon_karten_personen():
    return _karten_weiterreichen("personen")


# ─── Kartenprotokoll der Anlage in die Haupt-API uebernehmen (einmalig) ──────
# Die Anlage schrieb Kartenaktionen (karte-info, karte-zu, karte-weg, karte-geloescht)
# in telefon_log. Sie gehen einmal an die Haupt-API (access_karten_protokoll, aktion
# telefon-info|telefon-zuordnen|telefon-entziehen|telefon-loeschen, quelle "pbx:<id>").
# Idempotent: die Haupt-API legt keine Zeile doppelt an; danach merkt sich die Anlage die
# hoechste uebernommene id (config karten_protokoll_bis). Die Zeilen bleiben in telefon_log
# (PBX-Admin zeigt sie weiter). An-/Abmeldungen am Telefon bleiben nur hier.
#   python3 -c "import app; print(app.karten_protokoll_uebernehmen())"   (auf CT 220)
# und automatisch beim Start (Thread, wenn KARTEN_PROTOKOLL_UEBERNAHME nicht "aus" ist).
KARTEN_PROTOKOLL_EREIGNISSE = ("karte-info", "karte-zu", "karte-weg", "karte-geloescht")


def karten_protokoll_uebernehmen(post=None, stapel=500):
    """-> {"uebernommen": n, "gelesen": m, "bis": id}. Wirft bei Fehlern der Haupt-API."""
    post = post or requests.post
    conn = db.connect()
    try:
        bis = int(_cfg(conn).get("karten_protokoll_bis", "0") or 0)
    finally:
        conn.close()
    gesamt = {"uebernommen": 0, "gelesen": 0, "bis": bis}
    while True:
        conn = db.connect()
        try:
            zeilen = [dict(z) for z in conn.execute(
                "SELECT id, ext, ereignis, email, name, durch, zeit FROM telefon_log WHERE id > ? AND ereignis IN "
                f"({','.join('?' * len(KARTEN_PROTOKOLL_EREIGNISSE))}) ORDER BY id LIMIT ?",
                (bis, *KARTEN_PROTOKOLL_EREIGNISSE, stapel)).fetchall()]
        finally:
            conn.close()
        if not zeilen:
            return gesamt
        r = post(f"{MAIN_API_BASE}/api/pbx/karten-protokoll/uebernahme", json={"zeilen": zeilen},
                 headers={"X-PBX-Secret": PBX_SHARED_SECRET}, timeout=60)
        if r.status_code != 200:
            raise RuntimeError(f"Haupt-API: HTTP {r.status_code}")
        d = r.json()
        bis = zeilen[-1]["id"]
        gesamt["uebernommen"] += int(d.get("uebernommen") or 0)
        gesamt["gelesen"] += len(zeilen)
        gesamt["bis"] = bis
        conn = db.connect()
        try:
            conn.execute("INSERT INTO config (key, value) VALUES ('karten_protokoll_bis', ?) "
                         "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (str(bis),))
            conn.commit()
        finally:
            conn.close()


def _karten_protokoll_im_hintergrund():
    if os.environ.get("KARTEN_PROTOKOLL_UEBERNAHME", "").lower() in ("aus", "0", "nein", "false"):
        return
    import threading

    def lauf():
        for versuch in range(6):
            try:
                g = karten_protokoll_uebernehmen()
                if g["gelesen"]:
                    app.logger.info("Kartenprotokoll an die Haupt-API: %s", g)
                return
            except Exception as e:  # noqa: BLE001 - naechster Versuch, nie den Start stoeren
                app.logger.warning("Kartenprotokoll-Uebernahme (Versuch %d): %s", versuch + 1, e)
                time.sleep(60 * (versuch + 1))
    threading.Thread(target=lauf, name="karten-protokoll", daemon=True).start()


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
                  "apk_datei": r["apk_datei"], "updated_at": r["updated_at"],
                  "version_code": r["version_code"], "version_name": r["version_name"]})
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
        antwort = jsonify({"apps": [_app_json(r) for r in rows], "ausblenden": aus, "unsichtbar": unsichtbar})
    finally:
        conn.close()
    # ETag + If-None-Match: das Telefon fragt alle 15 Minuten und bekommt bei unveraendertem
    # Katalog nur 304 (spart Datenmenge, aendert sich etwas, ist es nach hoechstens 15 Minuten da)
    antwort.add_etag()
    return antwort.make_conditional(request)


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
SEITEN_HERKUNFT = {"https://www.rosenweg4303.ch", "https://rosenweg4303.ch",
                   "https://isp.rosenweg4303.ch"}   # ISP-Admin: Reiter App-Versionen (/api/pbx/apps-stand)


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
APPS_HERKUNFT = {"https://www.rosenweg4303.ch", "https://rosenweg4303.ch"}


APPS_SIGNATUR_SHA256 = apk.SIGNATUR_SHA256

# ─── Weitere Rosenweg-Apps auf /apps (Stefan 26.11.2026: "jede App gehoert auf /apps") ───
# Apps mit eigenem Repo (Flutter), die es fuer mehrere Plattformen gibt. Ihre Dateien kommen
# nicht aus dem Katalog der geteilten Telefone, sondern
#   - von der CI der App bei einem Release-Tag (POST /api/apps/release): sie meldet sich mit dem OIDC-Token
#     von GitHub Actions an (kein gespeichertes Geheimnis; geprueft werden Signatur, Repo, Tag),
#   - oder von der Technik von Hand (POST /api/pbx/apps-versionen/..., z.B. ein DMG ohne CI).
# Android-APKs muessen mit dem Rosenweg-Schluessel signiert sein und den Paketnamen aus dem
# Register tragen. Steht die App auch im Katalog der geteilten Telefone, wird dort dieselbe
# APK eingespielt (die Freigabe fuer die Telefone und ihre Gruppen bleibt Sache der Technik).
#
# Welche Apps es gibt, steht im Register apps-register.json des Website-Repos (siehe unten,
# _apps_register_auffrischen). Neue App: Eintrag dort, Logo nach www img/apps/<app>.png,
# Haupt-API ausrollen, Schritt "Auf /apps" in der CI (Action Rosenweg/Website/.github/actions/
# apps-release). Kein PBX-Deploy mehr. Erst mit einer Datei erscheint sie.
APPS_PLATTFORMEN = {
    # endung -> Kennbytes am Anfang (DMG: Kennung "koly" im letzten 512-Byte-Block)
    "android":   {"titel": "Android", "endungen": {".apk": b"PK\x03\x04"},
                  "mime": "application/vnd.android.package-archive"},
    "linux-deb": {"titel": "Linux (Debian 13)", "endungen": {".deb": b"!<arch>\ndebian-binary"},
                  "mime": "application/vnd.debian.binary-package"},
    "macos":     {"titel": "macOS", "endungen": {".dmg": None}, "mime": "application/x-apple-diskimage"},
    "windows":   {"titel": "Windows", "endungen": {".exe": b"MZ", ".msi": b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"},
                  "mime": "application/octet-stream"},
}
# ─── Register der Rosenweg-Apps (Flutter-Plan 4.2.7) ───────────────────────────────────────
# Eine Quelle: apps-register.json im Website-Repo (auch fuer die Karten-Sitzungen der Haupt-API).
# Die Haupt-API liefert es unter GET /api/apps/register; hier alle APPS_REGISTER_ALTER Sekunden
# neu geholt und auf der Platte gemerkt. Ohne Netz: die gemerkte Kopie, sonst die beim Deploy
# mitgelieferte Datei neben app.py. Daraus entstehen dieselben Namen wie frueher im Code:
#   APPS_REGISTER         "apps":    Apps mit eigenem Repo fuer mehrere Plattformen (vm, salz, ...)
#   APPS_KATALOG_REPOS    "katalog": Repo -> Paketname der Katalog-Apps (geteilte Telefone)
#   APPS_KATALOG_INFO     "katalog": Logo, Name, Satz, fuer wen, technik je Paketname
#   APPS_OEFFENTLICH_OHNE "katalog": nicht_oeffentlich (z.B. Rosenweg Geraet: kein Download)
# Welche Katalog-Apps es gibt, Name, Version und Stand kommen weiter live aus telefon_apps;
# fehlt ein Info-Eintrag, zeigt /apps die App trotzdem (Rosenweg-Logo, ohne Satz).
# technik: gehoert in die Gruppe "Technik" auf /apps.
APPS_REGISTER_URL = os.environ.get("PBX_APPS_REGISTER_URL", f"{MAIN_API_BASE}/api/apps/register")
APPS_REGISTER_KOPIE = os.environ.get("PBX_APPS_REGISTER_KOPIE", "/var/lib/pbx-api/apps-register.json")
APPS_REGISTER_MITGELIEFERT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "apps-register.json")
APPS_REGISTER_ALTER = int(os.environ.get("PBX_APPS_REGISTER_ALTER", "300"))
APPS_REGISTER = {}
APPS_KATALOG_REPOS = {}
APPS_KATALOG_INFO = {}
APPS_OEFFENTLICH_OHNE = set()
APPS_AUFGEGEBEN = set()        # aus apps-register.json "aufgegeben": nicht mehr auf /apps
_APPS_REGISTER_STAND = {"zeit": 0.0, "quelle": "", "fehler": ""}
_APP_SCHLUESSEL = re.compile(r"[a-z][a-z0-9-]{0,30}")
_APP_PAKET = re.compile(r"[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,6}")
_APP_REPO = re.compile(r"Rosenweg/[A-Za-z0-9._-]{1,100}")


_APP_LOGO_PFAD = re.compile(r"/[A-Za-z0-9/_.-]+(\?v=[A-Za-z0-9]{1,20})?")


def _apps_logos(logos):
    """Symbole der Gruppenfarben aus dem Register: nur {blau, gruen} mit gueltigem Pfad."""
    if not isinstance(logos, dict):
        return {}
    return {f: p for f, p in logos.items()
            if f in ("blau", "gruen") and isinstance(p, str) and _APP_LOGO_PFAD.fullmatch(p)}


def _apps_register_uebernehmen(d, quelle):
    """Register pruefen und die vier Namen neu binden (atomar je Name). True = uebernommen."""
    global APPS_REGISTER, APPS_KATALOG_REPOS, APPS_KATALOG_INFO, APPS_OEFFENTLICH_OHNE, APPS_AUFGEGEBEN
    try:
        if d.get("version") != 1:
            raise ValueError("version")
        register = {}
        for k, e in d["apps"].items():
            if not _APP_SCHLUESSEL.fullmatch(k) or not _APP_PAKET.fullmatch(e["paket"]) \
                    or not _APP_REPO.fullmatch(e["repo"]) or not isinstance(e["reihenfolge"], int):
                raise ValueError(f"apps.{k}")
            register[k] = {f: v for f, v in e.items() if not f.startswith("_")}
            register[k].setdefault("text", "")
            register[k].setdefault("fuer", "")
            register[k].setdefault("logo", "")
        repos, info, ohne = {}, {}, set()
        for paket, e in d["katalog"].items():
            if not _APP_PAKET.fullmatch(paket) or not _APP_REPO.fullmatch(e["repo"]):
                raise ValueError(f"katalog.{paket}")
            repos[e["repo"]] = paket
            i = {f: v for f, v in e.items() if f in ("logo", "logos", "name", "text", "fuer", "technik")}
            if i:
                info[paket] = i
            if e.get("nicht_oeffentlich"):
                ohne.add(paket)
        # Aufgegebene Apps (z.B. Rosenweg Karten, 27.11.2026): nicht mehr auf /apps, keine Releases
        aus = set()
        for paket in (d.get("aufgegeben") or {}):
            if not _APP_PAKET.fullmatch(paket):
                raise ValueError(f"aufgegeben.{paket}")
            aus.add(paket)
    except (AttributeError, KeyError, TypeError, ValueError) as e:
        _APPS_REGISTER_STAND["fehler"] = f"{quelle}: ungueltig ({e})"
        app.logger.warning("Apps-Register aus %s ungueltig: %s", quelle, e)
        return False
    APPS_REGISTER, APPS_KATALOG_REPOS, APPS_KATALOG_INFO, APPS_OEFFENTLICH_OHNE = register, repos, info, ohne
    APPS_AUFGEGEBEN = aus
    _APPS_REGISTER_STAND.update(quelle=quelle, fehler="")
    return True


def _apps_register_datei(pfad):
    try:
        with open(pfad, encoding="utf-8") as f:
            return _apps_register_uebernehmen(json.load(f), pfad)
    except (OSError, ValueError):
        return False


def _apps_register_auffrischen(erzwingen=False):
    """Hoechstens alle APPS_REGISTER_ALTER Sekunden von der Haupt-API holen (3 s Zeitlimit)."""
    jetzt = time.time()
    if not erzwingen and jetzt - _APPS_REGISTER_STAND["zeit"] < APPS_REGISTER_ALTER:
        return
    _APPS_REGISTER_STAND["zeit"] = jetzt  # auch bei Fehlschlag: nicht bei jeder Anfrage erneut
    try:
        r = requests.get(APPS_REGISTER_URL, timeout=3)
        r.raise_for_status()
        d = r.json()
        if _apps_register_uebernehmen(d, APPS_REGISTER_URL):
            try:
                os.makedirs(os.path.dirname(APPS_REGISTER_KOPIE), exist_ok=True)
                tmp = APPS_REGISTER_KOPIE + ".neu"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(d, f, ensure_ascii=False, indent=1)
                os.replace(tmp, APPS_REGISTER_KOPIE)
            except OSError as e:
                app.logger.warning("Apps-Register: Kopie nicht geschrieben: %s", e)
            return
    except (requests.RequestException, ValueError) as e:
        _APPS_REGISTER_STAND["fehler"] = f"{APPS_REGISTER_URL}: {e}"
        app.logger.warning("Apps-Register nicht ladbar (%s), bleibe bei %s", e, _APPS_REGISTER_STAND["quelle"] or "nichts")
    if not _APPS_REGISTER_STAND["quelle"]:
        _apps_register_datei(APPS_REGISTER_KOPIE) or _apps_register_datei(APPS_REGISTER_MITGELIEFERT)


# Beim Start ohne Netz: gemerkte Kopie, sonst mitgelieferte Datei. Die Haupt-API fragt die
# erste Anfrage an /api/apps*.
if not _apps_register_datei(APPS_REGISTER_KOPIE):
    _apps_register_datei(APPS_REGISTER_MITGELIEFERT)


@app.before_request
def _apps_register_vor_anfrage():
    if request.path.startswith(("/api/apps/", "/api/pbx/apps-versionen")):
        _apps_register_auffrischen()


APPS_BEHALTEN = 3          # Fassungen je App und Plattform (die aktuelle eingeschlossen)
APPS_DATEIEN_DIR = os.path.join(TELEFON_APPS_DIR, "dateien")
APPS_DATEI_MAX = 600 * 1024 * 1024
_VERSION = re.compile(r"[0-9]+(\.[0-9]+){1,3}([-+.][0-9A-Za-z.]{1,20})?")

# GitHub Actions OIDC: https://docs.github.com/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect
GITHUB_OIDC_ISS = "https://token.actions.githubusercontent.com"
APPS_OIDC_AUD = os.environ.get("PBX_APPS_OIDC_AUD", "https://pbx.rosenweg4303.ch/api/apps")
_GITHUB_JWKS = {"zeit": 0.0, "keys": {}}


def _b64_lesen(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _jwt_teile(token):
    """(kopf, claims, teile) ohne Pruefung oder None."""
    try:
        teile = token.split(".")
        if len(teile) != 3:
            return None
        return json.loads(_b64_lesen(teile[0])), json.loads(_b64_lesen(teile[1])), teile
    except (ValueError, binascii.Error, UnicodeDecodeError):
        return None


def _github_schluessel(kid):
    jetzt = time.time()
    if (kid not in _GITHUB_JWKS["keys"] or jetzt - _GITHUB_JWKS["zeit"] > 3600) and jetzt - _GITHUB_JWKS["zeit"] > 60:
        try:
            r = requests.get(GITHUB_OIDC_ISS + "/.well-known/jwks", timeout=10)
            r.raise_for_status()
            _GITHUB_JWKS["keys"] = {k["kid"]: k for k in r.json().get("keys", []) if k.get("kty") == "RSA" and k.get("kid")}
            _GITHUB_JWKS["zeit"] = jetzt
        except (requests.RequestException, ValueError, KeyError):
            app.logger.warning("GitHub-JWKS nicht ladbar")
    return _GITHUB_JWKS["keys"].get(kid)


def _github_oidc(token):
    """Claims eines gueltigen GitHub-Actions-OIDC-Tokens fuer APPS_OIDC_AUD, sonst None."""
    t = _jwt_teile(token)
    if not t:
        return None
    kopf, claims, teile = t
    if kopf.get("alg") != "RS256" or claims.get("iss") != GITHUB_OIDC_ISS:
        return None
    jwk = _github_schluessel(str(kopf.get("kid", "")))
    if not jwk:
        return None
    try:
        schluessel = rsa.RSAPublicNumbers(int.from_bytes(_b64_lesen(jwk["e"]), "big"),
                                          int.from_bytes(_b64_lesen(jwk["n"]), "big")).public_key()
        schluessel.verify(_b64_lesen(teile[2]), f"{teile[0]}.{teile[1]}".encode(), padding.PKCS1v15(), hashes.SHA256())
    except (InvalidSignature, ValueError, KeyError, binascii.Error):
        return None
    jetzt = time.time()
    if not (float(claims.get("exp", 0)) > jetzt and float(claims.get("nbf", claims.get("iat", 0))) < jetzt + 60):
        return None
    aud = claims.get("aud")
    if APPS_OIDC_AUD not in (aud if isinstance(aud, list) else [aud]):
        return None
    return claims


_apk_zertifikat_sha256 = apk.zertifikat_sha256
_apk_manifest = apk.manifest


def _oeffentlich(res):
    herkunft = request.headers.get("Origin", "")
    if herkunft in APPS_HERKUNFT:
        res.headers["Access-Control-Allow-Origin"] = herkunft
        res.headers["Vary"] = "Origin"
    res.headers["Cache-Control"] = "public, max-age=300"
    return res




def _apps_aktuell(conn, schluessel=None):
    """Neueste Fassung je (schluessel, plattform) als Liste von Zeilen."""
    sql = ("SELECT v.* FROM apps_versionen v JOIN (SELECT schluessel, plattform, MAX(id) AS id FROM apps_versionen "
           "GROUP BY schluessel, plattform) m ON m.id = v.id")
    if schluessel:
        return conn.execute(sql + " WHERE v.schluessel = ?", (schluessel,)).fetchall()
    return conn.execute(sql).fetchall()


def _register_nach_paket(paket):
    return next((k for k, e in APPS_REGISTER.items() if e["paket"] == paket), None)


@app.get("/api/apps/index.json")
def apps_index():
    """apps: alle Android-APKs (Updater der Apps) — Form wie bisher, dazu notiz.
    karten: Apps aus APPS_REGISTER mit mindestens einer Datei, je Plattform ein Download.
    liste: alle Apps fuer die Seite /apps in einer Liste (siehe _apps_liste)."""
    conn = db.connect()
    try:
        rows = conn.execute("SELECT paket, name, sha256, groesse, version_code, version_name, updated_at "
                            "FROM telefon_apps WHERE art = 'apk' AND aktiv = 1 AND apk_datei IS NOT NULL "
                            "ORDER BY reihenfolge, name").fetchall()
        aktuell = _apps_aktuell(conn)
    finally:
        conn.close()
    neu = {(v["schluessel"], v["plattform"]): v for v in aktuell}
    apps = []
    nur_anzeige = []
    # Aufgegebene Apps zeigt /apps nicht mehr (auch nicht dem Updater); im Katalog der geteilten
    # Telefone (telefon_apps) bleiben sie, bis die Technik sie dort abschaltet.
    rows = [r for r in rows if r["paket"] not in APPS_AUFGEGEBEN]
    for r in rows:
        if r["paket"] in APPS_OEFFENTLICH_OHNE:
            nur_anzeige.append(r)   # auf /apps zeigen, aber ohne Datei (Stefan 27.11.2026)
            continue
        v = neu.get((_register_nach_paket(r["paket"]) or r["paket"], "android"))
        apps.append({"paket": r["paket"], "name": r["name"], "sha256": r["sha256"], "groesse": r["groesse"],
                     "version_code": r["version_code"], "version_name": r["version_name"], "stand": r["updated_at"],
                     "url": f"/api/apps/{r['paket']}.apk",
                     "notiz": v["notiz"] if v and v["sha256"] == r["sha256"] else ""})
    im_katalog = {a["paket"]: a for a in apps}
    karten = []
    for app_id, e in APPS_REGISTER.items():
        downloads = []
        a = im_katalog.get(e["paket"])
        v = neu.get((app_id, "android"))
        if not a and v:
            # nicht im Katalog der Telefone: trotzdem in 'apps', damit der Updater sie kennt
            a = {"paket": e["paket"], "name": e["name"], "sha256": v["sha256"], "groesse": v["groesse"],
                 "version_code": v["version_code"], "version_name": v["version"], "stand": v["zeit"],
                 "url": f"/api/apps/{e['paket']}.apk", "notiz": v["notiz"]}
            apps.append(a)
        if a:
            downloads.append({"plattform": "android", "titel": "Android", "version": a["version_name"],
                              "groesse": a["groesse"], "sha256": a["sha256"], "stand": a["stand"],
                              "url": a["url"], "notiz": a["notiz"]})
        for pf_id, pf in APPS_PLATTFORMEN.items():
            v = neu.get((app_id, pf_id))
            if pf_id == "android" or not v:
                continue
            downloads.append({"plattform": pf_id, "titel": pf["titel"], "version": v["version"],
                              "groesse": v["groesse"], "sha256": v["sha256"], "stand": v["zeit"],
                              "url": f"/api/apps/datei/{app_id}/{pf_id}", "notiz": v["notiz"]})
        if downloads:
            karten.append({"app": app_id, "name": e["name"], "text": e["text"], "fuer": e["fuer"],
                           "logo": e["logo"], "paket": e["paket"], "downloads": downloads})
    liste = _apps_liste(rows, apps, karten, nur_anzeige)
    return _oeffentlich(jsonify({"apps": apps, "karten": karten, "liste": liste,
                                 "signatur_sha256": APPS_SIGNATUR_SHA256}))


def _apps_liste(rows, apps, karten, nur_anzeige):
    """Eine Liste aller Rosenweg-Apps fuer /apps: Register-Apps (alle Plattformen) und Katalog-Apps
    (Android) zusammen. gruppen: 'handy' (Android-Download), 'computer' (Linux/macOS/Windows),
    'telefone' (im Katalog der geteilten Telefone, kommt dort automatisch), 'technik'.
    nur_anzeige: ohne Download (APPS_OEFFENTLICH_OHNE, z.B. Rosenweg Geraet); dann fehlen url/sha256."""
    im_katalog = {r["paket"] for r in rows}
    karte_nach_paket = {k["paket"]: k for k in karten}
    reihe = {r["paket"]: i for i, r in enumerate(rows)}
    liste = []

    def eintrag(paket, name, text, fuer, logo, downloads, technik, version, stand, nur=False, logos=None):
        gruppen = []
        if not nur and any(d["plattform"] == "android" for d in downloads) and not technik:
            gruppen.append("handy")
        if any(d["plattform"] != "android" for d in downloads):
            gruppen.append("computer")
        if paket in im_katalog:
            gruppen.append("telefone")
        if technik:
            gruppen.append("technik")
        return {"paket": paket, "name": name, "text": text or "", "fuer": fuer or "",
                "logo": logo or "/logo-rosenweg.png", "logos": _apps_logos(logos), "gruppen": gruppen, "geteilte_telefone": paket in im_katalog,
                "nur_anzeige": nur, "version": version or "", "stand": stand or "", "downloads": downloads}

    for app_id, e in sorted(APPS_REGISTER.items(), key=lambda x: x[1]["reihenfolge"]):
        k = karte_nach_paket.get(e["paket"])
        if not k:
            continue
        haupt = max(k["downloads"], key=lambda d: d["stand"] or "")
        liste.append(eintrag(e["paket"], e["name"], e["text"], e["fuer"], e["logo"], k["downloads"],
                             bool(e.get("technik")), haupt["version"], haupt["stand"], logos=e.get("logos")))
    for a in apps:
        if a["paket"] in karte_nach_paket:
            continue
        info = APPS_KATALOG_INFO.get(a["paket"], {})
        dl = {"plattform": "android", "titel": "Android", "version": a["version_name"], "groesse": a["groesse"],
              "sha256": a["sha256"], "stand": a["stand"], "url": a["url"], "notiz": a["notiz"]}
        liste.append(eintrag(a["paket"], info.get("name") or a["name"], info.get("text"), info.get("fuer"),
                             info.get("logo"), [dl], bool(info.get("technik")), a["version_name"], a["stand"],
                             logos=info.get("logos")))
    for r in nur_anzeige:
        info = APPS_KATALOG_INFO.get(r["paket"], {})
        liste.append(eintrag(r["paket"], info.get("name") or r["name"], info.get("text"), info.get("fuer"),
                             info.get("logo"), [], bool(info.get("technik")), r["version_name"], r["updated_at"],
                             nur=True, logos=info.get("logos")))
    # Register-Apps vorne (nach 'reihenfolge'), danach die Katalog-Apps in der Reihenfolge der Telefone
    n = sum(1 for x in liste if x["paket"] in karte_nach_paket)
    return liste[:n] + sorted(liste[n:], key=lambda x: reihe.get(x["paket"], 10**6))


@app.get("/api/apps/<paket>.apk")
def apps_download(paket):
    if not re.fullmatch(r"[a-z][a-z0-9_]*(\.[a-z0-9_]+)+", paket) or paket in APPS_OEFFENTLICH_OHNE:
        return jsonify({"error": "unbekannt"}), 404
    conn = db.connect()
    try:
        r = conn.execute("SELECT name, apk_datei, version_name FROM telefon_apps "
                         "WHERE paket = ? AND art = 'apk' AND aktiv = 1", (paket,)).fetchone()
        v = None
        app_id = _register_nach_paket(paket)
        if (not r or not r["apk_datei"]) and app_id:
            v = next((x for x in _apps_aktuell(conn, app_id) if x["plattform"] == "android"), None)
    finally:
        conn.close()
    if v:
        name = re.sub(r"[^A-Za-z0-9]+", "-", f"{APPS_REGISTER[app_id]['name']}-{v['version']}").strip("-").lower()
        return _oeffentlich(send_from_directory(APPS_DATEIEN_DIR, v["datei"], as_attachment=True,
                                                download_name=f"{name}.apk",
                                                mimetype=APPS_PLATTFORMEN["android"]["mime"]))
    if not r or not r["apk_datei"]:
        return jsonify({"error": "unbekannt"}), 404
    name = re.sub(r"[^A-Za-z0-9]+", "-", f"{r['name']}-{r['version_name'] or ''}").strip("-").lower()
    return _oeffentlich(send_from_directory(TELEFON_APPS_DIR, r["apk_datei"], as_attachment=True,
                                            download_name=f"{name}.apk",
                                            mimetype="application/vnd.android.package-archive"))


@app.get("/api/apps/datei/<app_id>/<plattform>")
def apps_datei(app_id, plattform):
    if app_id not in APPS_REGISTER or plattform not in APPS_PLATTFORMEN or plattform == "android":
        return jsonify({"error": "unbekannt"}), 404
    conn = db.connect()
    try:
        v = next((x for x in _apps_aktuell(conn, app_id) if x["plattform"] == plattform), None)
    finally:
        conn.close()
    if not v:
        return jsonify({"error": "unbekannt"}), 404
    endung = os.path.splitext(v["datei"])[1]
    name = re.sub(r"[^A-Za-z0-9]+", "-", f"{APPS_REGISTER[app_id]['name']}-{v['version']}").strip("-").lower()
    return _oeffentlich(send_from_directory(APPS_DATEIEN_DIR, v["datei"], as_attachment=True,
                                            download_name=f"{name}{endung}",
                                            mimetype=APPS_PLATTFORMEN[plattform]["mime"]))


def _apps_einspielen(schluessel, plattform, quelle, version_soll=None):
    """Datei aus dem Multipart-Feld 'datei' pruefen, ablegen und freigeben.
    schluessel: App aus APPS_REGISTER oder Paketname einer Katalog-App.
    Felder: datei, version, sha256 (Pflicht fuer die CI), paket (Android, optional), notiz."""
    register = APPS_REGISTER.get(schluessel)
    paket_soll = register["paket"] if register else schluessel
    pf = APPS_PLATTFORMEN[plattform]
    if not register and plattform != "android":
        return jsonify({"error": "Katalog-Apps gibt es nur fuer Android"}), 400
    f = request.files.get("datei")
    if not f or not f.filename:
        return jsonify({"error": "Feld 'datei' fehlt"}), 400
    endung = os.path.splitext(f.filename)[1].lower()
    if endung not in pf["endungen"]:
        return jsonify({"error": f"{pf['titel']}: erlaubt sind {', '.join(pf['endungen'])}"}), 400
    version = str(request.form.get("version") or "").strip()
    version = version[1:] if version[:1] == "v" else version
    sha_soll = str(request.form.get("sha256") or "").strip().lower()
    if version_soll is not None and not re.fullmatch(r"[0-9a-f]{64}", sha_soll):
        return jsonify({"error": "sha256 der Datei fehlt"}), 400
    paket_angabe = str(request.form.get("paket") or "").strip()
    if paket_angabe and paket_angabe != paket_soll:
        return jsonify({"error": f"paket {paket_angabe} gehoert nicht zu diesem Repo ({paket_soll})"}), 400
    notiz = str(request.form.get("notiz") or "").strip()[:4000]
    notiz = _STEUERZEICHEN.sub(lambda m: m.group(0) if m.group(0) in "\n\t" else "", notiz)
    os.makedirs(APPS_DATEIEN_DIR, exist_ok=True)
    tmp = os.path.join(APPS_DATEIEN_DIR, f".hoch-{pysecrets.token_hex(8)}{endung}")
    try:
        h, n = hashlib.sha256(), 0
        with open(tmp, "wb") as out:
            while True:
                stueck = f.stream.read(1024 * 1024)
                if not stueck:
                    break
                n += len(stueck)
                if n > APPS_DATEI_MAX:
                    return jsonify({"error": "Datei zu gross"}), 413
                h.update(stueck)
                out.write(stueck)
        sha = h.hexdigest()
        if sha_soll and not hmac.compare_digest(sha, sha_soll):
            return jsonify({"error": "Pruefsumme stimmt nicht (Datei unvollstaendig?)"}), 400
        with open(tmp, "rb") as chk:
            kopf = chk.read(32)
            chk.seek(max(0, n - 512))
            schluss = chk.read(4)
        kenn = pf["endungen"][endung]
        if (kenn is None and schluss != b"koly") or (kenn is not None and not kopf.startswith(kenn)):
            return jsonify({"error": f"keine gueltige {endung}-Datei"}), 400
        version_code = None
        if plattform == "android":
            if _apk_zertifikat_sha256(tmp) != APPS_SIGNATUR_SHA256:
                return jsonify({"error": "APK ist nicht mit dem Rosenweg-Schluessel signiert"}), 400
            paket, version_code, vname = _apk_manifest(tmp)
            if paket != paket_soll:
                return jsonify({"error": f"APK hat Paket {paket}, erwartet {paket_soll}"}), 400
            if not version_code:
                return jsonify({"error": "versionCode im APK nicht lesbar"}), 400
            version = version or (vname or "")
        if not _VERSION.fullmatch(version):
            return jsonify({"error": "version fehlt oder ungueltig (z.B. 1.0.0)"}), 400
        if version_soll is not None and version.split("+")[0] != version_soll:
            return jsonify({"error": f"Version {version} passt nicht zum Tag {version_soll}"}), 400
        if plattform == "android" and not register:
            conn = db.connect()
            try:
                da = conn.execute("SELECT 1 FROM telefon_apps WHERE paket = ? AND art = 'apk'", (paket_soll,)).fetchone()
            finally:
                conn.close()
            if not da:
                return jsonify({"error": f"{paket_soll} steht nicht im App-Katalog – zuerst auf "
                                         "/smartphones anlegen"}), 409
        name_teil = re.sub(r"[^a-z0-9]+", "-", schluessel.lower())
        datei = f"{name_teil}-{plattform}-{sha[:12]}{endung}"
        os.replace(tmp, os.path.join(APPS_DATEIEN_DIR, datei))
        tmp = None
        conn = db.connect()
        weg = []
        try:
            katalog = None
            if plattform == "android":
                katalog = conn.execute("SELECT apk_datei FROM telefon_apps WHERE paket = ? AND art = 'apk'",
                                       (paket_soll,)).fetchone()
                ohne = {x.strip() for x in re.split(r"[,\s]+", _cfg(conn).get(
                    "telefon_katalog_ohne", "ch.rosenweg4303.kiosk")) if x.strip()}
                if not katalog and register and paket_soll not in ohne and not conn.execute(
                        "SELECT 1 FROM telefon_apps WHERE paket = ?", (paket_soll,)).fetchone():
                    # Jede Rosenweg-App gehoert auch auf die geteilten Telefone (Stefan 28.11.2026),
                    # ausser den Ausnahmen in config telefon_katalog_ohne (Standard: Kiosk = TV-Startseite):
                    # beim ersten Android-Release selbst in den Katalog aufnehmen, fuer alle sichtbar.
                    # Die App prueft ihre Rechte selbst; Freigabe/Gruppen aendert die Technik auf /smartphones.
                    reihe = (conn.execute("SELECT COALESCE(MAX(reihenfolge), 0) FROM telefon_apps").fetchone()[0] or 0) + 10
                    conn.execute("INSERT INTO telefon_apps (paket, name, art, gruppen, reihenfolge, aktiv) "
                                 "VALUES (?, ?, 'apk', '', ?, 1)",
                                 (paket_soll, register.get("name") or paket_soll, reihe))
                    katalog = {"apk_datei": None}
                if katalog:
                    # dieselbe Fassung in den Katalog der geteilten Telefone (Freigabe bleibt, wie sie ist)
                    kdatei = f"{paket_soll}-{sha[:12]}.apk"
                    shutil.copyfile(os.path.join(APPS_DATEIEN_DIR, datei), os.path.join(TELEFON_APPS_DIR, kdatei))
                    conn.execute("UPDATE telefon_apps SET apk_datei=?, sha256=?, groesse=?, version_code=?, "
                                 "version_name=?, updated_at=datetime('now') WHERE paket=?",
                                 (kdatei, sha, n, version_code, version, paket_soll))
                    if katalog["apk_datei"] and katalog["apk_datei"] != kdatei:
                        weg.append(os.path.join(TELEFON_APPS_DIR, katalog["apk_datei"]))
            conn.execute("INSERT INTO apps_versionen (schluessel, plattform, version, version_code, datei, sha256, "
                         "groesse, notiz, quelle) VALUES (?,?,?,?,?,?,?,?,?)",
                         (schluessel, plattform, version, version_code, datei, sha, n, notiz, quelle))
            # aeltere Fassungen begrenzen (dieselbe Datei kann mehrfach vorkommen: nur loeschen, wenn ungenutzt)
            alte = conn.execute("SELECT id, datei FROM apps_versionen WHERE schluessel = ? AND plattform = ? "
                                "ORDER BY id DESC LIMIT -1 OFFSET ?", (schluessel, plattform, APPS_BEHALTEN)).fetchall()
            for a in alte:
                conn.execute("DELETE FROM apps_versionen WHERE id = ?", (a["id"],))
            conn.commit()
            for a in alte:
                if not conn.execute("SELECT 1 FROM apps_versionen WHERE datei = ?", (a["datei"],)).fetchone():
                    weg.append(os.path.join(APPS_DATEIEN_DIR, a["datei"]))
        finally:
            conn.close()
        for pfad in weg:
            try:
                os.remove(pfad)
            except OSError:
                pass
        if katalog:
            adb_updater.anstossen()   # geteilte Telefone bekommen die Fassung per adb (adb_updater.py)
        app.logger.info("apps: %s %s %s (%s) von %s", schluessel, plattform, version, sha[:12], quelle)
        return jsonify({"ok": True, "schluessel": schluessel, "plattform": plattform, "version": version,
                        "version_code": version_code, "sha256": sha, "groesse": n, "katalog": bool(katalog)})
    finally:
        if tmp:
            try:
                os.remove(tmp)
            except OSError:
                pass


@app.post("/api/apps/release")
def apps_release():
    """Fuer die CI der App-Repos (Action Rosenweg/Website/.github/actions/apps-release).
    Authorization: Bearer <GitHub-Actions-OIDC-Token, audience APPS_OIDC_AUD> — kein Geheimnis.
    Zugelassen: Repos aus APPS_REGISTER/APPS_KATALOG_REPOS, nur fuer einen Tag (v)<version>.
    Multipart: datei, plattform, version, sha256, paket (Android), notiz."""
    claims = _github_oidc(_bearer() or "")
    if not claims:
        return jsonify({"error": "kein gueltiges GitHub-OIDC-Token"}), 401
    repo = str(claims.get("repository", ""))
    ref = str(claims.get("ref", ""))
    schluessel = next((k for k, e in APPS_REGISTER.items() if e["repo"] == repo), None) or APPS_KATALOG_REPOS.get(repo)
    tag = ref[len("refs/tags/"):] if ref.startswith("refs/tags/") else ""
    tag_version = tag[1:] if tag[:1] == "v" else tag
    if (not schluessel or claims.get("repository_owner") != "Rosenweg" or claims.get("ref_type") != "tag"
            or not _VERSION.fullmatch(tag_version)
            or claims.get("event_name") not in ("push", "release", "workflow_dispatch")):
        app.logger.warning("apps: Release abgewiesen: %s %s %s", repo, ref, claims.get("event_name"))
        return jsonify({"error": "nur eingetragene Rosenweg-App-Repos, nur fuer einen Release-Tag"}), 403
    plattform = str(request.form.get("plattform") or "android")
    if plattform not in APPS_PLATTFORMEN:
        return jsonify({"error": "plattform: " + ", ".join(APPS_PLATTFORMEN)}), 400
    return _apps_einspielen(schluessel, plattform, f"{repo}@{tag}", version_soll=tag_version)


# ─── Versionsstand der Apps auf den Geraeten (NOC, Stefan 27.11.2026) ─────────────────────
# Die Updater der Apps (Kotlin: commons-rosenweg updater >= 0.1.6, Flutter-Desktop: rosenweg_basis
# RosenwegAktualisierung) melden bei jeder Pruefung, welche Rosenweg-Apps in welcher Fassung
# installiert sind. Oeffentlich (die Apps haben ohne Anmeldung keinen Schluessel), darum streng
# geprueft und gebremst; keine Personendaten: nur die gehashte Geraetekennung, Pakete, Versionen.
STAND_MAX_APPS = 60
STAND_MAX_GERAETE = 20000
STAND_MAX_STUNDE = 30            # Meldungen je Geraet und Stunde
STAND_ALTER_TAGE = 90            # aeltere Geraete fallen aus der Liste
_STAND_GEBREMST = {}             # geraet -> [Zeitpunkte]
_GERAET_KENNUNG = re.compile(r"[0-9a-f]{64}")
_STAND_VERSION = re.compile(r"[0-9A-Za-z.+_-]{1,40}")


@app.post("/api/apps/stand")
def apps_stand_melden():
    """Body {geraet: sha256-hex, plattform, geteilt?, station?, system?, apps: [{paket, version, version_code?}]}"""
    b = request.get_json(silent=True)
    if not isinstance(b, dict):
        return jsonify({"error": "JSON erwartet"}), 400
    geraet = str(b.get("geraet") or "").lower()
    plattform = str(b.get("plattform") or "")
    apps = b.get("apps")
    if not _GERAET_KENNUNG.fullmatch(geraet) or plattform not in APPS_PLATTFORMEN \
            or not isinstance(apps, list) or not 0 < len(apps) <= STAND_MAX_APPS:
        return jsonify({"error": "geraet (sha256), plattform und apps (1-60) noetig"}), 400
    zeilen = {}
    for a in apps:
        if not isinstance(a, dict):
            return jsonify({"error": "apps: Eintraege {paket, version}"}), 400
        paket = str(a.get("paket") or "")
        version = str(a.get("version") or "")
        code = a.get("version_code")
        if not _APP_PAKET.fullmatch(paket) or not paket.startswith("ch.rosenweg4303.") \
                or (version and not _STAND_VERSION.fullmatch(version)) \
                or (code is not None and (not isinstance(code, int) or isinstance(code, bool) or not 0 <= code < 2**31)):
            return jsonify({"error": f"apps: ungueltig ({paket[:60]})"}), 400
        zeilen[paket] = (version, code)
    jetzt = time.time()
    liste = [t for t in _STAND_GEBREMST.get(geraet, []) if jetzt - t < 3600]
    if len(liste) >= STAND_MAX_STUNDE:
        return jsonify({"error": "Zu viele Meldungen - bitte spaeter"}), 429
    _STAND_GEBREMST[geraet] = liste + [jetzt]
    if len(_STAND_GEBREMST) > 4 * STAND_MAX_GERAETE:
        _STAND_GEBREMST.clear()
    system = re.sub(r"[^\w .,()/+-]", "", str(b.get("system") or ""))[:60]
    conn = db.connect()
    try:
        alt = int(jetzt) - STAND_ALTER_TAGE * 86400
        conn.execute("DELETE FROM apps_stand WHERE zuletzt < ?", (alt,))
        neu_geraet = not conn.execute("SELECT 1 FROM apps_stand WHERE geraet = ? LIMIT 1", (geraet,)).fetchone()
        if neu_geraet and conn.execute("SELECT COUNT(DISTINCT geraet) FROM apps_stand").fetchone()[0] >= STAND_MAX_GERAETE:
            return jsonify({"error": "voll"}), 503
        conn.execute("DELETE FROM apps_stand WHERE geraet = ? AND plattform = ?", (geraet, plattform))
        conn.executemany(
            "INSERT INTO apps_stand (geraet, plattform, paket, version, version_code, geteilt, station, system, zuletzt) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            [(geraet, plattform, p, v, c, int(bool(b.get("geteilt"))), int(bool(b.get("station"))), system, int(jetzt))
             for p, (v, c) in zeilen.items()])
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True, "apps": len(zeilen)})


def _version_teile(v):
    """'1.10.0+3' -> (1, 10, 0, 0); wie istNeuer in rosenweg_basis."""
    teile = re.split(r"[+-]", str(v or ""))[0].split(".")
    zahlen = [int(t) if t.strip().isdigit() else 0 for t in teile[:4]]
    return tuple(zahlen + [0] * (4 - len(zahlen)))


def _stand_aktuell(conn):
    """(paket, plattform) -> {version, version_code, name} der neuesten freigegebenen Fassung."""
    soll = {}
    for r in conn.execute("SELECT paket, name, version_code, version_name FROM telefon_apps "
                          "WHERE art = 'apk' AND aktiv = 1 AND apk_datei IS NOT NULL"):
        soll[(r["paket"], "android")] = {"version": r["version_name"] or "", "version_code": r["version_code"],
                                         "name": r["name"]}
    for v in _apps_aktuell(conn):
        e = APPS_REGISTER.get(v["schluessel"])
        paket = e["paket"] if e else v["schluessel"]
        name = e["name"] if e else paket
        alt = soll.get((paket, v["plattform"]))
        if v["plattform"] == "android" and alt and (alt["version_code"] or 0) >= (v["version_code"] or 0):
            continue
        soll[(paket, v["plattform"])] = {"version": v["version"], "version_code": v["version_code"], "name": name}
    return soll


def _stand_veraltet(ist_version, ist_code, s):
    if not s:
        return None   # nichts freigegeben: unbekannt
    if ist_code is not None and s.get("version_code"):
        return ist_code < s["version_code"]
    return _version_teile(ist_version) < _version_teile(s["version"])


@app.get("/api/pbx/apps-stand")
def apps_stand_liste():
    """Fuer das NOC (ISP-Admin, Reiter App-Versionen): je App und Plattform Anteil veralteter Geraete
    und die Liste. Eigene Geraete nur mit gekuerzter Kennung; geteilte Telefone mit Nebenstelle."""
    _, deny = require_admin()
    if deny:
        return deny
    conn = db.connect()
    try:
        soll = _stand_aktuell(conn)
        grenze = int(time.time()) - STAND_ALTER_TAGE * 86400
        zeilen = conn.execute("SELECT * FROM apps_stand WHERE zuletzt >= ? ORDER BY paket, plattform, zuletzt DESC",
                              (grenze,)).fetchall()
        geteilt = conn.execute("SELECT i.ext, i.paket, i.version_code, i.geprueft FROM telefon_apps_ist i "
                               "JOIN sip_extensions e ON e.ext = i.ext WHERE e.context = 'geteilt'").fetchall()
        namen = {r["paket"]: r["name"] for r in conn.execute("SELECT paket, name FROM telefon_apps")}
    finally:
        conn.close()
    gruppen = {}

    def eintrag(paket, plattform):
        k = (paket, plattform)
        if k not in gruppen:
            s = soll.get(k)
            reg = next((e for e in APPS_REGISTER.values() if e["paket"] == paket), None)
            gruppen[k] = {"paket": paket, "plattform": plattform,
                          "name": (s or {}).get("name") or namen.get(paket) or (reg or {}).get("name") or paket,
                          "aktuell": (s or {}).get("version", ""), "aktuell_code": (s or {}).get("version_code"),
                          "geraete": 0, "veraltet": 0, "liste": []}
        return gruppen[k]

    gesehen_geteilt = set()
    for r in zeilen:
        g = eintrag(r["paket"], r["plattform"])
        alt = _stand_veraltet(r["version"], r["version_code"], soll.get((r["paket"], r["plattform"])))
        g["geraete"] += 1
        g["veraltet"] += 1 if alt else 0
        art = "geteilt" if r["geteilt"] else ("station" if r["station"] else "eigen")
        g["liste"].append({"geraet": r["geraet"][:12], "art": art, "version": r["version"],
                           "version_code": r["version_code"], "veraltet": alt, "system": r["system"],
                           "zuletzt": r["zuletzt"]})
    for r in geteilt:
        k = (r["ext"], r["paket"])
        if k in gesehen_geteilt:
            continue
        gesehen_geteilt.add(k)
        g = eintrag(r["paket"], "android")
        alt = _stand_veraltet("", r["version_code"], soll.get((r["paket"], "android")))
        g["geraete"] += 1
        g["veraltet"] += 1 if alt else 0
        g["liste"].append({"geraet": f"Telefon {r['ext']}", "art": "telefon", "version": "",
                           "version_code": r["version_code"], "veraltet": alt, "system": "",
                           "zuletzt": r["geprueft"]})
    apps = sorted(gruppen.values(), key=lambda g: (-g["veraltet"], g["name"].lower(), g["plattform"]))
    for g in apps:
        g["anteil_veraltet"] = round(g["veraltet"] / g["geraete"], 3) if g["geraete"] else 0
        g["liste"].sort(key=lambda x: (not x["veraltet"], -(x["zuletzt"] or 0)))
    geraete = {r["geraet"] for r in zeilen} | {r["ext"] for r in geteilt}
    return jsonify({"apps": apps, "geraete": len(geraete), "alter_tage": STAND_ALTER_TAGE})


@app.get("/api/pbx/apps-versionen")
def apps_versionen_liste():
    _, deny = require_admin()
    if deny:
        return deny
    conn = db.connect()
    try:
        rows = conn.execute("SELECT id, schluessel, plattform, version, version_code, sha256, groesse, notiz, quelle, zeit "
                            "FROM apps_versionen ORDER BY schluessel, plattform, id DESC").fetchall()
    finally:
        conn.close()
    return jsonify({"register": [{"app": k, "name": e["name"], "repo": e["repo"], "paket": e["paket"]}
                                 for k, e in APPS_REGISTER.items()],
                    "katalog_repos": APPS_KATALOG_REPOS, "behalten": APPS_BEHALTEN,
                    "register_quelle": {k: v for k, v in _APPS_REGISTER_STAND.items() if k != "zeit"},
                    "versionen": [dict(r) for r in rows]})


@app.post("/api/pbx/apps-versionen/<schluessel>/<plattform>")
def apps_versionen_hochladen(schluessel, plattform):
    """Technik von Hand (z.B. macOS-DMG vom eigenen Mac). Multipart: datei, version, sha256?, notiz?"""
    user, deny = require_admin()
    if deny:
        return deny
    if plattform not in APPS_PLATTFORMEN or (schluessel not in APPS_REGISTER
                                             and schluessel not in APPS_KATALOG_REPOS.values()):
        return jsonify({"error": "unbekannt"}), 404
    return _apps_einspielen(schluessel, plattform, actor(user))


@app.delete("/api/pbx/apps-versionen/<int:vid>")
def apps_versionen_loeschen(vid):
    """Eine Fassung zurueckziehen; ist es die neueste, gilt wieder die vorherige (nur /apps-Dateien;
    den Katalog der Telefone setzt das nicht zurueck)."""
    _, deny = require_admin()
    if deny:
        return deny
    conn = db.connect()
    try:
        r = conn.execute("SELECT datei FROM apps_versionen WHERE id = ?", (vid,)).fetchone()
        conn.execute("DELETE FROM apps_versionen WHERE id = ?", (vid,))
        conn.commit()
        noch = r and conn.execute("SELECT 1 FROM apps_versionen WHERE datei = ?", (r["datei"],)).fetchone()
    finally:
        conn.close()
    if r and not noch:
        try:
            os.remove(os.path.join(APPS_DATEIEN_DIR, r["datei"]))
        except OSError:
            pass
    return jsonify({"ok": bool(r)})


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
        # versionCode/-Name aus dem Manifest: der adb-Updater vergleicht danach
        _p, vcode, vname = apk.manifest(os.path.join(TELEFON_APPS_DIR, datei))
        conn.execute("UPDATE telefon_apps SET apk_datei=?, sha256=?, groesse=?, version_code=?, version_name=?, "
                     "updated_at=datetime('now') WHERE paket=?",
                     (datei, sha, len(daten), vcode if _p == paket else None, vname if _p == paket else None, paket))
        conn.commit()
        alt = r["apk_datei"]
        if alt and alt != datei:
            try:
                os.remove(os.path.join(TELEFON_APPS_DIR, alt))
            except OSError:
                pass
        adb_updater.anstossen()   # geteilte Telefone bekommen die Fassung per adb
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
INTERN_PERSON_RE = re.compile(r"3[0-9]{5}")
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
    karten, k, kategorien = [], None, set()
    for z in zeilen:
        if z.upper() == "BEGIN:VCARD":
            k = {"name": "", "org": "", "nummern": [], "emails": []}
            kategorien = set()
        elif z.upper() == "END:VCARD" and k is not None:
            if "bewohner" in kategorien:
                # Personen der Siedlung: nur interne Nummern 3HHWWP, auch wenn im
                # Adressbuch (noch) echte stehen (Stefan 27.11.2026, contacts-sync)
                k["nummern"] = [n for n in k["nummern"] if INTERN_PERSON_RE.fullmatch(n["nummer"])]
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
                    typ = ("rosenweg" if INTERN_PERSON_RE.fullmatch(nummer)
                           else "mobil" if "CELL" in params else "arbeit" if "WORK" in params
                           else "privat" if "HOME" in params else "andere")
                    k["nummern"].append({"nummer": nummer, "typ": typ})
            elif feld == "CATEGORIES":
                kategorien |= {c.strip().lower() for c in wert.split(",")}
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
        return False   # "Max Muster AG" ist nicht "Max Muster"
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


def _privat_zugang():
    """HTTP-Basic <nummer>-p<id>:passwort eines eigenen Handys (telefon_sip_privat).
    -> (email, name) | None. Nur fuer Anrufliste/Voicemail der Person (nicht PIN,
    Nextcloud, Messenger: die gehoeren zur Sitzung auf geteilten Telefonen)."""
    a = request.authorization
    if not a or not a.username or not a.password or not SIP_PRIVAT_RE.fullmatch(a.username):
        return None
    zid = int(a.username.split("-p", 1)[1])
    conn = db.connect()
    try:
        r = conn.execute("SELECT email, nummer, passwort FROM telefon_sip_privat WHERE id = ?", (zid,)).fetchone()
        if not r or a.username != f"{r['nummer']}-p{zid}" or \
                not hmac.compare_digest(str(r["passwort"]).encode(), a.password.encode()):
            return None
        n = conn.execute("SELECT name FROM personen_nummern WHERE nummer = ? AND lower(email) = lower(?)",
                         (r["nummer"], r["email"])).fetchone()
        return r["email"], (n["name"] if n else "")
    finally:
        conn.close()


def _person_fuer_verlauf():
    """Person fuer Anrufliste/Voicemail: Nebenstelle mit Sitzung (geteiltes Telefon, wie
    bisher) oder eigener Handy-Zugang. -> ((email, name), None) | (None, response)"""
    a = request.authorization
    if a and a.username and SIP_PRIVAT_RE.fullmatch(a.username):
        p = _privat_zugang()
        if not p:
            return None, (jsonify({"error": "Unbekannter Zugang"}), 401)
        return p, None
    ext, deny = _nebenstelle()
    if deny:
        return None, deny
    conn = db.connect()
    try:
        return _person_der_nebenstelle(conn, ext), None
    finally:
        conn.close()


@app.get("/api/telefon/anrufliste")
def telefon_anrufliste():
    """Anrufe der Person, die an dieser Nebenstelle angemeldet ist (bzw. der das eigene Handy
    gehoert) — ueber alle Geraete und die persoenliche Nummer.
    ?limit= (max 500), optional ?tage= (nur die letzten N Tage, max 366) und ?vor=<beginn>
    (aeltere Seite: nur Anrufe vor diesem Zeitpunkt). gegenueber_name = interner Name."""
    person, deny = _person_fuer_verlauf()
    if deny:
        return deny
    email, name = person
    limit = min(int(request.args.get("limit", 200) or 200), 500)
    bedingung, werte = "", []
    tage = request.args.get("tage")
    if tage and tage.isdigit() and 0 < int(tage) <= 366:
        bedingung += " AND started_at >= datetime('now', ?)"
        werte.append(f"-{int(tage)} days")
    vor = request.args.get("vor") or ""
    if re.fullmatch(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}", vor):
        bedingung += " AND started_at < ?"
        werte.append(vor)
    conn = db.connect()
    try:
        if not email:
            return jsonify({"angemeldet": False, "anrufe": []})
        rows = conn.execute(
            "SELECT id, direction, caller_id, dialed, ext, person, ziel_ext, ziel_person, started_at, "
            "answered_at, duration_seconds, hangup_cause, voicemail_summary, voicemail_path "
            "FROM calls WHERE (lower(person) = lower(?) OR lower(ziel_person) = lower(?))" + bedingung +
            " ORDER BY started_at DESC LIMIT ?", (email, email, *werte, limit)).fetchall()
        namen = {}
        for r in conn.execute("SELECT lower(email) e, name FROM personen_nummern WHERE aktiv = 1"):
            namen.setdefault(r["e"], r["name"])
        anrufe = []
        for r in rows:
            ich_rufe = (r["person"] or "").lower() == email.lower() and r["direction"] in ("internal", "outbound")
            angenommen = bool(r["answered_at"]) or (r["hangup_cause"] or "").upper() == "ANSWERED"
            gegenueber = (r["ziel_person"] if ich_rufe else r["person"]) or ""
            anrufe.append({
                "gegenueber_name": namen.get(gegenueber.lower(), ""),
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
    person, deny = _person_fuer_verlauf()
    if deny:
        return deny
    email = person[0]
    conn = db.connect()
    try:
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


# ─── Hintergrundbild des Startbildschirms pro Person (geteilte Telefone) ─────
# Stefan 27.11.2026: "Pro Person synchronisieren". Rosenweg Geraet merkt, wenn die
# angemeldete Person einen neuen Hintergrund setzt (Galerie "Als Hintergrund" o.ae.),
# verkleinert ihn auf Bildschirmgroesse und laedt ihn als JPEG hoch. Nach dem Anmelden
# an irgendeinem geteilten Telefon setzt Geraet ihn wieder, beim Abmelden den Standard.
# Nur ueber den Geraetezugang und nur fuer die Person der Sitzung dieses Telefons
# (keine E-Mail im Pfad: niemand kommt an das Bild einer anderen Person). Das Bild liegt
# als Datei ausserhalb der DB, die Fassung (Hash) in telefon_hintergrund; /api/telefon/status
# meldet sie als "hintergrund" ("" = Standard).
HINTERGRUND_DIR = os.environ.get("PBX_HINTERGRUND_DIR", "/var/lib/pbx-api/hintergruende")
HINTERGRUND_MAX = int(os.environ.get("PBX_HINTERGRUND_MAX", str(600 * 1024)))
HINTERGRUND_SEITE_MAX = 4096


def _hintergrund_datei(email):
    name = hashlib.sha256(email.strip().lower().encode()).hexdigest()[:32]
    return os.path.join(HINTERGRUND_DIR, name + ".jpg")


def _jpeg_masse(daten):
    """(breite, hoehe) eines JPEG aus dem SOF-Marker, sonst None (kein JPEG)."""
    if len(daten) < 4 or daten[:3] != b"\xff\xd8\xff":
        return None
    i = 2
    while i + 4 <= len(daten):
        if daten[i] != 0xFF:
            return None
        marker = daten[i + 1]
        if marker == 0xFF:          # Fuellbyte
            i += 1
            continue
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        laenge = int.from_bytes(daten[i + 2:i + 4], "big")
        if laenge < 2:
            return None
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            if i + 9 > len(daten):
                return None
            hoehe = int.from_bytes(daten[i + 5:i + 7], "big")
            breite = int.from_bytes(daten[i + 7:i + 9], "big")
            return (breite, hoehe) if breite and hoehe else None
        if marker == 0xDA:          # Bilddaten ohne SOF davor
            return None
        i += 2 + laenge
    return None


def _hintergrund_version(conn, email):
    if not email:
        return ""
    r = conn.execute("SELECT version FROM telefon_hintergrund WHERE email = ?", (email.lower(),)).fetchone()
    return r["version"] if r and os.path.isfile(_hintergrund_datei(email)) else ""


def _hintergrund_loeschen(conn, email):
    conn.execute("DELETE FROM telefon_hintergrund WHERE email = ?", (email.lower(),))
    try:
        os.remove(_hintergrund_datei(email))
    except FileNotFoundError:
        pass


@app.route("/api/telefon/hintergrund", methods=["GET", "PUT", "DELETE"])
def telefon_hintergrund():
    """Rosenweg Geraet (Geraetezugang): Hintergrund der hier angemeldeten Person.
    GET -> image/jpeg (Header X-Hintergrund-Version) | 404 keiner (Standard);
    PUT Rohdaten image/jpeg (hoechstens HINTERGRUND_MAX) -> {ok, version};
    DELETE -> {ok} (zurueck auf den Standard). 409: niemand angemeldet."""
    ext, deny = _geraet()
    if deny:
        return deny
    conn = db.connect()
    try:
        email, _ = _person_der_nebenstelle(conn, ext)
        if not email:
            return jsonify({"error": "Niemand angemeldet"}), 409
        email = email.lower()
        if request.method == "GET":
            version = _hintergrund_version(conn, email)
            if not version:
                return jsonify({"error": "Kein Hintergrund", "version": ""}), 404
            r = send_file(_hintergrund_datei(email), mimetype="image/jpeg")
            r.headers["X-Hintergrund-Version"] = version
            r.headers["Cache-Control"] = "no-store"
            return r
        if request.method == "DELETE":
            _hintergrund_loeschen(conn, email)
            conn.commit()
            return jsonify({"ok": True, "version": ""})
        if not request.content_length:
            return jsonify({"error": "Bild fehlt"}), 400
        if request.content_length > HINTERGRUND_MAX:
            return jsonify({"error": "Bild zu gross", "max": HINTERGRUND_MAX}), 413
        daten = request.stream.read(HINTERGRUND_MAX + 1)
        if len(daten) > HINTERGRUND_MAX:
            return jsonify({"error": "Bild zu gross", "max": HINTERGRUND_MAX}), 413
        masse = _jpeg_masse(daten)
        if not masse:
            return jsonify({"error": "Kein JPEG"}), 400
        if max(masse) > HINTERGRUND_SEITE_MAX:
            return jsonify({"error": "Bild zu gross (Pixel)"}), 400
        version = hashlib.sha256(daten).hexdigest()[:16]
        os.makedirs(HINTERGRUND_DIR, mode=0o700, exist_ok=True)
        ziel = _hintergrund_datei(email)
        tmp = ziel + ".teil"
        with open(tmp, "wb") as f:
            f.write(daten)
        os.replace(tmp, ziel)
        conn.execute(
            "INSERT INTO telefon_hintergrund (email, version, groesse, breite, hoehe, ext, updated_at) "
            "VALUES (?,?,?,?,?,?, datetime('now')) ON CONFLICT(email) DO UPDATE SET version = excluded.version, "
            "groesse = excluded.groesse, breite = excluded.breite, hoehe = excluded.hoehe, ext = excluded.ext, "
            "updated_at = excluded.updated_at",
            (email, version, len(daten), masse[0], masse[1], str(ext)))
        conn.commit()
        return jsonify({"ok": True, "version": version})
    finally:
        conn.close()


# Konto geloescht (Stefan 27.11.2026: "alles loeschen, ueber die richtigen Ablaeufe"). Zuerst
# abmelden und widerrufen, dann loeschen; Anruf- und Anmeldeprotokoll werden anonymisiert (die
# Zahlen bleiben fuer die Statistik). Jeder Schritt einzeln: scheitert einer, wird er protokolliert
# und der Rest laeuft weiter. Nicht angefasst: telefon_fernwartung (Konten der Technik).
GELOESCHT = "gelöscht"
PERSON_LOESCHEN_TABELLEN = ("telefon_einstellungen", "telefon_pin", "telefon_ausweise")


def _loeschen_sitzungen(conn, email, k):
    exts = [r["ext"] for r in conn.execute("SELECT ext FROM telefon_sitzungen WHERE lower(email) = ?", (email,))]
    for ext in exts:
        _telefon_abmelden(conn, ext, "loeschung")
    conn.commit()
    return {"abgemeldet": exts}


def _loeschen_nextcloud(conn, email, k):
    exts = [r["ext"] for r in conn.execute("SELECT ext FROM telefon_nextcloud WHERE lower(email) = ?", (email,))]
    fehler = []
    for ext in exts:
        with _nc_sperre(ext):
            if NC_TOKEN_URL and not _nextcloud_widerruf_senden(email, ext):
                fehler.append(ext)
                continue
            conn.execute("DELETE FROM telefon_nextcloud WHERE ext = ? AND lower(email) = ?", (ext, email))
            conn.commit()
    if fehler:
        raise RuntimeError("Widerruf fehlgeschlagen: " + ", ".join(fehler))
    return {"widerrufen": exts}


def _loeschen_nextcloud_konto(conn, email, k):
    """Das Nextcloud-Konto selbst loeschen (nicht nur die App-Passwoerter): nc-token auf CT 104,
    POST /konto-loeschen. Kein Konto mit dieser E-Mail -> erledigt. Admin-Konten loescht nc-token
    nie (409 -> Schritt bleibt offen, die Technik sieht ihn auf der Loeschungen-Seite)."""
    if not NC_TOKEN_URL:
        raise RuntimeError("nc-token nicht eingerichtet")
    r = requests.post(f"{NC_TOKEN_URL}/konto-loeschen", json={"email": email},
                      headers={"X-NC-Token-Secret": NC_TOKEN_SECRET}, timeout=120)
    if r.status_code == 404:
        return {"konten": 0}
    if r.status_code != 200:
        raise RuntimeError(f"nc-token HTTP {r.status_code}")
    return {"konten": len((r.json() or {}).get("geloescht") or [])}


def _loeschen_sip(conn, email, k):
    person = conn.execute("DELETE FROM telefon_sip_person WHERE lower(email) = ?", (email,)).rowcount
    privat = conn.execute("DELETE FROM telefon_sip_privat WHERE lower(email) = ?", (email,)).rowcount
    conn.commit()
    # Immer neu schreiben (auch wenn die Zeilen schon weg sind): ein frueherer Versuch kann nach
    # dem Loeschen am pjsip-Reload gescheitert sein - so holt ein zweiter Aufruf ihn nach.
    regenerate_phones_conf(conn)   # schreibt pjsip_phones.conf und laedt pjsip neu
    return {"sip_person": person, "sip_privat": privat, "pjsip_neu": True}


def _loeschen_combox(conn, email, k):
    dateien = set()
    for n in k["nummern"]:
        if os.path.isdir(VM_PERSON_DIR):
            dateien |= {os.path.join(VM_PERSON_DIR, f) for f in os.listdir(VM_PERSON_DIR) if f.startswith(n + "-")}
    for r in conn.execute("SELECT voicemail_path FROM calls WHERE lower(ziel_person) = ? AND voicemail_path IS NOT NULL",
                          (email,)):
        pfad = os.path.realpath(r["voicemail_path"])
        if pfad.startswith(os.path.realpath(VM_PERSON_DIR) + "/"):
            dateien.add(pfad)
    weg = 0
    for f in sorted(dateien):
        if os.path.isfile(f):
            os.remove(f)
            weg += 1
    eintraege = conn.execute(
        "UPDATE calls SET voicemail_path = NULL, voicemail_transcript = NULL, voicemail_summary = NULL "
        "WHERE lower(ziel_person) = ? AND (voicemail_path IS NOT NULL OR voicemail_transcript IS NOT NULL "
        "OR voicemail_summary IS NOT NULL)", (email,)).rowcount
    conn.commit()
    return {"dateien": weg, "eintraege": eintraege}


def _loeschen_nummern(conn, email, k):
    n = conn.execute("DELETE FROM personen_nummern WHERE lower(email) = ?", (email,)).rowcount
    conn.commit()
    gemeldet = None
    # Scheitert die Meldung, holt sie der stuendliche Personen-Abgleich nach (meldet die ganze Liste)
    if n:
        # Website: PUT /api/pbx/personen/nummern ersetzt das ganze Abbild -> die Nummer ist dort weg
        gemeldet = personen_nummern_melden(conn)
        if not gemeldet:
            raise RuntimeError(f"{n} Nummer(n) freigegeben, Meldung an die Website fehlgeschlagen")
    return {"nummern": k["nummern"], "website": gemeldet}


def _loeschen_daten(conn, email, k):
    d = {t: conn.execute(f"DELETE FROM {t} WHERE lower(email) = ?", (email,)).rowcount
         for t in PERSON_LOESCHEN_TABELLEN}
    d["hintergrund"] = bool(conn.execute("SELECT 1 FROM telefon_hintergrund WHERE lower(email) = ?",
                                         (email,)).fetchone()) or os.path.isfile(_hintergrund_datei(email))
    _hintergrund_loeschen(conn, email)
    conn.commit()
    return d


def _loeschen_calls(conn, email, k):
    n = conn.execute("UPDATE calls SET person = ? WHERE lower(person) = ?", (GELOESCHT, email)).rowcount
    n += conn.execute("UPDATE calls SET ziel_person = ? WHERE lower(ziel_person) = ?", (GELOESCHT, email)).rowcount
    for nr in k["nummern"]:
        for sp in ("caller_id", "dialed", "ext", "ziel_ext"):
            n += conn.execute(f"UPDATE calls SET {sp} = ? WHERE {sp} = ? OR {sp} LIKE ? OR {sp} LIKE ?",
                              (GELOESCHT, nr, nr + "-%", "%<" + nr + ">%")).rowcount
    conn.commit()
    return {"felder": n}


def _loeschen_log(conn, email, k):
    n = conn.execute("UPDATE telefon_log SET email = ?, name = ? WHERE lower(email) = ?",
                     (GELOESCHT, GELOESCHT, email)).rowcount
    n += conn.execute("UPDATE telefon_log SET durch = ? WHERE lower(durch) = ?", (GELOESCHT, email)).rowcount
    conn.commit()
    return {"zeilen": n}


PERSON_LOESCHEN_SCHRITTE = (
    ("sitzungen", _loeschen_sitzungen),     # abmelden (_telefon_abmelden)
    ("nextcloud", _loeschen_nextcloud),     # App-Passwoerter widerrufen (nc-token /widerrufen)
    ("nextcloud_konto", _loeschen_nextcloud_konto),  # Nextcloud-Konto loeschen (nc-token /konto-loeschen)
    ("sip", _loeschen_sip),                 # SIP-Zugaenge weg, pjsip_phones.conf neu + reload
    ("combox", _loeschen_combox),           # persoenliche Sprachnachrichten (VM_PERSON_DIR)
    ("nummern", _loeschen_nummern),         # Nummer freigeben, Website melden
    ("daten", _loeschen_daten),             # Einstellungen, PIN, Anmelde-QR, Hintergrund
    ("anrufe", _loeschen_calls),            # anonymisieren
    ("protokoll", _loeschen_log),           # anonymisieren
)
# Ohne Angabe von schritte (aeltere Haupt-API): wie bisher, ohne das Nextcloud-Konto. Die
# Haupt-API verlangt nextcloud_konto nur, wenn kein anderes Konto mit der Adresse besteht.
PERSON_LOESCHEN_STANDARD = tuple(n for n, _ in PERSON_LOESCHEN_SCHRITTE if n != "nextcloud_konto")


@app.post("/api/pbx/person/loeschen")
def pbx_person_loeschen():
    """Haupt-API (X-PBX-Secret) nach dem Loeschen eines Kontos (Loeschungen, processAuthentiKDeletions
    -> lokalesKontoNachLoeschung): alles Persoenliche der Person auf der Anlage, ueber die
    bestehenden Ablaeufe (siehe PERSON_LOESCHEN_SCHRITTE). {email, schritte?, nummern?} ->
    {ok (alle Schritte ok), hintergrund, nummern, schritte: {name: {ok, ..., fehler?}}}
    schritte: nur diese (Wiederholung durch den Nachlauf der Haupt-API); nummern: Nummern
    aus einem frueheren Versuch (dann schon freigegeben, Anrufe trotzdem anonymisieren)."""
    err = require_agi()
    if err:
        return err
    body = request.get_json(silent=True) or {}
    email = str(body.get("email") or "").strip().lower()
    if not email or "@" not in email or len(email) > 320:
        return jsonify({"error": "email fehlt"}), 400
    namen = {n for n, _ in PERSON_LOESCHEN_SCHRITTE}
    verlangt = body.get("schritte")
    if verlangt is None:
        verlangt = PERSON_LOESCHEN_STANDARD
    elif not isinstance(verlangt, list) or not verlangt or any(not isinstance(s, str) or s not in namen for s in verlangt):
        return jsonify({"error": "schritte ungueltig"}), 400
    frueher = [str(n) for n in (body.get("nummern") or []) if re.fullmatch(r"\d{2,15}", str(n))] \
        if isinstance(body.get("nummern"), list) else []
    conn = db.connect()
    try:
        k = {"nummern": sorted({r["nummer"] for r in conn.execute(
            "SELECT nummer FROM personen_nummern WHERE lower(email) = ? ORDER BY nummer", (email,))} | set(frueher))}
        schritte = {}
        for name, schritt in PERSON_LOESCHEN_SCHRITTE:
            if name not in verlangt:
                continue
            try:
                schritte[name] = {"ok": True, **schritt(conn, email, k)}
            except Exception as e:  # noqa: BLE001 - weiter mit dem Rest, Schritt einzeln melden
                conn.rollback()
                app.logger.warning("Konto-Loeschung, Schritt %s: %s %s", name, type(e).__name__, e)
                schritte[name] = {"ok": False, "fehler": f"{type(e).__name__}: {e}"[:300]}
    finally:
        conn.close()
    app.logger.info("Konto geloescht: Anlage %s",
                    {n: ("ok" if s["ok"] else "FEHLER") for n, s in schritte.items()})
    return jsonify({"ok": all(s["ok"] for s in schritte.values()),
                    "hintergrund": bool(schritte.get("daten", {}).get("hintergrund")),
                    "nummern": k["nummern"], "schritte": schritte,
                    "reihenfolge": [n for n, _ in PERSON_LOESCHEN_SCHRITTE if n in verlangt]})


@app.delete("/api/telefon/ich/hintergrund")
def telefon_ich_hintergrund_loeschen():
    """Mein Telefon: eigenen Hintergrund der geteilten Telefone zuruecksetzen (Standard).
    Ein angemeldetes Telefon uebernimmt das mit dem naechsten Status (bis 30 s)."""
    user = current_user()
    if not user:
        return jsonify({"error": "Nicht angemeldet"}), 401
    email = (user.get("email") or "").lower()
    if not email:
        return jsonify({"error": "Konto ohne E-Mail"}), 400
    conn = db.connect()
    try:
        _hintergrund_loeschen(conn, email)
        conn.commit()
        return jsonify({"ok": True})
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
        if not probe:
            personen_nummern_melden(conn)
        return {"neu": neu, "probleme": probleme, "probe": probe}
    finally:
        conn.close()


def personen_nummern_melden(conn):
    """Vergebene Nummern an die Website (Stefan 27.11.2026): Telefonbuch und
    Nextcloud-Sync zeigen statt der echten Nummern nur noch 3HHWWP. Nur Nummer,
    E-Mail, Name, Wohnung, Haus, aktiv — keine Weiterleitungsziele."""
    rows = db.rows_to_dicts(conn.execute(
        "SELECT nummer, email, name, wohnung, haus, aktiv FROM personen_nummern ORDER BY nummer").fetchall())
    if not rows:
        return False
    try:
        r = requests.put(f"{MAIN_API_BASE}/api/pbx/personen/nummern", json={"nummern": rows},
                         headers={"X-PBX-Secret": PBX_SHARED_SECRET}, timeout=20)
        if not r.ok:
            app.logger.warning("Nummern an die Website: HTTP %s", r.status_code)
        return bool(r.ok)
    except requests.RequestException as e:
        app.logger.warning("Nummern an die Website: %s", type(e).__name__)
        return False


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
        try:
            telefon_geraetelog_aufraeumen()
        except Exception as e:
            app.logger.warning("Telefon-Protokoll aufraeumen: %s", e)
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


# Je Nebenstelle nur ein Ausstellen bzw. Widerrufen gleichzeitig (XCover 2101, 27.11.2026): nach
# der Anmeldung fragen mehrere Apps gleichzeitig ueber Rosenweg Geraet nach dem Zugang. Ohne Sperre
# stellte jede Anfrage ein eigenes App-Passwort aus, und nc-token loescht dabei die vorherigen
# gleichen Namens - das Telefon behielt ein schon geloeschtes (401, dann 429 Brute-Force-Sperre).
_NC_SPERREN = {}
_NC_SPERREN_LOCK = threading.Lock()


def _nc_sperre(ext):
    with _NC_SPERREN_LOCK:
        return _NC_SPERREN.setdefault(ext, threading.Lock())


def _nextcloud_widerruf_senden(email, ext):
    """App-Passwort "Rosenweg Geraet <ext>" der Person bei nc-token widerrufen. -> True wenn ok."""
    try:
        r = requests.post(f"{NC_TOKEN_URL}/widerrufen", json={"email": email, "name": _nc_name(ext)},
                          headers={"X-NC-Token-Secret": NC_TOKEN_SECRET}, timeout=60)
        if not r.ok:
            app.logger.warning("Nextcloud-Widerruf %s: HTTP %s", ext, r.status_code)
        return bool(r.ok)
    except Exception as e:  # noqa: BLE001
        app.logger.warning("Nextcloud-Widerruf %s: %s", ext, type(e).__name__)
        return False


def _nextcloud_widerrufen(conn, ext, sofort=False):
    """App-Passwort der Person auf diesem Geraet loeschen (beim Abmelden). Im Hintergrund, unter
    der Sperre der Nebenstelle (sonst koennte es ein gerade neu ausgestelltes treffen);
    sofort=True: gleich hier (der Aufrufer haelt die Sperre schon)."""
    r = conn.execute("SELECT email FROM telefon_nextcloud WHERE ext = ?", (ext,)).fetchone()
    if not r:
        return
    conn.execute("DELETE FROM telefon_nextcloud WHERE ext = ?", (ext,))
    email = r["email"]

    def widerruf():
        _nextcloud_widerruf_senden(email, ext)

    def los():
        with _nc_sperre(ext):
            widerruf()
    if not NC_TOKEN_URL:
        return
    if sofort:
        widerruf()
    else:
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
    with _nc_sperre(ext):   # parallele Anfragen warten und bekommen dann das gespeicherte
        return _telefon_nextcloud_holen(ext, f)


def _telefon_nextcloud_holen(ext, f):
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
        if r:   # andere Person: altes Passwort weg, vor dem neuen (gleicher Name)
            _nextcloud_widerrufen(conn, ext, sofort=True)
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


# ─── Portal-Anfragen der Rosenweg-Apps auf geteilten Telefonen ───────────────
# Auf einem geteilten Telefon meldet sich keine App selbst an (rosenweg-basis,
# docs/geteilte-telefone.md). Die App ruft Rosenweg Geraet (AnlageProvider
# "portal_anfrage"), Geraet ruft hier mit seinem Geraetezugang, und diese API stellt
# die Anfrage an die Haupt-API — im Namen der Person, die gerade am Telefon
# angemeldet ist. Dafuer stellt sie ein Token fuer GENAU diese eine Anfrage aus
# (HS256, PORTAL_ANLAGE_SECRET, 60 s, einmal; Haupt-API: api/lib/anlagetoken.js).
# Kein Token verlaesst CT 220: weder Geraet noch die App bekommt eines.
#
# Welche Pfade eine App so erreichen darf: auf geteilten Telefonen gelten dieselben
# Funktionen wie am eigenen Geraet (Karte, QR und Handy sind wie ein Schluessel,
# Entscheid Stefan 28.11.2026). Jede Rosenweg-App (gleiche Signatur, Paket
# ch.rosenweg4303.*) erreicht darum alles unter /api/; was die Person darf, sagt die
# Haupt-API wie sonst. Gesperrt bleibt nur, was einen Ausweis aendert oder erzeugt
# (PORTAL_GESPERRT, gleich wie PAT_GESPERRT in api/middleware/auth.js: Passwort,
# Passkeys, Zugangstoken, MQTT-Zugang, OAuth/Profil-Login) — mit den Ausnahmen in
# PORTAL_AUSNAHMEN. Die Config "portal_pfade" (JSON {paket: [eintrag, ...], "*": [...]})
# kann die Standardliste ersetzen; PORTAL_GESPERRT gilt immer. Eintrag:
#   "/api/salz/"          alles darunter, alle Methoden
#   "/api/auth/me"        genau dieser Pfad, alle Methoden
#   "GET /api/me"         nur mit diesen Methoden (mehrere: "GET,PUT /api/me")
# Jede Anfrage der Haupt-API traegt Telefon und Person (Anlage-Token: ext, paket, email).
PORTAL_ANLAGE_SECRET = os.environ.get("PORTAL_ANLAGE_SECRET", "")
PORTAL_TOKEN_S = 60
PORTAL_KOERPER_MAX = 256 * 1024
# Binder: die Antwort geht als Bundle an die App (Transaktionen bis ~1 MB)
PORTAL_ANTWORT_MAX = 512 * 1024
PORTAL_METHODEN = ("GET", "POST", "PUT", "DELETE")
# Dateien (PDF, Bilder) stueckweise: die App haengt "portal_bereich=<von>-<bis>"
# an den Pfad. Die Anlage nimmt ihn weg, fragt die Haupt-API mit "Range:
# bytes=<von>-<bis>" und gibt das Stueck als JSON zurueck:
#   {"binaer": {"typ", "daten" (base64), "von", "bis", "gesamt", "etag"}}
# So bleibt der Weg ueber Rosenweg Geraet reiner JSON-Text (Binder ~1 MB).
# Ein Stueck hoechstens 320 KB (base64 ~430 KB < PORTAL_ANTWORT_MAX), eine
# Datei hoechstens 64 MB (200 Stuecke; Geraet erlaubt 300 Anfragen je Minute).
# Hochladen geht ebenso in Stuecken (portal_hochladen, siehe _portal_teil).
PORTAL_BINAER_TEIL = 320 * 1024
PORTAL_BINAER_MAX = 64 * 1024 * 1024
_PORTAL_BEREICH = re.compile(r"(^|&)portal_bereich=(\d{1,9})-(\d{1,9})(?=&|$)")
PORTAL_PFADE_STANDARD = {"*": ["/api/"]}
# Nie ueber das Telefon (relativ zu /api/, Segmentgrenze, wie PAT_GESPERRT der Haupt-API)
PORTAL_GESPERRT = ("change-password", "me/tokens", "me/passkeys", "auth", "mqtt/my-app-passwords",
                   "mqtt/user-app-passwords")
# Ausnahmen davon (Methode, Pfad ohne /api/): wer bin ich
PORTAL_AUSNAHMEN = (("GET", "auth/me"),)
_PORTAL_PFAD = re.compile(r"/api/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,1000}(\?[A-Za-z0-9._~!$&'()*+,;=:@%/?-]{0,1000})?")
_PORTAL_KODIERT_VERBOTEN = re.compile(r"%(2e|2f|5c|00)", re.I)


def _portal_pfad_ok(pfad):
    """Nur /api/..., keine Punkt-Segmente, keine kodierten / . \\ oder NUL, kein //."""
    if not isinstance(pfad, str) or not _PORTAL_PFAD.fullmatch(pfad):
        return False
    weg = pfad.split("?", 1)[0]
    if "//" in weg or _PORTAL_KODIERT_VERBOTEN.search(pfad):
        return False
    return not any(teil in (".", "..") for teil in weg.split("/"))


def _portal_regeln(conn):
    roh = _cfg(conn).get("portal_pfade", "")
    if roh:
        try:
            r = json.loads(roh)
            if isinstance(r, dict):
                return r
        except ValueError:
            app.logger.warning("portal_pfade ist kein JSON — Standard gilt")
    return PORTAL_PFADE_STANDARD


def _portal_gesperrt(methode, pfad):
    """Pfad aendert einen Ausweis (Passwort, Token, Passkeys …)? Dann nie ueber das Telefon."""
    weg = _portal_pfad_normal(urllib.parse.unquote(pfad.split("?", 1)[0]))
    if (methode, weg) in PORTAL_AUSNAHMEN:
        return False
    return any(weg == g or weg.startswith(g + "/") for g in PORTAL_GESPERRT)


def _portal_erlaubt(regeln, paket, methode, pfad):
    if _portal_gesperrt(methode, pfad):
        return False
    weg = pfad.split("?", 1)[0].lower()
    for eintrag in list(regeln.get("*") or []) + list(regeln.get(paket) or []):
        teile = str(eintrag).strip().split(None, 1)
        methoden, muster = (teile[0].upper().split(","), teile[1]) if len(teile) == 2 else (None, teile[0])
        muster = muster.lower()
        if methoden and methode not in methoden:
            continue
        if (muster.endswith("/") and weg.startswith(muster)) or weg == muster:
            return True
    return False


def _portal_bereich(pfad):
    """portal_bereich=<von>-<bis> aus dem Pfad: (pfad ohne ihn, (von, bis)) oder (pfad, None).
    Ungueltig (bis < von, zu gross) -> (pfad, False)."""
    if "?" not in pfad:
        return pfad, None
    weg, frage = pfad.split("?", 1)
    m = _PORTAL_BEREICH.search(frage)
    if not m:
        return pfad, None
    von, bis = int(m.group(2)), int(m.group(3))
    if bis < von or bis - von + 1 > PORTAL_BINAER_TEIL or bis >= PORTAL_BINAER_MAX:
        return pfad, False
    rest = (frage[:m.start()] + frage[m.end():]).strip("&")
    rest = re.sub(r"&{2,}", "&", rest)
    return (f"{weg}?{rest}" if rest else weg), (von, bis)


def _portal_pfad_normal(pfad):
    """Wie authMiddleware der Haupt-API: ohne /api/, klein, ohne // und End-Schraegstriche."""
    p = re.sub(r"/{2,}", "/", pfad.split("?", 1)[0].lower())
    p = re.sub(r"^/api/", "", p)
    return p.strip("/")


def _portal_token(sitzung, ext, paket, methode, pfad, jetzt=None):
    jetzt = int(jetzt if jetzt is not None else time.time())
    kopf = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    inhalt = _b64url(json.dumps({
        "iss": "rosenweg-anlage", "aud": "rosenweg-portal", "sub": str(sitzung["user_id"] or ""),
        "email": sitzung["email"], "ext": ext, "paket": paket, "methode": methode,
        "pfad": _portal_pfad_normal(pfad), "iat": jetzt, "exp": jetzt + PORTAL_TOKEN_S,
        "jti": pysecrets.token_hex(16),
    }, separators=(",", ":"), ensure_ascii=False).encode())
    sig = _b64url(hmac.new(PORTAL_ANLAGE_SECRET.encode(), f"{kopf}.{inhalt}".encode(), hashlib.sha256).digest())
    return f"{kopf}.{inhalt}.{sig}"


def _portal_sitzung_marke(ext, sitzung):
    """Wechselt mit jeder An-/Abmeldung; die Apps laden neu, wenn sie sich aendert."""
    return hashlib.sha256(f"{ext}|{sitzung['email']}|{sitzung['seit']}".encode()).hexdigest()[:16]


# ─── Hochladen in Stuecken (Entscheid Stefan 28.11.2026, 64 MB) ──────────────
# Rosenweg Geraet reicht nur JSON-Text bis 256 KB weiter. Eine Datei geht darum in
# Stuecken zu hoechstens PORTAL_HOCH_TEIL Bytes: je Stueck eine Portal-Anfrage mit
#   teil: {id (16-32 Hex), nr (ab 0, lueckenlos), anzahl, gesamt (Bytes),
#          kopf (nur nr 0): {name, typ, multipart, feld, felder, inhaltstyp, kopf}}
#   koerper: das Stueck als base64
# Methode und Pfad sind die der echten Anfrage (POST/PUT /api/documents/...). Die Anlage
# legt die Stuecke ab (eine Datei je Telefon), prueft Person und Reihenfolge, und
# schickt beim letzten Stueck EINE Anfrage an die Haupt-API (Anlage-Token fuer genau
# diese Methode + diesen Pfad). Zwischenantwort: 202 {"teil": nr}; die letzte Antwort
# ist die der Haupt-API. Wechselt die Person, ist der Upload hinfaellig (409).
PORTAL_HOCH_TEIL = 180 * 1024
PORTAL_HOCH_TEILE_MAX = 700
PORTAL_HOCH_FRIST_S = 15 * 60
PORTAL_HOCH_KOPF_ERLAUBT = ("if-match", "if-none-match")
_PORTAL_HOCH_ID = re.compile(r"[0-9a-f]{16,32}")
_PORTAL_HOCH_LOCK = threading.Lock()


def _portal_hoch_dir():
    return os.environ.get("PORTAL_HOCH_DIR") or os.path.join(tempfile.gettempdir(), "pbx-portal-hoch")


def _portal_hoch_aufraeumen(wurzel, ext, ausser=None):
    """Alte Uploads (Frist) und andere Uploads desselben Telefons entfernen."""
    jetzt = time.time()
    try:
        for n in os.listdir(wurzel):
            d = os.path.join(wurzel, n)
            if d == ausser:
                continue
            alt = jetzt - os.path.getmtime(d) > PORTAL_HOCH_FRIST_S
            if alt or n.startswith(f"{ext}-"):
                shutil.rmtree(d, ignore_errors=True)
    except OSError:
        pass


def _portal_teil(ext, s, paket, methode, pfad, koerper, teil):
    if methode not in ("POST", "PUT"):
        return jsonify({"error": "Hochladen nur mit POST oder PUT"}), 400
    if not isinstance(teil, dict):
        return jsonify({"error": "teil ungueltig"}), 400
    tid, nr, anzahl, gesamt = teil.get("id"), teil.get("nr"), teil.get("anzahl"), teil.get("gesamt")
    if not (isinstance(tid, str) and _PORTAL_HOCH_ID.fullmatch(tid)
            and all(isinstance(x, int) and not isinstance(x, bool) for x in (nr, anzahl, gesamt))):
        return jsonify({"error": "teil ungueltig"}), 400
    if not (1 <= anzahl <= PORTAL_HOCH_TEILE_MAX and 0 <= nr < anzahl and 1 <= gesamt <= PORTAL_BINAER_MAX):
        return jsonify({"error": "teil ungueltig"}), 400
    if gesamt > anzahl * PORTAL_HOCH_TEIL or gesamt <= (anzahl - 1) * 1:
        return jsonify({"error": "teil ungueltig"}), 400
    try:
        daten = base64.b64decode(koerper or "", validate=True)
    except (binascii.Error, ValueError, TypeError):
        return jsonify({"error": "Stueck ungueltig"}), 400
    if not daten or len(daten) > PORTAL_HOCH_TEIL:
        return jsonify({"error": f"Stueck leer oder zu gross (hoechstens {PORTAL_HOCH_TEIL // 1024} KB)"}), 413
    marke = _portal_sitzung_marke(ext, s)
    wurzel = _portal_hoch_dir()
    ordner = os.path.join(wurzel, f"{ext}-{tid}")
    email = (s["email"] or "").lower()
    with _PORTAL_HOCH_LOCK:
        os.makedirs(wurzel, exist_ok=True)
        meta_pfad = os.path.join(ordner, "meta.json")
        if nr == 0:
            kopf = teil.get("kopf")
            if not isinstance(kopf, dict):
                return jsonify({"error": "kopf fehlt"}), 400
            _portal_hoch_aufraeumen(wurzel, ext)
            os.makedirs(ordner, exist_ok=True)
            with open(meta_pfad, "w", encoding="utf-8") as f:
                json.dump({"pfad": pfad, "methode": methode, "paket": paket, "email": email, "anzahl": anzahl,
                           "gesamt": gesamt, "kopf": kopf, "naechstes": 0, "bytes": 0}, f)
        try:
            with open(meta_pfad, encoding="utf-8") as f:
                meta = json.load(f)
        except (OSError, ValueError):
            return jsonify({"error": "Upload unbekannt oder abgelaufen", "upload_vorbei": True}), 410
        if meta["email"] != email:
            shutil.rmtree(ordner, ignore_errors=True)
            return jsonify({"error": "Niemand angemeldet", "nicht_angemeldet": True}), 409
        if (meta["pfad"], meta["methode"], meta["paket"], meta["anzahl"], meta["gesamt"]) != (pfad, methode, paket, anzahl, gesamt):
            shutil.rmtree(ordner, ignore_errors=True)
            return jsonify({"error": "Stueck passt nicht zum Upload"}), 400
        if nr != meta["naechstes"]:
            shutil.rmtree(ordner, ignore_errors=True)
            return jsonify({"error": "Stueck in falscher Reihenfolge"}), 400
        if meta["bytes"] + len(daten) > gesamt or (nr < anzahl - 1 and len(daten) == 0):
            shutil.rmtree(ordner, ignore_errors=True)
            return jsonify({"error": "Stuecke groesser als angekuendigt"}), 400
        with open(os.path.join(ordner, f"teil-{nr:05d}"), "wb") as f:
            f.write(daten)
        meta["naechstes"] = nr + 1
        meta["bytes"] += len(daten)
        with open(meta_pfad, "w", encoding="utf-8") as f:
            json.dump(meta, f)
        if nr < anzahl - 1:
            return jsonify({"status": 202, "json": json.dumps({"teil": nr}), "sitzung": marke})
        if meta["bytes"] != gesamt:
            shutil.rmtree(ordner, ignore_errors=True)
            return jsonify({"error": "Groesse stimmt nicht"}), 400
        try:
            teile = []
            for i in range(anzahl):
                with open(os.path.join(ordner, f"teil-{i:05d}"), "rb") as f:
                    teile.append(f.read())
            ganz = b"".join(teile)
        except OSError:
            shutil.rmtree(ordner, ignore_errors=True)
            return jsonify({"error": "Upload unvollstaendig", "upload_vorbei": True}), 410
        kopf = meta["kopf"]
        shutil.rmtree(ordner, ignore_errors=True)

    name = str(kopf.get("name") or "datei")[:300]
    typ = str(kopf.get("typ") or "application/octet-stream")[:100]
    kopfzeilen = {"Authorization": f"Bearer {_portal_token(s, ext, paket, methode, pfad)}",
                  "Accept": "application/json", "X-Rosenweg-Telefon": ext}
    extra = kopf.get("kopf") if isinstance(kopf.get("kopf"), dict) else {}
    for k, v in extra.items():
        if str(k).lower() in PORTAL_HOCH_KOPF_ERLAUBT and isinstance(v, str) and len(v) < 300:
            kopfzeilen[str(k)] = v
    try:
        if kopf.get("multipart"):
            felder = {str(k): str(v) for k, v in (kopf.get("felder") or {}).items()} if isinstance(kopf.get("felder"), dict) else {}
            r = requests.request(methode, f"{MAIN_API_BASE}{pfad}", headers=kopfzeilen, data=felder,
                                 files={str(kopf.get("feld") or "datei"): (name, ganz, typ)},
                                 timeout=300, allow_redirects=False, stream=True)
        else:
            kopfzeilen["Content-Type"] = str(kopf.get("inhaltstyp") or typ)[:100]
            kopfzeilen["X-Filename"] = str(kopf.get("x_filename") or urllib.parse.quote(name))[:600]
            r = requests.request(methode, f"{MAIN_API_BASE}{pfad}", headers=kopfzeilen, data=ganz,
                                 timeout=300, allow_redirects=False, stream=True)
        try:
            roh = r.raw.read(PORTAL_ANTWORT_MAX + 1, decode_content=True)
        finally:
            r.close()
    except requests.RequestException as e:
        app.logger.warning("portal %s: Upload, Haupt-API nicht erreichbar (%s)", ext, type(e).__name__)
        return jsonify({"error": "Keine Verbindung zum Portal"}), 502
    app.logger.info("portal %s %s %s %s -> %s (Upload %d Bytes)", ext, paket, methode, pfad.split("?", 1)[0],
                    r.status_code, len(ganz))
    if len(roh) > PORTAL_ANTWORT_MAX:
        return jsonify({"error": "Antwort zu gross fuer das Telefon"}), 502
    return jsonify({"status": r.status_code, "json": roh.decode("utf-8", "replace"), "sitzung": marke})


@app.post("/api/telefon/portal")
def telefon_portal():
    """Rosenweg Geraet: {methode, pfad, koerper (JSON-Text|null), paket} -> {status, json, sitzung}.
    409 nicht_angemeldet: niemand am Telefon. 403: Pfad fuer diese App nicht freigegeben."""
    ext, deny = _geraet()
    if deny:
        return deny
    if not PORTAL_ANLAGE_SECRET:
        return jsonify({"error": "Portal-Zugang der Telefone nicht eingerichtet"}), 503
    b = request.get_json(silent=True) or {}
    methode = str(b.get("methode") or "GET").upper()
    pfad = b.get("pfad")
    paket = str(b.get("paket") or "")
    koerper = b.get("koerper")
    if methode not in PORTAL_METHODEN:
        return jsonify({"error": "Methode nicht erlaubt"}), 400
    if not _portal_pfad_ok(pfad):
        return jsonify({"error": "Pfad ungueltig"}), 400
    if not _PAKET.fullmatch(paket) or paket.startswith("web."):
        return jsonify({"error": "paket ungueltig"}), 400
    if koerper is not None and (not isinstance(koerper, str) or len(koerper.encode()) > PORTAL_KOERPER_MAX):
        return jsonify({"error": "Anfrage zu gross"}), 413
    pfad, bereich = _portal_bereich(pfad)
    if bereich is False:
        return jsonify({"error": f"Bereich ungueltig (je Stueck hoechstens {PORTAL_BINAER_TEIL // 1024} KB, "
                                 f"je Datei hoechstens {PORTAL_BINAER_MAX // (1024 * 1024)} MB)"}), 413
    conn = db.connect()
    try:
        s = conn.execute("SELECT user_id, email, name, seit FROM telefon_sitzungen WHERE ext = ?", (ext,)).fetchone()
        regeln = _portal_regeln(conn)
    finally:
        conn.close()
    if not s or not s["email"]:
        return jsonify({"error": "Niemand angemeldet", "nicht_angemeldet": True}), 409
    if not _portal_erlaubt(regeln, paket, methode, pfad):
        app.logger.info("portal %s %s %s %s: nicht freigegeben", ext, paket, methode, pfad.split("?", 1)[0])
        return jsonify({"error": "Diese App darf das auf geteilten Telefonen nicht", "nicht_freigegeben": True}), 403
    if b.get("teil") is not None:
        return _portal_teil(ext, s, paket, methode, pfad, koerper, b.get("teil"))
    kopf = {"Authorization": f"Bearer {_portal_token(s, ext, paket, methode, pfad)}",
            "Accept": "application/json", "X-Rosenweg-Telefon": ext}
    if koerper is not None:
        kopf["Content-Type"] = "application/json"
    if bereich:
        kopf["Range"] = f"bytes={bereich[0]}-{bereich[1]}"
        kopf["Accept"] = "*/*"
    grenze = PORTAL_BINAER_TEIL if bereich else PORTAL_ANTWORT_MAX
    try:
        r = requests.request(methode, f"{MAIN_API_BASE}{pfad}", headers=kopf,
                             data=koerper.encode() if koerper is not None else None,
                             timeout=60 if bereich else 20, allow_redirects=False, stream=True)
        try:
            roh = r.raw.read(grenze + 1, decode_content=True)
        finally:
            r.close()
    except requests.RequestException as e:
        app.logger.warning("portal %s: Haupt-API nicht erreichbar (%s)", ext, type(e).__name__)
        return jsonify({"error": "Keine Verbindung zum Portal"}), 502
    if bereich and r.status_code in (200, 206) and "json" not in (r.headers.get("Content-Type") or ""):
        # Stueck einer Datei: 206 mit Content-Range; 200 = der Server kennt Range nicht
        # (dann muss die ganze Datei in ein Stueck passen)
        if len(roh) > grenze:
            return jsonify({"error": "Antwort zu gross fuer das Telefon", "zu_gross": True}), 502
        gesamt = len(roh)
        m = re.match(r"bytes (\d+)-(\d+)/(\d+)", r.headers.get("Content-Range") or "")
        if r.status_code == 206 and m:
            gesamt = int(m.group(3))
        if gesamt > PORTAL_BINAER_MAX:
            return jsonify({"error": f"Datei zu gross fuer das Telefon (hoechstens {PORTAL_BINAER_MAX // (1024 * 1024)} MB)",
                            "zu_gross": True}), 413
        von = int(m.group(1)) if (r.status_code == 206 and m) else 0
        teil = {"typ": (r.headers.get("Content-Type") or "application/octet-stream").split(";")[0].strip(),
                "daten": base64.b64encode(roh).decode(), "von": von, "bis": von + len(roh) - 1,
                "gesamt": gesamt, "etag": r.headers.get("ETag") or "",
                "name": r.headers.get("Content-Disposition") or ""}
        return jsonify({"status": r.status_code, "json": json.dumps({"binaer": teil}, separators=(",", ":")),
                        "sitzung": _portal_sitzung_marke(ext, s)})
    if len(roh) > PORTAL_ANTWORT_MAX:
        return jsonify({"error": "Antwort zu gross fuer das Telefon"}), 502
    if methode != "GET" or r.status_code >= 400:
        app.logger.info("portal %s %s %s %s -> %s", ext, paket, methode, pfad.split("?", 1)[0], r.status_code)
    return jsonify({"status": r.status_code, "json": roh.decode("utf-8", "replace"),
                    "sitzung": _portal_sitzung_marke(ext, s)})


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
        # geraet_gruppe: dasselbe Handy wie Messenger/Karten-Apps (Gruppenschluessel je Person, s. _geraet_gruppe)
        privat = [{"id": r["id"], "kennung": f"{r['nummer']}-p{r['id']}", "geraet": r["geraet"], "seit": r["created_at"],
                   "geraet_gruppe": _geraet_gruppe(email, r["geraet_kennung"]),
                   "registriert": f"{r['nummer']}-p{r['id']}" in regs}
                  for r in conn.execute("SELECT id, nummer, geraet, geraet_kennung, created_at FROM telefon_sip_privat "
                                        "WHERE lower(email) = ? OR (? <> '' AND nummer = ?) ORDER BY id",
                                        (email, nummer, nummer))]
        return jsonify({"name": user.get("name"), "darf": _telefon_darf(conn, user),
                        "sitzungen": db.rows_to_dicts(rows), "privat": privat})
    finally:
        conn.close()


# ─── "Mein Telefon" (docs/plans/telefon-benutzerfuehrung.md, Schritt 1) ─────────────
# Alles zur eigenen persoenlichen Nummer in einer Antwort, und die Erreichbarkeit
# (Weiterleitung, Voicemail) selbst einstellen. Bisher stand beides nur in der Datenbank.

def _ziel_normalisieren(z):
    """Zielnummer fuer die Weiterleitung: Leerzeichen/Striche weg, 0041 -> +41."""
    z = re.sub(r"[\s\-/().]", "", str(z or ""))
    if z.startswith("00"):
        z = "+" + z[2:]
    return z


def _erreichbarkeit(p):
    wl = p["weiterleitung"] if p["weiterleitung"] in ("aus", "immer", "nicht_erreichbar") else "aus"
    return {"weiterleitung": wl, "ziel": p["weiterleitung_ziel"] or "",
            "sekunden": max(5, min(int(p["weiterleitung_sekunden"] or 20), 60)),
            "voicemail": bool(p["voicemail"])}


def _gruppen_der_nummer(conn, nummer):
    """In welchen Gruppen/Diensten die Person klingelt (heute: Ring-Group Technik)."""
    r = conn.execute("SELECT bypass_hours, enabled FROM ring_members WHERE kind = 'person' AND phone = ?",
                     (str(nummer),)).fetchone()
    if not r or not r["enabled"]:
        return []
    return [{"nummer": "1000", "name": "Ring-Group Technik",
             "dienste": ["2000 Dienst Technik", "Amtsnummer"],
             "immer": bool(r["bypass_hours"])}]


@app.get("/api/telefon/ich")
def telefon_ich():
    """Mein Telefon: Nummer, Geraete, Erreichbarkeit, Gruppen der angemeldeten Person."""
    user = current_user()
    if not user:
        return jsonify({"error": "Nicht angemeldet"}), 401
    conn = db.connect()
    try:
        email = (user.get("email") or "").lower()
        nummer = str(_nummer_der_person(conn, email, user.get("name")) or "")
        if not nummer:
            return jsonify({"name": user.get("name"), "nummer": None})
        p = conn.execute("SELECT nummer, name, haus, wohnung, weiterleitung, weiterleitung_ziel, "
                         "weiterleitung_sekunden, voicemail FROM personen_nummern WHERE nummer = ?",
                         (nummer,)).fetchone()
        try:
            regs = ami.registered_aors()
        except Exception:  # noqa: BLE001
            regs = set()
        geraete = [{"art": "app", "id": r["id"], "name": r["geraet"] or "Handy", "seit": r["created_at"],
                    "kennung": f"{r['nummer']}-p{r['id']}", "erreichbar": f"{r['nummer']}-p{r['id']}" in regs}
                   for r in conn.execute("SELECT id, nummer, geraet, created_at FROM telefon_sip_privat "
                                         "WHERE nummer = ? ORDER BY id", (nummer,))]
        geraete += [{"art": "geteilt", "ext": r["ext"], "name": r["geraet"], "seit": r["seit"],
                     "erreichbar": str(r["ext"]) in regs}
                    for r in conn.execute("SELECT s.ext, e.name AS geraet, s.seit FROM telefon_sitzungen s "
                                          "JOIN sip_extensions e ON e.ext = s.ext WHERE lower(s.email) = ? "
                                          "ORDER BY s.ext", (email,))]
        letzte = conn.execute("SELECT ereignis, durch, zeit FROM telefon_log WHERE ext = ? AND ereignis LIKE "
                              "'Erreichbarkeit%' ORDER BY id DESC LIMIT 1", (nummer,)).fetchone()
        return jsonify({
            "name": p["name"], "nummer": nummer, "haus": p["haus"], "wohnung": p["wohnung"],
            "erreichbarkeit": _erreichbarkeit(p), "geraete": geraete,
            "gruppen": _gruppen_der_nummer(conn, nummer),
            "zuletzt_geaendert": dict(letzte) if letzte else None,
            "darf": _telefon_darf(conn, user),
            "hintergrund": bool(_hintergrund_version(conn, email)),
        })
    finally:
        conn.close()


def _erreichbarkeit_speichern(conn, nummer, b, durch):
    """Gemeinsam fuer die Person selbst und Technik. Gibt (dict, None) oder (None, fehler)."""
    p = conn.execute("SELECT * FROM personen_nummern WHERE nummer = ?", (nummer,)).fetchone()
    if not p:
        return None, "Nummer unbekannt"
    wl = b.get("weiterleitung", p["weiterleitung"])
    if wl not in ("aus", "immer", "nicht_erreichbar"):
        return None, "Weiterleitung: aus, immer oder nicht_erreichbar"
    ziel = _ziel_normalisieren(b["ziel"]) if "ziel" in b else (p["weiterleitung_ziel"] or "")
    if wl != "aus" and not _ZIEL_RE.match(ziel):
        return None, "Zielnummer ungültig (z.B. 079 123 45 67 oder +49 …)"
    try:
        sek = int(b.get("sekunden", p["weiterleitung_sekunden"] or 20))
    except (TypeError, ValueError):
        return None, "Sekunden: Zahl 5–60"
    sek = max(5, min(sek, 60))
    vm = 1 if b.get("voicemail", bool(p["voicemail"])) else 0
    conn.execute("UPDATE personen_nummern SET weiterleitung = ?, weiterleitung_ziel = ?, "
                 "weiterleitung_sekunden = ?, voicemail = ? WHERE nummer = ?",
                 (wl, ziel or None, sek, vm, nummer))
    text = {"aus": "Weiterleitung aus", "immer": f"Weiterleitung immer an {ziel}",
            "nicht_erreichbar": f"Weiterleitung nach {sek} s an {ziel}"}[wl] + (", Voicemail an" if vm else ", Voicemail aus")
    # Ziel nur gekuerzt ins Protokoll (Telefonnummer = Personendatum)
    text_log = text.replace(ziel, "…" + ziel[-3:]) if ziel else text
    conn.execute("INSERT INTO telefon_log (ext, ereignis, name, durch) VALUES (?,?,?,?)",
                 (nummer, "Erreichbarkeit: " + text_log, p["name"], durch))
    conn.commit()
    return _erreichbarkeit(conn.execute("SELECT * FROM personen_nummern WHERE nummer = ?", (nummer,)).fetchone()), None


@app.put("/api/telefon/ich/erreichbarkeit")
def telefon_ich_erreichbarkeit():
    """Die Person stellt Weiterleitung (aus/immer/nicht_erreichbar, Ziel, Sekunden) und
    Voicemail an/aus fuer ihre persoenliche Nummer ein. Gilt beim naechsten Anruf."""
    user = current_user()
    if not user:
        return jsonify({"error": "Nicht angemeldet"}), 401
    conn = db.connect()
    try:
        nummer = str(_nummer_der_person(conn, (user.get("email") or "").lower(), user.get("name")) or "")
        if not nummer:
            return jsonify({"error": "Du hast keine persönliche Nummer"}), 404
        e, fehler = _erreichbarkeit_speichern(conn, nummer, request.get_json(silent=True) or {}, "selbst")
    finally:
        conn.close()
    if fehler:
        return jsonify({"error": fehler}), 400
    app.logger.info("Erreichbarkeit %s geaendert (selbst)", nummer)
    return jsonify({"ok": True, "erreichbarkeit": e})


@app.put("/api/pbx/personen/<nummer>/erreichbarkeit")
def pbx_person_erreichbarkeit(nummer):
    """Technik/Praesident aendert die Erreichbarkeit einer Person (Entscheid Stefan 25.11.2026),
    protokolliert mit Namen."""
    user, deny = require_admin()
    if deny:
        return deny
    if not re.fullmatch(r"3[0-9]{5}", nummer):
        return jsonify({"error": "Nummer ungültig"}), 400
    conn = db.connect()
    try:
        e, fehler = _erreichbarkeit_speichern(conn, nummer, request.get_json(silent=True) or {}, actor(user))
    finally:
        conn.close()
    if fehler:
        return jsonify({"error": fehler}), 400
    app.logger.info("Erreichbarkeit %s geaendert durch %s", nummer, actor(user))
    return jsonify({"ok": True, "erreichbarkeit": e})


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
        bis = db.wartung_setzen(conn, ext, minuten, actor(user))
        # von Hand geschaltet: der Updater schaltet diese Wartung nicht mehr selbst aus
        conn.execute("UPDATE telefon_updater SET wartung_von_uns = 0 WHERE ext = ?", (ext,))
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


# ─── Installierter Stand und Protokoll der Geraete-App (28.11.2026) ───────────────────────────
# telefon_apps_ist fuellte bisher nur der adb-Updater der Anlage. Ist adb nicht erreichbar (nicht
# zugelassen, Telefon in anderem Netz), blieb die Tabelle fuer das Telefon leer und /smartphones
# zeigte nichts. Darum meldet Rosenweg Geraet den Stand selbst.

LOG_MAX_ZEILEN = 600            # je Sendung
LOG_MAX_TEXT = 1500
LOG_ALTER_TAGE = 14
LOG_MAX_JE_TELEFON = 60000      # Sicherung gegen Fluten
_LOG_STUFEN = set("VDIWEF")


@app.post("/api/telefon/apps-ist")
def telefon_apps_ist():
    """Geraet meldet {apps: {paket: versionCode}} der installierten Rosenweg-Apps (inkl. sich selbst)."""
    ext, deny = _geraet()
    if deny:
        return deny
    b = request.get_json(silent=True)
    apps = b.get("apps") if isinstance(b, dict) else None
    if not isinstance(apps, dict) or not 0 < len(apps) <= STAND_MAX_APPS:
        return jsonify({"error": "apps: {paket: versionCode} (1-60)"}), 400
    zeilen = []
    for paket, code in apps.items():
        if not _APP_PAKET.fullmatch(str(paket)) or not str(paket).startswith("ch.rosenweg4303.") \
                or not isinstance(code, int) or isinstance(code, bool) or not 0 <= code < 2**31:
            return jsonify({"error": f"apps: ungueltig ({str(paket)[:60]})"}), 400
        zeilen.append((ext, paket, code, int(time.time())))
    conn = db.connect()
    try:
        conn.execute("DELETE FROM telefon_apps_ist WHERE ext = ?", (ext,))
        conn.executemany("INSERT INTO telefon_apps_ist (ext, paket, version_code, geprueft) VALUES (?,?,?,?)", zeilen)
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True, "apps": len(zeilen)})


def telefon_geraetelog_aufraeumen(conn=None):
    """Zeilen aelter als 14 Tage weg (stuendlich im Personen-Lauf und bei jedem Empfang)."""
    eigen = conn is None
    conn = conn or db.connect()
    try:
        conn.execute("DELETE FROM telefon_geraetelog WHERE empfangen < ?", (int(time.time()) - LOG_ALTER_TAGE * 86400,))
        conn.commit()
    finally:
        if eigen:
            conn.close()


@app.route("/api/telefon/<ext>/log", methods=["POST", "GET"])
def telefon_geraetelog(ext):
    """POST (Geraet, nur die eigene Nebenstelle): {zeilen: [{t (ms), stufe, tag, text}]}.
    GET (Technik/Praesident): ?stufe=W (mindestens), ?tag=Teil, ?von=&bis= (Unix-s),
    ?limit= (Standard 300, max 2000); neueste zuerst."""
    if not re.fullmatch(r"[0-9]{2,8}", ext):
        return jsonify({"error": "Nebenstelle ungueltig"}), 400
    if request.method == "POST":
        eigene, deny = _geraet()
        if deny:
            return deny
        if eigene != ext:
            return jsonify({"error": "Geraet nicht berechtigt"}), 403
        b = request.get_json(silent=True)
        zeilen = b.get("zeilen") if isinstance(b, dict) else None
        if not isinstance(zeilen, list) or len(zeilen) > LOG_MAX_ZEILEN:
            return jsonify({"error": f"zeilen: Liste bis {LOG_MAX_ZEILEN}"}), 400
        jetzt = int(time.time())
        rows = []
        for z in zeilen:
            if not isinstance(z, dict):
                continue
            t = z.get("t")
            t = int(t) // 1000 if isinstance(t, (int, float)) and not isinstance(t, bool) else jetzt
            t = min(max(t, jetzt - LOG_ALTER_TAGE * 86400), jetzt + 300)
            stufe = str(z.get("stufe") or "I")[:1].upper()
            rows.append((ext, t, stufe if stufe in _LOG_STUFEN else "I", re.sub(r"[^\w ./:+-]", "", str(z.get("tag") or ""))[:60],
                         str(z.get("text") or "")[:LOG_MAX_TEXT], jetzt))
        conn = db.connect()
        try:
            telefon_geraetelog_aufraeumen(conn)
            conn.executemany("INSERT INTO telefon_geraetelog (ext, zeit, stufe, tag, text, empfangen) VALUES (?,?,?,?,?,?)", rows)
            ueber = conn.execute("SELECT COUNT(*) FROM telefon_geraetelog WHERE ext = ?", (ext,)).fetchone()[0] - LOG_MAX_JE_TELEFON
            if ueber > 0:
                conn.execute("DELETE FROM telefon_geraetelog WHERE id IN (SELECT id FROM telefon_geraetelog WHERE ext = ? "
                             "ORDER BY id LIMIT ?)", (ext, ueber))
            conn.commit()
        finally:
            conn.close()
        return jsonify({"ok": True, "zeilen": len(rows)})
    user, deny = require_admin()
    if deny:
        return deny
    reihenfolge = "VDIWEF"
    stufe = str(request.args.get("stufe") or "")[:1].upper()
    where, args = ["ext = ?"], [ext]
    if stufe in _LOG_STUFEN:
        where.append("instr(?, stufe) > 0")
        args.append(reihenfolge[reihenfolge.index(stufe):])
    tag = str(request.args.get("tag") or "")[:60]
    if tag:
        where.append("instr(lower(tag), lower(?)) > 0")
        args.append(tag)
    for name, op in (("von", ">="), ("bis", "<=")):
        v = request.args.get(name)
        if v:
            try:
                args.append(int(v))
            except ValueError:
                return jsonify({"error": f"{name}: Unix-Sekunden"}), 400
            where.append(f"zeit {op} ?")
    try:
        limit = max(1, min(int(request.args.get("limit") or 300), 2000))
    except ValueError:
        return jsonify({"error": "limit: Zahl"}), 400
    conn = db.connect()
    try:
        rows = conn.execute("SELECT zeit, stufe, tag, text FROM telefon_geraetelog WHERE " + " AND ".join(where)
                            + " ORDER BY zeit DESC, id DESC LIMIT ?", args + [limit]).fetchall()
        tage = [r[0] for r in conn.execute("SELECT DISTINCT date(zeit, 'unixepoch') FROM telefon_geraetelog WHERE ext = ? "
                                           "ORDER BY 1 DESC", (ext,))]
    finally:
        conn.close()
    return jsonify({"ext": ext, "tage": tage,
                    "zeilen": [{"zeit": r["zeit"], "stufe": r["stufe"], "tag": r["tag"], "text": r["text"]} for r in rows]})



@app.post("/api/telefon/adb")
def telefon_adb_melden():
    """Rosenweg Geraet meldet Adresse und Port von "Debugging ueber WLAN" ({adresse, port};
    port 0 = aus). Nur fuer die Anzeige "adb connect" auf /smartphones."""
    ext, deny = _geraet()
    if deny:
        return deny
    b = request.get_json(silent=True) or {}
    adresse = str(b.get("adresse") or "")
    try:
        port = int(b.get("port") or 0)
        if adresse:
            ipaddress.IPv4Address(adresse)
    except (TypeError, ValueError):
        return jsonify({"error": "adresse/port ungueltig"}), 400
    if not 0 <= port <= 65535:
        return jsonify({"error": "port ungueltig"}), 400
    conn = db.connect()
    try:
        conn.execute("INSERT INTO telefon_adb (ext, adresse, port, gemeldet) VALUES (?,?,?,?) "
                     "ON CONFLICT(ext) DO UPDATE SET adresse = excluded.adresse, port = excluded.port, "
                     "gemeldet = excluded.gemeldet", (ext, adresse if port else "", port, int(time.time())))
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True})

def _updater_json(conn, ext, u, jetzt):
    """Stand des adb-Updaters fuer eine Nebenstelle (fuer /smartphones)."""
    if not u:
        return {"zugelassen": False, "zulassen_bis": 0, "ergebnis": "", "geprueft": 0, "sofort": False,
                "ausstehend": []}
    return {"zugelassen": bool(u["zugelassen"]),
            "zulassen_bis": int(u["freigabe_bis"]) if int(u["freigabe_bis"] or 0) > jetzt else 0,
            "ergebnis": u["ergebnis"], "geprueft": int(u["geprueft"] or 0), "sofort": bool(u["sofort"]),
            "ausstehend": [{"paket": a["paket"], "name": a["name"], "ist": a["ist"], "soll": a["soll"],
                            "version": a["version_name"]} for a in adb_updater.ausstehend(conn, ext)]}


@app.post("/api/telefon/<ext>/updater")
def telefon_updater(ext):
    """Technik/Praesident: adb-Updater fuer ein geteiltes Telefon.
    {aktion: 'zulassen'}  Updater-Schluessel einmal zulassen (Wartung 15 Min. an, Geraet bestaetigt
                          die Rueckfrage nur fuer den Fingerabdruck des Updaters, 5 Min. lang)
    {aktion: 'jetzt'}     sofort pruefen und - wenn die Regeln es erlauben - einspielen
    {aktion: 'vergessen'} Zulassung/Seriennummer vergessen (Telefon ersetzt oder zurueckgesetzt)"""
    user, deny = require_admin()
    if deny:
        return deny
    if not re.fullmatch(r"[0-9]{2,8}", ext):
        return jsonify({"error": "Nebenstelle ungueltig"}), 400
    aktion = str((request.get_json(silent=True) or {}).get("aktion") or "")
    if aktion not in ("zulassen", "jetzt", "vergessen"):
        return jsonify({"error": "aktion: zulassen | jetzt | vergessen"}), 400
    if aktion == "zulassen" and not adb_updater.fingerabdruck():
        return jsonify({"error": "Der Updater hat noch keinen adb-Schluessel (pbx/DEPLOY-PBX-API.md)"}), 409
    conn = db.connect()
    weck = False
    try:
        if not conn.execute("SELECT 1 FROM sip_extensions WHERE ext = ? AND context = 'geteilt'", (ext,)).fetchone():
            return jsonify({"error": "Kein geteiltes Telefon"}), 404
        adb_updater.zeile(conn, ext)
        if aktion == "zulassen":
            bis = int(time.time()) + adb_updater.FREIGABE_S
            conn.execute("UPDATE telefon_updater SET zugelassen = 0, freigabe_bis = ? WHERE ext = ?", (bis, ext))
            w = conn.execute("SELECT wlan_debug_bis FROM telefon_wartung WHERE ext = ?", (ext,)).fetchone()
            if not w or int(w["wlan_debug_bis"] or 0) < bis:
                db.wartung_setzen(conn, ext, adb_updater.WARTUNG_MIN, actor(user))
                conn.execute("UPDATE telefon_updater SET wartung_von_uns = 1 WHERE ext = ?", (ext,))
                weck = True
        elif aktion == "jetzt":
            conn.execute("UPDATE telefon_updater SET sofort = 1 WHERE ext = ?", (ext,))
        else:
            conn.execute("UPDATE telefon_updater SET zugelassen = 0, freigabe_bis = 0, seriennummer = '' "
                         "WHERE ext = ?", (ext,))
            conn.execute("DELETE FROM telefon_apps_ist WHERE ext = ?", (ext,))
        conn.execute("INSERT INTO telefon_log (ext, ereignis, durch) VALUES (?,?,?)",
                     (ext, f"updater {aktion}", actor(user)))
        conn.commit()
    finally:
        conn.close()
    if weck:
        try:
            ami.originate(f"PJSIP/{ext}", "suchen", "s", callerid='"Wartung" <2098>', timeout_ms=15000)
        except Exception as e:  # noqa: BLE001
            app.logger.warning("Wartung wecken %s: %s", ext, type(e).__name__)
    gestartet = aktion != "vergessen" and adb_updater.anstossen()
    app.logger.info("Updater %s: %s durch %s", ext, aktion, actor(user))
    return jsonify({"ok": True, "gestartet": gestartet})


# ─── Fernwartung ueber den dauerhaften adb-Tunnel (pbx/adb-zentrale) ─────────
# Plan adb-tunnel-telefone (Stefan 27.11.2026): Rosenweg Geraet haelt einen WireGuard-Tunnel zur
# adb-zentrale offen; Technik arbeitet dort per SSH mit rw-adb. Diese API ist die Quelle der
# Peers (telefon_tunnel), schaltet den Not-Aus und fuehrt den Verlauf (telefon_fernwartung).
# Ohne PBX_ADB_ZENTRALE_URL bleibt alles beim Alten: der Status nennt keine Fernwartung.
ADB_ZENTRALE_URL = os.environ.get("PBX_ADB_ZENTRALE_URL", "").rstrip("/")
ADB_ZENTRALE_TOKEN = os.environ.get("PBX_ADB_ZENTRALE_TOKEN", "")
FW_NETZ = ipaddress.ip_network(os.environ.get("PBX_ADB_TUNNEL_NETZ", "10.243.44.0/24"))
_FW_MERK = {"info": (0.0, None), "zustand": (0.0, None)}


def _zentrale(methode, pfad, daten=None, timeout=5):
    """Anfrage an die Steuerung der adb-zentrale (Bearer PBX_ADB_ZENTRALE_TOKEN)."""
    if not ADB_ZENTRALE_URL or len(ADB_ZENTRALE_TOKEN) < 32:
        raise RuntimeError("adb-zentrale nicht eingerichtet")
    r = requests.request(methode, ADB_ZENTRALE_URL + pfad, json=daten, timeout=timeout,
                         headers={"Authorization": f"Bearer {ADB_ZENTRALE_TOKEN}"})
    if r.status_code != 200:
        raise RuntimeError(f"adb-zentrale {pfad.split('?')[0]}: HTTP {r.status_code}")
    return r.json()


def _zentrale_info(neu=False):
    """{public_key, adb_fingerabdruck, gateway, endpoint_extern, endpoint_intern} (60 s gemerkt) oder None."""
    zeit, info = _FW_MERK["info"]
    if not neu and info and time.time() - zeit < 60:
        return info
    try:
        info = _zentrale("GET", "/gesundheit", timeout=3)
        _FW_MERK["info"] = (time.time(), info)
    except Exception as e:  # noqa: BLE001 - Anlage laeuft ohne Zentrale weiter
        if ADB_ZENTRALE_URL:
            app.logger.warning("adb-zentrale: %s", e)
        if time.time() - zeit > 3600:
            info = None   # nach einer Stunde ohne Antwort nichts Altes mehr ausgeben
    return info


def _zentrale_zustand():
    """{ext: {letzter_handshake, sitzung}} (10 s gemerkt), {} wenn nicht erreichbar."""
    zeit, z = _FW_MERK["zustand"]
    if z is not None and time.time() - zeit < 10:
        return z
    try:
        z = {p["ext"]: p for p in _zentrale("GET", "/zustand", timeout=3).get("peers", [])}
    except Exception:  # noqa: BLE001
        z = None
    _FW_MERK["zustand"] = (time.time(), z if z is not None else {})
    return z if z is not None else {}


def _fw_peers(conn):
    return [{"ext": r["ext"], "public_key": r["pubkey"], "ip": r["ip"]} for r in conn.execute(
        "SELECT ext, pubkey, ip FROM telefon_tunnel WHERE bestaetigt = 1 AND aus = 0 ORDER BY ext")]


def _fw_schieben(conn):
    """Die ganze Peer-Liste an die Zentrale (sonst holt sie sie spaetestens in 5 Min.)."""
    try:
        _zentrale("PUT", "/peers", {"peers": _fw_peers(conn)})
        _FW_MERK["zustand"] = (0.0, None)
        return True
    except Exception as e:  # noqa: BLE001
        app.logger.warning("Peers an adb-zentrale: %s", e)
        return False


def _fw_wecken(ext):
    try:
        ami.originate(f"PJSIP/{ext}", "suchen", "s", callerid='"Wartung" <2098>', timeout_ms=15000)
        return True
    except Exception as e:  # noqa: BLE001
        app.logger.warning("Fernwartung wecken %s: %s", ext, type(e).__name__)
        return False


def _fw_schluessel():
    """Fingerabdruecke, die Rosenweg Geraet ausser seinem eigenen zulassen darf: Zentrale, Updater."""
    info = _zentrale_info() or {}
    return [fp for fp in (info.get("adb_fingerabdruck") or "", adb_updater.fingerabdruck()) if fp]


def _fw_status(conn, ext):
    """Feld "fernwartung" im Status des Telefons, None = nicht nennen (Zentrale nicht eingerichtet)."""
    if not ADB_ZENTRALE_URL:
        return None
    t = conn.execute("SELECT * FROM telefon_tunnel WHERE ext = ?", (ext,)).fetchone()
    if not t:
        return {"stand": "neu"}
    if t["aus"]:
        return {"stand": "aus"}
    if not t["bestaetigt"]:
        return {"stand": "wartet", "pubkey": t["pubkey"]}
    d = {"stand": "bereit", "pubkey": t["pubkey"], "adresse": t["ip"],
         "gateway": str(FW_NETZ.network_address + 1), "schluessel": _fw_schluessel()}
    info = _zentrale_info()
    if info:
        d.update({"peer_public": info.get("public_key", ""), "endpoint": info.get("endpoint_extern", ""),
                  "endpoint_intern": info.get("endpoint_intern", "")})
    return d


def _fw_log(conn, ext, ereignis, name=None, durch=None):
    conn.execute("INSERT INTO telefon_log (ext, ereignis, name, durch) VALUES (?,?,?,?)", (ext, ereignis, name, durch))


@app.post("/api/telefon/tunnel")
def telefon_tunnel_melden():
    """Rosenweg Geraet meldet seinen oeffentlichen WireGuard-Schluessel {pubkey}. Neu oder anders
    als bisher: wartet auf "Bestaetigen" auf /smartphones (ein anderer Schluessel nimmt den alten
    sofort aus der Zentrale). Antwort wie das Feld "fernwartung" im Status."""
    ext, deny = _geraet()
    if deny:
        return deny
    if not ADB_ZENTRALE_URL:
        return jsonify({"error": "Fernwartung nicht eingerichtet"}), 404
    pub = str((request.get_json(silent=True) or {}).get("pubkey") or "").strip()
    try:
        if len(base64.b64decode(pub, validate=True)) != 32:
            raise ValueError
    except (ValueError, binascii.Error):
        return jsonify({"error": "pubkey: 32 Byte Base64"}), 400
    conn = db.connect()
    try:
        t = conn.execute("SELECT * FROM telefon_tunnel WHERE ext = ?", (ext,)).fetchone()
        schieben = False
        if not t or not t["pubkey"]:
            # neu, oder nur ein Not-Aus ohne Schluessel vorgemerkt (der bleibt aus)
            belegt = {r["ip"] for r in conn.execute("SELECT ip FROM telefon_tunnel")}
            frei = next((str(a) for a in list(FW_NETZ.hosts())[1:] if str(a) not in belegt), None)
            if not frei:
                return jsonify({"error": "keine Tunnel-Adresse mehr frei"}), 409
            if t:
                conn.execute("UPDATE telefon_tunnel SET pubkey = ?, ip = ?, gemeldet = ? WHERE ext = ?",
                             (pub, frei, int(time.time()), ext))
            else:
                conn.execute("INSERT INTO telefon_tunnel (ext, pubkey, ip, gemeldet) VALUES (?,?,?,?)",
                             (ext, pub, frei, int(time.time())))
            _fw_log(conn, ext, "fernwartung schluessel", durch="Telefon (neu)")
        elif t["pubkey"] != pub:
            schieben = bool(t["bestaetigt"])
            conn.execute("UPDATE telefon_tunnel SET pubkey = ?, bestaetigt = 0, gemeldet = ?, geaendert = datetime('now') "
                         "WHERE ext = ?", (pub, int(time.time()), ext))
            _fw_log(conn, ext, "fernwartung schluessel", durch="Telefon (anderer Schluessel)")
        else:
            conn.execute("UPDATE telefon_tunnel SET gemeldet = ? WHERE ext = ?", (int(time.time()), ext))
        conn.commit()
        if schieben:
            _fw_schieben(conn)
        return jsonify(_fw_status(conn, ext))
    finally:
        conn.close()


@app.post("/api/telefon/fernwartung/meldung")
def telefon_fernwartung_meldung():
    """Rosenweg Geraet meldet eine fremde adb-Rueckfrage {art: 'fremder_schluessel', fingerabdruck,
    abgelehnt}. Steht im Verlauf und macht das NOC rot (24 h)."""
    ext, deny = _geraet()
    if deny:
        return deny
    b = request.get_json(silent=True) or {}
    fp = str(b.get("fingerabdruck") or "").upper()
    if b.get("art") != "fremder_schluessel" or not re.fullmatch(r"([0-9A-F]{2}:){15}[0-9A-F]{2}", fp):
        return jsonify({"error": "art/fingerabdruck ungueltig"}), 400
    abgelehnt = 1 if b.get("abgelehnt", True) else 0
    conn = db.connect()
    try:
        # hoechstens eine Meldung je Fingerabdruck und Telefon in 10 Minuten
        if not conn.execute("SELECT 1 FROM telefon_adb_fremd WHERE ext = ? AND fingerabdruck = ? AND zeit > ?",
                            (ext, fp, int(time.time()) - 600)).fetchone():
            conn.execute("INSERT INTO telefon_adb_fremd (ext, fingerabdruck, abgelehnt, zeit) VALUES (?,?,?,?)",
                         (ext, fp, abgelehnt, int(time.time())))
            _fw_log(conn, ext, "adb fremd " + ("abgelehnt" if abgelehnt else "offen gelassen"), durch=fp)
            conn.commit()
            app.logger.warning("Fremde adb-Rueckfrage an %s: %s (%s)", ext, fp,
                               "abgelehnt" if abgelehnt else "Wartung vor Ort, offen gelassen")
    finally:
        conn.close()
    return jsonify({"ok": True})


@app.post("/api/telefon/<ext>/fernwartung")
def telefon_fernwartung_schalten(ext):
    """Technik/Praesident: {aktion: bestaetigen | aus | ein | vergessen}.
    aus = Not-Aus: Peer sofort aus der Zentrale (offene Sitzung gekappt) und Weckanruf 2098 -
    Geraet setzt ADB_ENABLED=0 und stoppt den Tunnel. ein: wieder an, ohne USB."""
    user, deny = require_admin()
    if deny:
        return deny
    if not re.fullmatch(r"[0-9]{2,8}", ext):
        return jsonify({"error": "Nebenstelle ungueltig"}), 400
    aktion = str((request.get_json(silent=True) or {}).get("aktion") or "")
    if aktion not in ("bestaetigen", "aus", "ein", "vergessen"):
        return jsonify({"error": "aktion: bestaetigen | aus | ein | vergessen"}), 400
    conn = db.connect()
    try:
        if not conn.execute("SELECT 1 FROM sip_extensions WHERE ext = ? AND context = 'geteilt'", (ext,)).fetchone():
            return jsonify({"error": "Kein geteiltes Telefon"}), 404
        t = conn.execute("SELECT * FROM telefon_tunnel WHERE ext = ?", (ext,)).fetchone()
        if aktion in ("bestaetigen", "vergessen") and not t:
            return jsonify({"error": "Das Telefon hat noch keinen Schluessel gemeldet"}), 409
        if aktion == "bestaetigen":
            conn.execute("UPDATE telefon_tunnel SET bestaetigt = 1, durch = ?, geaendert = datetime('now') WHERE ext = ?",
                         (actor(user), ext))
        elif aktion == "aus":
            if t:
                conn.execute("UPDATE telefon_tunnel SET aus = 1, durch = ?, geaendert = datetime('now') WHERE ext = ?",
                             (actor(user), ext))
            else:   # noch kein Schluessel: trotzdem merken, damit der Tunnel gar nicht erst startet
                conn.execute("INSERT INTO telefon_tunnel (ext, pubkey, ip, aus, durch) VALUES (?, '', ?, 1, ?)",
                             (ext, f"aus-{ext}", actor(user)))
        elif aktion == "ein":
            conn.execute("UPDATE telefon_tunnel SET aus = 0, durch = ?, geaendert = datetime('now') WHERE ext = ?",
                         (actor(user), ext))
            conn.execute("DELETE FROM telefon_tunnel WHERE ext = ? AND pubkey = ''", (ext,))
        else:
            conn.execute("DELETE FROM telefon_tunnel WHERE ext = ?", (ext,))
        _fw_log(conn, ext, f"fernwartung {aktion}", durch=actor(user))
        conn.commit()
        sofort = True
        if aktion in ("aus", "vergessen"):
            try:
                _zentrale("DELETE", f"/peers/{ext}?durch={requests.utils.quote(actor(user))}")
            except Exception as e:  # noqa: BLE001
                sofort = False
                app.logger.warning("Not-Aus %s an der Zentrale: %s", ext, e)
        geschoben = _fw_schieben(conn)
    finally:
        conn.close()
    geweckt = _fw_wecken(ext)
    app.logger.info("Fernwartung %s: %s durch %s", ext, aktion, actor(user))
    return jsonify({"ok": True, "zentrale": sofort and geschoben, "geweckt": geweckt})


@app.post("/api/pbx/fernwartung/alle-aus")
def fernwartung_alle_aus():
    """Technik/Praesident: Not-Aus fuer alle geteilten Telefone auf einmal."""
    user, deny = require_admin()
    if deny:
        return deny
    conn = db.connect()
    try:
        exts = [r["ext"] for r in conn.execute("SELECT ext FROM sip_extensions WHERE context = 'geteilt'")]
        for ext in exts:
            if conn.execute("SELECT 1 FROM telefon_tunnel WHERE ext = ?", (ext,)).fetchone():
                conn.execute("UPDATE telefon_tunnel SET aus = 1, durch = ?, geaendert = datetime('now') WHERE ext = ?",
                             (actor(user), ext))
            else:
                conn.execute("INSERT INTO telefon_tunnel (ext, pubkey, ip, aus, durch) VALUES (?, '', ?, 1, ?)",
                             (ext, f"aus-{ext}", actor(user)))
            _fw_log(conn, ext, "fernwartung aus (alle)", durch=actor(user))
        conn.commit()
        # Erst die Zentrale leeren (wirkt auch, wenn kein Telefon antwortet), dann wecken.
        geschoben = _fw_schieben(conn)
        for ext in exts:
            try:
                _zentrale("DELETE", f"/peers/{ext}?durch={requests.utils.quote(actor(user))}")
            except Exception:  # noqa: BLE001
                pass
    finally:
        conn.close()
    geweckt = sum(1 for ext in exts if _fw_wecken(ext))
    app.logger.warning("Fernwartung: alle aus durch %s", actor(user))
    return jsonify({"ok": True, "telefone": len(exts), "zentrale": geschoben, "geweckt": geweckt})


def _zentrale_berechtigt():
    t = _bearer() or ""
    if len(ADB_ZENTRALE_TOKEN) < 32 or not hmac.compare_digest(t.encode(), ADB_ZENTRALE_TOKEN.encode()):
        return jsonify({"error": "Unauthorized"}), 401
    return None


@app.get("/api/pbx/fernwartung/peers")
def fernwartung_peers():
    """adb-zentrale holt die feste Peer-Liste (beim Start und alle 5 Min.)."""
    deny = _zentrale_berechtigt()
    if deny:
        return deny
    conn = db.connect()
    try:
        return jsonify({"peers": _fw_peers(conn)})
    finally:
        conn.close()


def _fw_text(v, n):
    return re.sub(r"[\x00-\x1f\x7f]", "", str(v or ""))[:n]


@app.post("/api/pbx/fernwartung/sitzung")
def fernwartung_sitzung():
    """adb-zentrale meldet Beginn {art:'auf'} und Ende {art:'zu', bytes, befehle} einer Sitzung."""
    deny = _zentrale_berechtigt()
    if deny:
        return deny
    b = request.get_json(silent=True) or {}
    ext = str(b.get("ext") or "")
    if b.get("art") not in ("auf", "zu") or not re.fullmatch(r"[0-9]{2,8}", ext):
        return jsonify({"error": "art/ext ungueltig"}), 400
    person, zweck = _fw_text(b.get("person"), 64), _fw_text(b.get("zweck"), 20)
    try:
        beginn = int(b.get("beginn") or 0)
        ende = int(b.get("ende") or 0)
        hin, her = int(b.get("bytes_hin") or 0), int(b.get("bytes_her") or 0)
    except (TypeError, ValueError):
        return jsonify({"error": "Zahlen erwartet"}), 400
    befehle = [_fw_text(x, 200) for x in (b.get("befehle") or [])[:200]] if isinstance(b.get("befehle"), list) else []
    conn = db.connect()
    try:
        offen = conn.execute("SELECT id FROM telefon_fernwartung WHERE ext = ? AND beginn = ? AND person = ?",
                             (ext, beginn, person)).fetchone()
        if b["art"] == "auf":
            if not offen:
                conn.execute("INSERT INTO telefon_fernwartung (ext, person, zweck, beginn) VALUES (?,?,?,?)",
                             (ext, person, zweck, beginn))
                _fw_log(conn, ext, "fernwartung an", name=person, durch=zweck)
        else:
            if offen:
                conn.execute("UPDATE telefon_fernwartung SET ende = ?, bytes_hin = ?, bytes_her = ?, befehle = ?, grund = ? "
                             "WHERE id = ?", (ende, hin, her, json.dumps(befehle), _fw_text(b.get("grund"), 80), offen["id"]))
            else:
                conn.execute("INSERT INTO telefon_fernwartung (ext, person, zweck, beginn, ende, bytes_hin, bytes_her, "
                             "befehle, grund) VALUES (?,?,?,?,?,?,?,?,?)",
                             (ext, person, zweck, beginn, ende, hin, her, json.dumps(befehle), _fw_text(b.get("grund"), 80)))
            _fw_log(conn, ext, "fernwartung ab", name=person, durch=_fw_text(b.get("grund"), 80) or zweck)
        conn.commit()
    finally:
        conn.close()
    _FW_MERK["zustand"] = (0.0, None)
    return jsonify({"ok": True})


def _fw_uebersicht(conn, ext, zustand, regs, jetzt):
    """Spalte "Fernwartung" auf /smartphones und Grundlage fuer das NOC.
    ampel: gruen (Handshake < 3 Min. oder < 20 Min. und registriert), gelb (laenger still, Telefon
    lebt aber), rot (still und nicht registriert, Not-Aus, fremde Rueckfrage in 24 h), blau (Sitzung),
    grau (nicht eingerichtet / wartet auf Bestaetigung)."""
    t = conn.execute("SELECT * FROM telefon_tunnel WHERE ext = ?", (ext,)).fetchone()
    fremd = conn.execute("SELECT fingerabdruck, abgelehnt, zeit FROM telefon_adb_fremd WHERE ext = ? AND zeit > ? "
                         "ORDER BY id DESC LIMIT 1", (ext, int(jetzt) - 86400)).fetchone()
    z = zustand.get(ext) or {}
    hs = int(z.get("letzter_handshake") or 0)
    alter = jetzt - hs if hs else None
    d = {"stand": "keiner", "adresse": None, "pubkey": None, "letzter_handshake": hs, "sitzung": z.get("sitzung"),
         "fremd": dict(fremd) if fremd else None, "durch": None, "ampel": "grau"}
    if t:
        d.update({"stand": "aus" if t["aus"] else ("bereit" if t["bestaetigt"] else "wartet"),
                  "adresse": t["ip"] if t["pubkey"] else None, "pubkey": t["pubkey"] or None, "durch": t["durch"]})
    if d["stand"] == "aus" or fremd:
        d["ampel"] = "rot"
    elif d["stand"] == "bereit":
        if d["sitzung"]:
            d["ampel"] = "blau"
        elif alter is not None and (alter < 180 or (alter < 1200 and str(ext) in regs)):
            d["ampel"] = "gruen"
        elif str(ext) in regs:
            d["ampel"] = "gelb"
        else:
            d["ampel"] = "rot"
    return d


@app.get("/api/pbx/fernwartung/noc")
def fernwartung_noc():
    """Haupt-API (X-PBX-Secret): Fernwartung je geteiltem Telefon fuer das NOC - ohne Personennamen
    (das NOC haengt an der Wand), ohne Schluessel und Adressen."""
    err = require_agi()
    if err:
        return err
    try:
        regs = ami.registered_aors()
    except Exception:  # noqa: BLE001
        regs = set()
    jetzt = time.time()
    zustand = _zentrale_zustand() if ADB_ZENTRALE_URL else {}
    conn = db.connect()
    try:
        telefone = []
        for e in conn.execute("SELECT ext, name FROM sip_extensions WHERE context = 'geteilt' AND enabled = 1 ORDER BY ext"):
            f = _fw_uebersicht(conn, e["ext"], zustand, regs, jetzt)
            s = f["sitzung"] or {}
            telefone.append({"ext": e["ext"], "name": e["name"], "stand": f["stand"], "ampel": f["ampel"],
                             "letzter_handshake": f["letzter_handshake"], "registriert": str(e["ext"]) in regs,
                             "sitzung": {"zweck": s.get("zweck"), "seit": s.get("beginn")} if s else None,
                             "fremd": bool(f["fremd"])})
        return jsonify({"eingerichtet": bool(ADB_ZENTRALE_URL), "zentrale": bool(_zentrale_info()) if ADB_ZENTRALE_URL else False,
                        "telefone": telefone, "ts": int(jetzt)})
    finally:
        conn.close()


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
        adb = {r["ext"]: r for r in conn.execute("SELECT ext, adresse, port, gemeldet FROM telefon_adb")}
        upd = {r["ext"]: r for r in conn.execute("SELECT * FROM telefon_updater")}
        zustand = _zentrale_zustand() if ADB_ZENTRALE_URL else {}
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
                # "adb connect" nur, solange das Debugging an ist und die Meldung frisch (< 15 min)
                "adb": (f"{adb[e['ext']]['adresse']}:{adb[e['ext']]['port']}"
                        if e["ext"] in adb and adb[e["ext"]]["port"] and bis > jetzt
                        and jetzt - int(adb[e["ext"]]["gemeldet"] or 0) < 900 else None),
                "updater": _updater_json(conn, e["ext"], upd.get(e["ext"]), jetzt),
                "fernwartung": _fw_uebersicht(conn, e["ext"], zustand, regs, jetzt),
            })
        privat = [{"id": r["id"], "kennung": f"{r['nummer']}-p{r['id']}", "nummer": r["nummer"],
                   "geraet": r["geraet"], "seit": r["created_at"],
                   "registriert": f"{r['nummer']}-p{r['id']}" in regs}
                  for r in conn.execute("SELECT id, nummer, geraet, created_at FROM telefon_sip_privat ORDER BY nummer, id")]
        log = db.rows_to_dicts(conn.execute("SELECT ext, ereignis, name, durch, zeit FROM telefon_log "
                                            "ORDER BY id DESC LIMIT 40").fetchall())
        verlauf = []
        for r in conn.execute("SELECT * FROM telefon_fernwartung ORDER BY beginn DESC, id DESC LIMIT 30"):
            v = dict(r)
            try:
                v["befehle"] = json.loads(v["befehle"] or "[]")
            except ValueError:
                v["befehle"] = []
            verlauf.append(v)
        info = _zentrale_info() if ADB_ZENTRALE_URL else None
        return jsonify({"telefone": telefone, "privat": privat, "log": log,
                        "gruppen": sorted(_telefon_gruppen(conn)),
                        "updater_fingerabdruck": adb_updater.fingerabdruck(),
                        "fernwartung_zentrale": {"eingerichtet": bool(ADB_ZENTRALE_URL), "erreichbar": bool(info),
                                                 "fingerabdruck": (info or {}).get("adb_fingerabdruck", ""),
                                                 "endpoint": (info or {}).get("endpoint_extern", "")},
                        "fernwartung_verlauf": verlauf})
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
        _karten_protokoll_im_hintergrund()
    from waitress import serve
    serve(app, host="0.0.0.0", port=PORT)
