// node --test api/test/zev-unzugeordnet.test.js — Z1: Nicht zugeordnete
// ZEV-Rechnungen bekommen die STWEG der Anlage, damit Ausschuss und Verwaltung
// dieser STWEG sie sehen und zuordnen. Erfundene Adressen (@beispiel.ch).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { zevStwegFuerEmpfaenger } = require('../lib/zev');

const S3 = { stweg: 3, aktiv: true, alias_prefix: 'zev', alias_domain: 'haus9.beispiel.ch', archiv_mailbox: 'archiv@haus9.beispiel.ch' };
const S5 = { stweg: 5, aktiv: true, alias_prefix: 'zev', alias_domain: 'haus5.beispiel.ch', archiv_mailbox: 'archiv@haus5.beispiel.ch' };

test('Unbekannter Alias der Domain einer STWEG -> diese STWEG', () => {
  assert.equal(zevStwegFuerEmpfaenger(['zev.tippfehler@haus9.beispiel.ch'], [S3, S5]), 3);
  assert.equal(zevStwegFuerEmpfaenger(['ZEV.Alt@Haus5.Beispiel.ch'], [S3, S5]), 5);
});

test('Ohne Alias: Archiv-Postfach entscheidet', () => {
  assert.equal(zevStwegFuerEmpfaenger(['archiv@haus5.beispiel.ch'], [S3, S5]), 5);
});

test('Nur eine aktive ZEV-STWEG (heute STWEG 3) -> diese', () => {
  assert.equal(zevStwegFuerEmpfaenger(['irgendwer@beispiel.ch'], [S3]), 3);
  assert.equal(zevStwegFuerEmpfaenger([], [S3]), 3);
});

test('Nicht eindeutig oder keine Konfiguration -> null (bleibt bei Technik)', () => {
  assert.equal(zevStwegFuerEmpfaenger(['irgendwer@beispiel.ch'], [S3, S5]), null);
  assert.equal(zevStwegFuerEmpfaenger(['zev.x@haus9.beispiel.ch', 'zev.y@haus5.beispiel.ch'], [S3, S5]), null);
  assert.equal(zevStwegFuerEmpfaenger(['zev.x@haus9.beispiel.ch'], []), null);
  assert.equal(zevStwegFuerEmpfaenger(['zev.x@haus9.beispiel.ch'], [{ ...S3, aktiv: false }]), null);
});

test('Ungültiger Prefix/Domain in der Konfiguration zählt nicht als Treffer', () => {
  const kaputt = { ...S5, alias_prefix: 'info..', alias_domain: 'haus9.beispiel.ch' };
  assert.equal(zevStwegFuerEmpfaenger(['info..x@haus9.beispiel.ch'], [S3, kaputt]), null);
});

test('Poller setzt die abgeleitete STWEG, nicht bei fremdem Absender; Zuordnen nur in der STWEG der Rechnung', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /const stwegUnz = \(!match && !unsicher\) \? zevStwegFuerEmpfaenger\(recips, zevCfgs\) : null;/);
  assert.match(src, /\[match\?\.stweg \|\| stwegUnz \|\| null,/);
  const i = src.indexOf("'/api/zev/rechnung/:id/zuordnen'");
  const block = src.slice(i, src.indexOf('\napp.', i + 10));
  assert.match(block, /if \(stweg !== altStweg\)/);
  assert.match(block, /altStweg == null \|\| !eigene\.has\(altStweg\)/);
});
