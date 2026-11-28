// node --test api/test/isp-stoerung.test.js — Rosenweg Internet: "Stoerung melden" zeigt zuerst,
// was im eigenen Haus schon bekannt ist (GET /api/isp/stoerungen/meine).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const s = require('../lib/isp-stoerung');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const VLAN = { 99: 9, 139: 13 };
const w = (id, scope, extra = {}) => ({ id, title: `W${id}`, scope, status: 'active', severity: 'warning', ...extra });

test('scope: alle, leer und ohne Angaben gelten fuer alle Haeuser', () => {
  assert.equal(s.betrifftHaeuser({ all: true }, [9], VLAN), 'alle');
  assert.equal(s.betrifftHaeuser({}, [9], VLAN), 'alle');
  assert.equal(s.betrifftHaeuser(null, [9], VLAN), 'alle');
  assert.equal(s.betrifftHaeuser({ houses: [] }, [9], VLAN), 'alle');
});

test('scope: Haeuser und VLANs treffen nur die Bewohner dieser Haeuser', () => {
  assert.equal(s.betrifftHaeuser({ houses: [9] }, [9], VLAN), 'haus');
  assert.equal(s.betrifftHaeuser({ houses: ['9', 13] }, [13], VLAN), 'haus');
  assert.equal(s.betrifftHaeuser({ houses: [13] }, [9], VLAN), null);
  assert.equal(s.betrifftHaeuser({ vlans: [99] }, [9], VLAN), 'haus');
  assert.equal(s.betrifftHaeuser({ vlans: [99] }, [13], VLAN), null);
  // ein VLAN ohne Haus (eigenes Netz) betrifft kein Haus
  assert.equal(s.betrifftHaeuser({ vlans: [4711] }, [9], VLAN), null);
  // Haus und VLAN zusammen
  assert.equal(s.betrifftHaeuser({ houses: [2], vlans: [139] }, [13], VLAN), 'haus');
});

test('wer in keinem Haus wohnt, sieht nur Wartungen fuer alle', () => {
  const r = s.wartungenFuerHaeuser([w(1, { all: true }), w(2, { houses: [9] })], [], VLAN);
  assert.deepEqual(r.map(x => x.id), [1]);
});

test('Liste: nur das Noetige, mit Art der Betroffenheit', () => {
  const r = s.wartungenFuerHaeuser([
    w(1, { houses: [9] }, { description: 'Switch-Tausch', start_at: '2026-11-30T20:00:00Z', geheim: 'x' }),
    w(2, { houses: [13] }), w(3, { all: true }),
  ], [9], VLAN);
  assert.deepEqual(r.map(x => [x.id, x.betrifft]), [[1, 'haus'], [3, 'alle']]);
  assert.equal(r[0].description, 'Switch-Tausch');
  assert.equal(r[0].geheim, undefined);
  assert.equal(r[0].scope, undefined);
  assert.deepEqual(s.wartungenFuerHaeuser(null, [9]), []);
});

test('Endpunkt: Anmeldung, Haus aus Wohnung/Hobbyraum, keine Admin-Felder', () => {
  const i = server.indexOf("app.get('/api/isp/stoerungen/meine'");
  assert.ok(i > 0);
  const j = server.indexOf('\napp.', i + 10);
  const r = server.slice(i, j);
  assert.match(r, /authMiddleware/);
  assert.match(r, /getUserVlanOptions/);
  assert.match(r, /'wohnung'/);
  assert.match(r, /'hobbyraum'/);
  assert.match(r, /ispStoerung\.wartungenFuerHaeuser/);
  assert.match(server, /const ispStoerung = require\('\.\/lib\/isp-stoerung'\)/);
  assert.doesNotMatch(r, /SELECT \*/);
  assert.doesNotMatch(r, /auto_source/);
});
