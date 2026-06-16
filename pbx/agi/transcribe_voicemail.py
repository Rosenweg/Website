#!/usr/bin/env python3
"""
AGI-Script: Asterisk ruft das nach jeder Voicemail-Aufnahme auf.

Aufgabe:
  1. Lies die WAV-Datei
  2. Schicke sie an die Rosenweg-API: POST /api/pbx/voicemail
     (Multipart: audio.wav + caller_id + uniqueid)
  3. Die API uebernimmt:
     - Transkription via OpenRouter (Whisper-1)
     - Mail an Technik-Gruppe mit Audio + Transkript + KI-Zusammenfassung
     - Optional WhatsApp-Push an Technik-Mitglieder mit Opt-In
  4. Wir warten kurz, damit Asterisk nicht reisst bevor die Datei
     gelesen ist — danach Hangup.

Args (von Asterisk via AGI()):
  sys.argv[1] = Pfad zur WAV-Datei
  sys.argv[2] = Caller-ID-Nummer
  sys.argv[3] = Unique-ID (Asterisk-Call-ID)
"""
import os
import sys
import time
from pathlib import Path

try:
    import requests
except ImportError:
    sys.stderr.write("[transcribe-agi] requests-Modul nicht verfuegbar\n")
    sys.exit(1)

def _load_env_file(path='/etc/default/asterisk-env'):
    env = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#'): continue
                if '=' in line:
                    k, v = line.split('=', 1)
                    env[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError: pass
    return env
_envfile = _load_env_file()
# Lokale PBX-API (KI-Pipeline laeuft autark in CT 220, nicht mehr Haupt-API).
API_BASE   = os.environ.get('PBX_API_BASE')      or _envfile.get('PBX_API_BASE', 'http://127.0.0.1:8095')
PBX_SECRET = os.environ.get('PBX_SHARED_SECRET') or _envfile.get('PBX_SHARED_SECRET', '')

def agi_log(msg):
    sys.stderr.write(f"[transcribe-agi] {msg}\n")
    print(f'VERBOSE "{msg}" 1')
    sys.stdout.flush()

def main():
    if len(sys.argv) < 4:
        agi_log(f'Falsche Args: {sys.argv}')
        return 1
    wav_path = Path(sys.argv[1])
    caller   = sys.argv[2] or 'unknown'
    uniqueid = sys.argv[3]
    # Asterisk schreibt Records ggf. mit Verzoegerung — kurz warten
    for _ in range(10):
        if wav_path.exists() and wav_path.stat().st_size > 1024:
            break
        time.sleep(0.5)
    if not wav_path.exists():
        agi_log(f'WAV nicht gefunden: {wav_path}')
        return 1
    try:
        with wav_path.open('rb') as fh:
            audio_bytes = fh.read()
        r = requests.post(
            f'{API_BASE}/api/pbx/voicemail',
            headers={
                'X-PBX-Secret': PBX_SECRET,
                'Content-Type': 'audio/wav',
                'X-Caller-Id': caller,
                'X-Unique-Id': uniqueid,
            },
            data=audio_bytes,
            timeout=120,
        )
        if r.ok:
            agi_log(f'API-Upload OK: {r.status_code}')
        else:
            agi_log(f'API-Upload Fehler {r.status_code}: {r.text[:200]}')
    except Exception as e:
        agi_log(f'Exception: {e}')
        return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())
