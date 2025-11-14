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


def get_verified_addresses() -> Dict[str, Dict]:
    """Holt die Liste der verifizierten Destination Addresses von Cloudflare"""
    try:
        response = requests.get(
            f"{API_BASE}/addresses",
            headers=HEADERS,
            timeout=30
        )
        response.raise_for_status()
        result = response.json()

        if not result.get('success'):
            print(f"❌ Cloudflare API Fehler: {result.get('errors', 'Unbekannter Fehler')}")
            return {}

        addresses = result.get('result', [])
        # Erstelle ein Dictionary mit E-Mail als Key
        return {
            addr['email']: {
                'id': addr.get('tag'),
                'verified': addr.get('verified'),
                'created': addr.get('created')
            }
            for addr in addresses
        }
    except requests.exceptions.RequestException as e:
        print(f"❌ Fehler beim Abrufen der Destination Addresses: {e}")
        return {}


def request_email_verification(email: str) -> bool:
    """Fordert Verifizierungs-E-Mail für eine neue Destination Address an"""
    payload = {
        "email": email
    }

    try:
        response = requests.post(
            f"{API_BASE}/addresses",
            headers=HEADERS,
            json=payload,
            timeout=30
        )
        response.raise_for_status()
        result = response.json()

        if result.get('success'):
            print(f"  📧 Verifizierungs-E-Mail gesendet an: {email}")
            return True
        else:
            errors = result.get('errors', [])
            # Prüfe ob die Adresse bereits existiert (oft Fehlercode 1004)
            if any('already exists' in str(err).lower() for err in errors):
                print(f"  ℹ️  E-Mail-Adresse bereits registriert: {email}")
                return True
            else:
                print(f"  ❌ Fehler beim Anfordern der Verifizierung für {email}: {errors}")
                return False
    except requests.exceptions.RequestException as e:
        print(f"  ❌ API-Fehler beim Anfordern der Verifizierung für {email}: {e}")
        return False


def sync_email_routing():
    """Hauptfunktion: Synchronisiert E-Mail-Routing mit Cloudflare"""
    print("🔄 Starte Synchronisation der E-Mail-Routing-Regeln mit Cloudflare...\n")

    # 1. Lade Kontaktdaten
    print("📖 Lade ausschuss-kontakte.json...")
    data = load_ausschuss_kontakte()
    desired_rules = extract_email_rules(data)
    print(f"  ℹ️  {len(desired_rules)} Regeln in JSON gefunden\n")

    # 2. Extrahiere alle einzigartigen Ziel-E-Mail-Adressen
    all_destination_emails = set()
    for _, to_emails in desired_rules:
        all_destination_emails.update(to_emails)
    print(f"📧 Gefundene Ziel-E-Mail-Adressen: {len(all_destination_emails)}\n")

    # 3. Hole verifizierte Destination Addresses von Cloudflare
    print("🔐 Prüfe Verifizierungsstatus der Ziel-E-Mail-Adressen...")
    verified_addresses = get_verified_addresses()
    print(f"  ℹ️  {len(verified_addresses)} bereits registrierte Adressen in Cloudflare\n")

    # 4. Identifiziere neue, nicht verifizierte Adressen und fordere Verifizierung an
    new_addresses = all_destination_emails - set(verified_addresses.keys())
    unverified_addresses = [
        email for email in verified_addresses.keys()
        if not verified_addresses[email].get('verified')
    ]

    if new_addresses or unverified_addresses:
        print("📮 Verifizierungs-E-Mails anfordern...\n")

        verification_requested = 0
        for email in new_addresses:
            if request_email_verification(email):
                verification_requested += 1

        if new_addresses:
            print(f"\n  ✅ Verifizierungs-E-Mails an {verification_requested} neue Adressen gesendet")

        if unverified_addresses:
            print(f"\n  ⚠️  {len(unverified_addresses)} Adressen sind noch nicht verifiziert:")
            for email in unverified_addresses:
                print(f"     - {email}")
            print("\n  ℹ️  Bitte die E-Mail-Postfächer überprüfen und die Verifizierungs-Links anklicken!")

        print()
    else:
        print("✅ Alle Ziel-E-Mail-Adressen sind bereits verifiziert!\n")

    # 5. Hole existierende Regeln von Cloudflare
    print("☁️  Hole existierende Regeln von Cloudflare...")
    existing_rules = get_existing_rules()
    print(f"  ℹ️  {len(existing_rules)} existierende Regeln in Cloudflare\n")

    # 6. Erstelle ein Mapping der existierenden Regeln
    existing_rules_map = {}
    for rule in existing_rules:
        from_email = get_rule_matcher_value(rule)
        if from_email:
            existing_rules_map[from_email] = {
                'id': rule.get('tag'),
                'to_emails': get_rule_forward_values(rule)
            }

    # 7. Synchronisiere Regeln
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

    # 8. Zusammenfassung
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
