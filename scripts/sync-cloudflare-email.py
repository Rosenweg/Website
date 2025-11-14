#!/usr/bin/env python3
"""
Cloudflare E-Mail-Routing Sync Script
Synchronisiert E-Mail-Routing-Regeln aus ausschuss-kontakte.json mit Cloudflare
"""

import os
import sys
import json
import requests
from typing import Dict, List, Tuple

# Cloudflare API Konfiguration
CLOUDFLARE_API_TOKEN = os.environ.get('CLOUDFLARE_API_TOKEN')
CLOUDFLARE_ZONE_ID = os.environ.get('CLOUDFLARE_ZONE_ID')

if not CLOUDFLARE_API_TOKEN or not CLOUDFLARE_ZONE_ID:
    print("❌ Fehler: CLOUDFLARE_API_TOKEN und CLOUDFLARE_ZONE_ID müssen als Umgebungsvariablen gesetzt sein")
    sys.exit(1)

# Cloudflare API Base URL
API_BASE = f"https://api.cloudflare.com/client/v4/zones/{CLOUDFLARE_ZONE_ID}/email/routing"

# Headers für Cloudflare API
HEADERS = {
    "Authorization": f"Bearer {CLOUDFLARE_API_TOKEN}",
    "Content-Type": "application/json"
}


def load_ausschuss_kontakte() -> Dict:
    """Lädt die ausschuss-kontakte.json Datei"""
    try:
        with open('ausschuss-kontakte.json', 'r', encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        print("❌ Fehler: ausschuss-kontakte.json nicht gefunden")
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"❌ Fehler beim Parsen der JSON: {e}")
        sys.exit(1)


def extract_email_rules(data: Dict) -> List[Tuple[str, List[str]]]:
    """
    Extrahiert E-Mail-Routing-Regeln aus den Kontaktdaten
    Returns: Liste von (from_email, [to_email1, to_email2, ...])
    """
    rules = []

    # Präsident
    if 'präsident' in data['ausschuss'] and 'email' in data['ausschuss']['präsident']:
        email = data['ausschuss']['präsident']['email']
        original = data['ausschuss']['präsident'].get('email_original')
        if original and '@rosenweg4303.ch' in email:
            rules.append((email, [original]))

    # STWEG-Vertreter
    for stweg in data['ausschuss']['vertreter']:
        if 'email' in stweg and 'email_forwards_to' in stweg:
            email = stweg['email']
            forwards_to = stweg['email_forwards_to']
            if '@rosenweg4303.ch' in email:
                rules.append((email, forwards_to))

    return rules


def get_existing_rules() -> List[Dict]:
    """Holt existierende E-Mail-Routing-Regeln von Cloudflare"""
    try:
        response = requests.get(
            f"{API_BASE}/rules",
            headers=HEADERS,
            timeout=30
        )
        response.raise_for_status()
        result = response.json()

        if not result.get('success'):
            print(f"❌ Cloudflare API Fehler: {result.get('errors', 'Unbekannter Fehler')}")
            return []

        return result.get('result', [])
    except requests.exceptions.RequestException as e:
        print(f"❌ Fehler beim Abrufen existierender Regeln: {e}")
        return []


def create_email_rule(from_email: str, to_emails: List[str]) -> bool:
    """Erstellt eine neue E-Mail-Routing-Regel in Cloudflare"""
    payload = {
        "matchers": [
            {
                "type": "literal",
                "field": "to",
                "value": from_email
            }
        ],
        "actions": [
            {
                "type": "forward",
                "value": to_emails
            }
        ],
        "enabled": True,
        "name": f"Weiterleitung für {from_email}"
    }

    try:
        response = requests.post(
            f"{API_BASE}/rules",
            headers=HEADERS,
            json=payload,
            timeout=30
        )
        response.raise_for_status()
        result = response.json()

        if result.get('success'):
            print(f"  ✅ Regel erstellt: {from_email} → {', '.join(to_emails)}")
            return True
        else:
            print(f"  ❌ Fehler beim Erstellen der Regel für {from_email}: {result.get('errors')}")
            return False
    except requests.exceptions.RequestException as e:
        print(f"  ❌ API-Fehler beim Erstellen der Regel für {from_email}: {e}")
        return False


def update_email_rule(rule_id: str, from_email: str, to_emails: List[str]) -> bool:
    """Aktualisiert eine existierende E-Mail-Routing-Regel"""
    payload = {
        "matchers": [
            {
                "type": "literal",
                "field": "to",
                "value": from_email
            }
        ],
        "actions": [
            {
                "type": "forward",
                "value": to_emails
            }
        ],
        "enabled": True,
        "name": f"Weiterleitung für {from_email}"
    }

    try:
        response = requests.put(
            f"{API_BASE}/rules/{rule_id}",
            headers=HEADERS,
            json=payload,
            timeout=30
        )
        response.raise_for_status()
        result = response.json()

        if result.get('success'):
            print(f"  ✅ Regel aktualisiert: {from_email} → {', '.join(to_emails)}")
            return True
        else:
            print(f"  ❌ Fehler beim Aktualisieren der Regel für {from_email}: {result.get('errors')}")
            return False
    except requests.exceptions.RequestException as e:
        print(f"  ❌ API-Fehler beim Aktualisieren der Regel für {from_email}: {e}")
        return False


def get_rule_matcher_value(rule: Dict) -> str:
    """Extrahiert die E-Mail-Adresse aus einer Cloudflare-Regel"""
    matchers = rule.get('matchers', [])
    for matcher in matchers:
        if matcher.get('field') == 'to':
            return matcher.get('value', '')
    return ''


def get_rule_forward_values(rule: Dict) -> List[str]:
    """Extrahiert die Weiterleitungs-Adressen aus einer Cloudflare-Regel"""
    actions = rule.get('actions', [])
    for action in actions:
        if action.get('type') == 'forward':
            return action.get('value', [])
    return []


def sync_email_routing():
    """Hauptfunktion: Synchronisiert E-Mail-Routing mit Cloudflare"""
    print("🔄 Starte Synchronisation der E-Mail-Routing-Regeln mit Cloudflare...\n")

    # 1. Lade Kontaktdaten
    print("📖 Lade ausschuss-kontakte.json...")
    data = load_ausschuss_kontakte()
    desired_rules = extract_email_rules(data)
    print(f"  ℹ️  {len(desired_rules)} Regeln in JSON gefunden\n")

    # 2. Hole existierende Regeln von Cloudflare
    print("☁️  Hole existierende Regeln von Cloudflare...")
    existing_rules = get_existing_rules()
    print(f"  ℹ️  {len(existing_rules)} existierende Regeln in Cloudflare\n")

    # 3. Erstelle ein Mapping der existierenden Regeln
    existing_rules_map = {}
    for rule in existing_rules:
        from_email = get_rule_matcher_value(rule)
        if from_email:
            existing_rules_map[from_email] = {
                'id': rule.get('tag'),
                'to_emails': get_rule_forward_values(rule)
            }

    # 4. Synchronisiere Regeln
    print("🔄 Synchronisiere Regeln...\n")

    created = 0
    updated = 0
    skipped = 0

    for from_email, to_emails in desired_rules:
        if from_email in existing_rules_map:
            # Regel existiert bereits - prüfe ob Update nötig ist
            existing_to_emails = set(existing_rules_map[from_email]['to_emails'])
            desired_to_emails = set(to_emails)

            if existing_to_emails != desired_to_emails:
                # Update erforderlich
                rule_id = existing_rules_map[from_email]['id']
                if update_email_rule(rule_id, from_email, to_emails):
                    updated += 1
                else:
                    print(f"  ⚠️  Fehler beim Aktualisieren von {from_email}")
            else:
                print(f"  ⏭️  Regel bereits aktuell: {from_email}")
                skipped += 1
        else:
            # Regel existiert nicht - erstelle sie
            if create_email_rule(from_email, to_emails):
                created += 1
            else:
                print(f"  ⚠️  Fehler beim Erstellen von {from_email}")

    # 5. Zusammenfassung
    print("\n" + "="*60)
    print("📊 Zusammenfassung:")
    print(f"  ✅ Erstellt:      {created}")
    print(f"  🔄 Aktualisiert:  {updated}")
    print(f"  ⏭️  Übersprungen:  {skipped}")
    print(f"  📧 Gesamt:        {len(desired_rules)}")
    print("="*60)

    if created > 0 or updated > 0:
        print("\n✅ Synchronisation erfolgreich abgeschlossen!")
    else:
        print("\n✅ Alle Regeln waren bereits aktuell - keine Änderungen nötig.")


if __name__ == '__main__':
    sync_email_routing()
