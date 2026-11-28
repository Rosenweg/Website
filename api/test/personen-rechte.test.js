// node --test api/test/personen-rechte.test.js — Personen (Klärung Welle 3.2;
// Entscheid Stefan 28.11.2026): Verwaltung ändert/führt zusammen wie der
// Ausschuss (eigene STWEG, gleiche Schutzregeln); beim Zusammenführen wandern
// alle Verweise mit; Geburtsdatum nur T/P, Notiz nur Ausschuss und T/P;
// anlegen/ändern/zusammenführen stehen im Protokoll.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pr = require('../lib/personen-rechte');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'personen.html'), 'utf8');

test('Schreib-STWEG: Ausschuss und Verwaltung', () => {
  assert.deepEqual([...pr.personenSchreibStwegs(['stweg3-ausschuss'])], [3]);
  assert.deepEqual([...pr.personenSchreibStwegs(['stweg5-verwaltung'])], [5]);
  assert.deepEqual([...pr.personenSchreibStwegs(['meg-verwaltung', 'stweg2-ausschuss'])].sort(), [2, 8]);
  assert.equal(pr.personenSchreibStwegs(['r9-eigentuemer']).size, 0);
});

test('userCanEditPerson und personGeschuetztFuer kennen die Verwaltung', () => {
  for (const fn of ['async function userCanEditPerson(', 'async function personGeschuetztFuer(']) {
    const i = server.indexOf(fn);
    assert.ok(i > 0, fn);
    assert.match(server.slice(i, i + 500), /personenRechte\.personenSchreibStwegs\(groups\)/, fn);
  }
  // Zusammenführen prüft beide Personen mit denselben Regeln wie Ändern
  const m = server.indexOf("app.post('/api/personen/merge'");
  const merge = server.slice(m, m + 4000);
  assert.match(merge, /userCanEditPerson\(req\.user, keepId\), userCanEditPerson\(req\.user, mergeId\)/);
  assert.match(merge, /personGeschuetztFuer\(req\.user, keepId\), personGeschuetztFuer\(req\.user, mergeId\)/);
});

test('Geburtsdatum nur T/P, Notiz nur Ausschuss und T/P', () => {
  const p = { id: 1, name: 'Muster', geburtsdatum: '1970-01-01', notiz: 'x' };
  assert.deepEqual(pr.personFuerLeser(['technik'], p), p);
  assert.deepEqual(pr.personFuerLeser(['Präsident'], p), p);
  const a = pr.personFuerLeser(['stweg3-ausschuss'], p);
  assert.equal(a.geburtsdatum, undefined);
  assert.equal(a.notiz, 'x');
  const v = pr.personFuerLeser(['stweg3-verwaltung'], p);
  assert.equal(v.geburtsdatum, undefined);
  assert.equal(v.notiz, undefined);
  // wer das Feld nicht sieht, überschreibt es auch nicht
  assert.deepEqual(pr.personBodyFiltern(['stweg3-verwaltung'], { name: 'N', notiz: '', geburtsdatum: null }), { name: 'N' });
  assert.deepEqual(pr.personBodyFiltern(['stweg3-ausschuss'], { notiz: 'n', geburtsdatum: '2000-01-01' }), { notiz: 'n' });
});

test('Routen filtern Felder und Body', () => {
  assert.match(server, /personen: r\.rows\.map\(p => personenRechte\.personFuerLeser\(g, sicht\(p, personFuerSicht\(p\)\)\)\)/);
  assert.match(server, /\.\.\.personenRechte\.personFuerLeser\(g, sicht\(r\.rows\[0\], personFuerSicht\(r\.rows\[0\]\)\)\)/);
  assert.match(server, /let b = personenRechte\.personBodyFiltern\(req\.user\?\.groups \|\| \[\], req\.body \|\| \{\}\);/);
  assert.match(server, /const b = personenRechte\.personBodyFiltern\(req\.user\?\.groups \|\| \[\], req\.body \|\| \{\}\);/);
});

test('Zusammenführen: jede REFERENCES personen-Spalte wird umgehängt', () => {
  // Alle Spalten mit REFERENCES personen(id) im Schema (server.js initDB)
  const schema = [];
  const re = /(?:ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+)|^\s*(\w+)) INTEGER REFERENCES personen\(id\)/gm;
  // Tabellenname für Spalten in CREATE TABLE: letzte CREATE TABLE davor
  let m;
  while ((m = re.exec(server))) {
    if (m[1]) { schema.push(`${m[1]}.${m[2]}`); continue; }
    const vorher = server.slice(0, m.index);
    const t = [...vorher.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].pop()[1];
    schema.push(`${t}.${m[3]}`);
  }
  assert.ok(schema.length >= 7, schema.join(', '));
  const liste = pr.PERSONEN_VERWEISE.map(([t, s]) => `${t}.${s}`);
  for (const s of schema) assert.ok(liste.includes(s), `fehlt in PERSONEN_VERWEISE: ${s}`);
  for (const pflicht of ['vollmachten.vollmachtgeber_person_id', 'vollmachten.bevollmaechtigter_person_id',
    'reklamationen.person_id', 'whatsapp_messages.person_id', 'pbx_ring_members.person_id']) {
    assert.ok(liste.includes(pflicht), pflicht);
  }
  assert.match(server, /const umgehaengt = await personenRechte\.verweiseUmhaengen\(client, keepId, mergeId\);/);
});

test('verweiseUmhaengen: setzt jede Spalte von merge auf keep', async () => {
  const sql = [];
  const client = { query: async (q, p) => { sql.push([q, p]); return q.startsWith('SELECT to_regclass') ? { rows: [{ t: 'x' }] } : { rowCount: 2 }; } };
  const z = await pr.verweiseUmhaengen(client, 10, 11);
  assert.equal(z['vollmachten.bevollmaechtigter_person_id'], 2);
  const updates = sql.filter(([q]) => q.startsWith('UPDATE'));
  assert.equal(updates.length, pr.PERSONEN_VERWEISE.length);
  assert.deepEqual(updates[0][1], [10, 11]);
});

test('Protokoll: anlegen, ändern, zusammenführen, Kartenvermerk', () => {
  assert.match(server, /app\.put\('\/api\/personen\/:id', authMiddleware, requireWohnungsverwaltungWrite, kartenAdmin\.mitKarteProtokollieren/);
  assert.match(server, /app\.post\('\/api\/personen', authMiddleware, requireWohnungsverwaltungWrite, kartenAdmin\.mitKarteProtokollieren/);
  assert.match(server, /objProtokoll\(req, 'personen', 'geaendert'/);
  assert.match(server, /objProtokoll\(req, 'personen', 'angelegt'/);
  assert.match(server, /bereich: 'personen', aktion: 'zusammengefuehrt'/);
  assert.deepEqual(pr.geaenderteFelder({ name: 'A', notiz: null, geburtsdatum: new Date('2000-01-02T00:00:00Z') },
    { name: 'B', notiz: '', geburtsdatum: '2000-01-02' }, ['name', 'notiz', 'geburtsdatum']), ['name']);
});

test('Seite: Felder nur zeigen, wenn der Server sie liefert', () => {
  assert.match(html, /FELDER\.geburtsdatum/);
  assert.match(html, /FELDER\.notiz/);
});

test('Vorschau „Wo wird die Person verwendet?“ zählt jeden Verweis, nur > 0', async () => {
  const zahlen = { 'vollmachten.vollmachtgeber_person_id': 2, 'reklamationen.person_id': 1 };
  const client = {
    query: async (q, p) => {
      if (q.startsWith('SELECT to_regclass')) return { rows: [{ t: 'x' }] };
      const m = q.match(/FROM (\w+) WHERE (\w+) = \$1/);
      assert.deepEqual(p, [7]);
      return { rows: [{ n: zahlen[`${m[1]}.${m[2]}`] || 0 }] };
    },
  };
  const z = await pr.verwendungZaehlen(client, 7);
  assert.deepEqual(z.map(x => [x.tabelle + '.' + x.spalte, x.anzahl]).sort(),
    [['reklamationen.person_id', 1], ['vollmachten.vollmachtgeber_person_id', 2]]);
  assert.equal(z.find(x => x.tabelle === 'reklamationen').text, 'Reklamationen');
  // jede Spalte der Zusammenführung hat einen lesbaren Text
  for (const [t, s] of pr.PERSONEN_VERWEISE) assert.ok(pr.VERWEIS_TEXT[`${t}.${s}`], `${t}.${s}`);
});

test('Vorschau-Route: gleiche Schutzregeln wie Ändern, ohne Daten fremder STWEG', () => {
  const i = server.indexOf("app.get('/api/personen/:id/verwendung'");
  assert.ok(i > 0);
  const r = server.slice(i, i + 2600);
  assert.match(r, /requireWohnungsverwaltungWrite/);
  assert.match(r, /userCanEditPerson\(req\.user, id\)/);
  assert.match(r, /personGeschuetztFuer\(req\.user, id\)/);
  assert.match(r, /w\.stweg = ANY\(\$2::int\[\]\)/);
  assert.match(r, /personenRechte\.verwendungZaehlen\(pool, id\)/);
});
