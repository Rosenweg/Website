#!/usr/bin/env python3
"""
Test Script für N8N E-Mail-Benachrichtigungs-Workflow
Sendet eine Test-Anfrage an den Webhook
"""

import requests
import json
from datetime import datetime

# Webhook URL
WEBHOOK_URL = "https://n8n.juroct.net/webhook/stweg3-email-change-notification"

def test_workflow():
    """Testet den Workflow mit Beispieldaten"""

    print("=" * 80)
    print("N8N Workflow Test - STWEG3 E-Mail-Änderungsbenachrichtigung")
    print("=" * 80)
    print()

    # Test-Daten
    test_data = {
        "oldEmail": "test.alt@example.com",
        "newEmail": "test.neu@example.com",
        "type": "Eigentümer",
        "name": "Max Mustermann",
        "wohnung": "Wohnung 1.1",
        "changeList": [
            'Name: "Max Müller" → "Max Mustermann"',
            'E-Mail: "test.alt@example.com" → "test.neu@example.com"',
            'Telefon: "079 123 45 67" → "079 987 65 43"'
        ],
        "changedBy": "admin@stweg3.ch",
        "timestamp": datetime.now().isoformat()
    }

    print("📤 Sende Test-Request...")
    print(f"   Webhook URL: {WEBHOOK_URL}")
    print()
    print("Test-Daten:")
    print(json.dumps(test_data, indent=2, ensure_ascii=False))
    print()

    try:
        response = requests.post(
            WEBHOOK_URL,
            headers={"Content-Type": "application/json"},
            json=test_data,
            timeout=30
        )

        print("-" * 80)
        print(f"✅ Response Status: {response.status_code}")
        print(f"Response Headers: {dict(response.headers)}")
        print()

        if response.status_code == 200:
            print("Response Body (raw):")
            print(f"'{response.text}'")
            print()

            if response.text.strip():
                try:
                    print("Response Body (parsed):")
                    print(json.dumps(response.json(), indent=2, ensure_ascii=False))
                except json.JSONDecodeError as e:
                    print(f"⚠️ Response ist kein gültiges JSON: {e}")
                    print(f"Raw content: {response.text}")
            else:
                print("⚠️ Response Body ist leer")

            print()
            print("=" * 80)
            print("✅ Workflow wurde ausgeführt!")
            print("=" * 80)
            print()
            print("📧 Überprüfen Sie:")
            print("   1. Ob die E-Mail an test.alt@example.com gesendet wurde")
            print("   2. Den Workflow in n8n auf Fehler (Executions Tab)")
            print("   3. Ob SMTP konfiguriert ist")
            return True
        else:
            print(f"❌ Test fehlgeschlagen")
            print(f"Response: {response.text}")
            return False

    except requests.exceptions.Timeout:
        print("❌ Timeout - Der Workflow antwortet nicht innerhalb von 30 Sekunden")
        print("   Dies kann passieren, wenn:")
        print("   1. Der Workflow nicht aktiviert ist")
        print("   2. SMTP-Credentials fehlen oder falsch sind")
        print("   3. Der E-Mail-Versand hängt")
        return False

    except requests.exceptions.RequestException as e:
        print(f"❌ Netzwerkfehler: {e}")
        return False


if __name__ == "__main__":
    success = test_workflow()

    if not success:
        print()
        print("💡 Mögliche Lösungen:")
        print("   1. Öffnen Sie n8n: https://n8n.juroct.net")
        print("   2. Aktivieren Sie den Workflow 'm3swn76BpgrTrUG6'")
        print("   3. Konfigurieren Sie die SMTP-Credentials")
        print("   4. Testen Sie den Workflow manuell in n8n")
