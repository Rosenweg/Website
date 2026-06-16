"""
Minimaler Asterisk-Manager-Interface-(AMI)-Client fuer die lokale PBX-API.

Laeuft IN CT 220 -> verbindet auf 127.0.0.1:5038 und liest User/Secret direkt
aus /etc/asterisk/manager.conf. Dadurch lebt das AMI-Secret an genau EINER
Stelle (Asterisk-Config) und muss nicht in die API-Config/ins Repo dupliziert
werden.
"""
import re
import socket

MANAGER_CONF = "/etc/asterisk/manager.conf"
AMI_HOST = "127.0.0.1"
AMI_PORT = 5038


def _read_credentials(path=MANAGER_CONF):
    """Erstes [section] mit secret = ... gilt als AMI-User. Gibt (user, secret)."""
    user, secret, section = None, None, None
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith(";"):
                    continue
                m = re.match(r"\[(.+?)\]", line)
                if m:
                    section = m.group(1)
                    continue
                m = re.match(r"secret\s*=\s*(\S+)", line)
                if m and section and section != "general":
                    user, secret = section, m.group(1)
                    break
    except FileNotFoundError:
        pass
    return user, secret


def _send(commands, timeout=8):
    user, secret = _read_credentials()
    if not user or not secret:
        raise RuntimeError("AMI-Credentials nicht in manager.conf gefunden")
    s = socket.create_connection((AMI_HOST, AMI_PORT), timeout=timeout)
    try:
        s.settimeout(timeout)
        s.recv(256)  # Banner
        payload = f"Action: Login\r\nUsername: {user}\r\nSecret: {secret}\r\n\r\n"
        for action in commands:
            block = "".join(f"{k}: {v}\r\n" for k, v in action.items())
            payload += block + "\r\n"
        payload += "Action: Logoff\r\n\r\n"
        s.sendall(payload.encode())
        buf = b""
        while True:
            try:
                chunk = s.recv(65535)
            except socket.timeout:
                break
            if not chunk:
                break
            buf += chunk
            if b"Goodbye" in buf or len(buf) > 262144:
                break
        return buf.decode(errors="replace")
    finally:
        try:
            s.close()
        except OSError:
            pass


def command(cli_command):
    """Fuehrt ein Asterisk-CLI-Kommando via AMI 'Command' aus, gibt Roh-Output."""
    return _send([{"Action": "Command", "Command": cli_command, "ActionID": "rw"}])


def trunk_status():
    """Liefert dict {registered, expires_in_seconds, raw}."""
    out = command("pjsip show registrations")
    m = re.search(r"Registered\s+\(exp\.\s+(\d+)s\)", out)
    auth_failed = "Authentication failed" in out
    return {
        "registered": bool(m),
        "expires_in_seconds": int(m.group(1)) if m else None,
        "ami_auth_failed": auth_failed,
        "raw": out[:2000],
    }


def originate(channel, context, exten, priority=1, callerid=None, timeout_ms=30000, variables=None):
    """Async Originate (z.B. um ein Mitglied in die ConfBridge zu holen)."""
    action = {
        "Action": "Originate",
        "Channel": channel,
        "Context": context,
        "Exten": exten,
        "Priority": str(priority),
        "Async": "true",
        "Timeout": str(timeout_ms),
    }
    if callerid:
        action["CallerID"] = callerid
    if variables:
        # AMI: mehrere Variable-Header werden konkateniert; hier simpel via Variable: k=v
        action["Variable"] = ",".join(f"{k}={v}" for k, v in variables.items())
    return _send([action])


def reload_pjsip():
    return command("pjsip reload")


if __name__ == "__main__":
    import json
    print(json.dumps(trunk_status(), indent=2))
