// node --test api/test/kartenadmin.test.js — Admin-Aktionen mit der Karte
// (lib/kartenadmin.js): Karte = Schluessel, Protokoll, Quittung, Bestaetigung
// per E-Mail fuer die zwoelf heiklen Aktionen. Ohne Datenbank (Speicher im RAM).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ka = require('../lib/kartenadmin');
const { anmeldung } = require('../lib/stufen');

function ramSpeicher() {
  const zeilen = new Map(); // hash -> eintrag
  return {
    zeilen,
    async anlegen(e, h) { zeilen.set(h, { ...e, status: 'wartet', erledigt: null }); },
    async verwerfen(id) { for (const [h, z] of zeilen) if (z.id === id) zeilen.delete(h); },
    async lesen(h) { return zeilen.get(h) || null; },
    async beanspruchen(h, jetzt = Date.now()) {
      const z = zeilen.get(h);
      if (!z || z.status !== 'wartet' || z.ablauf <= jetzt) return null;
      z.status = 'laeuft'; z.erledigt = jetzt; return { ...z };
    },
    async abschliessen(id, status, code) { for (const z of zeilen.values()) if (z.id === id) { z.status = status; z.code = code; } },
    async ablehnen(h, jetzt = Date.now()) {
      const z = zeilen.get(h);
      if (!z || z.status !== 'wartet') return null;
      z.status = 'abgelehnt'; z.erledigt = jetzt; return { ...z };
    },
  };
}

function umgebung(extra = {}) {
  const u = { mails: [], protokoll: [], technik: [], widerrufen: [], ausgefuehrt: [], speicher: ramSpeicher() };
  ka.einrichten({
    speicher: u.speicher, MAIL_FROM: 'portal@example.org', PORTAL_URL: 'https://portal.example.org',
    senden: async (m, trigger) => { u.mails.push({ ...m, trigger }); },
    protokollieren: (aktion, f) => u.protokoll.push({ aktion, ...f }),
    technikMelden: async (t) => { u.technik.push(t); },
    personLaden: async () => ({ aktiv: true, groups: ['technik'] }),
    sitzungenWiderrufen: async (wo, grund) => { u.widerrufen.push({ wo, grund }); },
    ausfuehren: async (e, ausweis) => {
      // wie die API beim Loopback: Ausweis genau einmal, fuer genau diese Anfrage
      const a = ka.ausweisEinloesen(ausweis, e.methode, e.url);
      u.ausgefuehrt.push({ e, a });
      return a ? { status: 200, text: '{"ok":true}' } : { status: 401, text: '{"error":"Bestaetigung abgelaufen"}' };
    },
    ...extra,
  });
  return u;
}

function anfrage(art, methode = 'PUT', url = '/api/permissions', body = { permissions: [] }) {
  return {
    method: methode, originalUrl: url, baseUrl: '', path: url, body, auth: anmeldung(art),
    user: { id: 7, email: 'Stefan@Example.org', name: 'Stefan' },
    appKarte: ['karte', 'qr', 'handy'].includes(art) ? { id: 'ks_' + '1'.repeat(32), app: 'ch.rosenweg4303.profil', app_name: 'Rosenweg Profil', geraet: 'Galaxy A15', karte: '1234-5678' } : undefined,
    absenderIp: '203.0.113.9',
  };
}
function antwort() {
  const r = { statusCode: 200, body: null, fertig: [],
    status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; },
    once(ev, fn) { if (ev === 'finish') this.fertig.push(fn); }, beenden() { this.fertig.forEach(f => f()); } };
  return r;
}
const tokenAus = (mail) => (mail.text.match(/karten-bestaetigung\/([A-Za-z0-9_-]+)/) || [])[1];

test('Aktion in verstaendlichem Deutsch', () => {
  assert.equal(ka.aktionText('PUT', '/api/permissions'), 'Rechteverwaltung: geändert');
  assert.equal(ka.aktionText('POST', '/api/stations/admin/abc/block'), 'Stationen: gesperrt');
  assert.equal(ka.aktionText('POST', '/api/access/doors/5/unlock'), 'Türen und Zutritt: Tür geöffnet');
  assert.equal(ka.aktionText('DELETE', '/api/proxmox/acl'), 'Proxmox-Rechte: gelöscht');
  assert.equal(ka.aktionText('POST', '/api/ssh/me/schluessel'), 'Eigene SSH-Schlüssel: angelegt bzw. ausgelöst');
  assert.equal(ka.pfadNormal('/api/SSH//Matrix/?x=1'), 'ssh/matrix');
});

test('Karte darf Admin-Aktionen; schreibende werden protokolliert und quittiert', () => {
  const u = umgebung();
  const req = anfrage('karte', 'POST', '/api/stations/admin/abc/block');
  const res = antwort();
  let weiter = false;
  ka.mitKarteProtokollieren(req, res, () => { weiter = true; });
  assert.equal(weiter, true);                       // nichts gesperrt
  res.beenden();
  assert.equal(u.protokoll.length, 1);
  const p = u.protokoll[0];
  assert.equal(p.aktion, 'admin-mit-karte');
  assert.equal(p.email, 'stefan@example.org');
  assert.equal(p.durch, 'karte:ks_' + '1'.repeat(32));
  assert.equal(p.displayId, '1234-5678');
  assert.match(p.detail, /Stationen: gesperrt · POST \/api\/stations\/admin\/abc\/block · 200 · App Rosenweg Profil, Gerät Galaxy A15, IP 203\.0\.113\.9/);
  assert.equal(ka._quittung()._offen('stefan@example.org'), 1);
  // einmal je Anfrage, auch wenn Waechter und Route beide vermerken
  assert.equal(ka.vermerken(req, res), false);
});

test('Nicht protokolliert: Konto, Lesen', () => {
  const u = umgebung();
  for (const [art, m] of [['website', 'POST'], ['app', 'DELETE'], ['pat', 'PUT'], ['karte', 'GET']]) {
    const res = antwort();
    ka.vermerken(anfrage(art, m, '/api/pbx/config'), res);
    res.beenden();
  }
  assert.equal(u.protokoll.length, 0);
});

test('Quittung gebuendelt: erste nach kurzer Zeit, weitere hoechstens alle 10 Minuten', async () => {
  let jetzt = 0; const timer = []; const gesendet = [];
  const b = ka.neuerBuendler({ senden: (email, l) => gesendet.push([email, l.length]), ersteMs: 60000, fensterMs: 600000,
    jetzt: () => jetzt, timer: (fn, ms) => { timer.push({ fn, ms }); return timer.length; } });
  b.hinzu('a@x', { n: 1 }); b.hinzu('a@x', { n: 2 }); b.hinzu('a@x', { n: 3 });
  assert.equal(timer.length, 1); assert.equal(timer[0].ms, 60000);
  jetzt = 60000; timer[0].fn(); await Promise.resolve();
  assert.deepEqual(gesendet, [['a@x', 3]]);
  jetzt = 120000; b.hinzu('a@x', { n: 4 });
  assert.equal(timer[1].ms, 540000);                // bis 10 min nach der letzten Mail
  b.hinzu('b@x', { n: 1 });
  assert.equal(timer[2].ms, 60000);                 // andere Person: eigene Mail
});

test('Quittungs-Mail: Aktion, Herkunft, Link zum Abmelden; abschaltbar', async () => {
  const m = ka.quittungMail('a@x', [{ zeit: Date.UTC(2026, 10, 27, 13, 0), text: 'Stationen: gesperrt', ok: true, app: 'Rosenweg Profil', geraet: 'Galaxy', ip: '1.2.3.4' }], 'https://p');
  assert.match(m.subject, /Mit deiner Rosenweg-Karte: Stationen: gesperrt/);
  assert.match(m.text, /Mit deiner Rosenweg-Karte wurde im Portal ausgeführt/);
  assert.match(m.text, /27\.11\.2026.*14:00.*Stationen: gesperrt — App Rosenweg Profil, Gerät Galaxy, IP 1\.2\.3\.4/);
  assert.match(m.text, /Warst du das nicht\? Karte sofort sperren: alle Apps abmelden unter https:\/\/p\/profil\.html#app-sitzungen/);
  assert.match(m.html, /technik@rosenweg4303\.ch/);
});

test('Heikle Aktion mit der Karte: 202, Mail mit Link, Eintrag; nichts ausgefuehrt', async () => {
  const u = umgebung();
  const res = antwort();
  let weiter = false;
  await ka.bestaetigungVerlangen(anfrage('qr'), res, () => { weiter = true; });
  assert.equal(weiter, false);
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.bestaetigung, 'email');
  assert.match(res.body.id, /^kb_[0-9a-f]{24}$/);
  assert.ok(Date.parse(res.body.ablauf) > Date.now());
  assert.match(res.body.hinweis, /Bitte bestätige in der E-Mail/);
  assert.equal(res.body.email, 's…@example.org');
  assert.equal(u.mails.length, 1);
  assert.equal(u.mails[0].to, 'stefan@example.org');
  assert.equal(u.mails[0].trigger, 'karten-bestaetigung');
  assert.match(u.mails[0].subject, /Bitte bestätigen: Rechteverwaltung: geändert/);
  assert.match(u.mails[0].text, /App Rosenweg Profil, Gerät Galaxy A15, IP 203\.0\.113\.9/);
  assert.ok(tokenAus(u.mails[0]));
  assert.equal(u.speicher.zeilen.size, 1);
  assert.equal([...u.speicher.zeilen.values()][0].status, 'wartet');
  assert.equal(u.protokoll.some(p => p.aktion === 'bestaetigung-angefragt'), true);
  assert.equal(u.ausgefuehrt.length, 0);
  // Mail im Speicher nur als Hash: das Token steht nirgends im Klartext
  assert.equal([...u.speicher.zeilen.keys()][0].length, 64);
  assert.ok(!JSON.stringify([...u.speicher.zeilen.values()]).includes(tokenAus(u.mails[0])));
});

test('Mit dem Konto laufen die heiklen Aktionen direkt', async () => {
  const u = umgebung();
  for (const art of ['website', 'app', 'pat', 'bestaetigt']) {
    let weiter = false;
    await ka.bestaetigungVerlangen(anfrage(art), antwort(), () => { weiter = true; });
    assert.equal(weiter, true, art);
  }
  assert.equal(u.mails.length, 0);
});

test('Bestaetigen fuehrt aus — genau einmal; fremdes Token und zweiter Klick scheitern', async () => {
  const u = umgebung();
  await ka.bestaetigungVerlangen(anfrage('karte', 'POST', '/api/ssh/matrix', { host: 'h', login: 'l' }), antwort(), () => {});
  const token = tokenAus(u.mails[0]);
  assert.equal((await ka.bestaetigen('x'.repeat(43))).ok, false);   // fremdes Token
  const r = await ka.bestaetigen(token);
  assert.equal(r.ok, true, r.meldung);
  assert.equal(u.ausgefuehrt.length, 1);
  const { e, a } = u.ausgefuehrt[0];
  assert.equal(e.methode, 'POST');
  assert.deepEqual(e.body, { host: 'h', login: 'l' });
  assert.equal(a.email, 'stefan@example.org');
  assert.deepEqual(a.groups, ['technik']);           // Rechte zum Ausfuehrungszeitpunkt
  assert.equal(u.protokoll.some(p => p.aktion === 'bestaetigt' && p.erfolg), true);
  const zweit = await ka.bestaetigen(token);
  assert.equal(zweit.ok, false);
  assert.match(zweit.meldung, /schon bestätigt/);
  assert.equal(u.ausgefuehrt.length, 1);
});

test('Abgelaufen: nichts ausgefuehrt', async () => {
  const u = umgebung();
  await ka.bestaetigungVerlangen(anfrage('karte'), antwort(), () => {});
  const token = tokenAus(u.mails[0]);
  const r = await ka.bestaetigen(token, Date.now() + (ka.BESTAETIGUNG_MIN + 1) * 60 * 1000);
  assert.equal(r.ok, false);
  assert.match(r.meldung, /abgelaufen/);
  assert.equal(u.ausgefuehrt.length, 0);
});

test('Konto inzwischen gesperrt: nicht ausgefuehrt', async () => {
  const u = umgebung({ personLaden: async () => ({ aktiv: false, groups: [] }) });
  await ka.bestaetigungVerlangen(anfrage('karte'), antwort(), () => {});
  const r = await ka.bestaetigen(tokenAus(u.mails[0]));
  assert.equal(r.ok, false);
  assert.equal(u.ausgefuehrt.length, 0);
});

test('Ablehnen: verworfen, Sitzung abgemeldet, Technik gemeldet; danach alle abmelden', async () => {
  const u = umgebung();
  await ka.bestaetigungVerlangen(anfrage('karte'), antwort(), () => {});
  const token = tokenAus(u.mails[0]);
  const r = await ka.ablehnen(token);
  assert.equal(r.ok, true);
  assert.deepEqual(u.widerrufen[0].wo, { id: 'ks_' + '1'.repeat(32) });
  await new Promise(res => setImmediate(res));
  assert.match(u.technik[0], /Karten-Aktion abgelehnt.*Rechteverwaltung: geändert/);
  assert.equal((await ka.bestaetigen(token)).ok, false);
  assert.equal(u.ausgefuehrt.length, 0);
  const alle = await ka.alleAbmelden(token);
  assert.equal(alle.ok, true);
  assert.deepEqual(u.widerrufen[1].wo, { email: 'stefan@example.org' });
});

test('Einmal-Ausweis: nur diese Methode, dieser Pfad, einmal, 60 s', () => {
  const e = { email: 'a@x', user_id: 1, methode: 'PUT', url: '/api/permissions', id: 'kb_1' };
  let t = ka.ausweisErzeugen(e, ['technik']);
  assert.ok(t.startsWith('rw_best_'));
  assert.equal(ka.ausweisEinloesen(t, 'POST', 'permissions'), null);
  t = ka.ausweisErzeugen(e, []);
  assert.equal(ka.ausweisEinloesen(t, 'PUT', 'permissions').email, 'a@x');
  assert.equal(ka.ausweisEinloesen(t, 'PUT', 'permissions'), null);          // schon verbraucht
  t = ka.ausweisErzeugen(e, []);
  assert.equal(ka.ausweisEinloesen(t, 'PUT', 'permissions', Date.now() + 61000), null);
  assert.equal(ka.ausweisEinloesen('rw_app_x', 'PUT', 'permissions'), null);
});

test('Mail-Versand fehlgeschlagen: 503, kein offener Eintrag', async () => {
  const u = umgebung({ senden: async () => { throw new Error('smtp weg'); } });
  const res = antwort();
  const fehler = console.error; console.error = () => {};
  try { await ka.bestaetigungVerlangen(anfrage('karte'), res, () => {}); } finally { console.error = fehler; }
  assert.equal(res.statusCode, 503);
  await new Promise(r => setImmediate(r));
  assert.equal(u.speicher.zeilen.size, 0);
});

// ─── Routen aus dem Quelltext ───────────────────────────────────────────────
const API = path.join(__dirname, '..');
const lesen = (f) => fs.readFileSync(path.join(API, f), 'utf8');
const MOUNTS = {
  'server.js': '', 'routes/ssh-zugang.js': '/api/ssh', 'routes/stations.js': '/api/stations',
  'routes/stationen-v2.js': '/api/stations/v2', 'routes/sicherungen.js': '/api/sicherungen', 'routes/salz.js': '/api/salz',
  'routes/app-karte.js': '', 'routes/app-daten.js': '', 'routes/app-tunnel.js': '', 'routes/messenger-zugang.js': '/api/messenger',
};
const ROUTEN = [];
for (const [datei, basis] of Object.entries(MOUNTS)) {
  lesen(datei).split('\n').forEach((z, i) => {
    const m = z.match(/^\s*(?:app|router)\.(get|post|put|patch|delete|use)\(\s*'([^']+)'\s*,(.*)$/);
    if (!m) return;
    const pfad = m[2].startsWith('/api') ? m[2] : basis + (m[2] === '/' ? '' : m[2]);
    ROUTEN.push({ methode: m[1].toUpperCase(), pfad, kopf: m[3].split(/\basync\b|\ba\(|=>/)[0], datei, zeile: i + 1 });
  });
}
const route = (m, p) => { const r = ROUTEN.find(x => x.methode === m && x.pfad === p); assert.ok(r, `${m} ${p} fehlt`); return r; };

const HEIKEL = [
  ['PUT', '/api/permissions'], ['PUT', '/api/proxmox/acl'], ['DELETE', '/api/proxmox/acl'],
  ['DELETE', '/api/admin/users/:pk'], ['POST', '/api/personen/merge'],
  ['POST', '/api/ssh/me/schluessel'], ['PUT', '/api/ssh/me/github'], ['POST', '/api/ssh/me/github/abgleich'],
  ['POST', '/api/ssh/matrix'], ['DELETE', '/api/ssh/matrix/:id'],
  ['POST', '/api/stations/admin/:id/ssh-wartung'], ['POST', '/api/stations/admin/wartungsschluessel'],
];

test('Die zwoelf heiklen Routen verlangen mit der Karte die Bestaetigung', () => {
  for (const [m, p] of HEIKEL) {
    const r = route(m, p);
    assert.match(r.kopf, /kartenAdmin\.bestaetigungVerlangen/, `${m} ${p} (${r.datei}:${r.zeile})`);
  }
  // Eigene SSH-Schluessel: Bestaetigung VOR requireUserLogin (sonst kaeme die Karte nie dorthin)
  assert.match(route('POST', '/api/ssh/me/schluessel').kopf, /bestaetigungVerlangen, requireUserLogin/);
  assert.equal(ROUTEN.filter(r => /bestaetigungVerlangen/.test(r.kopf)).length, HEIKEL.length);
});

test('Admin-Waechter vermerken nur, sie sperren die Karte nicht', () => {
  const WAECHTER = {
    'middleware/auth.js': ['adminOnly'], 'server.js': ['requireTechnikOrPraesident', 'requireMqttTechnik'],
    'routes/ssh-zugang.js': ['requireTechnik'], 'routes/stations.js': ['nurTechnik'],
    'routes/stationen-v2.js': ['nurTechnikGruppe'], 'routes/sicherungen.js': ['nurTechnik'],
  };
  for (const [datei, namen] of Object.entries(WAECHTER)) {
    const text = lesen(datei);
    for (const name of namen) {
      const m = text.match(new RegExp(`function ${name}\\(req, res, next\\) \\{([\\s\\S]*?)\\n\\s*\\}\\n`));
      assert.ok(m, `${datei}: ${name}`);
      assert.match(m[1], /kartenAdmin\.vermerken\(req, res\)/, `${datei}: ${name} vermerkt nicht`);
      assert.doesNotMatch(m[1], /stufe/i, `${datei}: ${name} prueft eine Stufe`);
    }
  }
  const alles = Object.keys(MOUNTS).concat(['middleware/auth.js']).map(lesen).join('\n');
  assert.doesNotMatch(alles, /mindestStufe|stufePruefen|STUFEN_MODUS/);
  const server = lesen('server.js');
  assert.match(server, /function ispIsAdmin\(req\) \{[\s\S]*?if \(admin\) kartenAdmin\.vermerken\(req, req\.res\);[\s\S]*?return admin;/);
  assert.match(server, /const isTech = isTechnik\(groups\) \|\| isPraesident\(groups\);\n\s*if \(isTech\) kartenAdmin\.vermerken/);
});

test('Endpunkte der bestehenden Apps: weder Bestaetigung noch Admin-Waechter', () => {
  const liste = [
    ['GET', '/api/auth/me'], ['GET', '/api/me'], ['PUT', '/api/me/phones'], ['GET', '/api/me/app-daten/:app'],
    ['PUT', '/api/me/app-daten/:app'], ['GET', '/api/energie/meine-zaehler'], ['GET', '/api/ssh/me'],
    ['POST', '/api/apps/sitzung/abmelden'], ['POST', '/api/apps/tunnel'], ['POST', '/api/messenger/zugang'],
    ['POST', '/api/salz/buchungen'], ['PUT', '/api/salz/lager/:id'],
  ];
  for (const [m, p] of liste) {
    const r = route(m, p);
    assert.doesNotMatch(r.kopf, /bestaetigungVerlangen|adminOnly|requireTechnikOrPraesident|nurTechnik/, `${m} ${p}`);
  }
});
