#!/usr/bin/env python3
"""
N8N Workflow Cleanup - Listet und löscht doppelte Workflows
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


def list_workflows(api_url, api_key):
    """Listet alle Workflows auf"""

    headers = {
        "Accept": "application/json",
        "X-N8N-API-KEY": api_key
    }

    try:
        response = requests.get(
            f"{api_url}/workflows",
            headers=headers,
            timeout=30
        )

        if response.status_code == 200:
            workflows = response.json()

            # Filter für STWEG3 E-Mail Workflows
            stweg3_workflows = [w for w in workflows.get('data', [])
                               if 'STWEG3' in w.get('name', '') and 'E-Mail' in w.get('name', '')]

            print(f"\n📋 Gefundene STWEG3 E-Mail-Änderungs-Workflows: {len(stweg3_workflows)}")
            print("=" * 80)

            for wf in stweg3_workflows:
                print(f"\nID: {wf['id']}")
                print(f"Name: {wf['name']}")
                print(f"Aktiv: {wf['active']}")
                print(f"Erstellt: {wf['createdAt']}")
                print(f"Aktualisiert: {wf['updatedAt']}")
                print("-" * 80)

            return stweg3_workflows
        else:
            print(f"❌ Fehler beim Abrufen der Workflows")
            print(f"   Status Code: {response.status_code}")
            print(f"   Response: {response.text}")
            return []

    except requests.exceptions.RequestException as e:
        print(f"❌ Netzwerkfehler: {e}")
        return []


def delete_workflow(api_url, api_key, workflow_id):
    """Löscht einen Workflow"""

    headers = {
        "Accept": "application/json",
        "X-N8N-API-KEY": api_key
    }

    try:
        response = requests.delete(
            f"{api_url}/workflows/{workflow_id}",
            headers=headers,
            timeout=30
        )

        if response.status_code in [200, 204]:
            print(f"✅ Workflow {workflow_id} erfolgreich gelöscht")
            return True
        else:
            print(f"❌ Fehler beim Löschen des Workflows {workflow_id}")
            print(f"   Status Code: {response.status_code}")
            print(f"   Response: {response.text}")
            return False

    except requests.exceptions.RequestException as e:
        print(f"❌ Netzwerkfehler: {e}")
        return False


def main():
    print("=" * 80)
    print("N8N Workflow Cleanup - STWEG3 E-Mail-Benachrichtigungen")
    print("=" * 80)

    # Load environment variables
    env_vars = load_env()

    api_url = env_vars.get('N8N_API_URL')
    api_key = env_vars.get('N8N_API_KEY')

    if not api_url or not api_key:
        print("❌ N8N_API_URL oder N8N_API_KEY nicht in .env gefunden")
        sys.exit(1)

    # List workflows
    workflows = list_workflows(api_url, api_key)

    if len(workflows) > 1:
        print(f"\n⚠️  Es wurden {len(workflows)} doppelte Workflows gefunden!")
        print("\nMöchten Sie die älteren Duplikate löschen? (Behalte nur den neuesten)")

        # Sortiere nach Erstellungsdatum (neuester zuerst)
        workflows_sorted = sorted(workflows, key=lambda x: x['createdAt'], reverse=True)

        print(f"\n✓ Behalten: {workflows_sorted[0]['id']} (erstellt: {workflows_sorted[0]['createdAt']})")

        if len(workflows_sorted) > 1:
            print(f"\n❌ Zu löschen:")
            for wf in workflows_sorted[1:]:
                print(f"   - {wf['id']} (erstellt: {wf['createdAt']})")

            response = input("\nFortfahren? (j/n): ")

            if response.lower() == 'j':
                for wf in workflows_sorted[1:]:
                    delete_workflow(api_url, api_key, wf['id'])

                print("\n✅ Cleanup abgeschlossen!")
                print(f"Verbleibender Workflow: {workflows_sorted[0]['id']}")
            else:
                print("\n❌ Abgebrochen")
    elif len(workflows) == 1:
        print(f"\n✅ Nur ein Workflow gefunden - kein Cleanup nötig")
        print(f"   ID: {workflows[0]['id']}")
    else:
        print(f"\n⚠️  Keine STWEG3 E-Mail-Workflows gefunden")


if __name__ == "__main__":
    main()
