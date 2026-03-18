#!/bin/bash
# Rosenweg Kiosk - Inactivity Logout Script
# Called by swayidle after 10 minutes of no mouse/keyboard input.
# Uses Chrome DevTools Protocol (CDP) to check session and trigger logout.

CDP_URL="http://localhost:9222"
SITE_URL="https://www.rosenweg4303.ch"
LOGOUT_URL="https://www.rosenweg4303.ch/api/auth/logout"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] LOGOUT: $1" >> /tmp/kiosk-watchdog.log
}

# Check if Chromium CDP is reachable
if ! curl -s "$CDP_URL/json" > /dev/null 2>&1; then
    log "Chromium CDP not reachable, skipping."
    exit 0
fi

# Use Python to interact with CDP via WebSocket
python3 << 'PYEOF'
import json
import socket
import struct
import sys
import re
import hashlib
import base64
import time
import urllib.request

CDP_URL = "http://localhost:9222"
SITE_URL = "https://www.rosenweg4303.ch"
LOGOUT_URL = "https://www.rosenweg4303.ch/api/auth/logout"

def get_ws_info():
    """Get WebSocket URL and page ID from CDP."""
    tabs = json.loads(urllib.request.urlopen(f"{CDP_URL}/json").read())
    if not tabs:
        return None, None
    return tabs[0].get("webSocketDebuggerUrl", ""), tabs[0].get("id", "")

def ws_connect(ws_url):
    """Connect to CDP WebSocket."""
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
    s.recv(4096)  # Read handshake response
    return s

def ws_send(sock, msg_id, method, params=None):
    """Send a CDP command via WebSocket."""
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
    """Receive a CDP response."""
    data = sock.recv(65536)
    if not data:
        return {}
    # Parse WebSocket frame
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
        print("No browser tab found.")
        sys.exit(0)

    sock = ws_connect(ws_url)
    if not sock:
        print("Cannot connect to CDP WebSocket.")
        sys.exit(0)

    try:
        # Check if session is active
        ws_send(sock, 1, "Runtime.evaluate", {
            "expression": "localStorage.getItem('rosenweg_session') !== null"
        })
        result = ws_recv(sock)
        is_logged_in = result.get("result", {}).get("result", {}).get("value", False)

        if not is_logged_in:
            print("No active session, skipping logout.")
            sys.exit(0)

        print("Active session found. Logging out...")

        # Clear localStorage
        ws_send(sock, 2, "Runtime.evaluate", {
            "expression": "localStorage.clear()"
        })
        ws_recv(sock)

        # Clear sessionStorage
        ws_send(sock, 3, "Runtime.evaluate", {
            "expression": "sessionStorage.clear()"
        })
        ws_recv(sock)

        # Clear cookies
        ws_send(sock, 4, "Network.enable")
        ws_recv(sock)
        ws_send(sock, 5, "Network.clearBrowserCookies")
        ws_recv(sock)

        # Navigate to logout URL
        ws_send(sock, 6, "Page.navigate", {"url": LOGOUT_URL})
        ws_recv(sock)

        # Wait for logout redirect chain
        time.sleep(5)

        # Navigate back to main site (login screen)
        ws_send(sock, 7, "Page.navigate", {"url": SITE_URL})
        ws_recv(sock)

        print("Logout complete. Login screen should appear.")

    finally:
        sock.close()

if __name__ == "__main__":
    main()
PYEOF

log "Logout script executed."
