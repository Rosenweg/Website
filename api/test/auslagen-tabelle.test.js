// node --test api/test/auslagen-tabelle.test.js — N2: Kopf und Zeilen der
// Auslagen-Tabelle haben gleich viele Spalten (Projekt hat eine eigene Zelle).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'auslagen.html'), 'utf8');

test('Anzahl Kopfspalten = Zellen je Zeile = colspan', () => {
  const kopf = html.slice(html.indexOf('<table id="auslagen-table"'), html.indexOf('<tbody id="tbody"'));
  const spalten = (kopf.match(/<th /g) || []).length;
  const zeile = html.slice(html.indexOf('return `<tr class="hover:bg-gray-50">'), html.indexOf('</tr>`;', html.indexOf('return `<tr class="hover:bg-gray-50">')));
  const zellen = (zeile.match(/<td /g) || []).length;
  assert.equal(spalten, 11);
  assert.equal(zellen, spalten);
  for (const m of html.matchAll(/colspan="(\d+)"/g)) assert.equal(Number(m[1]), spalten);
  // Reihenfolge: Kategorie, Projekt, Betrag
  assert.ok(zeile.indexOf('a.kategorie') < zeile.indexOf('projektZelle') && zeile.indexOf('projektZelle') < zeile.indexOf('fmtCHF(a.betrag_chf)'));
});
