// Persönliche Daten einer Rosenweg-App je Person (Stefan 27.11.2026, Rosenweg Uhr:
// "damit es einen Mehrwert gibt: die Synchronisation mit dem Backend").
//
// Allgemein für jede App, nicht nur die Uhr: eine App legt ihre Daten als
// EINTRÄGE ab, z.B. die Uhr je Wecker, je Weltuhr und je Timer-Vorlage einen.
// Jeder Eintrag hat
//   art         Sorte innerhalb der App ("wecker", "weltuhr", "timer")
//   id          Kennung, die die App vergibt (UUID o.ä.), je art eindeutig
//   geaendert   Zeitpunkt der Änderung in ms (Uhr des Geräts)
//   geloescht   true = Grabstein (gelöscht; bleibt stehen, damit andere Geräte es erfahren)
//   daten       JSON-Objekt der App (bei Grabsteinen null)
//
// Konflikte: je Eintrag gewinnt die letzte Änderung (grösseres geaendert); bei
// Gleichstand gewinnt Löschen, sonst bleibt der Stand des Servers. Wer zuletzt
// geändert hat, setzt sich durch — auch über Geräte, die lange offline waren.
//
// Abgleich: jede gespeicherte Änderung bekommt eine Version (je Person und App
// fortlaufend). Ein Gerät merkt sich die letzte Version, die es gesehen hat, und
// fragt nur nach dem, was danach kam (seit=<version>).
//
// Hier steht nur die Logik ohne Datenbank (Prüfen, Entscheiden, Antwort), damit
// sie ohne Postgres testbar ist (node --test api/test/app-daten.test.js); die
// Abfragen stehen in routes/app-daten.js.

const APP_MUSTER = /^ch\.rosenweg4303\.[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const ART_MUSTER = /^[a-z][a-z0-9_-]{0,31}$/;
const ID_MUSTER = /^[A-Za-z0-9._:-]{1,100}$/;

const GRENZEN = {
  eintraegeJeAnfrage: 500,
  eintraegeJeApp: 2000,      // inklusive Grabsteine
  datenBytes: 16 * 1024,     // je Eintrag (JSON)
  geraetZeichen: 60,
  // Geräte mit vorgehender Uhr: Zeitpunkte in der Zukunft auf jetzt + 5 Min kürzen,
  // sonst gewönne ihre Änderung gegen alle späteren.
  zukunftMs: 5 * 60 * 1000,
  // Grabsteine nach so langer Zeit entfernen (ein Gerät, das länger offline war,
  // bringt den Eintrag dann wieder)
  grabsteinTage: 400,
};

function appGueltig(app) {
  return typeof app === 'string' && app.length <= 80 && APP_MUSTER.test(app);
}

/**
 * Darf diese Anmeldung die Daten dieser App lesen/schreiben? Nur die Person selbst
 * (es gibt keine Technik-Ansicht). Zusätzlich gilt eine Karten-Sitzung und ein
 * Anlage-Token (geteiltes Telefon) jeweils für GENAU eine App: die Uhr kommt so
 * nicht an die Daten der Notizen.
 *   -> null (erlaubt) oder Fehlertext (403)
 */
function zugriffVerweigert(req, app) {
  const id = Number(req.user && (req.user.id ?? req.user.user_id));
  if (!Number.isInteger(id) || id <= 0) return 'Konto unbekannt';
  if (req.anlage && String(req.anlage.paket || '').toLowerCase() !== app) {
    return 'Diese App darf nur ihre eigenen Daten abgleichen';
  }
  if (req.appKarte && String(req.appKarte.app || '').toLowerCase() !== app) {
    return 'Diese Anmeldung gilt für eine andere App';
  }
  return null;
}

function benutzerId(req) {
  return Number(req.user.id ?? req.user.user_id);
}

/** ?seit=<version>: ganze Zahl >= 0, sonst 0 (alles). */
function seitAus(wert) {
  const n = Number(wert);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/**
 * Hochgeladene Einträge prüfen und vereinheitlichen.
 *   -> { eintraege: [{art, id, geaendert, geloescht, daten}] } oder { fehler }
 */
function eintraegePruefen(liste, jetzt = Date.now()) {
  if (!Array.isArray(liste)) return { fehler: 'eintraege muss eine Liste sein' };
  if (liste.length > GRENZEN.eintraegeJeAnfrage) {
    return { fehler: `Höchstens ${GRENZEN.eintraegeJeAnfrage} Einträge je Anfrage` };
  }
  const gesehen = new Set();
  const aus = [];
  for (const [i, e] of liste.entries()) {
    const wo = `Eintrag ${i + 1}`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) return { fehler: `${wo}: kein Objekt` };
    if (typeof e.art !== 'string' || !ART_MUSTER.test(e.art)) return { fehler: `${wo}: art ungültig` };
    if (typeof e.id !== 'string' || !ID_MUSTER.test(e.id)) return { fehler: `${wo}: id ungültig` };
    const schluessel = `${e.art}\u0000${e.id}`;
    if (gesehen.has(schluessel)) return { fehler: `${wo}: ${e.art}/${e.id} doppelt` };
    gesehen.add(schluessel);
    const g = Number(e.geaendert);
    if (!Number.isSafeInteger(g) || g <= 0) return { fehler: `${wo}: geaendert ungültig` };
    const geloescht = e.geloescht === true;
    let daten = null;
    if (!geloescht) {
      if (!e.daten || typeof e.daten !== 'object' || Array.isArray(e.daten)) {
        return { fehler: `${wo}: daten fehlt (Objekt) – zum Löschen geloescht: true` };
      }
      if (Buffer.byteLength(JSON.stringify(e.daten), 'utf8') > GRENZEN.datenBytes) {
        return { fehler: `${wo}: daten zu gross (höchstens ${GRENZEN.datenBytes / 1024} KiB)` };
      }
      daten = e.daten;
    }
    aus.push({ art: e.art, id: e.id, geaendert: Math.min(g, jetzt + GRENZEN.zukunftMs), geloescht, daten });
  }
  return { eintraege: aus };
}

/** Gewinnt der hochgeladene Eintrag gegen den gespeicherten (oder keinen)? */
function gewinnt(neu, alt) {
  if (!alt) return true;
  const a = Number(alt.geaendert);
  if (neu.geaendert !== a) return neu.geaendert > a;
  return neu.geloescht && !alt.geloescht;
}

/**
 * Entscheiden: welche Einträge werden gespeichert, welche abgelehnt (der Server
 * hat Neueres)? [gespeichert]: Map "art\0id" -> Zeile.
 */
function entscheiden(eintraege, gespeichert) {
  const schreiben = [];
  const abgelehnt = [];
  for (const e of eintraege) {
    const alt = gespeichert.get(`${e.art}\u0000${e.id}`);
    if (gewinnt(e, alt)) schreiben.push(e);
    else abgelehnt.push(alt);
  }
  return { schreiben, abgelehnt };
}

/** Zeile der Tabelle -> Eintrag der Antwort. */
function alsEintrag(z) {
  return {
    art: z.art, id: z.schluessel, geaendert: Number(z.geaendert), geloescht: Boolean(z.geloescht),
    daten: z.geloescht ? null : (z.daten ?? null), version: Number(z.version),
  };
}

/**
 * Antwortliste: alles seit [seit] und dazu die abgelehnten Einträge (deren
 * Stand das Gerät übernehmen soll), je Eintrag einmal, nach Version.
 */
function antwortEintraege(seitZeilen, abgelehnt = []) {
  const m = new Map();
  for (const z of [...seitZeilen, ...abgelehnt]) m.set(`${z.art}\u0000${z.schluessel}`, z);
  return [...m.values()].map(alsEintrag).sort((a, b) => a.version - b.version);
}

function geraetName(wert) {
  return String(wert ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, GRENZEN.geraetZeichen) || null;
}

module.exports = {
  GRENZEN, appGueltig, zugriffVerweigert, benutzerId, seitAus, eintraegePruefen, gewinnt,
  entscheiden, alsEintrag, antwortEintraege, geraetName,
};
