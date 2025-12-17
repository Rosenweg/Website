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
workflow_id = "m3swn76BpgrTrUG6"

headers = {
    "Accept": "application/json",
    "X-N8N-API-KEY": api_key
}

# Get latest execution
response = requests.get(
    f"{api_url}/executions",
    headers=headers,
    params={"workflowId": workflow_id, "limit": 1},
    timeout=30
)

executions = response.json()['data']
if executions:
    latest = executions[0]
    exec_id = latest['id']

    print(f"Latest Execution ID: {exec_id}")
    print(f"Status: {latest.get('status', 'N/A')}")
    print(f"Finished: {latest.get('finished', False)}")
    print(f"Started: {latest['startedAt']}")
    print(f"Stopped: {latest['stoppedAt']}")

    # Get detailed execution
    detail_response = requests.get(
        f"{api_url}/executions/{exec_id}",
        headers=headers,
        timeout=30
    )

    detail = detail_response.json()

    if 'data' in detail and 'resultData' in detail['data']:
        result = detail['data']['resultData']

        # Check for errors
        if 'error' in result:
            print("\n❌ WORKFLOW ERROR:")
            print(json.dumps(result['error'], indent=2))

        # Check node execution
        if 'runData' in result:
            print("\n📋 NODE EXECUTIONS:")
            for node_name, runs in result['runData'].items():
                if runs and len(runs) > 0:
                    run = runs[0]
                    if 'error' in run:
                        print(f"\n❌ {node_name}: ERROR")
                        print(f"   Message: {run['error'].get('message', 'N/A')}")
                    else:
                        print(f"✅ {node_name}: Success")
