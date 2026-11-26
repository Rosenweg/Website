// Attrappe eines Chromecast für die Tests: spricht CASTV2 über TLS wie ein
// echtes Gerät (castv2.Server), kennt aber nur, was der Wächter braucht —
// CONNECT, PING/PONG, GET_STATUS, LAUNCH und die Nachrichten an DashCast bzw.
// den eigenen Empfänger. Das Zertifikat ist selbst signiert und wird zur
// Laufzeit mit openssl erzeugt (ein Chromecast hat auch keins, das man prüfen
// könnte); fehlt openssl, überspringen die Tests.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const castv2 = require('castv2');
const { DASHCAST, EIGEN_NAMESPACE } = require('../lib/castwaechter');

const BACKDROP = { appId: 'E8C28D3C', displayName: 'Backdrop', isIdleScreen: true, sessionId: 'leer', transportId: 'leer' };

function zertifikat() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'castattrappe-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=attrappe', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')],
    { stdio: 'ignore' });
    return { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let zertifikatCache = null;
function opensslDa() {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

class CastAttrappe {
  constructor({ eigeneAppId = null, startVerweigern = false } = {}) {
    this.apps = [{ ...BACKDROP }];
    this.eigeneAppId = eigeneAppId;
    this.startVerweigern = startVerweigern;
    this.eingang = [];          // alle Nachrichten {ns, ziel, daten}
    this.geladen = [];          // was an DashCast/den eigenen Empfänger ging
    this.starts = 0;
    this.n = 0;
  }

  async starten() {
    if (!zertifikatCache) zertifikatCache = zertifikat();
    this.server = new castv2.Server(zertifikatCache);
    this.server.on('message', (client, quelle, ziel, ns, roh) => this.nachricht(client, quelle, ziel, ns, roh));
    await new Promise((ok) => this.server.listen(0, '127.0.0.1', ok));
    this.port = this.server.server.address().port;
    return this;
  }

  stoppen() { if (this.server) this.server.close(); }

  status() { return { applications: this.apps.map((x) => ({ ...x })), volume: { level: 1, muted: false } }; }

  senden(client, quelle, ziel, ns, daten) {
    this.server.send(client, quelle, ziel, ns, JSON.stringify(daten));
  }

  nachricht(client, quelle, ziel, ns, roh) {
    const d = JSON.parse(roh);
    this.eingang.push({ ns, ziel, daten: d });
    if (ns === 'urn:x-cast:com.google.cast.tp.heartbeat' && d.type === 'PING') {
      this.senden(client, ziel, quelle, ns, { type: 'PONG' });
      return;
    }
    if (ns === 'urn:x-cast:com.google.cast.receiver') {
      if (d.type === 'GET_STATUS') {
        this.senden(client, ziel, quelle, ns, { type: 'RECEIVER_STATUS', requestId: d.requestId, status: this.status() });
      } else if (d.type === 'LAUNCH') {
        this.starts += 1;
        if (this.startVerweigern) {
          this.senden(client, ziel, quelle, ns, { type: 'LAUNCH_ERROR', requestId: d.requestId, reason: 'NOT_FOUND' });
          return;
        }
        // Wie ein echtes Gerät: erst der alte Status, dann der neue.
        this.senden(client, ziel, quelle, ns, { type: 'RECEIVER_STATUS', requestId: d.requestId, status: this.status() });
        this.n += 1;
        const sitzung = `sitzung-${this.n}`;
        this.apps = [{ appId: d.appId, displayName: d.appId === DASHCAST.appId ? 'DashCast' : 'Rosenweg Anzeige', sessionId: sitzung, transportId: sitzung }];
        this.inhalt = null;
        setTimeout(() => this.senden(client, ziel, quelle, ns,
          { type: 'RECEIVER_STATUS', requestId: d.requestId, status: this.status() }), 20);
      }
      return;
    }
    const app = this.apps.find((x) => x.transportId === ziel);
    if (!app) return;
    if (ns === DASHCAST.namespace) this.geladen.push(d);
    if (ns === EIGEN_NAMESPACE) {
      if (d.type === 'LADEN') { this.geladen.push(d); this.inhalt = d.url; }
      if (d.type === 'STATUS') this.senden(client, ziel, quelle, ns, { type: 'STATUS', url: this.inhalt || null });
    }
  }

  // ─── Was in der Wirklichkeit passiert ───
  neustart() { this.apps = [{ ...BACKDROP }]; this.inhalt = null; }

  fremdCasten(name = 'YouTube') {
    this.n += 1;
    this.apps = [{ appId: '233637DE', displayName: name, sessionId: `fremd-${this.n}`, transportId: `fremd-${this.n}` }];
  }
}

module.exports = { CastAttrappe, opensslDa };
