#!/usr/bin/env python3
"""
N8N Workflow Updater - Beide E-Mail-Adressen benachrichtigen
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
    """Erstellt Workflow mit zwei E-Mail-Benachrichtigungen"""

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

            # 2. Code Node - Prepare Email HTML
            {
                "parameters": {
                    "jsCode": """const webhookData = $input.item.json.body;

// Build change list HTML
let changeListHTML = '';
if (webhookData.changeList && Array.isArray(webhookData.changeList)) {
    changeListHTML = webhookData.changeList.map(change => `<li>${change}</li>`).join('\\n                    ');
}

// Format timestamp to human-readable German format
let formattedTimestamp = webhookData.timestamp;
if (webhookData.timestamp) {
    const date = new Date(webhookData.timestamp);
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    formattedTimestamp = `${day}.${month}.${year} um ${hours}:${minutes} Uhr`;
}

return {
    json: {
        ...webhookData,
        changeListHTML: changeListHTML,
        timestamp: formattedTimestamp
    }
};"""
                },
                "name": "Prepare Email Data",
                "type": "n8n-nodes-base.code",
                "typeVersion": 2,
                "position": [450, 300]
            },

            # 3. E-Mail an ALTE Adresse (Sicherheitswarnung)
            {
                "parameters": {
                    "fromEmail": "r9kaiseraugst@gmail.com",
                    "toEmail": "={{ $json.oldEmail }}",
                    "subject": "={{ '⚠️ Ihre E-Mail-Adresse wurde geändert - STWEG ' + $json.stwegNummer }}",
                    "emailFormat": "html",
                    "text": """<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #dc2626 0%, #991b1b 100%); color: white; padding: 20px; border-radius: 8px 8px 0 0; }
        .content { background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; }
        .changes { background: white; padding: 15px; margin: 20px 0; border-left: 4px solid #dc2626; border-radius: 4px; }
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
            <h1 style="margin: 0;">⚠️ STWEG {{ $json.stwegNummer }} Rosenweg</h1>
            <p style="margin: 5px 0 0 0; opacity: 0.9;">Sicherheitsbenachrichtigung</p>
        </div>

        <div class="content">
            <h2>Ihre E-Mail-Adresse wurde geändert</h2>

            <p>Hallo,</p>

            <p>Ihre E-Mail-Adresse für <strong>{{ $json.wohnung }}</strong> ({{ $json.type }}) wurde soeben im STWEG {{ $json.stwegNummer }} Admin-Bereich geändert.</p>

            <div class="changes">
                <h3 style="margin-top: 0;">📝 Folgende Änderungen wurden vorgenommen:</h3>
                <ul style="list-style: disc; padding-left: 20px; margin: 10px 0;">
                    {{ $json.changeListHTML }}
                </ul>
            </div>

            <div class="warning">
                <strong>⚠️ Wichtig:</strong> Falls Sie diese Änderung nicht selbst vorgenommen haben oder nicht damit einverstanden sind,
                wenden Sie sich bitte umgehend an den Ausschuss (<strong>{{ $json.ausschussEmail }}</strong>) oder an <strong>{{ $json.changedBy }}</strong>,
                der diese Änderung durchgeführt hat.
            </div>

            <p><strong>Details zur Änderung:</strong></p>
            <ul style="background: white; padding: 15px; border-radius: 4px;">
                <li><strong>Zeitpunkt:</strong> {{ $json.timestamp }}</li>
                <li><strong>Geändert von:</strong> {{ $json.changedBy }}</li>
                <li><strong>Wohnung:</strong> {{ $json.wohnung }}</li>
                <li><strong>Art:</strong> {{ $json.type }}</li>
            </ul>

            <p>Diese E-Mail wurde an Ihre <strong>alte</strong> E-Mail-Adresse (<strong>{{ $json.oldEmail }}</strong>) gesendet,
            um Sie über die Änderung zu informieren.</p>

            <p><strong>Neue E-Mail-Adresse:</strong> {{ $json.newEmail }}</p>
        </div>

        <div class="footer">
            <p>© 2025 STWEG {{ $json.stwegNummer }} - Teil der STWEG-Kooperation Rosenweg<br>
            {{ $json.stwegAdresse }}, {{ $json.stwegOrt }}</p>
            <p style="margin-top: 15px; font-size: 11px; color: #6b7280;">
                Diese E-Mail wurde automatisch generiert. Bitte antworten Sie nicht direkt auf diese E-Mail.
            </p>
        </div>
    </div>
</body>
</html>""",
                    "options": {}
                },
                "name": "E-Mail an alte Adresse",
                "type": "n8n-nodes-base.emailSend",
                "typeVersion": 2,
                "position": [650, 200]
            },

            # 4. E-Mail an NEUE Adresse (Bestätigung)
            {
                "parameters": {
                    "fromEmail": "r9kaiseraugst@gmail.com",
                    "toEmail": "={{ $json.newEmail }}",
                    "subject": "={{ '✅ Willkommen! Ihre Kontaktdaten wurden aktualisiert - STWEG ' + $json.stwegNummer }}",
                    "emailFormat": "html",
                    "text": """<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; padding: 20px; border-radius: 8px 8px 0 0; }
        .content { background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; }
        .changes { background: white; padding: 15px; margin: 20px 0; border-left: 4px solid #10b981; border-radius: 4px; }
        .footer { background: #1f2937; color: #9ca3af; padding: 20px; text-align: center; font-size: 12px; border-radius: 0 0 8px 8px; }
        .info { background: #dbeafe; border: 1px solid #3b82f6; padding: 15px; border-radius: 4px; margin: 20px 0; }
        ul { list-style: none; padding: 0; }
        li { padding: 8px 0; border-bottom: 1px solid #e5e7eb; }
        li:last-child { border-bottom: none; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1 style="margin: 0;">✅ STWEG {{ $json.stwegNummer }} Rosenweg</h1>
            <p style="margin: 5px 0 0 0; opacity: 0.9;">Bestätigung</p>
        </div>

        <div class="content">
            <h2>Ihre Kontaktdaten wurden erfolgreich aktualisiert</h2>

            <p>Hallo,</p>

            <p>Ihre Kontaktdaten für <strong>{{ $json.wohnung }}</strong> ({{ $json.type }}) wurden erfolgreich im STWEG {{ $json.stwegNummer }} Admin-Bereich aktualisiert.</p>

            <div class="changes">
                <h3 style="margin-top: 0;">📝 Folgende Änderungen wurden vorgenommen:</h3>
                <ul style="list-style: disc; padding-left: 20px; margin: 10px 0;">
                    {{ $json.changeListHTML }}
                </ul>
            </div>

            <div class="info">
                <strong>✅ Bestätigung:</strong> Diese E-Mail-Adresse (<strong>{{ $json.newEmail }}</strong>) ist nun als Ihre aktuelle Kontaktadresse registriert.
                Alle zukünftigen Benachrichtigungen werden an diese Adresse gesendet.
            </div>

            <p><strong>Details zur Änderung:</strong></p>
            <ul style="background: white; padding: 15px; border-radius: 4px;">
                <li><strong>Zeitpunkt:</strong> {{ $json.timestamp }}</li>
                <li><strong>Geändert von:</strong> {{ $json.changedBy }}</li>
                <li><strong>Wohnung:</strong> {{ $json.wohnung }}</li>
                <li><strong>Art:</strong> {{ $json.type }}</li>
                <li><strong>Vorherige E-Mail:</strong> {{ $json.oldEmail }}</li>
            </ul>

            <p>Falls Sie Fragen haben oder diese Änderung nicht vorgenommen haben, wenden Sie sich bitte an den Ausschuss (<strong>{{ $json.ausschussEmail }}</strong>) oder an <strong>{{ $json.changedBy }}</strong>.</p>
        </div>

        <div class="footer">
            <p>© 2025 STWEG {{ $json.stwegNummer }} - Teil der STWEG-Kooperation Rosenweg<br>
            {{ $json.stwegAdresse }}, {{ $json.stwegOrt }}</p>
            <p style="margin-top: 15px; font-size: 11px; color: #6b7280;">
                Diese E-Mail wurde automatisch generiert. Bitte antworten Sie nicht direkt auf diese E-Mail.
            </p>
        </div>
    </div>
</body>
</html>""",
                    "options": {}
                },
                "name": "E-Mail an neue Adresse",
                "type": "n8n-nodes-base.emailSend",
                "typeVersion": 2,
                "position": [650, 400]
            },

            # 5. Merge Node (wartet auf beide E-Mails)
            {
                "parameters": {
                    "mode": "combine"
                },
                "name": "Merge",
                "type": "n8n-nodes-base.merge",
                "typeVersion": 2,
                "position": [850, 300]
            },

            # 6. Response Node
            {
                "parameters": {
                    "respondWith": "json",
                    "responseBody": "={{ { \"success\": true, \"message\": \"Notifications sent to both addresses\", \"timestamp\": $now } }}",
                    "options": {
                        "responseCode": 200
                    }
                },
                "name": "Response",
                "type": "n8n-nodes-base.respondToWebhook",
                "typeVersion": 1,
                "position": [1050, 300]
            }
        ],
        "connections": {
            "Webhook": {
                "main": [
                    [
                        {
                            "node": "Prepare Email Data",
                            "type": "main",
                            "index": 0
                        }
                    ]
                ]
            },
            "Prepare Email Data": {
                "main": [
                    [
                        {
                            "node": "E-Mail an alte Adresse",
                            "type": "main",
                            "index": 0
                        },
                        {
                            "node": "E-Mail an neue Adresse",
                            "type": "main",
                            "index": 0
                        }
                    ]
                ]
            },
            "E-Mail an alte Adresse": {
                "main": [
                    [
                        {
                            "node": "Merge",
                            "type": "main",
                            "index": 0
                        }
                    ]
                ]
            },
            "E-Mail an neue Adresse": {
                "main": [
                    [
                        {
                            "node": "Merge",
                            "type": "main",
                            "index": 1
                        }
                    ]
                ]
            },
            "Merge": {
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
            print(f"     - E-Mail an alte Adresse (Sicherheitswarnung)")
            print(f"     - E-Mail an neue Adresse (Bestätigung)")
            print(f"     - Beide E-Mails werden parallel versendet")

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
    print("N8N Workflow Updater - Beide E-Mail-Adressen benachrichtigen")
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
        print("📧 Jetzt werden ZWEI E-Mails versendet:")
        print("   1. An die alte E-Mail-Adresse (Sicherheitswarnung)")
        print("   2. An die neue E-Mail-Adresse (Bestätigung)")
    else:
        sys.exit(1)


if __name__ == "__main__":
    main()
