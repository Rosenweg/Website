// node --test api/test/grundbuch-freigeben.test.js — W14: Die Seite hat einen
// Knopf für die Freigabe (verify), die die API schon kannte.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'grundbuch.html'), 'utf8');
const api = fs.readFileSync(path.join(__dirname, '..', 'routes', 'grundbuch.js'), 'utf8');

test('API: verify nur Ausschuss/Technik', () => {
  assert.match(api, /router\.post\('\/anteile\/:parzelle\/:sub_id\/verify'[\s\S]{0,120}isAusschussOrTechnik\(req\)/);
});

test('Seite: Knopf nur für Berechtigte und erfasste Anteile', () => {
  assert.match(html, /id="m-verify"/);
  assert.match(html, /m-verify'\)\.classList\.toggle\('hidden', !\(DARF_FREIGEBEN && current\.status === 'erfasst'\)\)/);
  assert.match(html, /\/verify`, \{ method: 'POST' \}/);
  const vm = require('node:vm');
  const i = html.indexOf('function istAusschussOderTechnik(');
  const fn = html.slice(i, html.indexOf('\n    }\n', i) + 6);
  const sb = {};
  vm.runInNewContext(fn + '\nglobalThis.f = istAusschussOderTechnik;', sb);
  assert.equal(sb.f(['stweg3-ausschuss']), true);
  assert.equal(sb.f(['meg-ausschuss']), true);
  assert.equal(sb.f(['Präsident']), true);
  assert.equal(sb.f(['r9-eigentuemer']), false);
  assert.equal(sb.f(['stweg3-verwaltung']), false);
});
