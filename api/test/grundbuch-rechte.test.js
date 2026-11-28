// node --test api/test/grundbuch-rechte.test.js — Grundbuch: keine Mieter,
// STWEG-gebunden, KI-Auslese nur mit Hinweis und Bestätigung (Klärung Welle 3.1,
// F1/F7; Entscheid Stefan 28.11.2026).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const gb = require('../lib/grundbuch-rechte');

const api = fs.readFileSync(path.join(__dirname, '..', 'routes', 'grundbuch.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'grundbuch.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('Erfassen: Eigentümer, Ausschuss, Technik/Präsident – keine Mieter', () => {
  assert.equal(gb.gbErfassenDarf(['r9-eigentuemer']), true);
  assert.equal(gb.gbErfassenDarf(['eigentuemer']), true, 'übergeordnete Gruppe');
  assert.equal(gb.gbErfassenDarf(['stweg5-ausschuss']), true);
  assert.equal(gb.gbErfassenDarf(['technik']), true);
  assert.equal(gb.gbErfassenDarf(['r9-bewohner']), false, 'Mieter');
  assert.equal(gb.gbErfassenDarf(['stweg3-verwaltung']), false);
  assert.equal(gb.gbErfassenDarf([]), false);
});

test('Anteil mit STWEG: nur Eigentümer bzw. Ausschuss dieser STWEG', () => {
  assert.equal(gb.gbAnteilErfassen(['r9-eigentuemer'], 3), true);
  assert.equal(gb.gbAnteilErfassen(['r9-eigentuemer'], 5), false);
  assert.equal(gb.gbAnteilErfassen(['stweg5-ausschuss', 'r9-bewohner'], 3), false, 'Ausschuss 5, in Haus 9 nur Mieter');
  assert.equal(gb.gbAnteilErfassen(['stweg5-ausschuss'], 5), true);
  assert.equal(gb.gbAnteilErfassen(['r9-eigentuemer'], null), true, 'noch nicht zugeordnet');
  assert.equal(gb.gbAnteilErfassen(['r9-bewohner'], null), false);
  assert.equal(gb.gbAnteilErfassen(['Präsident'], 7), true);
});

test('Routen: Mieter weder reservieren noch speichern noch auslesen', () => {
  const reserve = api.slice(api.indexOf("router.post('/anteile/:parzelle/:sub_id/reserve'"));
  assert.match(reserve.slice(0, 600), /gb\.gbAnteilErfassen\(gruppen\(req\), cur\.stweg\)/);
  const speichern = api.slice(api.indexOf("router.post('/anteile/:parzelle/:sub_id', authMiddleware"));
  assert.match(speichern.slice(0, 1400), /gb\.gbAnteilErfassen\(g, cur\.stweg\)/);
  assert.match(speichern.slice(0, 1600), /gb\.gbVollSicht\(g, cur\.stweg\)/);
  assert.doesNotMatch(api, /isAusschussOrTechnik/, 'alte, nicht STWEG-gebundene Prüfung');
});

test('KI-Auslese: Anteil, Bestätigung, kein Token/MCP', () => {
  const ocr = api.slice(api.indexOf("router.post('/ocr'"), api.indexOf("const apiKey = process.env.OPENROUTER_API_KEY"));
  assert.match(ocr, /gb\.gbMaschinenKanal\(req\)/);
  assert.match(ocr, /gb\.gbErfassenDarf\(gruppen\(req\)\)/);
  assert.match(ocr, /parzelle und sub_id des Anteils fehlen/);
  assert.match(ocr, /req\.body\?\.bestaetigt_extern !== true/);
  assert.equal(gb.gbMaschinenKanal({ pat: { id: 1 }, headers: {} }), true);
  assert.equal(gb.gbMaschinenKanal({ headers: { 'x-rosenweg-kanal': 'MCP' } }), true);
  assert.equal(gb.gbMaschinenKanal({ headers: {} }), false);
});

test('Seite: klarer Hinweis vor dem Senden, kein automatisches Auslesen', () => {
  assert.match(html, /id="m-ocr-box"[\s\S]{0,400}OpenRouter[\s\S]{0,120}Anthropic/);
  assert.match(html, /confirm\('Auszug per KI auslesen\?/);
  assert.match(html, /bestaetigt_extern: true/);
  assert.doesNotMatch(html, /await runOcr\(f\);\n    \}\);/, 'kein Auto-OCR beim Datei-Wählen');
});

test('STWEG-Bindung: Spalte, Filter, Zuordnen nur T/P', () => {
  assert.match(server, /ALTER TABLE grundbuch_anteile ADD COLUMN IF NOT EXISTS stweg INTEGER/);
  assert.match(api, /router\.put\('\/parzellen\/:parzelle\/stweg', authMiddleware, kartenAdmin\.mitKarteProtokollieren/);
  assert.match(api, /if \(!istTP\(req\)\) return res\.status\(403\)/);
  assert.match(api, /if \(req\.query\.stweg\)/);
  // Status: Mitwirkende (E-Mails aller STWEG) nur T/P
  assert.match(api, /const topListe = istTP\(req\) \? top\.rows/);
});
