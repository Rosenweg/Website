// Pruefung der Zaehler-Ziele (host/port/type) gegen SSRF.
//
// Hintergrund (16.11.2026): Ueber die offenen Admin-Endpunkte wurden Schein-
// Zaehler angelegt (100.64.2.1:22, 100.64.2.53:5432, Shelly-HTTP auf beliebige
// Hosts). Der Collector hat dann per Modbus/HTTP genau dorthin verbunden und die
// Antwort bzw. Fehlermeldung zurueckgegeben — ein Portscanner im Hausnetz.
//
// Regeln:
//   - type nur modbus | shelly | smartfox
//   - host nur als IP-Literal (keine Namen: DNS-Rebinding / interne Namen)
//   - host muss in METER_NETWORKS liegen (CIDR-Liste, Default = Zaehlernetz)
//   - nie Loopback, Link-Local, Multicast, unspezifiziert, der Collector selbst
//     oder der DB-Host (auch wenn sie in einem Zaehlernetz laegen)
//   - modbus nur auf MODBUS_ALLOWED_PORTS (Default 502)
//   - shelly/smartfox sprechen immer http://<host>/... (Port 80); das Feld
//     port wird dort nicht verwendet.
const net = require('net');
const os = require('os');
const dns = require('dns').promises;

const METER_TYPES = ['modbus', 'shelly', 'smartfox'];

function parseCidrList(str) {
  return String(str || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const [addr, bitsStr] = s.split('/');
      const family = net.isIP(addr);
      if (!family) throw new Error(`METER_NETWORKS: ungueltige Adresse "${s}"`);
      const bits = bitsStr === undefined ? (family === 4 ? 32 : 128) : parseInt(bitsStr, 10);
      if (!Number.isInteger(bits) || bits < 0 || bits > (family === 4 ? 32 : 128)) {
        throw new Error(`METER_NETWORKS: ungueltige Praefixlaenge "${s}"`);
      }
      return { addr, bits, family: family === 4 ? 'ipv4' : 'ipv6' };
    });
}

function parsePortList(str) {
  const ports = String(str || '')
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(p => Number.isInteger(p) && p > 0 && p < 65536);
  return new Set(ports);
}

// Immer verboten, unabhaengig von METER_NETWORKS.
function buildDenyList() {
  const deny = new net.BlockList();
  deny.addSubnet('0.0.0.0', 8, 'ipv4');        // "dieses Netz" / unspezifiziert
  deny.addSubnet('127.0.0.0', 8, 'ipv4');      // Loopback
  deny.addSubnet('169.254.0.0', 16, 'ipv4');   // Link-Local
  deny.addSubnet('224.0.0.0', 4, 'ipv4');      // Multicast
  deny.addSubnet('240.0.0.0', 4, 'ipv4');      // reserviert + Broadcast
  deny.addAddress('::', 'ipv6');
  deny.addAddress('::1', 'ipv6');
  deny.addSubnet('fe80::', 10, 'ipv6');        // Link-Local
  deny.addSubnet('ff00::', 8, 'ipv6');         // Multicast
  // IPv4-mapped (::ffff:a.b.c.d) NICHT hier: net.BlockList prueft IPv4-Adressen
  // auch gegen ::ffff:0:0/96 und wuerde dann alles sperren. Siehe isV4Mapped().
  return deny;
}

// IPv4-mapped/-kompatible IPv6-Adressen umgehen sonst die IPv4-Regeln.
function isV4Mapped(h) {
  // WHATWG-URL normalisiert IPv6 kanonisch (z.B. 0:0:0:0:0:ffff:1.2.3.4 -> [::ffff:102:304]).
  let canon;
  try { canon = new URL(`http://[${h}]/`).hostname; } catch { return true; }
  return canon.startsWith('[::ffff:') || /^\[::[0-9a-f]{1,4}:[0-9a-f]{1,4}\]$/.test(canon);
}

function normalizeHost(host) {
  let h = String(host == null ? '' : host).trim();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  return h;
}

// Host fuer eine http://-URL (IPv6 in eckigen Klammern).
function httpHost(host) {
  const h = normalizeHost(host);
  return net.isIPv6(h) ? `[${h}]` : h;
}

function createMeterTargetValidator(opts = {}) {
  const networks = parseCidrList(opts.meterNetworks);
  const modbusPorts = parsePortList(opts.modbusPorts);
  if (networks.length === 0) throw new Error('METER_NETWORKS ist leer');
  if (modbusPorts.size === 0) throw new Error('MODBUS_ALLOWED_PORTS ist leer');

  const allow = new net.BlockList();
  for (const n of networks) allow.addSubnet(n.addr, n.bits, n.family);
  const deny = buildDenyList();

  // Eigene Adressen + DB-Host + explizit gesperrte Hosts (FORBIDDEN_HOSTS).
  const blockedHosts = new Set();
  const addBlocked = (ip) => { if (net.isIP(ip)) blockedHosts.add(ip.toLowerCase()); };
  for (const ifs of Object.values(os.networkInterfaces())) {
    for (const i of ifs || []) addBlocked(i.address.split('%')[0]);
  }
  for (const ip of opts.blockedHosts || []) addBlocked(normalizeHost(ip));

  function validate({ type, host, port }) {
    const t = type || 'modbus';
    if (!METER_TYPES.includes(t)) return `Unbekannter Zaehlertyp "${t}"`;
    const h = normalizeHost(host);
    const fam = net.isIP(h);
    if (!fam) return 'host muss eine IP-Adresse sein (keine Namen, kein Port)';
    const family = fam === 4 ? 'ipv4' : 'ipv6';
    if (fam === 6 && isV4Mapped(h)) return `host ${h} ist nicht erlaubt (IPv4-mapped IPv6)`;
    if (deny.check(h, family)) return `host ${h} ist nicht erlaubt (Loopback/Link-Local/Multicast/reserviert)`;
    if (blockedHosts.has(h.toLowerCase())) return `host ${h} ist nicht erlaubt (Collector/DB)`;
    if (!allow.check(h, family)) return `host ${h} liegt ausserhalb der Zaehlernetze (METER_NETWORKS)`;
    if (t === 'modbus') {
      const p = port == null || port === '' ? 502 : Number(port);
      if (!Number.isInteger(p) || !modbusPorts.has(p)) {
        return `Modbus-Port ${port} nicht erlaubt (erlaubt: ${[...modbusPorts].join(', ')})`;
      }
    }
    return null; // ok
  }

  return {
    validate,
    networks: networks.map(n => `${n.addr}/${n.bits}`),
    modbusPorts: [...modbusPorts],
    addBlockedHost: addBlocked,
  };
}

// DB-Host (z.B. Compose-Name "energy-db") aufloesen, damit er gesperrt wird.
async function resolveAll(name) {
  if (!name) return [];
  if (net.isIP(name)) return [name];
  try {
    const r = await dns.lookup(name, { all: true });
    return r.map(x => x.address);
  } catch {
    return [];
  }
}

module.exports = { createMeterTargetValidator, resolveAll, httpHost, normalizeHost, METER_TYPES };
