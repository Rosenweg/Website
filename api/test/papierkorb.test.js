// node --test api/test/papierkorb.test.js — Dokumente löschen geht in den
// Papierkorb (30 Tage), Wiederherstellen legt sie zurück.
const test = require('node:test');
const assert = require('node:assert/strict');
const fsn = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const pk = require('../lib/papierkorb');

// Kleine Tabelle im Speicher statt Postgres
function speicherPool() {
  const zeilen = new Map();
  let n = 0;
  return {
    zeilen,
    async query(sql, p = []) {
      if (/CREATE TABLE/.test(sql)) return { rows: [] };
      if (/^\s*INSERT INTO dokumente_papierkorb/.test(sql)) {
        const id = ++n;
        zeilen.set(id, { id, pfad: p[0], ablage: '', grund: p[1], groesse: p[2], geloescht_von: p[3], geloescht_name: p[4], geloescht_am: new Date() });
        return { rows: [{ id }] };
      }
      if (/^\s*UPDATE dokumente_papierkorb SET ablage/.test(sql)) { zeilen.get(p[1]).ablage = p[0]; return { rows: [] }; }
      if (/^\s*DELETE FROM dokumente_papierkorb/.test(sql)) { zeilen.delete(p[0]); return { rows: [] }; }
      if (/SELECT \* FROM dokumente_papierkorb WHERE id/.test(sql)) return { rows: zeilen.has(p[0]) ? [zeilen.get(p[0])] : [] };
      if (/WHERE geloescht_am < NOW\(\)/.test(sql)) {
        const grenze = Date.now() - p[0] * 86400000;
        return { rows: [...zeilen.values()].filter(z => z.geloescht_am.getTime() < grenze) };
      }
      if (/FROM dokumente_papierkorb WHERE ablage <> ''/.test(sql)) return { rows: [...zeilen.values()].filter(z => z.ablage) };
      throw new Error('unerwartet: ' + sql);
    },
  };
}

async function umgebung() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pk-'));
  await fs.mkdir(path.join(root, 'stweg3', 'protokolle'), { recursive: true });
  await fs.writeFile(path.join(root, 'stweg3', 'protokolle', 'gv-2026.pdf'), 'alt');
  return { root, pool: speicherPool(), fs };
}

test('Ablage im obersten Ordner, versteckt und gesperrt', () => {
  assert.equal(pk.ablageFuer('stweg3/protokolle/gv.pdf', 7), 'stweg3/.papierkorb/7-gv.pdf');
  assert.equal(pk.imPapierkorb('stweg3/.papierkorb/7-gv.pdf'), true);
  assert.equal(pk.imPapierkorb('stweg3/protokolle/gv.pdf'), false);
  assert.equal(pk.ersatzName('a/b/gv.pdf'), 'a/b/gv-wiederhergestellt.pdf');
  assert.equal(pk.ersatzName('a/b/gv.pdf', 2), 'a/b/gv-wiederhergestellt-2.pdf');
});

test('löschen, auflisten, wiederherstellen', async () => {
  const d = await umgebung();
  const e = await pk.hineinlegen(d, 'stweg3/protokolle/gv-2026.pdf', { email: 'otto@example.ch', name: 'Otto Ausschuss' });
  assert.equal(fsn.existsSync(path.join(d.root, 'stweg3/protokolle/gv-2026.pdf')), false);
  assert.equal(fsn.existsSync(path.join(d.root, e.ablage)), true);
  const alle = await pk.liste(d, () => true);
  assert.equal(alle.length, 1);
  assert.equal((await pk.liste(d, (p) => p.startsWith('stweg5/'))).length, 0);
  // inzwischen neue Datei mit gleichem Namen -> Zusatz im Namen
  await fs.writeFile(path.join(d.root, 'stweg3/protokolle/gv-2026.pdf'), 'neu');
  const r = await pk.wiederherstellen(d, e.id, () => true);
  assert.equal(r.umbenannt, true);
  assert.equal(r.pfad, 'stweg3/protokolle/gv-2026-wiederhergestellt.pdf');
  assert.equal(await fs.readFile(path.join(d.root, r.pfad), 'utf8'), 'alt');
  assert.equal(d.pool.zeilen.size, 0);
});

test('fremder Pfad: nicht wiederherstellen; nach 30 Tagen weg', async () => {
  const d = await umgebung();
  const e = await pk.hineinlegen(d, 'stweg3/protokolle/gv-2026.pdf', {});
  assert.equal(await pk.wiederherstellen(d, e.id, () => false), null);
  d.pool.zeilen.get(e.id).geloescht_am = new Date(Date.now() - 31 * 86400000);
  const weg = await pk.aufraeumen(d);
  assert.equal(weg.length, 1);
  assert.equal(fsn.existsSync(path.join(d.root, e.ablage)), false);
});

test('Server: Löschen und Ersetzen nutzen den Papierkorb, normale Routen sperren ihn', () => {
  const src = fsn.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = src.indexOf("app.delete('/api/documents/:path(*)'");
  const del = src.slice(i, src.indexOf('\n});', i));
  assert.doesNotMatch(del, /fs\.unlink/);
  assert.match(del, /papierkorb\.hineinlegen\(papierkorbDeps\(\), filePath, req\.user, 'geloescht'\)/);
  assert.match(src, /papierkorb\.hineinlegen\(papierkorbDeps\(\), filePath, req\.user, 'ersetzt'\)/);
  assert.match(src, /if \(papierkorb\.imPapierkorb\(userPath\)\) return null;/);
  assert.match(src, /app\.post\('\/api\/documents-papierkorb\/:id\/wiederherstellen', authMiddleware, canManageDocs/);
  const js = fsn.readFileSync(path.join(__dirname, '..', '..', 'js', 'documents.js'), 'utf8');
  assert.match(js, /showPapierkorb\(\)/);
  assert.match(js, /30 Tage lang wiederherstellen/);
});
