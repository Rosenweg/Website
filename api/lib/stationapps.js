// Programme für die Stationen aus der Navigation der Website ableiten.
//
// Auf einer Station sollen die Rosenweg-Seiten wie eigene Programme wirken:
// ein Eintrag im Menü, ein Symbol auf dem Schreibtisch, ein Fenster ohne
// Browser-Leiste. Die Liste dafür wird NICHT von Hand gepflegt, sondern aus
// js/nav.js gelesen — derselben Datei, aus der die Website ihr Menü baut.
// Kommt dort eine Seite dazu, haben die Stationen sie beim nächsten Lauf.
//
// Gelesen wird per vm-Sandbox statt mit einem regulären Ausdruck: nav.js ist
// gültiges JavaScript, und es auszuwerten ist verlässlicher, als Klammern zu
// zählen. SERVICES_GROUPS ist dort ein 'const' auf oberster Ebene und landet
// deshalb nicht von selbst im Kontext — die Zuweisung am Ende holt es heraus.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SITE_URL = (process.env.SITE_URL || 'https://www.rosenweg4303.ch').replace(/\/$/, '');

// Im Image liegt nav.js neben server.js; im Repo eine Ebene höher in js/.
const NAV_PFADE = [
  path.join(__dirname, '..', 'nav.js'),
  path.join(__dirname, '..', '..', 'js', 'nav.js'),
];

let zwischenspeicher = null;

function navQuelle() {
  for (const p of NAV_PFADE) {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch { /* nächster Pfad */ }
  }
  return null;
}

function gruppenLesen() {
  const quelle = navQuelle();
  if (!quelle) return null;

  // nav.js ist für den Browser geschrieben und greift weiter unten auf
  // window.location und Ähnliches zu. Statt den halben Browser nachzubauen:
  // die Liste in eine globale Zuweisung verwandeln, den Rest in try/catch
  // laufen lassen. Was danach scheitert, ist uns egal — die Daten stehen
  // ganz oben und sind dann schon geholt.
  const vorbereitet = quelle.replace(
    /\bconst\s+SERVICES_GROUPS\s*=/, 'globalThis.__STATION_GRUPPEN =');
  if (vorbereitet === quelle) {
    console.error('[stations] SERVICES_GROUPS in nav.js nicht gefunden.');
    return null;
  }

  const sandbox = {
    window: { location: { pathname: '/', href: '/', search: '', hash: '' }, addEventListener() {} },
    document: { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] },
    location: { pathname: '/', href: '/', search: '', hash: '' },
    navigator: { userAgent: 'station' },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: () => Promise.resolve({ json: () => ({}) }),
    console: { log() {}, warn() {}, error() {} },
    setTimeout() {}, setInterval() {},
  };
  sandbox.globalThis = sandbox;

  try {
    vm.runInNewContext(
      `try { ${vorbereitet} } catch (e) { globalThis.__STATION_REST = e.message; }`,
      sandbox,
      { timeout: 3000 },
    );
  } catch (e) {
    console.error('[stations] nav.js liess sich nicht auswerten:', e.message);
    return null;
  }
  return sandbox.__STATION_GRUPPEN || null;
}

function kennung(href) {
  return 'rosenweg-' + String(href)
    .replace(/\.html?$/, '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase()
    .replace(/^-+|-+$/g, '');
}

/**
 * Programme, die eine Station anzeigen soll.
 *
 * Nur Seiten der eigenen Website: die Einträge in nav.js, die auf fremde
 * Oberflächen zeigen (Proxmox, MQTT-Browser, WhatsApp-Gateway), sind
 * Werkzeuge für die Technik und gehören nicht auf einen Arbeitsplatz im
 * Treppenhaus.
 */
function stationApps() {
  if (zwischenspeicher) return zwischenspeicher;

  const gruppen = gruppenLesen();
  const apps = [{
    id: 'rosenweg-start',
    name: 'Rosenweg',
    beschreibung: 'Startseite der Siedlung',
    url: SITE_URL + '/',
    gruppe: 'Rosenweg',
    icon: '🏠',
  }];

  for (const gruppe of gruppen || []) {
    for (const eintrag of gruppe.items || []) {
      const href = String(eintrag.href || '');
      if (!href || /^https?:\/\//i.test(href)) continue;   // fremde Oberfläche
      apps.push({
        id: kennung(href),
        name: eintrag.label,
        beschreibung: gruppe.title || '',
        url: `${SITE_URL}/${href.replace(/^\/+/, '')}`,
        gruppe: gruppe.title || 'Rosenweg',
        icon: gruppe.icon || '',
        // Wer die Seite sehen darf. Die beiden Angaben in nav.js bedeuten
        // Verschiedenes, deshalb steht dabei, WELCHE es war:
        //
        //   permAny: 'a,b,c'  -> Gruppen, auch wenn es nur eine ist
        //   perm:    'seite'  -> ein benanntes Recht aus der Rechtetabelle
        //
        // Ohne diese Unterscheidung hielte 'permAny: wohnungsverwaltung' —
        // eine einzelne Gruppe ohne Komma — für ein benanntes Recht, fände
        // dazu nichts, und die Gruppe wäre still verloren.
        rechte: eintrag.perm || eintrag.permAny || null,
        rechte_art: eintrag.perm ? 'seite' : (eintrag.permAny ? 'gruppen' : null),
      });
    }
  }

  if (!gruppen) {
    console.warn('[stations] nav.js nicht gefunden — nur die Startseite als Programm.');
  }
  zwischenspeicher = apps;
  return apps;
}

/**
 * Zu jeder Seite die Gruppen, die sie sehen duerfen.
 *
 * Auf der Station entscheidet die Gruppenzugehoerigkeit, was im Menue
 * erscheint — dieselbe Mechanik wie bei apps.gruppen. Dafuer muss die Frage
 * umgedreht werden: die Website fragt „was darf dieser Benutzer", die Station
 * braucht „wer darf diese Seite".
 *
 * Zwei Sorten Angabe stehen in nav.js:
 *
 *   permAny: 'ausschuss,technik,praesident'   -> die Gruppen direkt
 *   perm:    'email-verteiler'                -> ein benanntes Recht, das in
 *                                                der Tabelle 'permissions' an
 *                                                Gruppen haengt
 *
 * Technik und Praesident duerfen laut getUserPermissions() alles — sie stehen
 * deshalb ueberall dabei, auch wenn sie in der Tabelle nicht vorkommen.
 *
 * Was KEINE Angabe hat, ist fuer alle da und bekommt eine leere Liste.
 *
 * Achtung, bewusste Ungenauigkeit: die Sonderregel, nach der ein
 * Ausschuss-Mitglied 'bewohner-verwaltung' fuer die EIGENE STWEG bekommt,
 * laesst sich nicht auf „diese Gruppe darf" abbilden. Solche Seiten erscheinen
 * auf der Station also fuer alle Ausschuss-Gruppen; die Seite selbst prueft
 * danach weiterhin genau.
 */
const IMMER_ERLAUBT = ['technik', 'praesident', 'präsident'];

async function gruppenJeApp(pool) {
  const apps = stationApps();
  const rechteSeiten = [...new Set(
    apps.filter((a) => a.rechte_art === 'seite' && a.rechte).map((a) => String(a.rechte)),
  )];

  // Eine Abfrage fuer alle benannten Rechte statt einer je Seite.
  const nachSeite = {};
  if (rechteSeiten.length && pool) {
    try {
      const r = await pool.query(
        'SELECT page, LOWER(group_name) AS gruppe FROM permissions WHERE page = ANY($1)',
        [rechteSeiten],
      );
      for (const zeile of r.rows) {
        (nachSeite[zeile.page] ||= []).push(zeile.gruppe);
      }
    } catch (e) {
      // Lieber alle Seiten fuer alle sichtbar als eine Station ohne Menue.
      console.error('[stationapps] Rechte nicht lesbar:', e.message);
      return apps.map((a) => ({ ...a, gruppen: [] }));
    }
  }

  return apps.map((a) => {
    const roh = a.rechte ? String(a.rechte) : '';
    if (!roh || !a.rechte_art) return { ...a, gruppen: [] };

    const gruppen = a.rechte_art === 'gruppen'
      ? roh.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
      : (nachSeite[roh] || []);

    // Eine Seite mit benanntem Recht, das keiner Gruppe zugeordnet ist, waere
    // sonst plötzlich fuer alle sichtbar. Dann lieber nur fuer die, die
    // ohnehin alles duerfen.
    return { ...a, gruppen: [...new Set([...gruppen, ...IMMER_ERLAUBT])] };
  });
}

module.exports = { stationApps, gruppenJeApp, SITE_URL };
