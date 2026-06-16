"""
Voicemail-KI-Pipeline der PBX-API — vollstaendig autark in CT 220:

  1. Transkription (Groq whisper-large-v3, sonst OpenRouter whisper-1)
  2. Analyse/Zusammenfassung + Defekt-Klassifikation (OpenRouter Claude Haiku)
  3. Zustellung per WhatsApp DIREKT ueber das Gateway (/gateway/send, keyed) —
     kein Umweg ueber die Haupt-API.
  4. Optional: Forward der Analyse an einen Webhook (Haupt-API) fuer die
     Rosenweg-spezifische Auto-Reklamation (FORWARD_VOICEMAIL_URL).

Alle Endpunkte/Keys via ENV (nichts hardcoded) -> auch fuer andere Projekte nutzbar.
"""
import json
import os
from datetime import datetime
from zoneinfo import ZoneInfo

import requests

OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
ANALYZE_MODEL = os.environ.get("VOICEMAIL_MODEL", "anthropic/claude-haiku-4.5")

GATEWAY_SEND_URL = os.environ.get("GATEWAY_SEND_URL", "")          # z.B. https://whatsapp.rosenweg4303.ch/gateway/send
GATEWAY_API_KEY = os.environ.get("GATEWAY_API_KEY", "")            # mg_...
WA_TARGET = os.environ.get("VOICEMAIL_WA_TARGET", "Rosenweg Technik")

FORWARD_URL = os.environ.get("FORWARD_VOICEMAIL_URL", "")          # optional: Haupt-API fuer Auto-Reklamation
FORWARD_SECRET = os.environ.get("FORWARD_VOICEMAIL_SECRET", os.environ.get("PBX_SHARED_SECRET", ""))
SITE_URL = os.environ.get("SITE_URL", "https://www.rosenweg4303.ch").rstrip("/")

ANALYZE_SYSTEM = (
    "Du analysierst Anrufbeantworter-Nachrichten der Rosenweg-STWEG (Schweizer "
    "Stockwerkeigentum). Antworte STRIKT als JSON mit den Feldern: "
    '{"summary": string (1-2 Saetze Kern-Anliegen, knapp), '
    '"urgency": "niedrig"|"mittel"|"hoch", '
    '"action": string (1 Satz naechste Handlung), '
    '"is_defekt": boolean (true wenn Schaden/Defekt/Reparaturbedarf), '
    '"defekt_stweg": number|null (STWEG-Nummer 1-8 falls genannt), '
    '"defekt_beschreibung": string (saubere Defektbeschreibung falls is_defekt, sonst "")}'
)

EMPTY_ANALYSIS = {
    "summary": "", "urgency": None, "action": "",
    "is_defekt": False, "defekt_stweg": None, "defekt_beschreibung": "",
}


def transcribe(audio_bytes, mimetype="audio/wav"):
    """Gibt (text, error). Groq bevorzugt (schnell, gratis), sonst OpenRouter."""
    if GROQ_API_KEY:
        url = "https://api.groq.com/openai/v1/audio/transcriptions"
        key, model, extra = GROQ_API_KEY, "whisper-large-v3", {}
    elif OPENROUTER_API_KEY:
        url = "https://openrouter.ai/api/v1/audio/transcriptions"
        key, model = OPENROUTER_API_KEY, "openai/whisper-1"
        extra = {"HTTP-Referer": "https://pbx.rosenweg4303.ch", "X-Title": "Rosenweg PBX"}
    else:
        return "", "kein GROQ_API_KEY/OPENROUTER_API_KEY"
    try:
        r = requests.post(
            url,
            headers={"Authorization": f"Bearer {key}", **extra},
            files={"file": ("voicemail.wav", audio_bytes, mimetype)},
            data={"model": model, "language": "de"},
            timeout=120,
        )
        if not r.ok:
            return "", f"Whisper {r.status_code}: {r.text[:200]}"
        return (r.json().get("text") or "").strip(), None
    except requests.RequestException as e:
        return "", str(e)


def analyze(transcript, caller_id):
    if not OPENROUTER_API_KEY or not transcript:
        return dict(EMPTY_ANALYSIS)
    try:
        r = requests.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={"Authorization": f"Bearer {OPENROUTER_API_KEY}", "Content-Type": "application/json"},
            json={
                "model": ANALYZE_MODEL,
                "max_tokens": 500,
                "response_format": {"type": "json_object"},
                "messages": [
                    {"role": "system", "content": ANALYZE_SYSTEM},
                    {"role": "user", "content": f"Anrufer: {caller_id}\nTranskript:\n{transcript}"},
                ],
            },
            timeout=40,
        )
        if not r.ok:
            return dict(EMPTY_ANALYSIS)
        content = r.json()["choices"][0]["message"]["content"]
        data = json.loads(content)
        out = dict(EMPTY_ANALYSIS)
        out.update({k: data.get(k, out[k]) for k in out})
        return out
    except (requests.RequestException, KeyError, ValueError):
        return dict(EMPTY_ANALYSIS)


def _gateway_send(title, body, attachments=None):
    if not GATEWAY_SEND_URL or not GATEWAY_API_KEY:
        return False, "Gateway nicht konfiguriert"
    try:
        r = requests.post(
            GATEWAY_SEND_URL,
            headers={"X-Messaging-Key": GATEWAY_API_KEY, "Content-Type": "application/json"},
            json={"channel": "whatsapp", "to": WA_TARGET, "title": title, "body": body,
                  "attachments": attachments or []},
            timeout=30,
        )
        return r.ok, (None if r.ok else f"{r.status_code}: {r.text[:200]}")
    except requests.RequestException as e:
        return False, str(e)


def deliver_whatsapp(caller_id, uniqueid, transcript, analysis, audio_b64, reklamation_id=None):
    now = datetime.now(ZoneInfo("Europe/Zurich")).strftime("%d.%m.%Y %H:%M")
    parts = [f"🕒 {now}"]
    if analysis.get("summary"):
        parts.append(f"*Zusammenfassung:* {analysis['summary']}")
    if analysis.get("urgency"):
        parts.append(f"*Dringlichkeit:* {analysis['urgency']}")
    if analysis.get("action"):
        parts.append(f"*Naechster Schritt:* {analysis['action']}")
    if reklamation_id:
        parts.append(f"✅ *Auto-Reklamation #{reklamation_id} erstellt* (STWEG "
                     f"{analysis.get('defekt_stweg') or '—'})\n{SITE_URL}/reklamationen.html#{reklamation_id}")
    if transcript:
        parts.append(f"*Transkript:*\n{transcript}")
    body = "\n\n".join(parts)[:3500]
    ok1, err1 = _gateway_send(f"📞 Voicemail von {caller_id}", body)
    # Audio als separate Sprachnachricht (Play-Button im WA-UI)
    ok2, err2 = _gateway_send(None, "", [{
        "filename": f"voicemail-{caller_id}-{uniqueid}.wav",
        "mimetype": "audio/wav",
        "data_base64": audio_b64,
    }])
    return ok1 and ok2, (err1 or err2)


def forward_for_reklamation(caller_id, uniqueid, transcript, analysis):
    """Optionaler Webhook an die Haupt-API: legt die Rosenweg-Auto-Reklamation an
    (personen-Lookup + reklamationen leben dort). Gibt die reklamation_id zurueck
    (oder None)."""
    if not FORWARD_URL:
        return None
    try:
        r = requests.post(
            FORWARD_URL,
            headers={"X-PBX-Secret": FORWARD_SECRET, "Content-Type": "application/json"},
            json={"caller_id": caller_id, "uniqueid": uniqueid, "transcript": transcript, "analysis": analysis},
            timeout=15,
        )
        return r.json().get("reklamation_id") if r.ok else None
    except (requests.RequestException, ValueError):
        return None


def process(audio_bytes, caller_id, uniqueid):
    """Vollstaendige Pipeline. Gibt dict mit Ergebnis (fuer Speicherung + Response)."""
    import base64
    transcript, wh_err = transcribe(audio_bytes)
    analysis = analyze(transcript, caller_id)
    # ERST die Reklamation (Haupt-API) -> ID -> DANN WhatsApp MIT Reklamations-Link.
    reklamation_id = forward_for_reklamation(caller_id, uniqueid, transcript, analysis)
    audio_b64 = base64.b64encode(audio_bytes).decode()
    wa_ok, wa_err = deliver_whatsapp(caller_id, uniqueid, transcript, analysis, audio_b64, reklamation_id)
    return {
        "transcript": transcript,
        "analysis": analysis,
        "whisper_error": wh_err,
        "whatsapp_ok": wa_ok,
        "whatsapp_error": wa_err,
        "reklamation_id": reklamation_id,
    }
