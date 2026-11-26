/**
 * Verbindung zu einem Chromecast über das Cast-Protokoll (CASTV2, TLS auf
 * TCP 8009), direkt per IP — kein mDNS, die Geräte stehen in anderen VLANs.
 *
 * Bibliothek: castv2 (npm). Sie macht nur TLS, Rahmen und Protobuf; die
 * wenigen Nachrichten darüber (CONNECT, PING/PONG, GET_STATUS, LAUNCH und die
 * eine Nachricht an den Empfänger) stehen hier. castv2-client oder
 * pychromecast brächten Medien-Steuerung mit, die eine Anzeige nicht braucht
 * — und pychromecast einen zweiten Dienst in Python neben der API.
 *
 * Die Verbindung bleibt offen (Herzschlag alle 5 s), wie bei einem Handy, das
 * castet: Manche Empfänger schliessen sich, wenn der letzte Absender geht.
 * Fällt sie weg (Neustart, WLAN), baut der nächste Lauf sie neu auf.
 */
const { EventEmitter } = require('events');
const castv2 = require('castv2');
const w = require('./castwaechter');

const NS = {
  verbindung: 'urn:x-cast:com.google.cast.tp.connection',
  herzschlag: 'urn:x-cast:com.google.cast.tp.heartbeat',
  empfaenger: 'urn:x-cast:com.google.cast.receiver',
};
const ABSENDER = 'sender-rosenweg';
const GERAET = 'receiver-0';
const HERZSCHLAG_MS = 5000;

// castv2 liest seine Protobuf-Beschreibung beim require() asynchron ein; wer
// sofort sendet, bekommt 'extension not loaded yet'. Einmal abwarten.
let protoBereit = null;
function bereit() {
  if (protoBereit) return protoBereit;
  const { CastMessage } = require('castv2/lib/proto');
  protoBereit = new Promise((ok, fehler) => {
    const start = Date.now();
    const pruefen = () => {
      try {
        CastMessage.serialize({ protocolVersion: 0, sourceId: 'a', destinationId: 'b', namespace: 'c', payloadType: 0, payloadUtf8: '' });
        ok();
      } catch (e) {
        if (Date.now() - start > 5000) { protoBereit = null; fehler(e); } else setTimeout(pruefen, 10);
      }
    };
    pruefen();
  });
  return protoBereit;
}

class CastVerbindung extends EventEmitter {
  constructor(adresse, { port = 8009, zeitlimitMs = 8000, startlimitMs = 20000 } = {}) {
    super();
    this.adresse = adresse;
    this.port = port;
    this.zeitlimitMs = zeitlimitMs;
    // Chromecast 1 braucht für den Start einer Web-App gut zehn Sekunden.
    this.startlimitMs = startlimitMs;
    this.client = null;
    this.offen = false;
    this.anfrage = 1;
    this.warten = new Map();     // requestId -> {ok, fehler, timer}
    this.transporte = new Set(); // Ziele, an die CONNECT schon ging
    this.takt = null;
  }

  async oeffnen() {
    if (this.offen) return this;
    await bereit();
    return new Promise((ok, fehler) => {
      const client = new castv2.Client();
      this.client = client;
      let fertig = false;
      const zeit = setTimeout(() => {
        if (fertig) return;
        fertig = true;
        this.schliessen();
        fehler(new Error(`keine Antwort von ${this.adresse}:${this.port}`));
      }, this.zeitlimitMs);
      client.on('error', (e) => {
        if (!fertig) { fertig = true; clearTimeout(zeit); this.schliessen(); fehler(e); return; }
        this.schliessen();
      });
      client.on('close', () => this.schliessen());
      client.on('message', (quelle, ziel, ns, daten) => this.eingang(quelle, ziel, ns, daten));
      client.connect({ host: this.adresse, port: this.port }, () => {
        if (fertig) return;
        fertig = true;
        clearTimeout(zeit);
        this.offen = true;
        this.senden(GERAET, NS.verbindung, { type: 'CONNECT' });
        this.takt = setInterval(() => {
          try { this.senden(GERAET, NS.herzschlag, { type: 'PING' }); } catch { this.schliessen(); }
        }, HERZSCHLAG_MS);
        if (this.takt.unref) this.takt.unref();
        ok(this);
      });
    });
  }

  schliessen() {
    clearInterval(this.takt);
    this.takt = null;
    const warAuf = this.offen || this.client;
    this.offen = false;
    this.transporte.clear();
    for (const [, v] of this.warten) { clearTimeout(v.timer); v.fehler(new Error('Verbindung getrennt')); }
    this.warten.clear();
    const c = this.client;
    this.client = null;
    if (c) { try { c.close(); } catch { /* schon zu */ } }
    if (warAuf) this.emit('zu');
  }

  senden(ziel, ns, daten) {
    if (!this.client) throw new Error('nicht verbunden');
    this.client.send(ABSENDER, ziel, ns, JSON.stringify(daten));
  }

  eingang(quelle, ziel, ns, roh) {
    let d;
    try { d = JSON.parse(roh); } catch { return; }
    if (ns === NS.herzschlag && d.type === 'PING') {
      try { this.senden(quelle, NS.herzschlag, { type: 'PONG' }); } catch { /* weg */ }
      return;
    }
    if (ns === NS.verbindung && d.type === 'CLOSE') { this.transporte.delete(quelle); return; }
    if (d.requestId != null && this.warten.has(d.requestId)) {
      const v = this.warten.get(d.requestId);
      if (v.passt && !v.passt(d)) return;
      clearTimeout(v.timer);
      this.warten.delete(d.requestId);
      v.ok(d);
      return;
    }
    // Ohne requestId: Rundsendungen des Geräts und Antworten des Empfängers.
    this.emit('nachricht', { quelle, ns, daten: d });
  }

  frage(ziel, ns, daten, limit = this.zeitlimitMs, passt = null) {
    const requestId = this.anfrage++;
    return new Promise((ok, fehler) => {
      const timer = setTimeout(() => { this.warten.delete(requestId); fehler(new Error(`keine Antwort auf ${daten.type}`)); }, limit);
      this.warten.set(requestId, { ok, fehler, timer, passt });
      try { this.senden(ziel, ns, { ...daten, requestId }); } catch (e) { clearTimeout(timer); this.warten.delete(requestId); fehler(e); }
    });
  }

  async status() {
    const a = await this.frage(GERAET, NS.empfaenger, { type: 'GET_STATUS' });
    return a.status || {};
  }

  /** App starten und warten, bis sie im Status steht. Gibt die App zurück. */
  async starten(appId) {
    const a = await this.frage(GERAET, NS.empfaenger, { type: 'LAUNCH', appId }, this.startlimitMs,
      // Ein Chromecast schickt zuerst den alten Status (noch Backdrop) und
      // erst später den mit der neuen App — auf den warten.
      (d) => d.type !== 'RECEIVER_STATUS' || (d.status?.applications || []).some((x) => x.appId === appId));
    if (a.type === 'LAUNCH_ERROR' || a.type === 'INVALID_REQUEST') {
      throw new Error(`Start abgelehnt: ${a.reason || a.type}`);
    }
    const app = (a.status?.applications || []).find((x) => x.appId === appId);
    if (!app) throw new Error('App nach dem Start nicht im Status');
    return app;
  }

  /** An eine laufende App senden (vorher CONNECT auf ihren Transport). */
  anApp(transportId, ns, daten) {
    if (!this.transporte.has(transportId)) {
      this.senden(transportId, NS.verbindung, { type: 'CONNECT' });
      this.transporte.add(transportId);
    }
    this.senden(transportId, ns, daten);
  }

  /** Den eigenen Empfänger fragen, was er zeigt. null, wenn er schweigt. */
  empfaengerFragen(transportId, ns, limit = 3000) {
    return new Promise((ok) => {
      const zeit = setTimeout(() => { this.off('nachricht', hoeren); ok(null); }, limit);
      const hoeren = ({ quelle, ns: n, daten }) => {
        if (quelle !== transportId || n !== ns || daten.type !== 'STATUS') return;
        clearTimeout(zeit);
        this.off('nachricht', hoeren);
        ok(daten);
      };
      this.on('nachricht', hoeren);
      try { this.anApp(transportId, ns, { type: 'STATUS' }); } catch { clearTimeout(zeit); this.off('nachricht', hoeren); ok(null); }
    });
  }
}

// Offene Verbindungen je Adresse, über die Läufe hinweg.
const verbindungen = new Map();

async function verbindungHolen(adresse, opts = {}) {
  const schluessel = `${adresse}:${opts.port || 8009}`;
  let v = verbindungen.get(schluessel);
  if (v && v.offen) return v;
  v = new CastVerbindung(adresse, opts);
  verbindungen.set(schluessel, v);
  v.once('zu', () => { if (verbindungen.get(schluessel) === v) verbindungen.delete(schluessel); });
  await v.oeffnen();
  return v;
}

function alleSchliessen(ausser = null) {
  for (const [k, v] of verbindungen) {
    if (ausser && ausser.has(k)) continue;
    v.schliessen();
    verbindungen.delete(k);
  }
}

/**
 * Ein Lauf für ein Gerät: verbinden, Status lesen, entscheiden, handeln.
 * Gibt {aktion, grund, zustand, wiederhergestellt} zurück; wirft nicht.
 *
 *   geraet: {adresse, port?}
 *   url, reloadMinuten, empfaenger, zustand, pauseMs, notfall, erzwingen, gesperrt, jetzt
 */
async function abgleichen({
  geraet, url, reloadMinuten, empfaenger, zustand, pauseMs, notfall, erzwingen, gesperrt, jetzt, verbindungsOpts,
}) {
  const zeit = () => (typeof jetzt === 'function' ? jetzt() : (jetzt ?? Date.now()));
  if (gesperrt) {
    return w.entscheiden({ gesperrt: true, empfaenger, zustand, jetzt: zeit() });
  }
  let v = null;
  let status = null;
  try {
    v = await verbindungHolen(geraet.adresse, { port: geraet.port, ...(verbindungsOpts || {}) });
    status = await v.status();
  } catch (e) {
    if (v) v.schliessen();
    const r = w.entscheiden({ erreichbar: false, empfaenger, zustand, jetzt: zeit() });
    r.zustand.fehler = String(e.message || e).slice(0, 300);
    return r;
  }

  let app = w.vordergrund(status);
  let meldung = null;
  if (app && app.appId === empfaenger.appId && empfaenger.art === 'eigen') {
    meldung = await v.empfaengerFragen(app.transportId, empfaenger.namespace);
  }
  const e = w.entscheiden({
    erreichbar: true, status, meldung, empfaenger, url, zustand, jetzt: zeit(), pauseMs, notfall, erzwingen,
  });
  e.zustand.fehler = null;
  if (e.aktion !== 'starten' && e.aktion !== 'laden') return e;

  try {
    // Eine Wiederherstellung ist alles, was nicht das blosse Nachladen in
    // die eigene Sitzung ist: nach Neustart, nach fremdem Cast.
    const wiederherstellung = e.aktion === 'starten';
    if (e.aktion === 'starten') app = await v.starten(empfaenger.appId);
    v.anApp(app.transportId, empfaenger.namespace, w.ladeNachricht(empfaenger, url, reloadMinuten));
    e.zustand = w.gestartet(e.zustand, { jetzt: zeit(), sessionId: app.sessionId, url, wiederherstellung });
    e.zustand.app = { id: app.appId, name: app.displayName || app.appId };
    e.wiederhergestellt = wiederherstellung;
  } catch (fehler) {
    e.zustand = w.gescheitert(e.zustand, { jetzt: zeit(), fehler: fehler.message });
    e.aktion = 'gescheitert';
    e.grund = `Start gescheitert: ${fehler.message}`;
  }
  return e;
}

module.exports = { CastVerbindung, verbindungHolen, alleSchliessen, abgleichen, NS };
