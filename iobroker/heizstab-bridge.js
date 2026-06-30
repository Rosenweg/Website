// Heizstab Manuell/Auto-Steuerbrücke — eigenständig im ioBroker (ersetzt den
// Python-Dienst heizstab-bridge). Liest 0_userdata.0.heizstab.mode/manual_on
// nativ und stellt SmartFox (100.64.90.62:502) per Modbus TCP. Self-healing:
// gleicht alle 3 s ab + bei jeder State-Änderung, schreibt nur bei Abweichung.
//   AUTO    -> 40400=0            (Control via Modbus AUS -> SmartFox regelt per PV)
//   MANUELL -> 40400=1, 40401=val (1000=100%/EIN, 0=AUS; Aout 0.1%-Schritte)
const net = require('net');
const IP = '100.64.90.62', PORT = 502;
const MODE = '0_userdata.0.heizstab.mode';
const MANON = '0_userdata.0.heizstab.manual_on';

function mbReq(buf) {
  return new Promise((resolve) => {
    const s = new net.Socket(); let done = false, acc = Buffer.alloc(0);
    const fin = (r) => { if (done) return; done = true; try { s.destroy(); } catch (e) {} resolve(r); };
    s.setTimeout(5000);
    s.on('timeout', () => fin(null));
    s.on('error', () => fin(null));
    s.on('data', (d) => { acc = Buffer.concat([acc, d]); if (acc.length >= 9) fin(acc); });
    s.connect(PORT, IP, () => s.write(buf));
  });
}
function frameWrite(addr, vals) {
  const q = vals.length, b = Buffer.alloc(13 + q * 2);
  b.writeUInt16BE(1, 0); b.writeUInt16BE(0, 2); b.writeUInt16BE(7 + q * 2, 4); b.writeUInt8(1, 6);
  b.writeUInt8(0x10, 7); b.writeUInt16BE(addr, 8); b.writeUInt16BE(q, 10); b.writeUInt8(q * 2, 12);
  for (let i = 0; i < q; i++) b.writeUInt16BE(vals[i] & 0xFFFF, 13 + i * 2);
  return b;
}
function frameRead(addr, q) {
  const b = Buffer.alloc(12);
  b.writeUInt16BE(1, 0); b.writeUInt16BE(0, 2); b.writeUInt16BE(6, 4); b.writeUInt8(1, 6);
  b.writeUInt8(0x03, 7); b.writeUInt16BE(addr, 8); b.writeUInt16BE(q, 10);
  return b;
}
async function readReg(addr) {
  const r = await mbReq(frameRead(addr, 1));
  if (!r || r.length < 11 || (r[7] & 0x80)) return null;
  return r.readUInt16BE(9);
}
function desired() {
  const m = getState(MODE);
  if (!m || m.val == null) return null;
  const mo = getState(MANON);
  const manon = !!mo && (mo.val === true || mo.val === 'true' || mo.val === 1);
  if (m.val === 'manuell') return [1, manon ? 1000 : 0];
  return [0, 0];
}
let busy = false, loggedOnce = false;
async function apply() {
  if (busy) return; busy = true;
  try {
    const tgt = desired();
    if (!tgt) return;
    const ctrl = await readReg(40400);
    if (!loggedOnce) { log('[Heizstab-Bridge] aktiv — 40400=' + ctrl + ' Ziel=' + JSON.stringify(tgt)); loggedOnce = true; }
    if (ctrl == null) return;
    let mism = ctrl !== tgt[0];
    if (tgt[0] === 1) { const a = await readReg(40401); if (a != null && a !== tgt[1]) mism = true; }
    if (mism) {
      await mbReq(frameWrite(40400, tgt));
      log('[Heizstab-Bridge] gestellt: 40400=' + tgt[0] + ' 40401=' + tgt[1]);
    }
  } finally { busy = false; }
}
on({ id: MODE, change: 'any' }, apply);
on({ id: MANON, change: 'any' }, apply);
setInterval(apply, 3000);
log('[Heizstab-Bridge] Script gestartet (SmartFox ' + IP + ' Modbus 40400/40401)');
apply();
