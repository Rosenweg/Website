// node --test api/test/rechte-schluessel.test.js — W18/F6-1: Rechte-Schlüssel
// nur mit Umlaut, ASCII-Zeilen werden zusammengeführt; Rechteverwaltung zeigt alle.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const rs = require('../lib/rechte-schluessel');

const WURZEL = path.join(__dirname, '..', '..');

// Tabelle permissions im Speicher, nur die zwei Abfragen von vereinheitlichen()
function falscheDb(zeilen) {
  const t = zeilen.map(z => ({ ...z }));
  return {
    t,
    async query(sql, [a, b]) {
      if (sql === rs.SQL_UEBERNEHMEN) {
        for (const z of t.filter(x => x.page === a)) {
          const da = t.find(x => x.group_name === z.group_name && x.page === b);
          if (da) da.access = rs.hoeheres(da.access, z.access); else t.push({ group_name: z.group_name, page: b, access: z.access });
        }
        return { rowCount: 0 };
      }
      if (/^DELETE FROM permissions WHERE page = \$1$/.test(sql)) {
        const vor = t.length;
        for (let i = t.length - 1; i >= 0; i--) if (t[i].page === a) t.splice(i, 1);
        return { rowCount: vor - t.length };
      }
      throw new Error('unerwartet: ' + sql);
    },
  };
}

test('ASCII-Zeilen gehen auf den Umlaut-Schlüssel, höheres Recht gewinnt', async () => {
  const db = falscheDb([
    { group_name: 'stweg3-verwaltung', page: 'zaehler', access: 'read' },
    { group_name: 'stweg3-ausschuss', page: 'zaehler', access: 'write' },
    { group_name: 'stweg3-ausschuss', page: 'zähler', access: 'read' },
    { group_name: 'stweg3-verwaltung', page: 'waschkueche-admin', access: 'read' },
    { group_name: 'technik', page: 'mail-empfaenger', access: 'write' },
    { group_name: 'technik', page: 'handwerker', access: 'write' },
  ]);
  const n = await rs.vereinheitlichen(db);
  assert.equal(n, 4);
  const hat = (g, p) => (db.t.find(x => x.group_name === g && x.page === p) || {}).access;
  assert.equal(hat('stweg3-verwaltung', 'zähler'), 'read');
  assert.equal(hat('stweg3-ausschuss', 'zähler'), 'write');
  assert.equal(hat('stweg3-verwaltung', 'waschküche-admin'), 'read');
  assert.equal(hat('technik', 'mail-empfänger'), 'write');
  assert.equal(hat('technik', 'handwerker'), 'write');
  assert.ok(!db.t.some(x => /ae|ue/.test(x.page) && rs.DOPPELTE_SCHLUESSEL.some(([a]) => a === x.page)));
});

test('Seeds und Menü nutzen nur noch die Umlaut-Form', () => {
  const src = fs.readFileSync(path.join(WURZEL, 'api', 'server.js'), 'utf8');
  const nav = fs.readFileSync(path.join(WURZEL, 'js', 'nav.js'), 'utf8');
  for (const [alt] of rs.DOPPELTE_SCHLUESSEL) {
    assert.doesNotMatch(src, new RegExp(`\\['${alt}', '(read|write)'\\]`), alt);
    assert.doesNotMatch(nav, new RegExp(`perm(Any)?: '([^']*,)?${alt}(,[^']*)?'`), alt);
  }
  assert.match(src, /await rechteSchluessel\.vereinheitlichen\(client\)/);
});

test('Rechteverwaltung: fehlende Rechte als Spalte, dazu jeder Schlüssel aus der Tabelle', () => {
  const auth = fs.readFileSync(path.join(WURZEL, 'api', 'lib', 'auth.js'), 'utf8');
  for (const id of ['objektverwaltung', 'projekte', 'vollmachten', 'loeschungen', 'pbx-admin', 'echtheitspruefung', 'mail-empfänger', 'waschküche', 'waschküche-admin', 'zähler']) {
    assert.ok(auth.includes(`{ id: '${id}'`), id);
  }
  assert.match(auth, /function rechteSpalten\(zeilen\)/);
  const src = fs.readFileSync(path.join(WURZEL, 'api', 'server.js'), 'utf8');
  assert.match(src, /pages: rechteSpalten\(result\.rows\)/);
});
