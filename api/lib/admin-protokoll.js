// Protokoll für Verwaltungsaktionen ohne eigenes Protokoll (Befunde W15, W16).
//
// Wer hat wann welches Recht geändert, einen Löschtermin verschoben oder einen
// Eintrag entfernt? Eine Zeile je Änderung in admin_protokoll:
//   bereich  'rechte' | 'loeschungen' | …
//   aktion   z. B. 'geaendert', 'timer-verlaengert', 'entfernt'
//   ziel     worauf es sich bezieht (z. B. 'stweg3-ausschuss · auslagen' oder eine E-Mail)
//   alt/neu  Wert vorher/nachher (Text)
//   email, name, art  wer (art: Anmeldeart – konto, karte, qr, handy, anlage …)
// Lesen: Rechteverwaltung bzw. Kontolöschungen zeigen ihren Bereich an.
// Das Protokoll wird nie automatisch gelöscht (wenige Zeilen).

const SQL_TABELLE = `
  CREATE TABLE IF NOT EXISTS admin_protokoll (
    id SERIAL PRIMARY KEY,
    zeit TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    bereich TEXT NOT NULL,
    aktion TEXT NOT NULL,
    ziel TEXT,
    alt TEXT,
    neu TEXT,
    detail TEXT,
    email TEXT,
    name TEXT,
    art TEXT
  );
  CREATE INDEX IF NOT EXISTS admin_protokoll_bereich_zeit ON admin_protokoll (bereich, zeit DESC);`;

const bereitJe = new WeakMap();
function bereit(pool) {
  if (!bereitJe.has(pool)) {
    bereitJe.set(pool, pool.query(SQL_TABELLE).catch((e) => { bereitJe.delete(pool); throw e; }));
  }
  return bereitJe.get(pool);
}

const kurz = (v, n = 500) => (v === undefined || v === null ? null : String(v).slice(0, n));

function wer(req) {
  return {
    email: kurz(String(req?.user?.email || '').toLowerCase() || null, 200),
    name: kurz(req?.user?.name || null, 200),
    art: kurz(req?.auth?.art || (req?.appKarte ? 'karte' : req?.anlage ? 'anlage' : req?.pat ? 'token' : 'konto'), 40),
  };
}

/** Zeilen eintragen. db = pool oder client (in einer Transaktion). */
async function eintragen(pool, db, req, eintraege) {
  const liste = (Array.isArray(eintraege) ? eintraege : [eintraege]).filter(Boolean);
  if (!liste.length) return 0;
  await bereit(pool);
  const w = wer(req);
  for (const e of liste) {
    await (db || pool).query(
      `INSERT INTO admin_protokoll (bereich, aktion, ziel, alt, neu, detail, email, name, art)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [kurz(e.bereich, 40), kurz(e.aktion, 60), kurz(e.ziel), kurz(e.alt, 200), kurz(e.neu, 200), kurz(e.detail, 2000), w.email, w.name, w.art]);
  }
  return liste.length;
}

async function lesen(pool, bereich, limit = 100) {
  await bereit(pool);
  const n = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
  const { rows } = await pool.query(
    `SELECT zeit, aktion, ziel, alt, neu, detail, email, name, art FROM admin_protokoll
     WHERE bereich = $1 ORDER BY zeit DESC, id DESC LIMIT $2`, [bereich, n]);
  return rows;
}

/**
 * Welche Rechte ändert ein PUT /api/permissions wirklich? alte: Zeilen der
 * Tabelle permissions; neue: [{ group_name, page, access }] aus dem Body.
 * Gleichbleibende Werte zählen nicht ('none' = keine Zeile).
 */
function rechteAenderungen(alte, neue) {
  const vorher = new Map();
  for (const r of alte || []) vorher.set(`${r.group_name}\u0000${r.page}`, r.access);
  const raus = [];
  const gesehen = new Set();
  for (const p of neue || []) {
    if (!p || !p.group_name || !p.page || !['none', 'read', 'write'].includes(p.access)) continue;
    const k = `${p.group_name}\u0000${p.page}`;
    if (gesehen.has(k)) continue;
    gesehen.add(k);
    const alt = vorher.get(k) || 'none';
    if (alt !== p.access) raus.push({ group_name: p.group_name, page: p.page, alt, neu: p.access });
  }
  return raus;
}

module.exports = { bereit, eintragen, lesen, rechteAenderungen, SQL_TABELLE };
