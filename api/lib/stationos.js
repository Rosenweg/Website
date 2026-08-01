// Versionen des Stations-Betriebssystems verwalten.
//
// Früher holten sich die Stationen neue Versionen selbst per git aus dem
// privaten Repo — mit einem Deploy-Key auf jedem Gerät. Der ist mit dem
// anonymen Installationsmedium weggefallen, und damit stand das Selbst-
// Update still: base/60-updates.sh meldete nur noch "Kein Deploy-Key für das
// OS-Repo — Selbst-Update deaktiviert".
//
// Jetzt geht es umgekehrt: wer eine Version baut, veröffentlicht sie hier,
// und die Stationen holen sie mit ihrem eigenen Token ab. Kein GitHub-Zugang
// auf dem Server, kein Schlüssel auf den Geräten, und die Verwaltung sieht,
// welche Version wo läuft.
//
// Die Tarballs sind klein (rund 200 KB) und liegen in der Datenbank. Das
// spart ein Dateiverzeichnis, das gesichert und aufgeräumt werden müsste,
// und die Sicherung der Datenbank nimmt sie ohnehin mit.
const crypto = require('crypto');
const { pool } = require('./db');

const KANAELE = ['main', 'test'];
const AUFBEWAHREN = 10;   // ältere Versionen je Kanal löschen

let schemaReady = null;
async function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = pool.query(`
    CREATE TABLE IF NOT EXISTS station_os_versionen (
      version           TEXT NOT NULL,
      kanal             TEXT NOT NULL DEFAULT 'main',
      groesse           INTEGER NOT NULL,
      sha256            TEXT NOT NULL,
      daten             BYTEA NOT NULL,
      notiz             TEXT,
      veroeffentlicht_von TEXT,
      veroeffentlicht_am  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (kanal, version)
    );
    CREATE INDEX IF NOT EXISTS station_os_neueste
      ON station_os_versionen (kanal, veroeffentlicht_am DESC);
  `).catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}

/** Neue Version ablegen. Gibt es sie im Kanal schon, wird sie ersetzt. */
async function veroeffentlichen({ version, kanal, daten, notiz, wer }) {
  await ensureSchema();
  const k = KANAELE.includes(kanal) ? kanal : 'main';
  const sha256 = crypto.createHash('sha256').update(daten).digest('hex');

  await pool.query(
    `INSERT INTO station_os_versionen (version, kanal, groesse, sha256, daten, notiz, veroeffentlicht_von)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (kanal, version) DO UPDATE SET
       groesse = EXCLUDED.groesse, sha256 = EXCLUDED.sha256, daten = EXCLUDED.daten,
       notiz = EXCLUDED.notiz, veroeffentlicht_von = EXCLUDED.veroeffentlicht_von,
       veroeffentlicht_am = NOW()`,
    [version, k, daten.length, sha256, daten, notiz || null, wer || null],
  );

  // Alte Stände aufräumen, aber grosszügig: ein Rollback greift auf sie zu.
  await pool.query(
    `DELETE FROM station_os_versionen
      WHERE kanal = $1 AND version NOT IN (
        SELECT version FROM station_os_versionen WHERE kanal = $1
         ORDER BY veroeffentlicht_am DESC LIMIT $2)`,
    [k, AUFBEWAHREN],
  );

  return { version, kanal: k, groesse: daten.length, sha256 };
}

/** Was ist im Kanal das Neueste? Ohne die Daten selbst. */
async function neueste(kanal) {
  await ensureSchema();
  const r = await pool.query(
    `SELECT version, kanal, groesse, sha256, notiz, veroeffentlicht_von, veroeffentlicht_am
       FROM station_os_versionen WHERE kanal = $1
      ORDER BY veroeffentlicht_am DESC LIMIT 1`,
    [KANAELE.includes(kanal) ? kanal : 'main'],
  );
  return r.rows[0] || null;
}

/** Eine bestimmte Version samt Daten — auch für den Rollback. */
async function holen(kanal, version) {
  await ensureSchema();
  const r = await pool.query(
    'SELECT version, kanal, groesse, sha256, daten FROM station_os_versionen WHERE kanal = $1 AND version = $2',
    [KANAELE.includes(kanal) ? kanal : 'main', version],
  );
  return r.rows[0] || null;
}

/** Übersicht für die Verwaltung. */
async function liste() {
  await ensureSchema();
  const r = await pool.query(
    `SELECT version, kanal, groesse, sha256, notiz, veroeffentlicht_von, veroeffentlicht_am
       FROM station_os_versionen ORDER BY kanal, veroeffentlicht_am DESC`);
  return r.rows;
}

module.exports = { veroeffentlichen, neueste, holen, liste, KANAELE };
