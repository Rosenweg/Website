// Aufbewahrung der Unterschriftenlisten (Entscheid Stefan 28.11.2026, E2):
// Listen (Snapshot mit Eigentümern, Adressen, Wertquoten), ihre Rückläufe
// (Ja/Nein mit Name) und das gespeicherte Original-PDF bleiben 10 Jahre ab
// dem Erzeugen (generated_at) – so lange gelten sie als Beschlussunterlagen.
// Danach löscht der tägliche Lauf (server.js, 04:20) alles drei. Der
// öffentliche Abruf per Hash (verify-json, snapshot/:hash.pdf) bleibt bis
// dahin unverändert (Entscheid vom 21.11.2026); danach liefert er 404.
const pathModule = require('path');

const UL_AUFBEWAHRUNG_JAHRE = 10;

/**
 * Abgelaufene Listen löschen. db: pool (query), fs: fs.promises (unlink),
 * docsPath: Wurzel der Dokumente. -> { listen, ruecklaeufe, pdfs }
 */
async function ulAbgelaufeneLoeschen(db, { fs, docsPath, jahre = UL_AUFBEWAHRUNG_JAHRE } = {}) {
  const alt = await db.query(
    `SELECT hash, pdf_path FROM unterschriftenliste_snapshots
      WHERE generated_at < NOW() - make_interval(years => $1::int)`, [jahre]);
  if (!alt.rows.length) return { listen: 0, ruecklaeufe: 0, pdfs: 0 };
  const hashes = alt.rows.map(r => r.hash);
  const rl = await db.query('DELETE FROM unterschriftenliste_rueckläufe WHERE snapshot_hash = ANY($1::text[])', [hashes]);
  const sn = await db.query('DELETE FROM unterschriftenliste_snapshots WHERE hash = ANY($1::text[])', [hashes]);
  let pdfs = 0;
  const wurzel = pathModule.resolve(docsPath || '/documents') + pathModule.sep;
  for (const r of alt.rows) {
    if (!r.pdf_path || !fs) continue;
    const voll = pathModule.resolve(wurzel, r.pdf_path);
    if (!voll.startsWith(wurzel)) continue; // nur im Dokumente-Ordner
    try { await fs.unlink(voll); pdfs++; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return { listen: sn.rowCount || 0, ruecklaeufe: rl.rowCount || 0, pdfs };
}

module.exports = { UL_AUFBEWAHRUNG_JAHRE, ulAbgelaufeneLoeschen };
