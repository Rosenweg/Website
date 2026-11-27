// node --test api/test/energie-monitor-stweg.test.js — W11: Das Recht
// „energie-monitor“ gibt Ausschuss/Verwaltung die Zähler ihrer STWEG frei;
// der Präsident gilt in der Oberfläche wie die Technik.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Die Route braucht express und die Anmeldung nur zum Einhängen; für die reine
// Zuordnung reicht ein Stummel.
const Module = require('node:module');
const orig = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'express') { const r = () => {}; r.Router = () => ({ get() {}, use() {} }); return r; }
  if (req.endsWith('middleware/auth')) return { authMiddleware() {}, requirePermission() { return () => {}; } };
  return orig.call(this, req, ...rest);
};
const { zaehlerStweg } = require('../routes/energie-lesen');
Module._load = orig;

test('STWEG aus der Zählergruppe', () => {
  assert.equal(zaehlerStweg({ group_id: 'r9' }), 3);
  assert.equal(zaehlerStweg({ group_id: 'R1' }), 6);
  assert.equal(zaehlerStweg({ group_id: 'rw17' }), 1);
  assert.equal(zaehlerStweg({ group_id: 'stweg5' }), 5);
  assert.equal(zaehlerStweg({ group_id: 'meg' }), 8);
  assert.equal(zaehlerStweg({ group_id: 'labor' }), null);
  assert.equal(zaehlerStweg({}), null);
});

test('Routen nehmen die STWEG-Zähler dazu', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'energie-lesen.js'), 'utf8');
  assert.match(src, /hatRecht\(req, 'energie-monitor', 'read'\)/);
  assert.match(src, /await monitorRecht\(req\)/);
  assert.match(src, /return new Set\(\(await sichtbareZaehler\(req\)\)\.map/);
  assert.match(src, /req\.query\.stweg === '1'/);
});

test('Seite: Präsident wie Technik, genaue Gruppennamen', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'energie-monitor.html'), 'utf8');
  assert.doesNotMatch(html, /includes\('technik'\)/);
  assert.match(html, /gl === 'praesident'/);
  assert.match(html, /meine-zaehler\?gemeinschaft=1&stweg=1/);
});
