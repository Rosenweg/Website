#!/usr/bin/env python3
"""
N8N Workflow Updater - Aktualisiert den bestehenden Workflow
"""

import os
import sys
import json
import requests
from pathlib import Path

# Load environment variables
def load_env():
    env_path = Path(__file__).parent.parent / '.env'
    env_vars = {}

    if not env_path.exists():
        print(f"❌ .env Datei nicht gefunden: {env_path}")
        sys.exit(1)

    with open(env_path, 'r') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                env_vars[key] = value

    return env_vars


def create_workflow_definition():
    """Erstellt die KORRIGIERTE Workflow-Definition"""

    workflow = {
        "name": "STWEG3 - E-Mail Änderungsbenachrichtigung",
        "nodes": [
            # 1. Webhook Node
            {
                "parameters": {
                    "httpMethod": "POST",
                    "path": "stweg3-email-change-notification",
                    "responseMode": "responseNode",
                    "options": {}
                },
                "name": "Webhook",
                "type": "n8n-nodes-base.webhook",
                "typeVersion": 1,
                "position": [250, 300],
                "webhookId": "stweg3-email-change"
            },

            # 2. Send Email Node - DIREKT ohne Set Node
            {
                "parameters": {
                    "fromEmail": "r9kaiseraugst@gmail.com",
                    "toEmail": "={{ $json.body.oldEmail }}",
                    "subject": "📧 Ihre Kontaktdaten wurden aktualisiert - STWEG 3",
                    "emailFormat": "html",
                    "text": """<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #ea580c 0%, #c2410c 100%); color: white; padding: 20px; border-radius: 8px 8px 0 0; }
        .content { background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; }
        .changes { background: white; padding: 15px; margin: 20px 0; border-left: 4px solid #ea580c; border-radius: 4px; }
        .footer { background: #1f2937; color: #9ca3af; padding: 20px; text-align: center; font-size: 12px; border-radius: 0 0 8px 8px; }
        .warning { background: #fef3c7; border: 1px solid #fbbf24; padding: 15px; border-radius: 4px; margin: 20px 0; }
        ul { list-style: none; padding: 0; }
        li { padding: 8px 0; border-bottom: 1px solid #e5e7eb; }
        li:last-child { border-bottom: none; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1 style="margin: 0;">🏢 STWEG 3 Rosenweg</h1>
            <p style="margin: 5px 0 0 0; opacity: 0.9;">Kontaktdaten-Änderung</p>
        </div>

        <div class="content">
            <h2>Ihre Kontaktdaten wurden aktualisiert</h2>

            <p>Hallo,</p>

            <p>Ihre Kontaktdaten für <strong>{{ $json.body.wohnung }}</strong> ({{ $json.body.type }}) wurden soeben im STWEG 3 Admin-Bereich geändert.</p>

            <div class="changes">
                <h3 style="margin-top: 0;">📝 Folgende Änderungen wurden vorgenommen:</h3>
                <div>{{ $json.body.changeList.join('<br>') }}</div>
            </div>

            <div class="warning">
                <strong>⚠️ Wichtig:</strong> Falls Sie diese Änderung nicht selbst vorgenommen haben oder nicht damit einverstanden sind,
                wenden Sie sich bitte umgehend an den Ausschuss oder an <strong>{{ $json.body.changedBy }}</strong>,
                der diese Änderung durchgeführt hat.
            </div>

            <p><strong>Details zur Änderung:</strong></p>
            <ul style="background: white; padding: 15px; border-radius: 4px;">
                <li><strong>Zeitpunkt:</strong> {{ $json.body.timestamp }}</li>
                <li><strong>Geändert von:</strong> {{ $json.body.changedBy }}</li>
                <li><strong>Wohnung:</strong> {{ $json.body.wohnung }}</li>
                <li><strong>Art:</strong> {{ $json.body.type }}</li>
            </ul>

            <p>Diese E-Mail wurde automatisch an Ihre alte E-Mail-Adresse (<strong>{{ $json.body.oldEmail }}</strong>) gesendet,
            um Sie über die Änderung zu informieren.</p>

            <p>Zukünftige Benachrichtigungen erhalten Sie an: <strong>{{ $json.body.newEmail }}</strong></p>
        </div>

        <div class="footer">
            <p>© 2025 STWEG 3 - Teil der STWEG-Kooperation Rosenweg<br>
            Rosenweg 43, 4303 Kaiseraugst</p>
            <p style="margin-top: 15px; font-size: 11px; color: #6b7280;">
                Diese E-Mail wurde automatisch generiert. Bitte antworten Sie nicht direkt auf diese E-Mail.
            </p>
        </div>
    </div>
</body>
</html>""",
                    "options": {}
                },
                "name": "E-Mail senden",
                "type": "n8n-nodes-base.emailSend",
                "typeVersion": 2,
                "position": [450, 300],
                "credentials": {
                    "smtp": {
                        "id": "1",
                        "name": "SMTP Account"
                    }
                }
            },

            # 3. Response Node
            {
                "parameters": {
                    "respondWith": "json",
                    "responseBody": "={{ { \"success\": true, \"message\": \"Notification sent successfully\", \"recipient\": $json.from, \"timestamp\": $now } }}",
                    "options": {
                        "responseCode": 200
                    }
                },
                "name": "Response",
                "type": "n8n-nodes-base.respondToWebhook",
                "typeVersion": 1,
                "position": [650, 300]
            }
        ],
        "connections": {
            "Webhook": {
                "main": [
                    [
                        {
                            "node": "E-Mail senden",
                            "type": "main",
                            "index": 0
                        }
                    ]
                ]
            },
            "E-Mail senden": {
                "main": [
                    [
                        {
                            "node": "Response",
                            "type": "main",
                            "index": 0
                        }
                    ]
                ]
            }
        },
        "settings": {
            "saveDataErrorExecution": "all",
            "saveDataSuccessExecution": "all",
            "saveManualExecutions": True
        }
    }

    return workflow


def update_workflow(api_url, api_key, workflow_id):
    """Aktualisiert den Workflow über die N8N API"""

    print(f"🔧 Aktualisiere Workflow {workflow_id}...")

    workflow = create_workflow_definition()

    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-N8N-API-KEY": api_key
    }

    try:
        # Workflow aktualisieren (PUT nicht PATCH)
        response = requests.put(
            f"{api_url}/workflows/{workflow_id}",
            headers=headers,
            json=workflow,
            timeout=30
        )

        if response.status_code in [200, 201]:
            workflow_data = response.json()

            print(f"✅ Workflow erfolgreich aktualisiert!")
            print(f"   Workflow ID: {workflow_id}")
            print(f"   Name: {workflow_data.get('name')}")
            print(f"   Änderungen:")
            print(f"     - Absender geändert auf: r9kaiseraugst@gmail.com")
            print(f"     - Set Node entfernt (unnötig)")
            print(f"     - Direkte Verbindung: Webhook → E-Mail → Response")
            print(f"     - Korrekte Variablen-Pfade: $json.body.oldEmail, etc.")

            return True
        else:
            print(f"❌ Fehler beim Aktualisieren des Workflows")
            print(f"   Status Code: {response.status_code}")
            print(f"   Response: {response.text}")
            return False

    except requests.exceptions.RequestException as e:
        print(f"❌ Netzwerkfehler: {e}")
        return False


def main():
    print("=" * 70)
    print("N8N Workflow Updater - STWEG3 E-Mail-Benachrichtigungen")
    print("=" * 70)
    print()

    # Load environment variables
    env_vars = load_env()

    api_url = env_vars.get('N8N_API_URL')
    api_key = env_vars.get('N8N_API_KEY')

    if not api_url or not api_key:
        print("❌ N8N_API_URL oder N8N_API_KEY nicht in .env gefunden")
        sys.exit(1)

    # Bekannte Workflow-ID
    workflow_id = "m3swn76BpgrTrUG6"

    print(f"🔗 N8N API URL: {api_url}")
    print(f"📋 Workflow ID: {workflow_id}")
    print()

    # Update workflow
    success = update_workflow(api_url, api_key, workflow_id)

    if success:
        print()
        print("=" * 70)
        print("✅ Update abgeschlossen!")
        print("=" * 70)
        print()
        print("📧 Nächste Schritte:")
        print("   1. Konfigurieren Sie SMTP-Credentials in n8n")
        print("      (Credential ID '1' für r9kaiseraugst@gmail.com)")
        print("   2. Testen Sie den Workflow erneut")
    else:
        sys.exit(1)


if __name__ == "__main__":
    main()
