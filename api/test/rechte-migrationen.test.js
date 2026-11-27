// node --test api/test/rechte-migrationen.test.js — Befund P2: neue Rechte-
// Vorgaben greifen per benannter, einmaliger Migration auch fuer bestehende
// Gruppen; geaenderte Werte in der Rechteverwaltung bleiben danach.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RECHTE_MIGRATIONEN, rechteMigrationenAusfuehren } = require('../lib/rechte-migrationen');

// Kleine Attrappe: versteht genau die SQL der Migration.
function attrappe(perms) {
  const tabelle = new Map(Object.entries(perms)); // 'gruppe|seite' -> access
  const migr = new Set();
  let tx = null;
  const STUFE = { none: 0, read: 1, write: 2 };
  return {
    tabelle, migr,
    async query(sql, p = []) {
      if (/CREATE TABLE IF NOT EXISTS rechte_migrationen/.test(sql)) return { rows: [] };
      if (sql === 'BEGIN') { tx = { migr: new Set(migr), tabelle: new Map(tabelle) }; return {}; }
      if (sql === 'COMMIT') { tx = null; return {}; }
      if (sql === 'ROLLBACK') { if (tx) { migr.clear(); tx.migr.forEach(x => migr.add(x)); tabelle.clear(); tx.tabelle.forEach((v, k) => tabelle.set(k, v)); } tx = null; return {}; }
      if (/INSERT INTO rechte_migrationen/.test(sql)) {
        if (migr.has(p[0])) return { rows: [] };
        migr.add(p[0]); return { rows: [{ name: p[0] }] };
      }
      if (/UPDATE rechte_migrationen/.test(sql)) return { rowCount: 1 };
      if (/INSERT INTO permissions/.test(sql)) {
        let n = 0;
        for (const g of p[0]) {
          const k = `${g}|${p[1]}`;
          const alt = tabelle.get(k);
          if (alt === undefined) { tabelle.set(k, p[2]); n++; }
          else if (alt !== 'none' && STUFE[alt] < STUFE[p[2]]) { tabelle.set(k, p[2]); n++; }
        }
        return { rowCount: n };
      }
      throw new Error('unerwartete SQL: ' + sql);
    },
  };
}

test('Vorgaben: projekte=write für alle Verwaltungen, bewohner-verwaltung=write für alle Ausschüsse', () => {
  const p = RECHTE_MIGRATIONEN.find(m => m.page === 'projekte');
  assert.equal(p.access, 'write');
  assert.deepEqual([...p.gruppen].sort(), ['meg-verwaltung', ...[1, 2, 3, 4, 5, 6, 7].map(n => `stweg${n}-verwaltung`)].sort());
  const b = RECHTE_MIGRATIONEN.find(m => m.page === 'bewohner-verwaltung');
  assert.equal(b.access, 'write');
  assert.deepEqual([...b.gruppen].sort(), ['meg-ausschuss', ...[1, 2, 3, 4, 5, 6, 7].map(n => `stweg${n}-ausschuss`)].sort());
  assert.equal(new Set(RECHTE_MIGRATIONEN.map(m => m.name)).size, RECHTE_MIGRATIONEN.length, 'Namen eindeutig');
});

test('hebt read auf write, legt fehlende an, lässt none und write stehen; nur einmal', async () => {
  const c = attrappe({
    'stweg3-verwaltung|projekte': 'read',
    'stweg5-verwaltung|projekte': 'none',
    'stweg1-verwaltung|projekte': 'write',
  });
  const liste = [{ name: 'test-1', page: 'projekte', access: 'write', gruppen: ['stweg1-verwaltung', 'stweg3-verwaltung', 'stweg5-verwaltung', 'stweg7-verwaltung'] }];
  const r1 = await rechteMigrationenAusfuehren(c, liste);
  assert.deepEqual(r1, [{ name: 'test-1', geaendert: 2 }]);
  assert.equal(c.tabelle.get('stweg3-verwaltung|projekte'), 'write');
  assert.equal(c.tabelle.get('stweg7-verwaltung|projekte'), 'write');
  assert.equal(c.tabelle.get('stweg5-verwaltung|projekte'), 'none');
  // Danach in der Rechteverwaltung zurückgestellt: zweiter Start ändert nichts
  c.tabelle.set('stweg3-verwaltung|projekte', 'read');
  assert.deepEqual(await rechteMigrationenAusfuehren(c, liste), []);
  assert.equal(c.tabelle.get('stweg3-verwaltung|projekte'), 'read');
});

test('Fehler: Migration bleibt offen und wird beim nächsten Start erneut versucht', async () => {
  const c = attrappe({});
  const orig = c.query.bind(c);
  let einmal = true;
  c.query = async (sql, p) => {
    if (einmal && /INSERT INTO permissions/.test(sql)) { einmal = false; throw new Error('weg'); }
    return orig(sql, p);
  };
  const liste = [{ name: 'test-2', page: 'projekte', access: 'write', gruppen: ['stweg3-verwaltung'] }];
  await assert.rejects(rechteMigrationenAusfuehren(c, liste));
  assert.equal(c.migr.has('test-2'), false);
  assert.deepEqual(await rechteMigrationenAusfuehren(c, liste), [{ name: 'test-2', geaendert: 1 }]);
});

test('server.js führt die Migrationen in initDB aus', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /rechteMigrationen\.rechteMigrationenAusfuehren\(client\)/);
});
