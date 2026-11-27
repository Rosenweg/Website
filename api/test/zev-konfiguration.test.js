// node --test api/test/zev-konfiguration.test.js — Z2: Alias-Domain/-Prefix
// wirken nur für Technik/Präsident; andere bekommen die Felder schreibgeschützt
// und bei abweichenden Werten eine Meldung im Klartext.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { zevAliasAusFormular } = require('../lib/zev');

const prev = { alias_domain: 'haus9.beispiel.ch', alias_prefix: 'zev' };

test('Ausschuss ohne Alias-Felder: bisherige Werte bleiben', () => {
  assert.deepEqual(zevAliasAusFormular({ darfAlias: false, prev, body: { aktiv: true } }), { domain: 'haus9.beispiel.ch', prefix: 'zev' });
});

test('Ausschuss schickt unveränderte Werte (alte Seite): kein Fehler', () => {
  assert.deepEqual(zevAliasAusFormular({ darfAlias: false, prev, body: { alias_domain: 'Haus9.Beispiel.ch ', alias_prefix: 'zev' } }),
    { domain: 'haus9.beispiel.ch', prefix: 'zev' });
});

test('Ausschuss ändert Alias-Domain: 403 mit Klartext', () => {
  const r = zevAliasAusFormular({ darfAlias: false, prev, body: { alias_domain: 'andere.beispiel.ch' } });
  assert.equal(r.status, 403);
  assert.match(r.error, /nur Technik oder Präsident/);
  assert.equal(zevAliasAusFormular({ darfAlias: false, prev, body: { alias_prefix: 'strom' } }).status, 403);
});

test('Technik/Präsident: ändern mit Prüfung, Vorgaben bei leer', () => {
  assert.deepEqual(zevAliasAusFormular({ darfAlias: true, prev, body: { alias_domain: 'neu.beispiel.ch', alias_prefix: 'strom' } }),
    { domain: 'neu.beispiel.ch', prefix: 'strom' });
  assert.deepEqual(zevAliasAusFormular({ darfAlias: true, prev, body: {} }), { domain: 'rosenweg9.ch', prefix: 'zev' });
  const d = zevAliasAusFormular({ darfAlias: true, prev, body: { alias_domain: 'kein domain' } });
  assert.equal(d.status, 400); assert.match(d.error, /Alias-Domain/);
  const p = zevAliasAusFormular({ darfAlias: true, prev, body: { alias_prefix: 'a.b' } });
  assert.equal(p.status, 400); assert.match(p.error, /Alias-Prefix/);
});

test('Seite: Alias-Felder schreibgeschützt ohne Recht, Fehler mit Servertext statt „HTTP 4xx“', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'stweg3', 'pages', 'zev-smartme.html'), 'utf8');
  assert.match(html, /\$\(id\)\.readOnly = !RECHTE\.alias/);
  assert.match(html, /if \(RECHTE\.alias\) \{\s*body\.alias_domain/);
  assert.ok(!/new Error\('HTTP ' \+ r\.status\)/.test(html), 'kein nacktes HTTP-Fehlerbild mehr');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /rechte: zevSeitenRechte\(req\.user, stweg\)/);
});

// Z6: Fehlermeldung nennt die Beschriftung der Seite, nicht den Feldnamen.
test('Ungültige Mail: Meldung mit Feldbeschriftung statt internem Namen', () => {
  const { zevMailFeldFehler, ZEV_MAIL_FELDER } = require('../lib/zev');
  assert.equal(zevMailFeldFehler({ axova_email: 'info@beispiel.ch', archiv_mailbox: '' }), null);
  const m = zevMailFeldFehler({ axova_email: 'kein-mail' });
  assert.match(m, /Axova-Mailadresse/);
  assert.ok(!/axova_email/.test(m));
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'stweg3', 'pages', 'zev-smartme.html'), 'utf8');
  for (const [, beschriftung] of ZEV_MAIL_FELDER) assert.ok(html.includes(beschriftung), `Seite kennt „${beschriftung}“`);
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(!/Ungültige E-Mail in \$\{f\}/.test(src));
});
