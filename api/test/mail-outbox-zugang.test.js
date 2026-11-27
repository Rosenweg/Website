// node --test api/test/mail-outbox-zugang.test.js — W21/W29: Die Outbox richtet
// sich nach den Freigabe-Regeln; wer eine Mail einstellt, sieht sie dort.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const groups = require('../lib/groups');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const stueck = (kopf) => { const i = src.indexOf(kopf); return src.slice(i, src.indexOf('\n}\n', i) + 2); };
const sb = { ...groups, regel: 'technik,praesident' };
vm.runInNewContext(
  stueck('function userHasAnyGroup(') + '\n' + stueck('async function mailQueueZugang(')
  + '\nasync function getApprovalRuleForQueueItem() { return { required_groups: regel, min_approvers: 1 }; }'
  + '\nglobalThis.zugang = mailQueueZugang;', sb);
const req = (g, email = 'otto@example.ch') => ({ user: { groups: g, email } });
const mail = { source_type: 'ad-hoc', created_by: 'Otto@Example.ch' };

test('Technik/Präsident alles', async () => {
  const z = await sb.zugang(req(['Präsident']), mail);
  assert.equal(z.sehen, true);
  assert.equal(z.freigeber, true);
});

test('Freigabe-Gruppe aus der Regel', async () => {
  sb.regel = 'stweg3-ausschuss';
  const z = await sb.zugang(req(['stweg3-ausschuss'], 'anna@example.ch'), mail);
  assert.equal(z.sehen, true);
  assert.equal(z.freigeber, true);
  const y = await sb.zugang(req(['stweg5-ausschuss'], 'anna@example.ch'), mail);
  assert.equal(y.sehen, false);
  sb.regel = 'technik,praesident';
});

test('eigene Mail: sehen, nicht freigeben', async () => {
  const z = await sb.zugang(req(['stweg3-ausschuss']), mail);
  assert.equal(z.sehen, true);
  assert.equal(z.freigeber, false);
});

test('Routen nutzen mailQueueZugang statt nur Technik/Präsident', () => {
  for (const r of ["app.get('/api/verwaltung-mail-queue', authMiddleware, async",
    "app.get('/api/verwaltung-mail-queue/:id', authMiddleware, async",
    "app.put('/api/verwaltung-mail-queue/:id', authMiddleware, ...mailQueueSchreibend",
    "app.post('/api/verwaltung-mail-queue/:id/ablehnen', authMiddleware, ...mailQueueSchreibend",
    "app.get('/api/verwaltung-mail-queue/:id/attachment/:idx', authMiddleware, async"]) {
    assert.ok(src.includes(r), r);
  }
  assert.doesNotMatch(src, /verwaltung-mail-queue[^\n]*requireTechnikOrPraesident/);
});

test('Seiten: kein Versprechen „immer Freigabe“, Knöpfe nur für Freigebende', () => {
  const compose = fs.readFileSync(path.join(__dirname, '..', '..', 'mail-compose.html'), 'utf8');
  assert.doesNotMatch(compose, /Wird automatisch in die/);
  assert.match(compose, /Direktversand/);
  const outbox = fs.readFileSync(path.join(__dirname, '..', '..', 'verwaltung-mail-outbox.html'), 'utf8');
  assert.match(outbox, /const darfFreigeben = isPending && !!m\._can_approve/);
  assert.doesNotMatch(outbox, /nur Technik \/ Präsident/);
  const nav = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'nav.js'), 'utf8');
  assert.match(nav, /verwaltung-mail-outbox\.html', activeKey: 'verwaltung-mail-outbox', permAny: 'technik,praesident,mail-compose'/);
});
