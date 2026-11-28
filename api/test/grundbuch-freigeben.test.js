// node --test api/test/grundbuch-freigeben.test.js — W14: Die Seite hat einen
// Knopf für die Freigabe (verify), die die API schon kannte. Seit 28.11.2026
// STWEG-gebunden: freigeben darf der Ausschuss der STWEG des Anteils sowie
// Technik/Präsident (lib/grundbuch-rechte.js gbVollSicht), die Seite folgt
// dem Feld darf_freigeben je Anteil.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'grundbuch.html'), 'utf8');
const api = fs.readFileSync(path.join(__dirname, '..', 'routes', 'grundbuch.js'), 'utf8');
const gb = require('../lib/grundbuch-rechte');

test('API: verify nur Ausschuss dieser STWEG oder Technik/Präsident', () => {
  assert.match(api, /router\.post\('\/anteile\/:parzelle\/:sub_id\/verify'[\s\S]{0,260}gb\.gbVollSicht\(gruppen\(req\), cur\.stweg\)/);
  assert.equal(gb.gbVollSicht(['stweg3-ausschuss'], 3), true);
  assert.equal(gb.gbVollSicht(['meg-ausschuss'], 8), true);
  assert.equal(gb.gbVollSicht(['Präsident'], null), true);
  assert.equal(gb.gbVollSicht(['stweg3-ausschuss'], 5), false, 'fremde STWEG');
  assert.equal(gb.gbVollSicht(['stweg3-ausschuss'], null), false, 'ohne STWEG nur T/P');
  assert.equal(gb.gbVollSicht(['r9-eigentuemer'], 3), false);
  assert.equal(gb.gbVollSicht(['stweg3-verwaltung'], 3), false);
});

test('Seite: Knopf nur für Berechtigte und erfasste Anteile', () => {
  assert.match(html, /id="m-verify"/);
  assert.match(html, /DARF_FREIGEBEN = !!current\.darf_freigeben;/);
  assert.match(html, /m-verify'\)\.classList\.toggle\('hidden', !\(DARF_FREIGEBEN && current\.status === 'erfasst'\)\)/);
  assert.match(html, /\/verify`, \{ method: 'POST' \}/);
  assert.match(api, /darf_freigeben: voll/);
});
