// node --test api/test/zev-wechsel.test.js — Z4: Verkauf einer selbst bewohnten
// Wohnung (Wechsel nur mit Rolle Eigentümer) meldet dem Messdienst und hält den
// alten Alias 6 Monate, wie beim Mieterwechsel. Erfundene Kontakte.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { zevAktuellerBewohner, zevWechselMelden } = require('../lib/zev');

const neueEigentuemerin = { id: 21, wohnung_id: 7, rolle: 'eigentuemer', sort_order: 0 };
const mieter = { id: 22, wohnung_id: 7, rolle: 'mieter', sort_order: 0 };

test('Aktueller Bewohner: Mieter > Bewohner > Eigentümer, dann sort_order und id', () => {
  assert.equal(zevAktuellerBewohner([neueEigentuemerin, mieter]).id, 22);
  assert.equal(zevAktuellerBewohner([neueEigentuemerin, { id: 23, rolle: 'bewohner' }]).id, 23);
  assert.equal(zevAktuellerBewohner([{ id: 5, rolle: 'eigentuemer', sort_order: 2 }, { id: 9, rolle: 'eigentuemer', sort_order: 1 }]).id, 9);
  assert.equal(zevAktuellerBewohner([{ id: 9, rolle: 'eigentuemer' }, { id: 5, rolle: 'eigentuemer' }]).id, 5);
  assert.equal(zevAktuellerBewohner([{ id: 1, rolle: 'verwalter' }]), null);
});

test('Selbst bewohnte Wohnung verkauft: neue Eigentümerin wird gemeldet', () => {
  assert.equal(zevWechselMelden(neueEigentuemerin, [neueEigentuemerin]), true);
});

test('Vermietete Wohnung verkauft: keine Meldung (Alias bleibt beim Mieter)', () => {
  assert.equal(zevWechselMelden(neueEigentuemerin, [neueEigentuemerin, mieter]), false);
});

test('Zweite Eigentümerin (Paar): nur die erste ist Namensgeberin des Alias', () => {
  const zweite = { id: 30, wohnung_id: 7, rolle: 'eigentuemer', sort_order: 1 };
  assert.equal(zevWechselMelden(zweite, [neueEigentuemerin, zweite]), false);
});

test('Mieter und Bewohner werden weiterhin immer gemeldet, Verwalter nie', () => {
  assert.equal(zevWechselMelden(mieter, [neueEigentuemerin, mieter]), true);
  assert.equal(zevWechselMelden({ id: 40, rolle: 'bewohner' }, []), true);
  assert.equal(zevWechselMelden({ id: 41, rolle: 'verwalter' }, []), false);
});

test('Server: Tageslauf, alter Alias (6 Monate) und Umstellungs-Hinweis kennen die Rolle Eigentümer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const map = src.slice(src.indexOf('async function buildZevAliasMap'), src.indexOf('async function sendZevRemail'));
  assert.match(map, /k\.rolle IN \('mieter','bewohner','eigentuemer'\)\s*\n\s*AND k\.archiviert_am IS NOT NULL/);
  const notify = src.slice(src.indexOf('async function notifyZevWechsel'), src.indexOf('async function retryZevRemails'));
  assert.match(notify, /rolle IN \('mieter','bewohner','eigentuemer'\) AND archiviert_am IS NOT NULL/);
  assert.match(notify, /Eigentümer \(selbst bewohnt\)/);
  const daily = src.slice(src.indexOf('async function processZevDaily'), src.indexOf("app.get('/api/zev/config/:stweg'"));
  assert.match(daily, /k\.rolle IN \('mieter','bewohner','eigentuemer'\)/);
  assert.match(daily, /zevWechselMelden\(k, /);
});
