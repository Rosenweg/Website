#!/usr/bin/env python3
"""
N8N Workflow Creator für STWEG3 E-Mail-Änderungsbenachrichtigungen
Erstellt automatisch einen N8N Workflow über die API
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

# N8N Workflow Definition
def create_workflow_definition():
    """Erstellt die komplette Workflow-Definition für N8N"""

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

            # 2. Set Node - Daten vorbereiten
            {
                "parameters": {
                    "values": {
                        "string": [
                            {
                                "name": "oldEmail",
                                "value": "={{ $json.oldEmail }}"
                            },
                            {
                                "name": "newEmail",
                                "value": "={{ $json.newEmail }}"
                            },
                            {
                                "name": "type",
                                "value": "={{ $json.type }}"
                            },
                            {
                                "name": "name",
                                "value": "={{ $json.name }}"
                            },
                            {
                                "name": "wohnung",
                                "value": "={{ $json.wohnung }}"
                            },
                            {
                                "name": "changedBy",
                                "value": "={{ $json.changedBy }}"
                            },
                            {
                                "name": "timestamp",
                                "value": "={{ $json.timestamp }}"
                            },
                            {
                                "name": "changeList",
                                "value": "={{ $json.changeList.join('<br>') }}"
                            }
                        ]
                    },
                    "options": {}
                },
                "name": "Daten vorbereiten",
                "type": "n8n-nodes-base.set",
                "typeVersion": 1,
                "position": [450, 300]
            },

            # 3. Send Email Node
            {
                "parameters": {
                    "fromEmail": "noreply@rosenweg4303.ch",
                    "toEmail": "={{ $json.oldEmail }}",
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

            <p>Ihre Kontaktdaten für <strong>{{ $json.wohnung }}</strong> ({{ $json.type }}) wurden soeben im STWEG 3 Admin-Bereich geändert.</p>

            <div class="changes">
                <h3 style="margin-top: 0;">📝 Folgende Änderungen wurden vorgenommen:</h3>
                <div>{{ $json.changeList }}</div>
            </div>

            <div class="warning">
                <strong>⚠️ Wichtig:</strong> Falls Sie diese Änderung nicht selbst vorgenommen haben oder nicht damit einverstanden sind,
                wenden Sie sich bitte umgehend an den Ausschuss oder an <strong>{{ $json.changedBy }}</strong>,
                der diese Änderung durchgeführt hat.
            </div>

            <p><strong>Details zur Änderung:</strong></p>
            <ul style="background: white; padding: 15px; border-radius: 4px;">
                <li><strong>Zeitpunkt:</strong> {{ $json.timestamp }}</li>
                <li><strong>Geändert von:</strong> {{ $json.changedBy }}</li>
                <li><strong>Wohnung:</strong> {{ $json.wohnung }}</li>
                <li><strong>Art:</strong> {{ $json.type }}</li>
            </ul>

            <p>Diese E-Mail wurde automatisch an Ihre alte E-Mail-Adresse (<strong>{{ $json.oldEmail }}</strong>) gesendet,
            um Sie über die Änderung zu informieren.</p>

            <p>Zukünftige Benachrichtigungen erhalten Sie an: <strong>{{ $json.newEmail }}</strong></p>
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
                "position": [650, 300],
                "credentials": {
                    "smtp": {
                        "id": "1",
                        "name": "SMTP Account"
                    }
                }
            },

            # 4. Response Node
            {
                "parameters": {
                    "respondWith": "json",
                    "responseBody": """{
  "success": true,
  "message": "Notification sent successfully",
  "recipient": "{{ $json.oldEmail }}",
  "timestamp": "{{ $now }}"
}""",
                    "options": {
                        "responseCode": 200
                    }
                },
                "name": "Response",
                "type": "n8n-nodes-base.respondToWebhook",
                "typeVersion": 1,
                "position": [850, 300]
            }
        ],
        "connections": {
            "Webhook": {
                "main": [
                    [
                        {
                            "node": "Daten vorbereiten",
                            "type": "main",
                            "index": 0
                        }
                    ]
                ]
            },
            "Daten vorbereiten": {
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


def create_workflow(api_url, api_key):
    """Erstellt den Workflow über die N8N API"""

    print("🔧 Erstelle N8N Workflow...")

    workflow = create_workflow_definition()

    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-N8N-API-KEY": api_key
    }

    try:
        # Workflow erstellen
        response = requests.post(
            f"{api_url}/workflows",
            headers=headers,
            json=workflow,
            timeout=30
        )

        if response.status_code in [200, 201]:
            workflow_data = response.json()
            workflow_id = workflow_data.get('id')

            print(f"✅ Workflow erfolgreich erstellt!")
            print(f"   Workflow ID: {workflow_id}")
            print(f"   Name: {workflow_data.get('name')}")
            print(f"   Webhook URL: https://n8n.juroct.net/webhook/stweg3-email-change-notification")
            print(f"\n📋 Nächste Schritte:")
            print(f"   1. Öffnen Sie n8n: https://n8n.juroct.net")
            print(f"   2. Konfigurieren Sie die SMTP-Credentials im 'E-Mail senden' Node")
            print(f"   3. Aktivieren Sie den Workflow (aktivieren Sie ihn manuell)")

            return workflow_id
        else:
            print(f"❌ Fehler beim Erstellen des Workflows")
            print(f"   Status Code: {response.status_code}")
            print(f"   Response: {response.text}")
            return None

    except requests.exceptions.RequestException as e:
        print(f"❌ Netzwerkfehler: {e}")
        return None


def main():
    print("=" * 60)
    print("N8N Workflow Creator - STWEG3 E-Mail-Benachrichtigungen")
    print("=" * 60)
    print()

    # Load environment variables
    env_vars = load_env()

    api_url = env_vars.get('N8N_API_URL')
    api_key = env_vars.get('N8N_API_KEY')

    if not api_url or not api_key:
        print("❌ N8N_API_URL oder N8N_API_KEY nicht in .env gefunden")
        sys.exit(1)

    print(f"🔗 N8N API URL: {api_url}")
    print()

    # Create workflow
    workflow_id = create_workflow(api_url, api_key)

    if workflow_id:
        print()
        print("=" * 60)
        print("✅ Setup abgeschlossen!")
        print("=" * 60)
    else:
        sys.exit(1)


if __name__ == "__main__":
    main()
