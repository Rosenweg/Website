import json
from datetime import datetime
import os

# Get current directory
current_dir = os.path.dirname(os.path.abspath(__file__))

# Load API responses
with open(os.path.join(current_dir, 'networks_full.json'), 'r', encoding='utf-8') as f:
    networks_data = json.load(f)
with open(os.path.join(current_dir, 'devices_full.json'), 'r', encoding='utf-8') as f:
    devices_data = json.load(f)

# Parse networks
all_networks = []
wan_connections = []

for n in networks_data['data']:
    if n.get('purpose') == 'wan':
        wan_conn = {
            "name": n['name'],
            "type": n.get('wan_type', 'dhcp'),
            "dns": [],
            "speed": {
                "download": f"{n.get('wan_provider_capabilities', {}).get('download_kilobits_per_second', 0) // 1000} Mbps",
                "upload": f"{n.get('wan_provider_capabilities', {}).get('upload_kilobits_per_second', 0) // 1000} Mbps"
            },
            "load_balance_weight": n.get('wan_load_balance_weight', 0),
            "failover_priority": n.get('wan_failover_priority', 0),
            "status": "primary" if n.get('wan_failover_priority') == 1 else "failover-only",
            "ipv6_enabled": n.get('ipv6_enabled', False),
            "ipv6_type": n.get('wan_type_v6', 'disabled')
        }

        # DNS servers (IPv4 and IPv6)
        if n.get('wan_dns1'):
            wan_conn['dns'].append(n['wan_dns1'])
        if n.get('wan_dns2'):
            wan_conn['dns'].append(n['wan_dns2'])
        if n.get('wan_ipv6_dns1'):
            if 'ipv6_dns' not in wan_conn:
                wan_conn['ipv6_dns'] = []
            wan_conn['ipv6_dns'].append(n['wan_ipv6_dns1'])
        if n.get('wan_ipv6_dns2'):
            if 'ipv6_dns' not in wan_conn:
                wan_conn['ipv6_dns'] = []
            wan_conn['ipv6_dns'].append(n['wan_ipv6_dns2'])

        wan_connections.append(wan_conn)

    elif n.get('purpose') != 'remote-user-vpn':
        network = {
            "name": n['name'],
            "vlan": n.get('vlan'),
            "vlan_enabled": n.get('vlan_enabled', False),
            "purpose": n.get('purpose', 'vlan-only'),
            "enabled": n.get('enabled', True),
            "ipv6_enabled": n.get('ipv6_enabled', False)
        }

        # IPv4
        if n.get('ip_subnet'):
            network["subnet"] = n['ip_subnet']
            network["gateway"] = n['ip_subnet'].split('/')[0]

        # IPv6
        if n.get('ipv6_ra_enabled') or n.get('ipv6_enabled'):
            ipv6_info = {}
            if n.get('ipv6_subnet'):
                ipv6_info['subnet'] = n['ipv6_subnet']
            if n.get('ipv6_interface_type'):
                ipv6_info['type'] = n['ipv6_interface_type']
            if n.get('ipv6_ra_enabled'):
                ipv6_info['ra_enabled'] = True
            if ipv6_info:
                network['ipv6'] = ipv6_info

        # DHCP
        if n.get('dhcpd_start'):
            network["dhcp_range"] = {
                "start": n['dhcpd_start'],
                "end": n['dhcpd_stop']
            }

        if n.get('domain_name'):
            network["domain"] = n['domain_name']

        # DNS servers
        dns_servers = []
        for i in range(1, 5):
            dns_key = f'dhcpd_dns_{i}'
            if n.get(dns_key):
                dns_servers.append(n[dns_key])
        if dns_servers:
            network["dns"] = dns_servers

        # Special features
        features = {}
        if n.get('dhcpd_boot_enabled'):
            features['dhcp_boot_enabled'] = True
            if n.get('dhcpd_boot_server'):
                features['boot_server'] = n['dhcpd_boot_server']
            if n.get('dhcpd_boot_filename'):
                features['boot_filename'] = n['dhcpd_boot_filename']

        if n.get('igmp_snooping'):
            features['igmp_snooping'] = True

        if n.get('dhcpguard_enabled'):
            features['dhcp_guard'] = True

        if n.get('purpose') == 'guest':
            features['client_isolation'] = True
            features['internet_only'] = True

        if features:
            network['features'] = features

        network["description"] = n.get('name', '')
        network["active_clients"] = 0

        all_networks.append(network)

# Sort networks by VLAN
all_networks.sort(key=lambda x: x.get('vlan') or 9999)

# Parse devices
all_devices = []
for d in devices_data['data']:
    device = {
        "name": d.get('name', 'Unknown'),
        "model": d.get('model', 'Unknown'),
        "ip": d.get('ip', 'N/A'),
        "mac": d.get('mac', 'N/A'),
        "status": "online" if d.get('state') == 1 else "offline"
    }

    # IPv6 address
    if d.get('ipv6'):
        device['ipv6'] = d['ipv6']

    # Device type and role
    device_type = d.get('type', '')
    if device_type == 'uap':
        device["role"] = "access_point"
        device["type"] = d.get('model', 'AP')

        # Radio information for APs
        if d.get('radio_table'):
            radios = {}
            for radio in d['radio_table']:
                band = radio.get('name', '')
                radios[band] = {
                    "channel": radio.get('channel'),
                    "width": f"{radio.get('ht', 20)}MHz",
                    "tx_power": radio.get('tx_power')
                }
            if radios:
                device['radios'] = radios

    elif device_type == 'usw':
        device["role"] = "switch"
        device["type"] = d.get('model', 'Switch')

        # Port count
        if d.get('num_port'):
            device['ports'] = d['num_port']

    elif device_type == 'ugw' or device_type == 'udm':
        device["role"] = "gateway"
        device["type"] = d.get('model', 'Gateway')
    else:
        device["role"] = device_type
        device["type"] = d.get('model', 'Unknown')

    # Firmware version
    if d.get('version'):
        device['firmware'] = d['version']

    # Uptime
    if d.get('uptime'):
        device['uptime_seconds'] = d['uptime']

    # Description and location from name
    device["description"] = d.get('name', '')

    # Try to extract location from name
    name = d.get('name', '')
    if 'R9' in name:
        if 'Dach' in name:
            device["location"] = "R9 Dach"
        elif 'Heizungsraum' in name:
            device["location"] = "R9 Heizungsraum"
        elif 'Hauptverteilung' in name:
            device["location"] = "R9 Hauptverteilung"
        elif 'Kooperation' in name:
            if '2OG' in name:
                device["location"] = "Kooperation R9 2OG"
            elif '1OG' in name:
                device["location"] = "Kooperation R9 1OG"
            elif 'EG' in name:
                device["location"] = "Kooperation R9 EG"
            elif 'UG' in name:
                device["location"] = "Kooperation R9 UG"
            elif 'Keller' in name:
                device["location"] = "Kooperation R9 Keller"
            else:
                device["location"] = "Kooperation R9"
        elif 'Technikraum' in name or 'T+T' in name:
            device["location"] = "Technikraum RW9"
        else:
            device["location"] = "Rosenweg 9"
    elif 'R13' in name:
        device["location"] = "Rosenweg 13"
    else:
        device["location"] = "Unknown"

    # Client count
    device["clients"] = d.get('num_sta', 0)

    all_devices.append(device)

# Count device types
device_stats = {
    "total_devices": len(all_devices),
    "access_points": len([d for d in all_devices if d['role'] == 'access_point']),
    "switches": len([d for d in all_devices if d['role'] == 'switch']),
    "gateway": len([d for d in all_devices if d['role'] == 'gateway']),
    "active_clients": sum([d.get('clients', 0) for d in all_devices]),
    "total_vlans": len([n for n in all_networks if n.get('vlan')]),
    "total_networks": len(all_networks)
}

# VPN info (extract from networks if exists)
vpn_info = None
for n in networks_data['data']:
    if n.get('purpose') == 'remote-user-vpn':
        vpn_info = {
            "type": "WireGuard",
            "enabled": n.get('enabled', False),
            "subnet": n.get('ip_subnet', '192.168.9.1/24'),
            "port": n.get('remote_user_vpn_port', 51820),
            "interface": "wan",
            "description": n.get('name', 'VPN Server')
        }
        break

# Create output
output = {
    "generated_at": datetime.utcnow().isoformat() + 'Z',
    "source": "UniFi Network Controller API",
    "api_version": "v2",
    "unifi_controller": {
        "url": "https://100.64.9.1",
        "api_endpoint": "/proxy/network/api",
        "location": "UDM-Pro Technikraum RW9"
    },
    "statistics": device_stats,
    "devices": all_devices,
    "networks": all_networks,
    "wan": wan_connections
}

if vpn_info:
    output['vpn'] = vpn_info

# Write to file
output_file = os.path.join(current_dir, 'network-data.json')
with open(output_file, 'w', encoding='utf-8') as f:
    json.dump(output, f, indent=2, ensure_ascii=False)

print(f"✓ Updated network-data.json created")
print(f"✓ Total devices: {device_stats['total_devices']}")
print(f"✓ Total networks: {device_stats['total_networks']}")
print(f"✓ Total VLANs: {device_stats['total_vlans']}")
print(f"✓ IPv6 enabled networks: {len([n for n in all_networks if n.get('ipv6_enabled')])}")
