// node --test api/test/hilfe-anleitungen.test.js — Befund H1: hilfe.html
// verlinkt je Thema auf die Anleitungen als PDF (js/hilfe-anleitungen.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WURZEL = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(WURZEL, 'hilfe.html'), 'utf8');
const js = fs.readFileSync(path.join(WURZEL, 'js', 'hilfe-anleitungen.js'), 'utf8');
const sb = {};
vm.runInNewContext(js + '\nglobalThis.__a = ANLEITUNGEN; globalThis.__z = ABSCHNITT_PDF;', sb);

test('jeder zugeordnete Abschnitt existiert in hilfe.html', () => {
  for (const id of Object.keys(sb.__z)) assert.ok(html.includes(`<section id="${id}"`), id);
});

test('Zuordnung nennt nur bekannte PDFs, Ordner wie im Dokumenten-Repo', () => {
  for (const [id, liste] of Object.entries(sb.__z)) {
    for (const [g, d] of liste) assert.ok(sb.__a[g] && sb.__a[g].dateien[d], `${id}: ${g}/${d}`);
  }
  assert.equal(sb.__a.bewohner.ordner, 'allgemein/anleitungen/bewohner/');
  assert.equal(sb.__a.ausschuss.ordner, 'allgemein/anleitungen/ausschuss-technik-praesident/');
  assert.equal(sb.__a.hausverwaltung.ordner, 'allgemein/anleitungen/hausverwaltung/');
  assert.equal(sb.__a.technik.ordner, 'technik/anleitungen/');
  for (const g of Object.values(sb.__a)) for (const d of Object.keys(g.dateien)) assert.match(d, /^[a-z0-9-]+\.pdf$/);
});

test('Technik-Anleitungen nur für Technik/Präsident sichtbar', () => {
  assert.equal(sb.__a.technik.nurGruppen, 'technik,praesident');
  for (const g of ['bewohner', 'ausschuss', 'hausverwaltung']) assert.equal(sb.__a[g].nurGruppen, undefined);
});

test('hilfe.html bindet die Anleitungen ein und öffnet über downloadDoc', () => {
  assert.match(html, /<div id="anleitungen-pdf"/);
  assert.match(html, /<script src="\/js\/hilfe-anleitungen\.js"><\/script>\s*<script>HilfeAnleitungen\.init\(document\);<\/script>/);
  assert.match(html, /async function downloadDoc\(path\)/);
  assert.match(js, /window\.downloadDoc\(b\.dataset\.pdf\)/);
});
