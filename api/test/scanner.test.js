// node --test api/test/scanner.test.js — Scanner-Konten: Passwort, Zettel, Ablauf
// (lib/scanner.js), Passwort-API (lib/adpasswort.js), Druck-API (lib/druckapi.js).
// Ohne Datenbank und ohne Netz.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const S = require('../lib/scanner');
const adPasswort = require('../lib/adpasswort');
const druckApi = require('../lib/druckapi');
const ka = require('../lib/kartenadmin');

const R13 = S.scannerFinden('r13');

test('Geräteliste: eindeutig, Konten nur scan-…', () => {
  assert.deepEqual(S.listePruefen(), []);
  assert.ok(R13 && R13.konto === 'scan-r13');
  assert.deepEqual(S.listePruefen([{ id: 'a', konto: 'administrator' }]), ['konto administrator (nur scan-…)']);
  assert.equal(S.listePruefen([{ id: 'a', konto: 'scan-a' }, { id: 'a', konto: 'scan-a' }]).length, 2);
  assert.equal(S.scannerFinden('../r13'), null);
  assert.equal(S.scannerFinden('R13'), null);
  assert.equal(S.scannerFinden('gibtsnicht'), null);
});

test('Passwort: 16 Zeichen, nur eintippbare, unverwechselbare Zeichen, alle drei Klassen', () => {
  const erlaubt = new Set(S.GROSS + S.KLEIN + S.ZIFFERN);
  for (const z of '0Oo1lIi2Zz5SsB') assert.equal(erlaubt.has(z), false, `${z} ist verwechselbar`);
  for (const z of 'ckpsuvwxyz') assert.equal(erlaubt.has(z), false, `${z} sieht gross gleich aus`);
  const gesehen = new Set();
  for (let i = 0; i < 500; i++) {
    const p = S.passwortErzeugen();
    assert.equal(p.length, S.PASSWORT_LAENGE);
    assert.ok([...p].every(c => erlaubt.has(c)), p);
    assert.match(p, /[A-Z]/); assert.match(p, /[a-z]/); assert.match(p, /[0-9]/);
    assert.ok(!p.toLowerCase().includes(R13.konto), 'enthält den Kontonamen');
    gesehen.add(p);
  }
  assert.equal(gesehen.size, 500);
  // Ein Zufall, der nur Grossbuchstaben liefert, wird verworfen, bis alle Klassen da sind
  let n = 0;
  const zufall = (max) => (n++ < 16 ? 0 : (n % max));
  const p = S.passwortErzeugen(zufall);
  assert.ok(n > 16);
  assert.match(p, /[a-z]/); assert.match(p, /[0-9]/);
});

test('Zettel: Server, Freigabe, Benutzer, Passwort in Gruppen, Datum, Hinweis zum Vernichten', () => {
  const html = S.zettelHtml(R13, 'AbCd3456EfGh789J', { zeit: new Date('2026-11-27T15:30:00Z'), von: 'Stefan <Test>' });
  assert.match(html, /100\.64\.2\.29/);
  assert.match(html, /files\.ad\.rosenweg4303\.ch/);
  assert.match(html, />scans</);
  assert.match(html, /scan-r13/);
  assert.match(html, /AbCd 3456 EfGh 789J/);
  assert.match(html, /27\. November 2026/);
  assert.match(html, /vernichten/);
  assert.match(html, /Stefan &lt;Test&gt;/);            // escaped
  assert.doesNotMatch(html, /<script|https?:\/\/(?!100\.64\.139\.4)/); // nichts von aussen
  assert.equal(S.gruppiert('ABCDEFGHJK'), 'ABCD EFGH JK');
});

test('ohnePasswort ersetzt jedes Vorkommen und kürzt', () => {
  assert.equal(S.ohnePasswort('x Geheim1 y Geheim1', 'Geheim1'), 'x *** y ***');
  assert.equal(S.ohnePasswort('a'.repeat(900), 'z').length, 500);
  assert.equal(S.ohnePasswort(undefined, 'z'), '');
});

// ─── Ablauf ─────────────────────────────────────────────────────────────────
const PW = 'TestPw3456EfGh78';
function umgebung(ueber = {}) {
  const u = { schritte: [], zeilen: [], htmls: [], adAufrufe: [] };
  u.deps = {
    passwortErzeugen: () => PW,
    jetzt: () => new Date('2026-11-27T12:00:00Z'),
    htmlZuPdf: async (html) => { u.schritte.push('pdf'); u.htmls.push(html); return Buffer.from('%PDF-1.7 ' + html); },
    drucken: async (drucker, pdf, name) => { u.schritte.push(`druck:${drucker}:${name}`); return { ok: true, status: 'ok', message: 'request id is DruckerR9-7 (1 file(s))' }; },
    adSetzen: async (konto, pw) => { u.schritte.push('ad'); u.adAufrufe.push([konto, pw]); return { ok: true }; },
    protokollieren: async (z) => { u.zeilen.push(z); },
    ...ueber,
  };
  return u;
}
const WER = { email: 'technik@example.ch', name: 'Tech Nik', art: 'website' };
const ohnePw = (u, r) => {
  const alles = JSON.stringify(u.zeilen) + JSON.stringify(r);
  assert.ok(!alles.includes(PW), 'Passwort im Protokoll oder in der Antwort');
};

test('Erfolg: erst PDF, dann Druck auf DruckerR9, dann AD — Protokoll ohne Passwort', async () => {
  const u = umgebung();
  const r = await S.passwortDrucken(R13, WER, u.deps);
  assert.equal(r.ergebnis, 'ok'); assert.equal(r.status, 200);
  assert.deepEqual(u.schritte, ['pdf', 'druck:DruckerR9:scanner-zugang.pdf', 'ad']);
  assert.deepEqual(u.adAufrufe, [['scan-r13', PW]]);
  assert.ok(u.htmls[0].includes(S.gruppiert(PW)));  // nur auf dem Zettel
  assert.equal(u.zeilen.length, 1);
  assert.deepEqual({ ...u.zeilen[0], zeit: undefined }, {
    scanner_id: 'r13', konto: 'scan-r13', email: 'technik@example.ch', name: 'Tech Nik', art: 'website',
    ergebnis: 'ok', detail: 'DruckerR9: request id is DruckerR9-7 (1 file(s))', zeit: undefined,
  });
  assert.match(r.meldung, /DruckerR9/);
  ohnePw(u, r);
});

test('PDF scheitert: weder Druck noch AD', async () => {
  const u = umgebung({ htmlZuPdf: async () => { throw new Error(`Gotenberg sagt ${PW}`); } });
  const r = await S.passwortDrucken(R13, WER, u.deps);
  assert.equal(r.ergebnis, 'pdf-fehler');
  assert.equal(u.adAufrufe.length, 0);
  assert.match(r.meldung, /Nichts geändert/);
  ohnePw(u, r);
});

test('Druck scheitert (Antwort oder Netz): AD bleibt unberührt', async () => {
  for (const drucken of [
    async () => ({ ok: false, status: 'error', message: 'lp: Fehler' }),
    async () => { throw new Error('ECONNREFUSED'); },
  ]) {
    const u = umgebung({ drucken });
    const r = await S.passwortDrucken(R13, WER, u.deps);
    assert.equal(r.ergebnis, 'druck-fehler');
    assert.equal(u.adAufrufe.length, 0);
    assert.match(r.meldung, /bisherige Passwort gilt weiter/);
    ohnePw(u, r);
  }
});

test('AD scheitert: Zettel ungültig; fehlendes Konto und Zeitüberschreitung eigens gemeldet', async () => {
  const faelle = [
    [{ ok: false, fehler: `ERROR: password ${PW} does not meet complexity` }, 'ad-fehler', /vernichten/],
    [{ ok: false, fehler: "ERROR: Failed to set password for user 'scan-r13': Unable to find user 'scan-r13'" }, 'kein-konto', /anlegen/],
    [{ ok: false, fehler: 'The operation was aborted due to timeout', zeitueberschreitung: true }, 'ad-unklar', /ausprobieren/],
  ];
  for (const [ad, ergebnis, meldung] of faelle) {
    const u = umgebung({ adSetzen: async () => ad });
    const r = await S.passwortDrucken(R13, WER, u.deps);
    assert.equal(r.ergebnis, ergebnis);
    assert.match(r.meldung, meldung);
    assert.equal(u.zeilen[0].ergebnis, ergebnis);
    ohnePw(u, r);
  }
});

test('Protokoll kaputt: das Ergebnis kommt trotzdem an', async () => {
  const u = umgebung({ protokollieren: async () => { throw new Error('DB weg'); } });
  const fehler = console.error; console.error = () => {};
  try {
    const r = await S.passwortDrucken(R13, WER, u.deps);
    assert.equal(r.ergebnis, 'ok');
  } finally { console.error = fehler; }
});

// ─── Passwort-API und Druck-API ─────────────────────────────────────────────
function mitUmgebung(werte, fn) {
  const alt = {};
  for (const k of Object.keys(werte)) { alt[k] = process.env[k]; if (werte[k] == null) delete process.env[k]; else process.env[k] = werte[k]; }
  return Promise.resolve().then(fn).finally(() => { for (const k of Object.keys(alt)) { if (alt[k] == null) delete process.env[k]; else process.env[k] = alt[k]; } });
}

test('Passwort-API: ohne Geheimnis kein Aufruf; Fehlertext ohne Passwort', () => mitUmgebung(
  { AD_PASSWORD_API_SECRET: null, AD_PASSWORD_API_URL: 'http://dc.test:8446/' }, async () => {
    let aufrufe = 0;
    const f = async () => { aufrufe++; return { ok: true, status: 200 }; };
    assert.equal(adPasswort.eingerichtet(), false);
    assert.equal((await adPasswort.setzen('scan-r13', PW, { fetchImpl: f })).ok, false);
    assert.equal(aufrufe, 0);

    process.env.AD_PASSWORD_API_SECRET = 'geheim';
    let gesehen;
    const ok = await adPasswort.setzen('scan-r13', PW, { fetchImpl: async (url, o) => { gesehen = { url, o }; return { ok: true, status: 200 }; } });
    assert.equal(ok.ok, true);
    assert.equal(gesehen.url, 'http://dc.test:8446/');
    assert.equal(gesehen.o.headers.Authorization, 'Bearer geheim');
    assert.deepEqual(JSON.parse(gesehen.o.body), { username: 'scan-r13', password: PW });

    const fehl = await adPasswort.setzen('scan-r13', PW, {
      fetchImpl: async () => ({ ok: false, status: 500, text: async () => JSON.stringify({ error: `bad ${PW}` }) }),
    });
    assert.deepEqual(fehl, { ok: false, status: 500, fehler: 'bad ***' });

    const zeit = await adPasswort.setzen('scan-r13', PW, {
      fetchImpl: async () => { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; },
    });
    assert.equal(zeit.zeitueberschreitung, true);
  }));

test('Druck-API: nur bekannte Warteschlangen, nur mit Geheimnis', () => mitUmgebung(
  { PRINT_API_SECRET: null, PRINT_API_URL: 'http://cups.test:8080/' }, async () => {
    await assert.rejects(druckApi.drucken('DruckerR9', Buffer.from('x'), 'a.pdf', { fetchImpl: async () => ({}) }), /PRINT_API_SECRET/);
    process.env.PRINT_API_SECRET = 'p';
    await assert.rejects(druckApi.drucken('../x', Buffer.from('x'), 'a.pdf'), /Unbekannter Drucker/);
    let gesehen;
    const r = await druckApi.drucken('DruckerR9', Buffer.from('x'), 'scanner-zugang.pdf', {
      fetchImpl: async (url, o) => { gesehen = { url, o }; return { ok: true, status: 200, json: async () => ({ status: 'ok', message: 'request id' }) }; },
    });
    assert.deepEqual(r, { ok: true, status: 'ok', message: 'request id' });
    assert.equal(gesehen.url, 'http://cups.test:8080/print/DruckerR9');
    assert.equal(gesehen.o.headers['X-Filename'], 'scanner-zugang.pdf');
    const f = await druckApi.drucken('DruckerR9', Buffer.from('x'), 'a.pdf', {
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ status: 'error', message: 'lp kaputt' }) }),
    });
    assert.deepEqual(f, { ok: false, status: 'error', message: 'lp kaputt' });
  }));

// ─── Einbindung ─────────────────────────────────────────────────────────────
test('Route: Technik-Wächter mit Kartenprotokoll; Passwort nie in Antwort oder Log', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'scanner.js'), 'utf8');
  assert.match(route, /router\.use\(authMiddleware, nurTechnik\)/);
  assert.match(route, /function nurTechnik\(req, res, next\) \{[\s\S]*?kartenAdmin\.vermerken\(req, res\)/);
  assert.doesNotMatch(route, /passwort\s*[:,)]/i, 'Route reicht ein Passwort weiter, statt nur pw an adSetzen');
  assert.doesNotMatch(route, /console\.[a-z]+\([^)]*\bpw\b/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /app\.use\('\/api\/scanner', require\('\.\/routes\/scanner'\)\.scannerRouter\(/);
  assert.equal(ka.aktionText('POST', '/api/scanner/r13/passwort-drucken'), 'Scanner-Konten: neues Passwort gedruckt');
});

test('Seite und Menü', () => {
  const root = path.join(__dirname, '..', '..');
  const seite = fs.readFileSync(path.join(root, 'scanner.html'), 'utf8');
  assert.match(seite, /passwort-drucken/);
  assert.doesNotMatch(seite, /\.passwort\b|password/i, 'Seite liest kein Passwort aus der Antwort');
  const nav = fs.readFileSync(path.join(root, 'js', 'nav.js'), 'utf8');
  assert.match(nav, /href: 'scanner\.html'/);
});
