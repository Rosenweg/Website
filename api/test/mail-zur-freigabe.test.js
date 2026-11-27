// node --test api/test/mail-zur-freigabe.test.js — Rosenweg Mail-Freigabe (App):
// GET /api/verwaltung-mail-queue/zur-freigabe liefert genau die Mails, die die
// Person jetzt freigeben kann (wie POST /:id/freigeben), mit ?seit= fuer
// "neu seit dem letzten Blick".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const groups = require('../lib/groups');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const stueck = (kopf) => { const i = src.indexOf(kopf); assert.ok(i >= 0, kopf); return src.slice(i, src.indexOf('\n}\n', i) + 2); };

const zeilen = [
  { id: 1, source_type: 'ad-hoc', source_id: null, subject: 'Rundschreiben', created_at: '2026-11-27T08:00:00Z', edited_at: null, von_mir: false, freigaben: '0', attachment_count: '1' },
  { id: 2, source_type: 'auslage-auszahlung', source_id: 9, subject: 'Auszahlung', created_at: '2026-11-28T08:00:00Z', edited_at: null, von_mir: false, freigaben: '1', attachment_count: '0' },
  { id: 3, source_type: 'ad-hoc', source_id: null, subject: 'Schon freigegeben', created_at: '2026-11-28T09:00:00Z', edited_at: null, von_mir: true, freigaben: '1', attachment_count: '0' },
  { id: 4, source_type: 'stweg3-info', source_id: null, subject: 'Nur Ausschuss', created_at: '2026-11-26T09:00:00Z', edited_at: '2026-11-28T10:00:00Z', von_mir: false, freigaben: '0', attachment_count: '0' },
];
const regeln = {
  'ad-hoc': { required_groups: 'technik,praesident', min_approvers: 1 },
  'auslage-auszahlung': { required_groups: 'technik,praesident', min_approvers: 2 },
  'stweg3-info': { required_groups: 'stweg3-ausschuss', min_approvers: 1 },
};
const sb = {
  ...groups,
  anfragen: [],
  pool: { query: async (sql, params) => { sb.anfragen.push({ sql, params }); return { rows: zeilen.map(z => ({ ...z })) }; } },
  getApprovalRuleForQueueItem: async (row) => regeln[row.source_type],
};
vm.runInNewContext(
  stueck('function userHasAnyGroup(') + '\n' + stueck('async function mailsZurFreigabe(')
  + '\nglobalThis.zurFreigabe = mailsZurFreigabe;', sb);
// Werte aus dem vm-Kontext haben eigene Array-Prototypen: als JSON vergleichen
const ids = (mails) => JSON.stringify(mails.map(m => m.id));
const ich = (g) => ({ groups: g, email: 'erika@example.ch' });

test('Präsident: alle offenen, die er freigeben darf, ohne die schon freigegebene', async () => {
  const { mails, anzahl } = await sb.zurFreigabe(ich(['Präsident']), null);
  assert.equal(ids(mails), '[1,2]');
  assert.equal(anzahl, 2);
  assert.equal(mails[1].noetig, 2);
  assert.equal(mails[1].freigaben, 1);
  assert.equal(mails[0].attachment_count, 1);
  assert.equal('von_mir' in mails[0], false);
  // eigene Freigaben per E-Mail der Person
  assert.equal(JSON.stringify(sb.anfragen.at(-1).params), '["erika@example.ch"]');
  assert.match(sb.anfragen.at(-1).sql, /status = 'pending'/);
});

test('Gruppe aus der Regel: nur ihre Mails (wie POST /freigeben)', async () => {
  const { mails } = await sb.zurFreigabe(ich(['stweg3-ausschuss']), null);
  assert.equal(ids(mails), '[4]');
  const leer = await sb.zurFreigabe(ich(['stweg5-ausschuss']), null);
  assert.equal(ids(leer.mails), '[]');
});

test('seit: nur neu eingestellte oder bearbeitete, anzahl zaehlt alle', async () => {
  const seit = new Date('2026-11-27T12:00:00Z');
  const a = await sb.zurFreigabe(ich(['technik', 'stweg3-ausschuss']), seit);
  assert.equal(ids(a.mails), '[2,4]'); // 4: bearbeitet am 28.
  assert.equal(a.anzahl, 3);
});

test('Route: vor /:id angemeldet, seit wird geprueft, keine Technik-Sperre', () => {
  const route = "app.get('/api/verwaltung-mail-queue/zur-freigabe', authMiddleware, async";
  const i = src.indexOf(route);
  assert.ok(i > 0, route);
  assert.ok(i < src.indexOf("app.get('/api/verwaltung-mail-queue/:id', authMiddleware"), 'vor /:id, sonst faengt :id sie ab');
  const rumpf = src.slice(i, src.indexOf('\n});\n', i));
  assert.match(rumpf, /status\(400\)/);
  assert.doesNotMatch(rumpf, /requireTechnikOrPraesident/);
});
