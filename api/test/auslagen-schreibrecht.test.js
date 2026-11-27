// node --test api/test/auslagen-schreibrecht.test.js — W22: Prüfen und Genehmigen
// fremder Auslagen braucht das Seitenrecht „auslagen“ = write.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const groups = require('../lib/groups');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const stueck = (kopf) => { const i = src.indexOf(kopf); return src.slice(i, src.indexOf('\n}\n', i) + 2); };
const sb = { ...groups, recht: 'write' };
vm.runInNewContext([
  stueck('function canEditAuslageStatus('), stueck('async function auslagenSchreibrecht('), stueck('async function darfAuslagePruefen('),
  "async function getUserPermissions() { return { auslagen: recht }; }",
  'globalThis.darf = darfAuslagePruefen;'].join('\n'), sb);
const req = (g) => ({ user: { groups: g, email: 'a@example.ch' } });

test('Ausschuss mit write prüft, mit read nicht', async () => {
  sb.recht = 'write';
  assert.equal(await sb.darf({ stweg: 3 }, req(['stweg3-ausschuss'])), true);
  sb.recht = 'read';
  assert.equal(await sb.darf({ stweg: 3 }, req(['stweg3-ausschuss'])), false);
});

test('fremde STWEG nie, Technik immer', async () => {
  sb.recht = 'write';
  assert.equal(await sb.darf({ stweg: 5 }, req(['stweg3-ausschuss'])), false);
  sb.recht = 'none';
  assert.equal(await sb.darf({ stweg: 5 }, req(['technik'])), true);
});

test('alle Prüf-Stellen nutzen die Regel', () => {
  assert.equal((src.match(/darfAuslagePruefen\(row, req\)/g) || []).length, 6); // Definition + 5 Stellen
  assert.match(src, /can_review: isAdmin \|\| \(ausschussStwegs\.length > 0 && await auslagenSchreibrecht\(req\)\)/);
});
