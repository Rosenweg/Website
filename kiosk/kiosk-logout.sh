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
import os
import socket
import struct
import sys
import re
import base64
import time
import urllib.error
import urllib.parse
import urllib.request

CDP_URL = "http://localhost:9222"
SITE_URL = "https://www.rosenweg4303.ch"
LOGOUT_URL = SITE_URL + "/api/auth/logout"
SESSION_KEY = "rosenweg_session"
# Herkuenfte, deren Cookies/Speicher immer geloescht werden — auch wenn kein
# Token gefunden wurde (z. B. Anmeldung haengt nur noch im Authentik-Cookie).
_s = urllib.parse.urlsplit(SITE_URL)
ORIGINS = [_s.scheme + "://" + _s.netloc,
           "https://authentik.rosenweg4303.ch",
           "https://auth.rosenweg4303.ch"]


def page_tabs():
    """Alle Seiten-Tabs (nicht nur den ersten; Service-Worker u. a. ausgenommen)."""
    try:
        tabs = json.loads(urllib.request.urlopen(CDP_URL + "/json", timeout=5).read())
    except (OSError, ValueError):
        return []
    return [t for t in tabs if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]


def recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("CDP-Verbindung geschlossen")
        buf += chunk
    return buf


def ws_connect(ws_url):
    m = re.match(r"ws://([^:/]+):(\d+)(.*)", ws_url)
    if not m:
        return None
    host, port, path = m.group(1), int(m.group(2)), m.group(3)
    s = socket.create_connection((host, port), timeout=5)
    key = base64.b64encode(os.urandom(16)).decode()
    handshake = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        f"Upgrade: websocket\r\n"
        f"Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        f"Sec-WebSocket-Version: 13\r\n\r\n"
    )
    s.sendall(handshake.encode())
    # Kopf vollstaendig lesen, damit kein Rest davon als Frame gedeutet wird
    kopf = b""
    while b"\r\n\r\n" not in kopf:
        kopf += recv_exact(s, 1)
    if b" 101 " not in kopf.split(b"\r\n", 1)[0]:
        s.close()
        return None
    return s


def ws_send(sock, msg_id, method, params=None):
    payload = json.dumps({"id": msg_id, "method": method, "params": params or {}}).encode()
    frame = bytearray([0x81])
    length = len(payload)
    # Client-Frames muessen maskiert sein (RFC 6455)
    if length < 126:
        frame.append(0x80 | length)
    elif length < 65536:
        frame.append(0x80 | 126)
        frame.extend(struct.pack(">H", length))
    else:
        frame.append(0x80 | 127)
        frame.extend(struct.pack(">Q", length))
    maske = os.urandom(4)
    frame.extend(maske)
    frame.extend(bytes(b ^ maske[i % 4] for i, b in enumerate(payload)))
    sock.sendall(frame)


def ws_recv_msg(sock):
    """Eine ganze Nachricht lesen (Laenge, Fragmente, Ping beachten)."""
    teile = []
    while True:
        b1, b2 = recv_exact(sock, 2)
        laenge = b2 & 0x7F
        if laenge == 126:
            laenge = struct.unpack(">H", recv_exact(sock, 2))[0]
        elif laenge == 127:
            laenge = struct.unpack(">Q", recv_exact(sock, 8))[0]
        maske = recv_exact(sock, 4) if b2 & 0x80 else None
        daten = recv_exact(sock, laenge)
        if maske:
            daten = bytes(b ^ maske[i % 4] for i, b in enumerate(daten))
        opcode = b1 & 0x0F
        if opcode == 0x8:
            raise ConnectionError("CDP-Verbindung geschlossen")
        if opcode in (0x9, 0xA):
            continue
        teile.append(daten)
        if b1 & 0x80:
            break
    try:
        return json.loads(b"".join(teile))
    except ValueError:
        return {}


def ws_call(sock, msg_id, method, params=None):
    """Befehl senden und auf DIE Antwort mit dieser id warten (Ereignisse ueberspringen)."""
    ws_send(sock, msg_id, method, params)
    ende = time.time() + 5
    while time.time() < ende:
        msg = ws_recv_msg(sock)
        if msg.get("id") == msg_id:
            return msg
    return {}


class _KeinRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def api_logout(token):
    """API-Sitzung serverseitig beenden; Token im Header, nicht in der URL (Logs)."""
    req = urllib.request.Request(LOGOUT_URL, headers={"Authorization": "Bearer " + token})
    try:
        urllib.request.build_opener(_KeinRedirect).open(req, timeout=10)
    except urllib.error.HTTPError:
        pass  # 302 zu Authentik = erwartet; die Sitzung ist dann schon geloescht
    except OSError as e:
        print("Logout-Aufruf fehlgeschlagen:", e)


LS_LESEN = ("(function(){try{return localStorage.getItem('" + SESSION_KEY
            + "')||''}catch(e){return ''}})()")
LS_LEEREN = "(function(){try{localStorage.clear();sessionStorage.clear()}catch(e){}})()"


def main():
    tabs = page_tabs()
    if not tabs:
        print("No browser tab found.")
        sys.exit(0)

    tokens = []
    socks = []
    for tab in tabs:
        try:
            s = ws_connect(tab["webSocketDebuggerUrl"])
        except OSError:
            s = None
        if s:
            socks.append(s)
    if not socks:
        print("Cannot connect to CDP WebSocket.")
        sys.exit(0)

    try:
        haupt = socks[0]
        # Den Sitzungstoken selbst holen: die API-Sitzung muss serverseitig enden,
        # nicht nur im Browser. Quelle 1: geteiltes Cookie (.rosenweg4303.ch) —
        # browserweit, unabhaengig davon, welche Seite gerade offen ist.
        r = ws_call(haupt, 1, "Network.getAllCookies")
        cookies = r.get("result", {}).get("cookies")
        if cookies is None:
            r = ws_call(haupt, 2, "Storage.getCookies")
            cookies = r.get("result", {}).get("cookies") or []
        for c in cookies:
            if c.get("name") == SESSION_KEY and c.get("value"):
                tokens.append(urllib.parse.unquote(c["value"]))
        # Quelle 2: localStorage jedes Tabs (nur gleiche Herkunft lesbar)
        for i, s in enumerate(socks):
            try:
                r = ws_call(s, 10 + i, "Runtime.evaluate", {"expression": LS_LESEN})
                v = r.get("result", {}).get("result", {}).get("value") or ""
                if v:
                    tokens.append(v)
            except (OSError, ConnectionError):
                pass

        for t in dict.fromkeys(tokens):
            api_logout(t)
        print("Sessions beendet:", len(set(tokens)))

        # Immer aufraeumen, auch ohne gefundenen Token
        for i, s in enumerate(socks):
            try:
                ws_call(s, 100 + i, "Runtime.evaluate", {"expression": LS_LEEREN})
            except (OSError, ConnectionError):
                pass
        ws_call(haupt, 200, "Network.clearBrowserCookies")
        for i, o in enumerate(ORIGINS):
            ws_call(haupt, 210 + i, "Storage.clearDataForOrigin",
                    {"origin": o, "storageTypes": "all"})
        ws_call(haupt, 230, "Network.clearBrowserCache")

        # Zurueck zum Login-Bildschirm
        ws_call(haupt, 240, "Page.navigate", {"url": SITE_URL})
        print("Logout complete. Login screen should appear.")
    finally:
        for s in socks:
            try:
                s.close()
            except OSError:
                pass


if __name__ == "__main__":
    main()
PYEOF

log "Logout script executed."
