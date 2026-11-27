// Rechte-Schluessel mit Umlaut: eine Schreibweise (Befund W18/F6-1).
//
// Code (requirePermission), Rechteverwaltung (MANAGED_PAGES) und Menue fragen
// die Schreibweise mit Umlaut ('zähler', 'waschküche-admin', 'mail-empfänger').
// In der Tabelle permissions standen teils ASCII-Schluessel ('zaehler' …): die
// wirkten nirgends bzw. erschienen in der Rechteverwaltung als „none“.
// vereinheitlichen() uebernimmt sie beim Start auf den Umlaut-Schluessel (das
// hoehere Recht gewinnt) und loescht die ASCII-Zeile. Danach nur noch Umlaut
// verwenden; die ASCII-Form nie neu anlegen.
const DOPPELTE_SCHLUESSEL = [
  ['zaehler', 'zähler'],
  ['waschkueche', 'waschküche'],
  ['waschkueche-admin', 'waschküche-admin'],
  ['mail-empfaenger', 'mail-empfänger'],
];

const STUFE = { none: 0, read: 1, write: 2 };
function hoeheres(a, b) {
  return (STUFE[b] || 0) > (STUFE[a] || 0) ? b : a;
}

const SQL_UEBERNEHMEN = `
  INSERT INTO permissions (group_name, page, access)
  SELECT group_name, $2, access FROM permissions WHERE page = $1
  ON CONFLICT (group_name, page) DO UPDATE SET access = CASE
    WHEN permissions.access = 'write' OR EXCLUDED.access = 'write' THEN 'write'
    WHEN permissions.access = 'read' OR EXCLUDED.access = 'read' THEN 'read'
    ELSE permissions.access END`;

async function vereinheitlichen(client) {
  let n = 0;
  for (const [alt, neu] of DOPPELTE_SCHLUESSEL) {
    await client.query(SQL_UEBERNEHMEN, [alt, neu]);
    const r = await client.query('DELETE FROM permissions WHERE page = $1', [alt]);
    n += r.rowCount || 0;
  }
  return n;
}

module.exports = { DOPPELTE_SCHLUESSEL, hoeheres, vereinheitlichen, SQL_UEBERNEHMEN };
