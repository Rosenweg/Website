// node --test api/test/briefe-rechte.test.js — Briefe: STWEG beim Erfassen und
// in der Sicht, Vier-Augen-Loeschen, Magic Bytes, 15 MB, Hinweis + Tageslimit
// fuer die externe Texterkennung (Entscheide Stefan 28.11.2026).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const r = require('../lib/briefe-rechte');

const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('Sicht: Ausschuss nur seine STWEG, Technik/Präsident alles (auch ohne STWEG)', () => {
  assert.equal(r.darfSehen(['stweg3-ausschuss'], 3), true);
  assert.equal(r.darfSehen(['stweg3-ausschuss'], 5), false);
  assert.equal(r.darfSehen(['stweg3-ausschuss'], null), false); // Altbestand ohne STWEG
  assert.equal(r.darfSehen(['technik'], null), true);
  assert.equal(r.darfSehen(['Präsident'], 5), true);
  assert.equal(r.darfZugang(['stweg3-verwaltung']), false);
  assert.equal(r.darfZugang(['r9-bewohner']), false);
  assert.equal(r.darfZugang(['meg-ausschuss']), true);
});

test('Erfassen: nur für die eigene STWEG; eine STWEG wird vorgewählt', () => {
  assert.equal(r.erfassStweg(['stweg3-ausschuss'], 3), 3);
  assert.equal(r.erfassStweg(['stweg3-ausschuss'], '3'), 3);
  assert.equal(r.erfassStweg(['stweg3-ausschuss'], 5), null);
  assert.equal(r.erfassStweg(['stweg3-ausschuss'], undefined), 3);
  assert.equal(r.erfassStweg(['stweg3-ausschuss', 'stweg5-ausschuss'], undefined), null);
  assert.equal(r.erfassStweg(['technik'], 7), 7);
  assert.equal(r.erfassStweg(['technik'], undefined), null);
  assert.equal(r.erfassStweg(['technik'], 99), null);
});

test('Vier-Augen: andere Konto-ID, Ausschuss derselben STWEG oder Technik/Präsident', () => {
  const a = { beantragt_von_id: 4 };
  assert.equal(r.darfEntscheiden({ id: 4, groups: ['technik'] }, a, 3).grund, 'eigener-antrag');
  assert.equal(r.darfEntscheiden({ id: 5, groups: ['stweg3-ausschuss'] }, a, 3).ok, true);
  assert.equal(r.darfEntscheiden({ id: 5, groups: ['stweg5-ausschuss'] }, a, 3).grund, 'andere-stweg');
  assert.equal(r.darfEntscheiden({ id: 5, groups: ['technik'] }, a, null).ok, true);
  assert.equal(r.darfEntscheiden({ groups: ['technik'] }, a, 3).grund, 'keine-konto-id');
});

test('Upload: Inhalt zählt, nicht die Endung', () => {
  assert.equal(r.bildTyp(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])), 'jpeg');
  assert.equal(r.bildTyp(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'png');
  assert.equal(r.bildTyp(Buffer.from('<svg onload=alert(1)>')), null);
  assert.equal(r.bildTyp(Buffer.from('%PDF-1.7 xxxxx')), null);
  assert.equal(r.bildTyp(Buffer.alloc(3)), null);
  assert.equal(r.base64Bytes('not base64!'), null);
  assert.deepEqual([...r.base64Bytes('data:image/jpeg;base64,/9j/')], [0xff, 0xd8, 0xff]);
  assert.equal(r.MAX_BYTES, 15 * 1024 * 1024);
});

test('Dateinamen: kein Pfad, nur <name>-<5 Ziffern>.jpeg|png', () => {
  assert.ok(r.sichererDateiname('anna-beispiel-12345.jpeg'));
  assert.ok(r.sichererDateiname('Muster-AG-00001.png'));
  assert.equal(r.sichererDateiname('../x-12345.jpeg'), null);
  assert.equal(r.sichererDateiname('a/b-12345.jpeg'), null);
  assert.equal(r.sichererDateiname('.versteckt-12345.jpeg'), null);
  assert.equal(r.sichererDateiname('anna-12345.svg'), null);
});

test('Hinweis und Tageslimit', () => {
  assert.match(r.HINWEIS_EXTERN, /OpenRouter/);
  assert.match(r.HINWEIS_EXTERN, /Anthropic/);
  assert.ok(r.OCR_TAGESLIMIT >= 1);
});

test('Router: Bestätigung, kein PAT/MCP, STWEG, Magic Bytes, Limit in der DB, Protokoll', () => {
  const s = src('routes/briefe.js');
  const i = s.indexOf("router.post('/upload'");
  const up = s.slice(i);
  const pos = (t) => { const p = up.indexOf(t); assert.ok(p > 0, t); return p; };
  // Reihenfolge: erst Hinweis/Kanal/STWEG/Inhalt pruefen und zaehlen, dann extern senden
  assert.ok(pos('req.pat ||') < pos('bestaetigt_extern !== true'));
  assert.ok(pos('bestaetigt_extern !== true') < pos('regeln.erfassStweg('));
  assert.ok(pos('regeln.erfassStweg(') < pos('regeln.bildTyp(buf)'));
  assert.ok(pos('regeln.bildTyp(buf)') < pos('await ocrZaehlen(req)'));
  assert.ok(pos('await ocrZaehlen(req)') < pos("fetch('https://openrouter.ai"));
  assert.match(s, /INSERT INTO briefe_ocr_nutzung/);
  assert.match(s, /WHERE briefe_ocr_nutzung\.anzahl < \$2/);
  assert.match(s, /protokoll\(req, 'erfasst'/);
  assert.match(s, /protokoll\(req, 'loeschantrag'/);
  assert.match(s, /protokoll\(req, 'loeschung-bestaetigt'/);
  assert.match(s, /CONSTRAINT briefe_vier_augen CHECK/);
  // Kein Rohinhalt der KI-Antwort mehr in Log oder Antwort
  assert.doesNotMatch(s, /raw: content/);
});

test('server.js: eigener JSON-Parser (15 MB wirksam), Router, Dokumenten-API gesperrt', () => {
  const s = src('server.js');
  const p = s.indexOf("app.use('/api/briefe/upload'");
  const g = s.indexOf("app.use(express.json({ limit: '10mb' }))");
  assert.ok(p > 0 && p < g, 'Parser vor dem globalen');
  assert.match(s.slice(p, g), /express\.json\(\{ limit: '21mb' \}\)/);
  assert.match(s, /app\.use\('\/api\/briefe', require\('\.\/routes\/briefe'\)\)/);
  assert.doesNotMatch(s, /app\.(get|post)\('\/api\/briefe/);
  assert.match(s, /require\('\.\/routes\/briefe'\)\.schemaSicherstellen\(client\)/);
  assert.match(s, /DOC_SPERR_ORDNER = new Set\(\[[^\]]*'fotos_von_versendeten_briefen'/);
  // 15 MB Bild als Base64 passt in 21 MB JSON
  assert.ok(Math.ceil(r.MAX_BYTES / 3) * 4 + 1000 < 21 * 1024 * 1024);
});

test('Fileserver-Tabelle: Brief-Fotos nur ADMIN', () => {
  const t = fs.readFileSync(path.join(__dirname, '..', '..', 'fileserver-lxc', 'ordnerrechte', 'tabelle.txt'), 'utf8');
  assert.match(t, /^~fotos_von_versendeten_briefen \| - \| -$/m);
});

test('Seite: STWEG-Auswahl, Hinweis vor dem Senden, Foto über /api/briefe', () => {
  const h = fs.readFileSync(path.join(__dirname, '..', '..', 'brief-tracking.html'), 'utf8');
  assert.match(h, /id="stweg-select"/);
  assert.match(h, /bestaetigt_extern: true/);
  assert.match(h, /confirm\('Texterkennung starten\?/);
  assert.match(h, /\/api\/briefe\/\$\{encodeURIComponent\(b\.filename\)\}\/bild/);
  assert.doesNotMatch(h, /\/api\/documents\//);
});
