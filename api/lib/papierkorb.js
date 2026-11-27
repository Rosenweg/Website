// Papierkorb für die Dokumenten-Ablage (Befund F3-4, Bericht Anleitungs-Prüfung).
//
// Löschen über die Website war endgültig (fs.unlink); Samba hat einen eigenen
// Papierkorb, die Website nicht. Jetzt:
//
//   Löschen       Datei wandert nach <oberster Ordner>/.papierkorb/<id>-<name>
//                 (gleicher Ordner der obersten Ebene = gleiche Fileserver-
//                 Rechte wie vorher; walkDocs zeigt Punkt-Ordner nicht an,
//                 safeDocPath sperrt .papierkorb für die normalen Routen)
//   Ersetzen      die überschriebene Fassung landet ebenso im Papierkorb
//   Wiederherst.  zurück an den alten Ort; gibt es dort inzwischen eine Datei,
//                 mit Zusatz „-wiederhergestellt“ im Namen
//   nach 30 Tagen endgültig gelöscht (Tageslauf)
//
// Wer was sieht: wer den ursprünglichen Pfad schreiben darf (canWriteDocPath),
// sieht und holt den Eintrag zurück. Jede Aktion steht in admin_protokoll
// (Bereich 'dokumente').
const pathModule = require('path');

const ORDNER = '.papierkorb';
const TAGE = 30;

const SQL_TABELLE = `
  CREATE TABLE IF NOT EXISTS dokumente_papierkorb (
    id SERIAL PRIMARY KEY,
    pfad TEXT NOT NULL,
    ablage TEXT NOT NULL,
    grund TEXT NOT NULL DEFAULT 'geloescht',
    groesse BIGINT,
    geloescht_von TEXT,
    geloescht_name TEXT,
    geloescht_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS dokumente_papierkorb_zeit ON dokumente_papierkorb (geloescht_am);`;

const bereitJe = new WeakMap();
function bereit(pool) {
  if (!bereitJe.has(pool)) bereitJe.set(pool, pool.query(SQL_TABELLE).catch((e) => { bereitJe.delete(pool); throw e; }));
  return bereitJe.get(pool);
}

/** Liegt ein Pfad (relativ zur Ablage) im Papierkorb? */
function imPapierkorb(rel) {
  return String(rel || '').split(/[\\/]+/).some(s => s.toLowerCase() === ORDNER);
}

/** Ablageort im Papierkorb für einen Pfad: <oberster Ordner>/.papierkorb/<id>-<name> */
function ablageFuer(pfad, id) {
  const teile = String(pfad).split('/').filter(Boolean);
  const name = teile.pop();
  const oben = teile.length ? teile[0] + '/' : '';
  return `${oben}${ORDNER}/${id}-${name}`;
}

/** Name für die Wiederherstellung, wenn am alten Ort schon etwas liegt. */
function ersatzName(pfad, n = 1) {
  const i = pfad.lastIndexOf('/');
  const ordner = i >= 0 ? pfad.slice(0, i + 1) : '';
  const name = pfad.slice(i + 1);
  const p = name.lastIndexOf('.');
  const stamm = p > 0 ? name.slice(0, p) : name;
  const endung = p > 0 ? name.slice(p) : '';
  return `${ordner}${stamm}-wiederhergestellt${n > 1 ? '-' + n : ''}${endung}`;
}

async function verschieben(fs, von, nach) {
  await fs.mkdir(pathModule.dirname(nach), { recursive: true });
  try {
    await fs.rename(von, nach);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fs.copyFile(von, nach);
    await fs.unlink(von);
  }
}

/**
 * Eine Datei in den Papierkorb legen. deps: { pool, fs, root (DOCS_PATH) }.
 * -> Zeile { id, pfad, ablage, … }
 */
async function hineinlegen({ pool, fs, root }, pfad, wer = {}, grund = 'geloescht') {
  await bereit(pool);
  const voll = pathModule.join(root, pfad);
  const st = await fs.stat(voll);
  if (!st.isFile()) throw Object.assign(new Error('Nur Dateien'), { code: 'EISDIR' });
  const r = await pool.query(
    `INSERT INTO dokumente_papierkorb (pfad, ablage, grund, groesse, geloescht_von, geloescht_name)
     VALUES ($1, '', $2, $3, $4, $5) RETURNING id`,
    [pfad, grund, st.size, wer.email || null, wer.name || null]);
  const id = r.rows[0].id;
  const ablage = ablageFuer(pfad, id);
  try {
    await verschieben(fs, voll, pathModule.join(root, ablage));
  } catch (e) {
    await pool.query('DELETE FROM dokumente_papierkorb WHERE id = $1', [id]).catch(() => {});
    throw e;
  }
  await pool.query('UPDATE dokumente_papierkorb SET ablage = $1 WHERE id = $2', [ablage, id]);
  return { id, pfad, ablage, grund, groesse: st.size };
}

/** Einträge (neueste zuerst), gefiltert mit darf(pfad). */
async function liste({ pool }, darf, tage = TAGE) {
  await bereit(pool);
  const { rows } = await pool.query(
    `SELECT id, pfad, grund, groesse, geloescht_von, geloescht_name, geloescht_am,
            geloescht_am + make_interval(days => $1::int) AS endgueltig_am
       FROM dokumente_papierkorb WHERE ablage <> '' ORDER BY geloescht_am DESC, id DESC LIMIT 1000`, [tage]);
  return rows.filter(r => darf(r.pfad));
}

/** Zurücklegen. -> { pfad (wo die Datei jetzt liegt), umbenannt } */
async function wiederherstellen({ pool, fs, root }, id, darf) {
  await bereit(pool);
  const r = await pool.query('SELECT * FROM dokumente_papierkorb WHERE id = $1', [id]);
  const e = r.rows[0];
  if (!e || !e.ablage || !darf(e.pfad)) return null;
  let ziel = e.pfad;
  for (let n = 1; n < 50; n++) {
    const da = await fs.stat(pathModule.join(root, ziel)).then(() => true, () => false);
    if (!da) break;
    ziel = ersatzName(e.pfad, n);
  }
  await verschieben(fs, pathModule.join(root, e.ablage), pathModule.join(root, ziel));
  await pool.query('DELETE FROM dokumente_papierkorb WHERE id = $1', [id]);
  return { eintrag: e, pfad: ziel, umbenannt: ziel !== e.pfad };
}

/** Einträge älter als `tage` endgültig löschen. -> Liste der gelöschten Einträge */
async function aufraeumen({ pool, fs, root }, tage = TAGE) {
  await bereit(pool);
  const { rows } = await pool.query(
    `SELECT id, pfad, ablage FROM dokumente_papierkorb
      WHERE geloescht_am < NOW() - make_interval(days => $1::int)`, [tage]);
  const weg = [];
  for (const e of rows) {
    if (e.ablage) await fs.unlink(pathModule.join(root, e.ablage)).catch(err => { if (err.code !== 'ENOENT') throw err; });
    await pool.query('DELETE FROM dokumente_papierkorb WHERE id = $1', [e.id]);
    weg.push(e);
  }
  return weg;
}

module.exports = { ORDNER, TAGE, imPapierkorb, ablageFuer, ersatzName, hineinlegen, liste, wiederherstellen, aufraeumen, bereit };
