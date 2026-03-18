#!/bin/bash
# ============================================================================
# Rosenweg Kiosk Setup Script
# ============================================================================
# Run this on a fresh Debian 13 (Trixie) minimal installation.
# Reads configuration from private GitHub repo (Rosenweg/kiosk-config).
#
# Prerequisites:
#   - SSH deploy key at /root/deploy-key (injected via preseed/ISO)
#   - Network connection
#
# Usage:
#   chmod +x setup-kiosk.sh
#   sudo ./setup-kiosk.sh
#   reboot
# ============================================================================

set -euo pipefail

CONFIG_REPO="git@github.com:Rosenweg/kiosk-config.git"
CONFIG_DIR="/opt/kiosk-config"
DEPLOY_KEY="/root/deploy-key"

# --- Check root ---
if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: This script must be run as root."
    exit 1
fi

echo "=== Rosenweg Kiosk Setup ==="
echo ""

# --- 1. Install packages ---
echo "[1/11] Installing packages..."
apt-get update -qq
apt-get install -y -qq \
    cage \
    chromium \
    python3 \
    swayidle \
    fonts-liberation \
    fonts-noto \
    network-manager \
    systemd-timesyncd \
    nftables \
    curl \
    jq \
    git \
    openssh-client

# --- 2. Clone private config repo ---
echo "[2/11] Cloning private config repo..."
if [ ! -f "$DEPLOY_KEY" ]; then
    echo "ERROR: Deploy key not found at $DEPLOY_KEY"
    echo "Place the SSH deploy key there before running this script."
    exit 1
fi

chmod 600 "$DEPLOY_KEY"
export GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o StrictHostKeyChecking=accept-new"

if [ -d "$CONFIG_DIR" ]; then
    cd "$CONFIG_DIR" && git pull
else
    git clone "$CONFIG_REPO" "$CONFIG_DIR"
fi

# --- 3. Read config ---
echo "[3/11] Reading configuration..."
CONFIG_FILE="$CONFIG_DIR/config.json"
if [ ! -f "$CONFIG_FILE" ]; then
    echo "ERROR: config.json not found in private repo."
    exit 1
fi

HOSTNAME=$(jq -r '.hostname // "rosenweg-kiosk"' "$CONFIG_FILE")
ROOT_PW=$(jq -r '.root_password // empty' "$CONFIG_FILE")
WIFI_SSID=$(jq -r '.wifi.ssid // empty' "$CONFIG_FILE")
WIFI_PW=$(jq -r '.wifi.password // empty' "$CONFIG_FILE")
KIOSK_URL=$(jq -r '.kiosk.url // "https://www.rosenweg4303.ch"' "$CONFIG_FILE")
TIMEOUT=$(jq -r '.kiosk.inactivity_timeout_seconds // 600' "$CONFIG_FILE")
TIMEZONE=$(jq -r '.kiosk.timezone // "Europe/Zurich"' "$CONFIG_FILE")
LOG_INTERVAL=$(jq -r '.logging.push_interval_minutes // 60' "$CONFIG_FILE")

# Build allowed domains list for Chromium policy
ALLOWED_DOMAINS=$(jq -r '.kiosk.allowed_domains // ["www.rosenweg4303.ch", "authentik.rosenweg4303.ch"] | .[]' "$CONFIG_FILE")

# --- 4. Set hostname and root password ---
echo "[4/11] Configuring system..."
hostnamectl set-hostname "$HOSTNAME"
if [ -n "$ROOT_PW" ] && [ "$ROOT_PW" != "CHANGE_ME" ]; then
    echo "root:$ROOT_PW" | chpasswd
fi

# --- 5. Create kiosk user ---
echo "[5/11] Creating kiosk user..."
if ! id -u kiosk &>/dev/null; then
    useradd -m -s /bin/bash kiosk
fi
passwd -l kiosk

# Set up SSH for kiosk user (for log pushing)
mkdir -p /home/kiosk/.ssh
cp "$DEPLOY_KEY" /home/kiosk/.ssh/deploy-key
chmod 600 /home/kiosk/.ssh/deploy-key
cat > /home/kiosk/.ssh/config << 'EOF'
Host github.com
    IdentityFile ~/.ssh/deploy-key
    StrictHostKeyChecking accept-new
EOF
chown -R kiosk:kiosk /home/kiosk/.ssh

# --- 6. Set timezone and NTP ---
timedatectl set-timezone "$TIMEZONE"
timedatectl set-ntp true

# --- 7. Auto-login on tty1 ---
echo "[6/11] Configuring auto-login..."
mkdir -p /etc/systemd/system/getty@tty1.service.d

cat > /etc/systemd/system/getty@tty1.service.d/autologin.conf << 'EOF'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin kiosk --noclear %I $TERM
Type=idle
EOF

# --- 8. Systemd services ---
echo "[7/11] Creating systemd services..."
KIOSK_UID=$(id -u kiosk)

cat > /etc/systemd/system/kiosk-runtime-dir.service << RTEOF
[Unit]
Description=Create XDG_RUNTIME_DIR for kiosk user
Before=getty@tty1.service

[Service]
Type=oneshot
ExecStart=/bin/mkdir -p /run/user/${KIOSK_UID}
ExecStart=/bin/chown kiosk:kiosk /run/user/${KIOSK_UID}
ExecStart=/bin/chmod 700 /run/user/${KIOSK_UID}

[Install]
WantedBy=multi-user.target
RTEOF

cat > /etc/systemd/system/disable-blanking.service << 'EOF'
[Unit]
Description=Disable console blanking

[Service]
Type=oneshot
ExecStart=/usr/bin/setterm --blank 0 --powerdown 0 --powersave off
StandardOutput=tty
TTYPath=/dev/tty1

[Install]
WantedBy=multi-user.target
EOF

# --- 9. Kiosk scripts ---
echo "[8/11] Installing kiosk scripts..."

# Browser launcher (uses URL from config)
cat > /home/kiosk/kiosk-browser.sh << BROWSEREOF
#!/bin/bash
# Rosenweg Kiosk - Chromium Launcher

# Clear previous session data
rm -rf /home/kiosk/.config/chromium/Default/Local\ Storage/* 2>/dev/null
rm -rf /home/kiosk/.config/chromium/Default/Session\ Storage/* 2>/dev/null
rm -rf /home/kiosk/.config/chromium/Default/Cookies* 2>/dev/null
rm -rf /home/kiosk/.config/chromium/Default/Cache/* 2>/dev/null

exec chromium \\
    --kiosk \\
    --no-first-run \\
    --disable-translate \\
    --disable-infobars \\
    --disable-suggestions-service \\
    --disable-save-password-bubble \\
    --disable-session-crashed-bubble \\
    --disable-features=TranslateUI \\
    --disable-component-update \\
    --noerrdialogs \\
    --disable-pinch \\
    --overscroll-history-navigation=0 \\
    --remote-debugging-port=9222 \\
    --autoplay-policy=no-user-gesture-required \\
    --check-for-update-interval=31536000 \\
    --disable-background-networking \\
    "${KIOSK_URL}"
BROWSEREOF

# Logout script (called by swayidle on inactivity)
cat > /home/kiosk/kiosk-logout.sh << LOGOUTEOF
#!/bin/bash
# Rosenweg Kiosk - Inactivity Logout Script

CDP_URL="http://localhost:9222"

log() {
    echo "[\$(date '+%Y-%m-%d %H:%M:%S')] LOGOUT: \$1" >> /var/log/kiosk-watchdog.log
}

if ! curl -s "\$CDP_URL/json" > /dev/null 2>&1; then
    log "Chromium CDP not reachable, skipping."
    exit 0
fi

python3 << 'PYEOF'
import json
import socket
import struct
import sys
import re
import base64
import time
import urllib.request

CDP_URL = "http://localhost:9222"
SITE_URL = "${KIOSK_URL}"
LOGOUT_URL = "${KIOSK_URL}/api/auth/logout"

def get_ws_info():
    tabs = json.loads(urllib.request.urlopen(f"{CDP_URL}/json").read())
    if not tabs:
        return None, None
    return tabs[0].get("webSocketDebuggerUrl", ""), tabs[0].get("id", "")

def ws_connect(ws_url):
    m = re.match(r"ws://([^:]+):(\d+)(.*)", ws_url)
    if not m:
        return None
    host, port, path = m.group(1), int(m.group(2)), m.group(3)
    s = socket.create_connection((host, port), timeout=5)
    key = base64.b64encode(b"kiosk-logout-key").decode()
    handshake = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        f"Upgrade: websocket\r\n"
        f"Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        f"Sec-WebSocket-Version: 13\r\n\r\n"
    )
    s.send(handshake.encode())
    s.recv(4096)
    return s

def ws_send(sock, msg_id, method, params=None):
    msg = json.dumps({"id": msg_id, "method": method, "params": params or {}})
    payload = msg.encode()
    frame = bytearray([0x81])
    length = len(payload)
    if length < 126:
        frame.append(length)
    elif length < 65536:
        frame.append(126)
        frame.extend(struct.pack(">H", length))
    else:
        frame.append(127)
        frame.extend(struct.pack(">Q", length))
    frame.extend(payload)
    sock.send(frame)

def ws_recv(sock):
    data = sock.recv(65536)
    if not data:
        return {}
    offset = 2
    length = data[1] & 0x7F
    if length == 126:
        offset = 4
    elif length == 127:
        offset = 10
    try:
        return json.loads(data[offset:])
    except (json.JSONDecodeError, IndexError):
        return {}

def main():
    ws_url, page_id = get_ws_info()
    if not ws_url:
        sys.exit(0)

    sock = ws_connect(ws_url)
    if not sock:
        sys.exit(0)

    try:
        ws_send(sock, 1, "Runtime.evaluate", {
            "expression": "localStorage.getItem('rosenweg_session') !== null"
        })
        result = ws_recv(sock)
        is_logged_in = result.get("result", {}).get("result", {}).get("value", False)

        if not is_logged_in:
            sys.exit(0)

        ws_send(sock, 2, "Runtime.evaluate", {"expression": "localStorage.clear()"})
        ws_recv(sock)
        ws_send(sock, 3, "Runtime.evaluate", {"expression": "sessionStorage.clear()"})
        ws_recv(sock)
        ws_send(sock, 4, "Network.enable")
        ws_recv(sock)
        ws_send(sock, 5, "Network.clearBrowserCookies")
        ws_recv(sock)
        ws_send(sock, 6, "Page.navigate", {"url": LOGOUT_URL})
        ws_recv(sock)
        time.sleep(5)
        ws_send(sock, 7, "Page.navigate", {"url": SITE_URL})
        ws_recv(sock)
    finally:
        sock.close()

if __name__ == "__main__":
    main()
PYEOF

log "Logout script executed."
LOGOUTEOF

chmod +x /home/kiosk/kiosk-browser.sh
chmod +x /home/kiosk/kiosk-logout.sh
chown kiosk:kiosk /home/kiosk/kiosk-browser.sh /home/kiosk/kiosk-logout.sh

# Log pusher script
cat > /home/kiosk/kiosk-log-push.sh << 'LOGPUSHEOF'
#!/bin/bash
# Rosenweg Kiosk - Push logs to private GitHub repo

CONFIG_DIR="/opt/kiosk-config"
HOSTNAME=$(hostname)
LOG_DIR="$CONFIG_DIR/logs/$HOSTNAME"
TIMESTAMP=$(date '+%Y-%m-%d_%H-%M-%S')

export GIT_SSH_COMMAND="ssh -i /home/kiosk/.ssh/deploy-key -o StrictHostKeyChecking=accept-new"

cd "$CONFIG_DIR" || exit 1

# Pull latest
git pull --quiet 2>/dev/null || true

# Create log directory
mkdir -p "$LOG_DIR"

# Collect system info
cat > "$LOG_DIR/status.json" << STATUSEOF
{
    "hostname": "$HOSTNAME",
    "timestamp": "$(date -Iseconds)",
    "uptime": "$(uptime -p)",
    "disk_usage": "$(df -h / | tail -1 | awk '{print $5}')",
    "memory_usage": "$(free -m | awk '/Mem:/ {printf "%.0f%%", $3/$2*100}')",
    "ip_address": "$(hostname -I | awk '{print $1}')",
    "chromium_running": $(pgrep -c chromium 2>/dev/null || echo 0)
}
STATUSEOF

# Copy watchdog log
if [ -f /var/log/kiosk-watchdog.log ]; then
    tail -1000 /var/log/kiosk-watchdog.log > "$LOG_DIR/watchdog.log"
fi

# Copy system log excerpts
journalctl --since "1 hour ago" --no-pager -q 2>/dev/null | tail -200 > "$LOG_DIR/system.log"

# Commit and push
cd "$CONFIG_DIR"
git add "logs/$HOSTNAME/" 2>/dev/null
if git diff --cached --quiet; then
    exit 0  # Nothing to commit
fi
git -c user.name="Kiosk $HOSTNAME" -c user.email="kiosk@rosenweg4303.ch" \
    commit -m "logs: $HOSTNAME status update $TIMESTAMP" --quiet
git push --quiet 2>/dev/null || true
LOGPUSHEOF

chmod +x /home/kiosk/kiosk-log-push.sh
chown kiosk:kiosk /home/kiosk/kiosk-log-push.sh

# Bash profile (boot chain) - uses timeout from config
cat > /home/kiosk/.bash_profile << PROFILEEOF
# Rosenweg Kiosk - Auto-start on tty1
if [ "\$(tty)" = "/dev/tty1" ]; then
    export XDG_RUNTIME_DIR=/run/user/\$(id -u)

    # Start inactivity monitor: logout after ${TIMEOUT}s of no input
    swayidle -w timeout ${TIMEOUT} '/home/kiosk/kiosk-logout.sh' &

    # Start kiosk browser in cage (Wayland compositor)
    # -s flag hides cursor when idle
    exec cage -s -- /home/kiosk/kiosk-browser.sh
fi
PROFILEEOF
chown kiosk:kiosk /home/kiosk/.bash_profile

# --- 10. Chromium URL restriction policy ---
echo "[9/11] Installing Chromium policies..."
mkdir -p /etc/chromium/policies/managed

# Build allowlist from config
ALLOWLIST="["
for domain in $ALLOWED_DOMAINS; do
    ALLOWLIST="$ALLOWLIST\"https://$domain\",\"https://$domain/*\","
done
ALLOWLIST="${ALLOWLIST%,}]"

cat > /etc/chromium/policies/managed/kiosk-policy.json << POLICYEOF
{
    "URLBlocklist": ["*"],
    "URLAllowlist": $ALLOWLIST,
    "BookmarkBarEnabled": false,
    "BrowserSignin": 0,
    "DefaultBrowserSettingEnabled": false,
    "DeveloperToolsAvailability": 2,
    "DownloadRestrictions": 3,
    "EditBookmarksEnabled": false,
    "ExtensionInstallBlocklist": ["*"],
    "FullscreenAllowed": true,
    "IncognitoModeAvailability": 1,
    "ManagedBookmarks": [],
    "PasswordManagerEnabled": false,
    "PrintingEnabled": false,
    "SavingBrowserHistoryDisabled": true,
    "SearchSuggestEnabled": false,
    "ShowHomeButton": false
}
POLICYEOF

# --- 11. Security hardening ---
echo "[10/11] Applying security hardening..."

# Disable VT switching
mkdir -p /etc/systemd/logind.conf.d
cat > /etc/systemd/logind.conf.d/kiosk.conf << 'EOF'
[Login]
NAutoVTs=1
ReserveVT=0
EOF

systemctl mask ctrl-alt-del.target

cat > /etc/modprobe.d/disable-usb-storage.conf << 'EOF'
blacklist usb-storage
blacklist uas
EOF

systemctl disable ssh.service 2>/dev/null || true
systemctl mask ssh.service 2>/dev/null || true

# Firewall
cat > /etc/nftables.conf << 'EOF'
#!/usr/sbin/nft -f
flush ruleset

table inet filter {
    chain input {
        type filter hook input priority 0; policy drop;
        iif lo accept
        ct state established,related accept
        udp dport 68 accept
    }

    chain forward {
        type filter hook forward priority 0; policy drop;
    }

    chain output {
        type filter hook output priority 0; policy drop;
        oif lo accept
        ct state established,related accept
        udp dport 53 accept
        tcp dport 53 accept
        tcp dport 443 accept
        tcp dport 22 accept
        udp dport 123 accept
        udp dport 67 accept
    }
}
EOF

# --- 12. Log push timer ---
echo "[11/11] Enabling services..."

cat > /etc/systemd/system/kiosk-log-push.service << 'EOF'
[Unit]
Description=Push kiosk logs to GitHub
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=kiosk
ExecStart=/home/kiosk/kiosk-log-push.sh
Environment=HOME=/home/kiosk
EOF

cat > /etc/systemd/system/kiosk-log-push.timer << TIMEREOF
[Unit]
Description=Push kiosk logs periodically

[Timer]
OnBootSec=5min
OnUnitActiveSec=${LOG_INTERVAL}min
Persistent=true

[Install]
WantedBy=timers.target
TIMEREOF

# WiFi setup
if [ -n "$WIFI_SSID" ] && [ "$WIFI_SSID" != "CHANGE_ME" ]; then
    systemctl start NetworkManager
    sleep 3
    nmcli device wifi connect "$WIFI_SSID" password "$WIFI_PW" 2>/dev/null || \
        echo "WARNING: WiFi connection to '$WIFI_SSID' failed. Configure manually after reboot."
fi

# Enable services
systemctl daemon-reload
systemctl enable kiosk-runtime-dir.service
systemctl enable disable-blanking.service
systemctl enable nftables.service
systemctl enable NetworkManager.service
systemctl enable kiosk-log-push.timer

# Protect kiosk files
chattr +i /home/kiosk/.bash_profile
chattr +i /home/kiosk/kiosk-browser.sh
chattr +i /home/kiosk/kiosk-logout.sh

echo ""
echo "=== Setup complete! ==="
echo ""
echo "Configuration loaded from: $CONFIG_FILE"
echo "  Hostname:    $HOSTNAME"
echo "  Kiosk URL:   $KIOSK_URL"
echo "  Timeout:     ${TIMEOUT}s inactivity"
echo "  Log push:    every ${LOG_INTERVAL} min"
echo ""
echo "Run 'reboot' to start the kiosk."
echo ""
