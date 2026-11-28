// Einmalige Rechte-Migrationen (Befund P2).
//
// Die Seeds in initDB legen Rechte mit ON CONFLICT DO NOTHING an: so bleiben in
// der Rechteverwaltung geaenderte Werte erhalten – aber eine neue Vorgabe (z. B.
// projekte read -> write) greift fuer schon bestehende Gruppen nie. Statt
// ON CONFLICT DO UPDATE auf alles setzt eine benannte Migration GEZIELT die
// genannten Werte, genau einmal je Datenbank (Tabelle rechte_migrationen).
//
// Regeln einer Migration:
//   - fehlt die Zeile: wird angelegt
//   - steht ein tieferes Recht (read < write): wird angehoben
//   - steht 'none' oder ein gleich hohes/hoeheres Recht: bleibt (bewusst
//     gesperrte Gruppen nicht wieder oeffnen)
// Nach dem Lauf ist der Name eingetragen; spaetere Aenderungen in der
// Rechteverwaltung bleiben. Neue Vorgabe = neuer Name, nie einen alten aendern.
const { STWEG_GROUPS, VERWALTUNG_GROUPS } = require('./groups');

const AUSSCHUESSE = Object.values(STWEG_GROUPS).map(g => g.ausschuss).filter(Boolean);
const VERWALTUNGEN = Object.values(VERWALTUNG_GROUPS);

const RECHTE_MIGRATIONEN = [
  // Projekte anlegen/bearbeiten fuer die Verwaltung ihrer STWEG(s) (Entscheid Stefan 27.11.2026)
  { name: '2026-11-27-projekte-verwaltung-write', page: 'projekte', access: 'write', gruppen: VERWALTUNGEN },
  // Konten anlegen: alle Ausschuesse (Entscheid Stefan 27.11.2026, Befund W2/F3-8)
  { name: '2026-11-27-bewohner-verwaltung-ausschuss-write', page: 'bewohner-verwaltung', access: 'write', gruppen: AUSSCHUESSE },
  // Im Portal an Verteiler senden verlangt schreiben (Entscheid Stefan 27.11.2026, V10);
  // 'Verwaltung' = ÜBERGANG (alte globale Gruppe).
  { name: '2026-11-27-email-verteiler-verwaltung-write', page: 'email-verteiler', access: 'write', gruppen: [...VERWALTUNGEN, 'Verwaltung'] },
  // STWEG-Termine anlegen/aendern/loeschen: alle Ausschuesse und Verwaltungen, die API
  // bindet es an die eigene STWEG (lib/termine.js; Entscheid Stefan 28.11.2026)
  { name: '2026-11-28-stweg-termine-ausschuss-verwaltung-write', page: 'stweg-termine', access: 'write', gruppen: [...AUSSCHUESSE, ...VERWALTUNGEN] },
  // Vollmachten: die Ausschuss-Sicht (alle Vollmachten der eigenen STWEG) haengt
  // jetzt am Seitenrecht „vollmachten“; Vorgabe lesen, damit nichts wegfaellt
  // (Entscheid Stefan 28.11.2026, Fund R2). Abschalten: in der Rechteverwaltung auf none.
  { name: '2026-11-28-vollmachten-ausschuss-read', page: 'vollmachten', access: 'read', gruppen: AUSSCHUESSE },
  // Handwerker: der Ausschuss liest Vertraege, Einsaetze und Notfall-Zuordnungen
  // seiner STWEG (lib/handwerker-rechte.js; Entscheid Stefan 28.11.2026).
  // Schreiben bleibt der Verwaltung der STWEG und Technik/Praesident vorbehalten.
  { name: '2026-11-28-handwerker-ausschuss-read', page: 'handwerker', access: 'read', gruppen: AUSSCHUESSE },
  // Konto-Loeschungen: Ausschuss und Verwaltung stoppen und verlaengern fuer die eigene
  // STWEG (Sicht in server.js); „Eintrag entfernen“ bleibt Technik, „Sofort loeschen“
  // Technik/Praesident (lib/kontoloeschung.js; Entscheid Stefan 28.11.2026, E3b).
  { name: '2026-11-28-loeschungen-ausschuss-verwaltung-write', page: 'loeschungen', access: 'write', gruppen: [...AUSSCHUESSE, ...VERWALTUNGEN].filter(g => /^stweg\d+-/.test(g)) },
  // E-Mail-Archiv: die API prueft jetzt das Seitenrecht „email-archiv“; die
  // Verwaltung liest die Mails ihrer STWEG(s) plus „haus“ (Entscheid Stefan
  // 28.11.2026, Klaerung Mail-Archiv E2/F2). Der Ausschuss hat den Seed „read“.
  { name: '2026-11-28-email-archiv-verwaltung-read', page: 'email-archiv', access: 'read', gruppen: [...VERWALTUNGEN, 'Verwaltung'] },
];

const SQL_TABELLE = `
  CREATE TABLE IF NOT EXISTS rechte_migrationen (
    name VARCHAR(120) PRIMARY KEY,
    ausgefuehrt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    geaendert INTEGER NOT NULL DEFAULT 0
  )`;

const SQL_SETZEN = `
  INSERT INTO permissions (group_name, page, access)
  SELECT g, $2, $3 FROM unnest($1::text[]) AS g
  ON CONFLICT (group_name, page) DO UPDATE SET access = EXCLUDED.access
  WHERE permissions.access <> 'none'
    AND (CASE permissions.access WHEN 'read' THEN 1 WHEN 'write' THEN 2 ELSE 0 END)
      < (CASE EXCLUDED.access WHEN 'read' THEN 1 WHEN 'write' THEN 2 ELSE 0 END)`;

// Fuehrt alle noch nicht eingetragenen Migrationen aus. Je Migration eine
// Transaktion: erst den Namen beanspruchen (mehrere API-Repliken starten
// gleichzeitig – nur eine fuehrt aus), dann setzen, dann zaehlen.
// Liefert [{ name, geaendert }] der in diesem Lauf ausgefuehrten.
async function rechteMigrationenAusfuehren(client, liste = RECHTE_MIGRATIONEN) {
  await client.query(SQL_TABELLE);
  const erledigt = [];
  for (const m of liste) {
    await client.query('BEGIN');
    try {
      const neu = await client.query(
        'INSERT INTO rechte_migrationen (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING name', [m.name]);
      if (!neu.rows.length) { await client.query('ROLLBACK'); continue; }
      const r = await client.query(SQL_SETZEN, [m.gruppen, m.page, m.access]);
      const geaendert = r.rowCount || 0;
      await client.query('UPDATE rechte_migrationen SET geaendert = $2 WHERE name = $1', [m.name, geaendert]);
      await client.query('COMMIT');
      erledigt.push({ name: m.name, geaendert });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    }
  }
  return erledigt;
}

module.exports = { RECHTE_MIGRATIONEN, rechteMigrationenAusfuehren, SQL_SETZEN };
