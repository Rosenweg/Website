#!/usr/bin/env python3
import requests
import json
from pathlib import Path

def load_env():
    env_path = Path(__file__).parent.parent / '.env'
    env_vars = {}
    with open(env_path, 'r') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                env_vars[key] = value
    return env_vars

env = load_env()
api_url = env['N8N_API_URL']
api_key = env['N8N_API_KEY']

headers = {
    "Accept": "application/json",
    "X-N8N-API-KEY": api_key
}

# Get latest execution ID
response = requests.get(
    f"{api_url}/executions",
    headers=headers,
    params={"workflowId": "m3swn76BpgrTrUG6", "limit": 1},
    timeout=30
)

exec_id = response.json()['data'][0]['id']

# Get full execution detail
detail_response = requests.get(
    f"{api_url}/executions/{exec_id}",
    headers=headers,
    timeout=30
)

print(json.dumps(detail_response.json(), indent=2))
