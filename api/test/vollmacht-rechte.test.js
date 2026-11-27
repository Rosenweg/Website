// node --test api/test/vollmacht-rechte.test.js — Wer darf eine Vollmacht
// widerrufen (Befund B11): Server und Knopf nach derselben Regel.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vr = require('../lib/vollmacht-rechte');

const aktiv = {
  status: 'aktiv',
  vollmachtgeber_email: 'geber@example.org',
  vollmachtgeber_liste: [{ email: 'geber@example.org' }, { email: 'Mitgeber@Example.org' }],
};

test('Technik und Präsident dürfen widerrufen', () => {
  assert.equal(vr.darfWiderrufen({ groups: ['technik'], email: 'x@example.org' }, aktiv), true);
  assert.equal(vr.darfWiderrufen({ groups: ['Präsident'], email: 'x@example.org' }, aktiv), true);
});

test('Ausschuss und Verwaltung ohne eigene Vollmacht dürfen nicht', () => {
  assert.equal(vr.darfWiderrufen({ groups: ['stweg3-ausschuss'], email: 'a@example.org' }, aktiv), false);
  assert.equal(vr.darfWiderrufen({ groups: ['Verwaltung'], email: 'v@example.org' }, aktiv), false);
  assert.equal(vr.darfWiderrufenRecht(['stweg3-ausschuss', 'Verwaltung'], false), false);
});

test('Vollmachtgeber (Primär-Adresse oder Liste) dürfen, Gross/Klein egal', () => {
  assert.equal(vr.darfWiderrufen({ groups: [], email: 'GEBER@example.org' }, aktiv), true);
  assert.equal(vr.darfWiderrufen({ groups: [], email: 'mitgeber@example.org' }, aktiv), true);
  assert.equal(vr.darfWiderrufen({ groups: [], email: 'bevollmaechtigt@example.org' }, aktiv), false);
  assert.equal(vr.istVollmachtgeber('', 'geber@example.org', []), false);
});

test('Knopf nur bei aktiven Vollmachten', () => {
  for (const status of ['entwurf', 'widerrufen', 'abgelaufen']) {
    assert.equal(vr.darfWiderrufen({ groups: ['technik'], email: 'geber@example.org' }, { ...aktiv, status }), false, status);
  }
  assert.equal(vr.darfWiderrufen({ groups: ['technik'] }, null), false);
});

test('Server und Seite nutzen die gemeinsame Regel', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /vollmachtRechte\.darfWiderrufenRecht\(groups, isGeber\)/);
  assert.match(server, /row\.darf_widerrufen = vollmachtRechte\.darfWiderrufen\(/);
  const seite = fs.readFileSync(path.join(__dirname, '..', '..', 'vollmachten.html'), 'utf8');
  assert.match(seite, /const canRevoke = v\.darf_widerrufen === true;/);
});

test('F2-6: Typ „Person“ mit getipptem Namen wird extern, nie ein ungültiger Typ', () => {
  assert.equal(vr.bvTyp('person'), 'extern');
  assert.equal(vr.bvTyp('Eigentuemer'), 'eigentuemer');
  assert.equal(vr.bvTyp('mieter'), 'mieter');
  assert.equal(vr.bvTyp('verwaltung'), 'verwaltung');
  assert.equal(vr.bvTyp(''), null);
  assert.equal(vr.bvTyp('irgendwas'), null);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.equal((server.match(/vollmachtRechte\.bvTyp\(b\.bevollmaechtigter_typ\)/g) || []).length, 2); // POST und PUT
  const seite = fs.readFileSync(path.join(__dirname, '..', '..', 'vollmachten.html'), 'utf8');
  assert.match(seite, /bevollmaechtigter_typ: bvTypFuerServer\(/);
  assert.match(seite, /if \(uiTyp === 'person'\) return 'extern';/);
});
