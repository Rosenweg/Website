// node --test api/test/nav-menue.test.js — Menü in js/nav.js (Befunde B6, B9):
// Seiten im Menü, Verwaltungsmenü nur mit Seitenrecht, Adressen ohne Umlaut.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WURZEL = path.join(__dirname, '..', '..');
const quelle = fs.readFileSync(path.join(WURZEL, 'js', 'nav.js'), 'utf8');

function konstanten() {
  // Nur die Konstanten oben in nav.js auswerten (wie api/lib/stationapps.js).
  const kopf = quelle.slice(0, quelle.indexOf('const RosenwegNav'));
  const sb = {};
  vm.runInNewContext(kopf + '\nglobalThis.__k = { VERWALTUNG_NAV, VERWALTUNG_NAV_GRUPPE, TELEFON_NAV_GRUPPEN, WASCH_NAV_GRUPPEN };', sb);
  return sb.__k;
}

test('Verwaltungsmenü: jede Seite gibt es, Adresse ohne Umlaut, jeder Eintrag mit Seitenrecht', () => {
  const k = konstanten();
  // Verwaltung je STWEG (api/lib/groups.js) plus Übergang „verwaltung“
  const { VERWALTUNG_GROUPS } = require('../lib/groups');
  const navGruppen = k.VERWALTUNG_NAV_GRUPPE.split(',');
  assert.ok(navGruppen.includes('verwaltung'));
  for (const g of Object.values(VERWALTUNG_GROUPS)) assert.ok(navGruppen.includes(g), g + ' fehlt im Menü');
  assert.ok(k.VERWALTUNG_NAV.length >= 5);
  for (const v of k.VERWALTUNG_NAV) {
    assert.match(v.href, /^[a-z0-9-]+\.html$/, v.href);
    assert.ok(fs.existsSync(path.join(WURZEL, v.href)), v.href + ' fehlt');
    assert.ok(v.permAny && v.permAny.split(',').every(Boolean), v.label + ' ohne Recht');
  }
  const hrefs = k.VERWALTUNG_NAV.map(v => v.href);
  assert.ok(hrefs.includes('objektverwaltung.html'));
  assert.ok(hrefs.includes('unterschriftenliste-ruecklaeufe.html'));
});

test('Bewohner-Menü zeigt Mein Telefon, Smartphones, Apps und Waschküche', () => {
  for (const seite of ['mein-telefon.html', 'smartphones.html', 'apps.html', 'waschkueche.html']) {
    const n = quelle.split('${base}' + seite + '"').length - 1;
    assert.ok(n >= 2, seite + ': Desktop und Handy erwartet, gefunden ' + n);
  }
  const k = konstanten();
  assert.match(k.TELEFON_NAV_GRUPPEN, /bewohner/);
  assert.match(k.WASCH_NAV_GRUPPEN, /bewohner/);
});

test('Verwaltungsmenü ist an die Gruppe gebunden (Desktop und Handy)', () => {
  const n = quelle.split('data-nur-gruppe="${VERWALTUNG_NAV_GRUPPE}"').length - 1;
  assert.equal(n, 2);
  assert.match(quelle, /querySelectorAll\('\[data-nur-gruppe\]'\)/);
});

test('alte Rückläufe-Adresse mit Umlaut leitet auf die neue weiter', () => {
  const alt = fs.readFileSync(path.join(WURZEL, 'unterschriftenliste-rueckläufe.html'), 'utf8');
  assert.match(alt, /location\.replace\('\/unterschriftenliste-ruecklaeufe\.html' \+ location\.search/);
  assert.ok(fs.existsSync(path.join(WURZEL, 'unterschriftenliste-ruecklaeufe.html')));
});

test('F5-3: PBX-Admin steht unter „Betrieb & Admin“ und im Admin-Menü, nur mit Recht pbx-admin', () => {
  const kopf = quelle.slice(0, quelle.indexOf('const RosenwegNav'));
  const sb = {};
  vm.runInNewContext(kopf + '\nglobalThis.__g = SERVICES_GROUPS;', sb);
  const betrieb = sb.__g.find(g => g.title === 'Betrieb & Admin');
  const pbx = betrieb.items.filter(i => /pbx\.rosenweg4303\.ch/.test(i.href));
  assert.equal(pbx.length, 1);
  assert.equal(pbx[0].perm, 'pbx-admin');
  // nicht doppelt in einer anderen Gruppe
  const alle = sb.__g.flatMap(g => g.items).filter(i => /pbx\.rosenweg4303\.ch/.test(i.href));
  assert.equal(alle.length, 1);
  // Admin-Bereich (admin.rosenweg4303.ch): Eintrag nur für die Audience admin
  assert.match(quelle, /href: 'https:\/\/pbx\.rosenweg4303\.ch\/', label: 'PBX-Admin \(Telefonanlage\)', group: 'Infrastruktur', perm: 'pbx-admin', aud: \['admin'\]/);
  // Recht pbx-admin ist nur für Technik und Präsident angelegt
  const server = fs.readFileSync(path.join(WURZEL, 'api', 'server.js'), 'utf8');
  assert.match(server, /\('technik', 'pbx-admin', 'write'\),\s*\('Präsident', 'pbx-admin', 'write'\)/);
});

test('STWEG-Seiten: Reklamationsseite der STWEG im Bewohner-Menü (Desktop und Handy)', () => {
  assert.equal(quelle.split('${stwegReklD}').length - 1, 1);
  assert.equal(quelle.split('${stwegReklM}').length - 1, 1);
  for (const d of ['stweg1', 'stweg2', 'stweg3', 'stweg4', 'stweg5', 'stweg6', 'stweg7', 'meg']) {
    assert.ok(fs.existsSync(path.join(WURZEL, d, 'pages', 'reklamationen.html')), d);
  }
  // Helfer ausführen: ohne STWEG-Seite kein Eintrag, mit Pfad /stwegN/ der eigene
  const start = quelle.indexOf('  _stwegReklHref() {');
  const ende = quelle.indexOf('  _isStwegSite() {');
  const helfer = quelle.slice(start, ende);
  const isStweg = quelle.slice(ende, quelle.indexOf('\n  },', ende) + 4);
  const probe = (host, pfad) => {
    const sb = { window: { location: { hostname: host, pathname: pfad } } };
    vm.runInNewContext(`const o = {${helfer}${isStweg}}; globalThis.__r = o._stwegReklHref();`, sb);
    return sb.__r;
  };
  assert.equal(probe('www.rosenweg4303.ch', '/index.html'), null);
  assert.equal(probe('stweg5.rosenweg4303.ch', '/'), '/pages/reklamationen.html');
  assert.equal(probe('www.rosenweg4303.ch', '/stweg3/index.html'), '/stweg3/pages/reklamationen.html');
});
