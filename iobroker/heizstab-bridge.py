#!/usr/bin/env python3
# Heizstab Manuell/Auto-Brücke: liest Modus aus ioBroker (simple-api REST) und
# stellt SmartFox per Modbus TCP. Self-healing: gleicht alle 3 s ab, schreibt nur
# bei Abweichung (SmartFox quittiert Writes oft verzögert -> Read-Back zählt).
#   AUTO    -> 40400=0            (Control via Modbus AUS -> SmartFox regelt per PV)
#   MANUELL -> 40400=1, 40401=val (val=1000 -> 100%/EIN, 0 -> AUS; Aout 0.1%-Schritte)
import socket, struct, time, urllib.request

SF_IP = "100.64.90.62"; SF_PORT = 502
API = "http://127.0.0.1:8087/getPlainValue/"
MODE = "0_userdata.0.heizstab.mode"
MANON = "0_userdata.0.heizstab.manual_on"

def get_state(sid):
    try:
        with urllib.request.urlopen(API + sid, timeout=4) as r:
            return r.read().decode().strip().strip('"')
    except Exception:
        return None

def mb_req(pdu, timeout=5):
    mbap = struct.pack('>HHHB', 1, 0, len(pdu) + 1, 1)
    try:
        s = socket.create_connection((SF_IP, SF_PORT), timeout=timeout)
        s.sendall(mbap + pdu); r = s.recv(512); s.close(); return r
    except Exception:
        return None

def read_reg(addr):
    r = mb_req(struct.pack('>BHH', 0x03, addr, 1))
    if not r or len(r) < 11 or (r[7] & 0x80):
        return None
    return struct.unpack('>H', r[9:11])[0]

def write_regs(addr, vals):
    pdu = struct.pack('>BHHB', 0x10, addr, len(vals), len(vals) * 2) + b''.join(struct.pack('>H', v & 0xFFFF) for v in vals)
    mb_req(pdu)  # Quittung kommt oft verspätet -> ignorieren, per Read-Back prüfen

def desired():
    mode = get_state(MODE)
    if mode is None:
        return None
    manon = str(get_state(MANON)).lower() in ('true', '1', 'on')
    if mode == 'manuell':
        return (1, 1000 if manon else 0)
    return (0, 0)

print("[heizstab-bridge] start", flush=True)
last_log = None
while True:
    try:
        tgt = desired()
        if tgt is not None:
            ctrl = read_reg(40400)
            if ctrl is not None:
                mism = (ctrl != tgt[0])
                if tgt[0] == 1:
                    aout = read_reg(40401)
                    if aout is not None and aout != tgt[1]:
                        mism = True
                if mism:
                    write_regs(40400, list(tgt))
                    time.sleep(1.0)
                    nc = read_reg(40400)
                    if last_log != tgt:
                        print("[heizstab-bridge] Ziel %s geschrieben, 40400=%s" % (str(tgt), str(nc)), flush=True)
                        last_log = tgt
    except Exception as e:
        print("[heizstab-bridge] err %s" % e, flush=True)
    time.sleep(3)
