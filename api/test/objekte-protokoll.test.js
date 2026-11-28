// node --test api/test/objekte-protokoll.test.js — Objekte (Klärung Welle 3.1;
// Entscheid Stefan 28.11.2026): Protokoll mit Kartenvermerk für Wohnungen,
// Kontakte, Import, Export, Unterschriftenlisten, Rückläufe und Konten über
// Kontakte; Wohnung löschen und Import nur Technik/Präsident; Rückläufe nur
// Ausschuss/Verwaltung der STWEG; Unterschriftenlisten 10 Jahre.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frist = require('../lib/unterschriftenliste-frist');
const { zevAdminFuerStweg } = require('../lib/zev');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const ov = fs.readFileSync(path.join(__dirname, '..', '..', 'objektverwaltung.html'), 'utf8');
const route = (anfang) => { const i = server.indexOf(anfang); assert.ok(i > 0, anfang); return server.slice(i, server.indexOf('\n});\n', i)); };

test('Schreibende Objekt-Routen: Kartenvermerk und Protokoll', () => {
  const faelle = [
    ["app.post('/api/wohnungen/:stweg', ", "'wohnung-angelegt'"],
    ["app.put('/api/wohnungen/:stweg/:id', ", "'wohnung-geaendert'"],
    ["app.delete('/api/wohnungen/:stweg/:id', ", "'wohnung-geloescht'"],
    ["app.post('/api/wohnungen/:stweg/:id/kontakte/:kid/archive'", "'kontakt-archiviert'"],
    ["app.post('/api/wohnungen/:stweg/import'", "'import'"],
    ["app.put(encodeURI('/api/unterschriftenliste/:hash/rueckläufe/:idx')", "'ruecklauf-erfasst'"],
    ["app.post('/api/objekte/export'", "'export'"],
  ];
  for (const [r, aktion] of faelle) {
    const t = route(r);
    assert.match(t.split('\n')[0], /\.\.\.objSchreibend/, `${r}: Kartenvermerk`);
    assert.ok(t.includes(aktion), `${r}: Protokoll ${aktion}`);
  }
  const ul = route("app.get('/api/unterschriftenliste/:stweg.pdf'");
  assert.match(ul, /kartenAdmin\.vermerken\(req, res, \{ lesend: true, text: 'Unterschriftenliste erzeugt' \}\)/);
  assert.match(ul, /'unterschriftenliste-erzeugt'/);
});

test('Konten über Kontakte: mit Protokoll (wer speichert, löst aus)', () => {
  assert.match(server, /async function syncKontakteToAuthentik\(stweg, kontakte, bewohntVon, req = null\)/);
  assert.match(server, /objProtokoll\(req, 'objekte', 'konto-angelegt'/);
  assert.match(server, /objProtokoll\(req, 'objekte', 'gruppe-gesetzt'/);
  assert.match(route("app.post('/api/wohnungen/:stweg', "), /syncKontakteToAuthentik\(stweg, b\.kontakte, b\.bewohnt_von, req\)/);
  assert.match(route("app.put('/api/wohnungen/:stweg/:id', "), /syncKontakteToAuthentik\(parseStweg\(req\.params\.stweg\), b\.kontakte, b\.bewohnt_von, req\)/);
});

test('Wohnung löschen und Import nur Technik/Präsident', () => {
  assert.match(route("app.delete('/api/wohnungen/:stweg/:id', ").split('\n')[0], /requireTechnikOrPraesident/);
  assert.match(route("app.post('/api/wohnungen/:stweg/import'").split('\n')[0], /requireTechnikOrPraesident/);
  assert.match(ov, /window\.darfLoeschenUndImport = isTechnik;/);
  assert.match(ov, /canWriteWohnungen && window\.darfLoeschenUndImport\) document\.getElementById\('btn-delete'\)/);
});

test('Export: nur Ausschuss/Verwaltung der STWEG und Technik, Seite fragt vorher', () => {
  const t = route("app.post('/api/objekte/export'");
  assert.match(t, /stweg \? zevAdminFuerStweg\(g, stweg\)/);
  for (const f of ['exportXLSX', 'exportCSV', 'exportEigentuemerXLSX', 'exportEigentuemerCSV']) {
    const i = ov.indexOf(`async function ${f}()`);
    assert.ok(i > 0, f);
    assert.match(ov.slice(i, i + 400), /await exportFreigabe\(/, f);
  }
});

test('Rückläufe: nur Ausschuss/Verwaltung dieser STWEG und Technik/Präsident', () => {
  const t = route("app.get(encodeURI('/api/unterschriftenliste/:hash/rueckläufe')");
  assert.match(t, /zevAdminFuerStweg\(req\.user\?\.groups \|\| \[\], snap\.rows\[0\]\.stweg\)/);
  assert.equal(zevAdminFuerStweg(['stweg3-ausschuss'], 3), true);
  assert.equal(zevAdminFuerStweg(['stweg3-verwaltung'], 3), true);
  assert.equal(zevAdminFuerStweg(['technik'], 3), true);
  assert.equal(zevAdminFuerStweg(['stweg5-ausschuss', 'r9-bewohner'], 3), false, 'Ausschuss 5, Bewohner in Haus 9');
  assert.equal(zevAdminFuerStweg(['r9-eigentuemer'], 3), false);
});

test('Öffentlicher Abruf per Hash unverändert (Entscheid 21.11.)', () => {
  assert.match(server, /app\.get\('\/api\/unterschriftenliste\/snapshot\/:hash\.pdf', async \(req, res\) => \{/);
  assert.match(server, /app\.get\('\/api\/unterschriftenliste\/verify-json', async \(req, res\) => \{/);
});

test('Aufbewahrung: 10 Jahre, täglicher Lauf löscht Liste, Rückläufe und PDF', async () => {
  assert.equal(frist.UL_AUFBEWAHRUNG_JAHRE, 10);
  assert.match(server, /taeglichUm\(4, 20, async \(\) => \{[\s\S]{0,200}ulFrist\.ulAbgelaufeneLoeschen\(pool/);
  const sql = [];
  const db = { query: async (q, p) => {
    sql.push([q, p]);
    if (q.includes('SELECT hash')) return { rows: [{ hash: 'AAAAAAAAAAAA', pdf_path: 'allgemein/unterschriftenlisten/AAAAAAAAAAAA.pdf' }, { hash: 'BBBBBBBBBBBB', pdf_path: '../../etc/passwd' }] };
    if (q.includes('rueckläufe')) return { rowCount: 7 };
    return { rowCount: 2 };
  } };
  const geloescht = [];
  const fsFake = { unlink: async (f) => { geloescht.push(f); } };
  const n = await frist.ulAbgelaufeneLoeschen(db, { fs: fsFake, docsPath: '/documents' });
  assert.deepEqual(n, { listen: 2, ruecklaeufe: 7, pdfs: 1 });
  assert.deepEqual(sql[0][1], [10]);
  assert.match(sql[0][0], /generated_at < NOW\(\) - make_interval\(years => \$1::int\)/);
  assert.deepEqual(geloescht, ['/documents/allgemein/unterschriftenlisten/AAAAAAAAAAAA.pdf'], 'nur im Dokumente-Ordner');
  // nichts abgelaufen: keine Löschung
  const leer = { query: async () => ({ rows: [] }) };
  assert.deepEqual(await frist.ulAbgelaufeneLoeschen(leer, { fs: fsFake }), { listen: 0, ruecklaeufe: 0, pdfs: 0 });
});
