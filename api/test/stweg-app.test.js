// node --test api/test/stweg-app.test.js — Rosenweg STWEG: Rollen, Sicht, Schreibrecht,
// Markdown, Uebernahme der alten Abschnitte, Druck, Modul-Positivliste. Erfundene Konten.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const a = require('../lib/stweg-app');
const t = require('../lib/mitteilungen-text');
const { RECHTE_MIGRATIONEN } = require('../lib/rechte-migrationen');
const lies = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

test('Sicht: Vorgabe Bewohner, Eigentümer-Mitteilungen nicht für Mieter, öffentlich für alle', () => {
  assert.deepEqual([...a.sichtbarkeitenFuer(null, 3)], ['oeffentlich']);
  assert.deepEqual([...a.sichtbarkeitenFuer(['r9-bewohner'], 3)].sort(), ['bewohner', 'oeffentlich']);
  assert.ok(a.sichtbarkeitenFuer(['r9-eigentuemer'], 3).has('eigentuemer'));
  assert.ok(a.sichtbarkeitenFuer(['stweg3-verwaltung'], 3).has('eigentuemer'));
  assert.deepEqual([...a.sichtbarkeitenFuer(['r9-bewohner'], 5)], ['oeffentlich'], 'fremde STWEG');
  assert.ok(a.sichtbarkeitenFuer(['r9-bewohner'], 0).has('bewohner'), 'Kooperation: Mitglied irgendeiner STWEG');
});

test('Schreiben: Ausschuss und Verwaltung der eigenen STWEG mit Recht, Kooperation nur T/P', () => {
  assert.equal(a.mitteilungSchreibenErlaubt(['stweg3-ausschuss'], 3, 'write'), true);
  assert.equal(a.mitteilungSchreibenErlaubt(['stweg3-verwaltung'], 3, 'write'), true);
  assert.equal(a.mitteilungSchreibenErlaubt(['stweg3-ausschuss'], 3, 'read'), false);
  assert.equal(a.mitteilungSchreibenErlaubt(['stweg3-ausschuss'], 5, 'write'), false);
  assert.equal(a.mitteilungSchreibenErlaubt(['r9-eigentuemer'], 3, 'write'), false);
  assert.equal(a.mitteilungSchreibenErlaubt(['stweg3-ausschuss'], 0, 'write'), false);
  assert.equal(a.mitteilungSchreibenErlaubt(['technik'], 0, 'none'), true);
  assert.equal(a.mitteilungSchreibenErlaubt(['Präsident'], 8, 'none'), true);
  assert.equal(a.mitteilungSchreibenErlaubt(['technik'], 9, 'none'), false);
});

test('meine: Rollen, darf, Einstellplätze nur MEG', () => {
  const m = a.meineStwegs(['r9-bewohner', 'meg-verwaltung'], { 'stweg-mitteilungen': 'write' });
  assert.deepEqual(m.map(x => x.nr), [3, 8]);
  assert.deepEqual(m[0].rollen, ['bewohner']);
  assert.equal(m[0].dokZugang, 'bewohner');
  assert.equal(m[0].darf.mitteilungen, false);
  assert.equal(m[1].darf.mitteilungen, true);
  assert.equal(m[1].darf.einstellplaetze, true);
  assert.equal(m[1].einstellplaetze, true);
  assert.equal(m[0].einstellplaetze, false);
  assert.equal(a.meineStwegs(['technik'], {}).length, 8);
});

test('Formular: Pflichtfelder, Sichtbarkeit, Datum', () => {
  assert.equal(a.mitteilungAusFormular({ titel: '', text: 'x' }).feld, 'titel');
  assert.equal(a.mitteilungAusFormular({ titel: 'a', text: ' ' }).feld, 'text');
  assert.equal(a.mitteilungAusFormular({ titel: 'a', text: 'x', sichtbarkeit: 'alle' }).feld, 'sichtbarkeit');
  assert.equal(a.mitteilungAusFormular({ titel: 'a', text: 'x', gueltig_bis: '31.12.' }).feld, 'gueltig_bis');
  const ok = a.mitteilungAusFormular({ titel: 'a', text: 'x', wichtig: true }).werte;
  assert.equal(ok.sichtbarkeit, 'bewohner');
  assert.equal(ok.wichtig, true);
  assert.deepEqual(a.mitteilungAusFormular({ wichtig: true }, { teilweise: true }).werte, { wichtig: true });
});

test('Bild: Typ und Magic Bytes', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
  assert.equal(a.bildTypPruefen('image/png', png), true);
  assert.equal(a.bildTypPruefen('image/jpeg', png), false);
  assert.equal(a.bildTypPruefen('image/svg+xml', png), false);
  assert.equal(a.bildTypPruefen('image/png', Buffer.from('<svg></svg>....')), false);
});

test('Markdown: rohes HTML und javascript-Links werden Text, Bilder nur als Bild-ID', () => {
  const h = t.markdownZuHtml('**fett** <script>x</script> [a](javascript:alert(1)) ![](bild:' + 'a'.repeat(32) + ') ![](http://evil/x.png)');
  assert.match(h, /<strong>fett<\/strong>/);
  assert.doesNotMatch(h, /<script/);
  assert.doesNotMatch(h, /href="javascript/);
  assert.match(h, /src="\/api\/stweg-bilder\/a{32}"/);
  assert.deepEqual(t.bildIds('![](bild:' + 'b'.repeat(32) + ')'), ['b'.repeat(32)]);
});

test('Übernahme alter Abschnitte: Text, Links, Listen, Tabellen, Base64-Bilder bleiben', () => {
  const r = t.htmlZuMarkdown('<h2>Willkommen</h2><p>Hallo <strong>alle</strong> &amp; <a href="https://x.ch">hier</a></p><ul><li>Eins</li><li>Zwei</li></ul><table><tr><td>Müll</td><td>Montag</td></tr></table><p><img src="data:image/png;base64,iVBORw0KGgo="></p>');
  assert.match(r.md, /## Willkommen/);
  assert.match(r.md, /\*\*alle\*\* & \[hier\]\(https:\/\/x\.ch\)/);
  assert.match(r.md, /- Eins\n- Zwei/);
  assert.match(r.md, /- Müll · Montag/);
  assert.equal(r.bilder.length, 1);
  assert.match(r.md, /!\[\]\(bild:@@0@@\)/);
});

test('Druck: Vermerk vertraulich mit Name und Datum, Namen maskiert', () => {
  const h = a.kontaktlisteHtml({ stweg: 3, wohnungen: [{ bezeichnung: 'W1', bewohner: [{ name: 'A <b>B</b>', email: 'a@example.org', rolle: 'mieter' }] }], ausschuss: [] }, 'Erika Muster', Date.UTC(2026, 10, 28));
  assert.match(h, /VERTRAULICH – erstellt für Erika Muster am 28\.11\.2026/);
  assert.doesNotMatch(h, /<b>B<\/b>/);
  assert.match(a.einstellplaetzeHtml([{ platz_nr: '1', typ: 'auto', status: 'frei' }], 'X'), /Einstellplätze MEG/);
});

test('Server: Modul-Positivliste, Migration, Rechte-Spalte, PDF-Routen, Router', () => {
  assert.deepEqual(a.MODULE, ['waschkueche']);
  const s = lies('api/server.js');
  assert.match(s, /stwegAppLib\.MODULE\.includes\(module\)/);
  assert.match(s, /app\.get\('\/api\/stweg\/:nr\/kontakte\.pdf', authMiddleware/);
  assert.match(s, /app\.get\('\/api\/stweg\/:stweg\/wohnungen\.pdf', authMiddleware/);
  assert.match(lies('api/routes/meg.js'), /router\.get\('\/einstellplaetze\.pdf', authMiddleware, megManageGate/);
  assert.match(lies('api/lib/auth.js'), /\{ id: 'stweg-mitteilungen', label: 'STWEG-Mitteilungen' \}/);
  const m = RECHTE_MIGRATIONEN.find(x => x.page === 'stweg-mitteilungen');
  assert.equal(m.access, 'write');
  assert.ok(m.gruppen.includes('stweg3-ausschuss') && m.gruppen.includes('meg-verwaltung'));
  const r = lies('api/routes/stweg-app.js');
  assert.match(r, /herkunft TEXT UNIQUE/);          // Übernahme wiederholbar
  assert.match(r, /geloescht_am=NOW\(\)/);          // Löschen blendet nur aus
  assert.doesNotMatch(r, /DELETE FROM stweg_mitteilungen|DROP TABLE|DELETE FROM stweg_sections/);
});
