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

const { stwegVonHaus } = require('./haeuser');

const SITE_URL = (process.env.SITE_URL || 'https://www.rosenweg4303.ch').replace(/\/$/, '');

// Adresse der STWEG-Seite eines Hauses (nginx.stweg.conf bedient stweg1..7).
const stwegUrl = (n) => `https://stweg${n}.rosenweg4303.ch`;

// Nur eigene Adressen werden zu Programmen. Alles andere (fremde Dienste,
// http ohne s) bleibt draussen — auch wenn es in nav.js steht.
function eigeneAdresse(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.port) return false;
    const h = u.hostname.toLowerCase();
    return h === 'rosenweg4303.ch' || h.endsWith('.rosenweg4303.ch')
      || h === 'rosenweg9.ch' || h === 'www.rosenweg9.ch';
  } catch { return false; }
}

// Symbol je Gruppe, als Name im Symbol-Thema der Station (z. B.
// /usr/share/icons/hicolor/<groesse>/apps/rosenweg-telefon.png). Die Dateien
// kommen spaeter; bis dahin nimmt die Station rosenweg-logo. Eine Gruppe, die
// hier fehlt, bekommt einen Namen aus ihrem Titel — neu in nav.js heisst also
// nicht namenlos.
const GRUPPEN_SYMBOL = {
  'Rosenweg': 'rosenweg-start',
  'Bewohner': 'rosenweg-bewohner',
  'Mein Haus': 'rosenweg-haus',
  'Verwaltung & Objekte': 'rosenweg-verwaltung',
  'E-Mail': 'rosenweg-mail',
  'Mail-Outbox (Genehmigung)': 'rosenweg-mail-outbox',
  'WhatsApp & Meldungen': 'rosenweg-telefon',
  'Betrieb & Admin': 'rosenweg-betrieb',
};
function gruppenSymbol(titel) {
  if (GRUPPEN_SYMBOL[titel]) return GRUPPEN_SYMBOL[titel];
  const slug = String(titel || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug ? 'rosenweg-' + slug : 'rosenweg-logo';
}

// Seiten, die nicht in SERVICES_GROUPS stehen, weil die Website sie anders
// verlinkt (Kopfzeile, Bewohner-Menue in nav.js). Für alle sichtbar; die Seite
// selbst verlangt die Anmeldung, wo noetig. WLAN und TV liegen nur auf dem
// ISP-Frontend (siehe Kommentar im Bewohner-Menue von nav.js), Schaden melden
// und Terminumfragen in der PWA.
const FESTE_SEITEN = [
  { id: 'rosenweg-dashboard', name: 'Dashboard', url: `${SITE_URL}/dashboard.html`, gruppe: 'Rosenweg' },
  { id: 'rosenweg-profil', name: 'Mein Profil', url: `${SITE_URL}/profil.html`, gruppe: 'Rosenweg' },
  { id: 'rosenweg-apps', name: 'Rosenweg-Apps', url: `${SITE_URL}/apps.html`, gruppe: 'Rosenweg' },
  { id: 'rosenweg-hilfe', name: 'Hilfe', url: `${SITE_URL}/hilfe.html`, gruppe: 'Rosenweg' },
  { id: 'rosenweg-telefonbuch', name: 'Telefonbuch', url: `${SITE_URL}/telefonbuch.html`, gruppe: 'Bewohner' },
  { id: 'rosenweg-isp-wlan', name: 'WLAN-Zugang', url: 'https://isp.rosenweg4303.ch/wlan.html', gruppe: 'Bewohner' },
  { id: 'rosenweg-isp-tv', name: 'TV / Fernsehen', url: 'https://isp.rosenweg4303.ch/tv.html', gruppe: 'Bewohner' },
  { id: 'rosenweg-isp-internet', name: 'Internet / ISP', url: 'https://isp.rosenweg4303.ch/', gruppe: 'Bewohner' },
  { id: 'rosenweg-isp-mein-zugang', name: 'Mein Zugang', url: 'https://isp.rosenweg4303.ch/isp-mein-zugang.html', gruppe: 'Bewohner' },
  { id: 'rosenweg-pwa-reparatur', name: 'Schaden melden', url: 'https://pwa.rosenweg4303.ch/reparatur/', gruppe: 'Bewohner' },
  { id: 'rosenweg-pwa-doodle', name: 'Terminumfragen', url: 'https://pwa.rosenweg4303.ch/doodle/', gruppe: 'Bewohner' },
];

// Seiten, die es nur im eigenen Haus gibt. Die Station kennt ihr Haus
// (stations.haus), daraus folgt die STWEG. Ohne Haus erscheinen sie nicht.
//   Waschküche: nur wo das Modul zugeschaltet ist (docker-stack.yml,
//               WASCHKUECHE=1 — heute nur STWEG 3).
//   ZEV:        nur Haus 9 (STWEG 3) rechnet über den ZEV ab.
const WASCHKUECHE_STWEG = [3];
const ZEV_STWEG = [3];
function hausSeiten(stweg) {
  if (!stweg) return [];
  const basis = stwegUrl(stweg);
  const raus = [];
  if (WASCHKUECHE_STWEG.includes(stweg)) {
    raus.push({ id: 'rosenweg-haus-waschkueche', name: 'Waschküche', url: `${basis}/waschkueche.html` });
  }
  if (ZEV_STWEG.includes(stweg)) {
    raus.push({ id: 'rosenweg-haus-zev-rechnungen', name: 'ZEV-Rechnungen', url: `${basis}/pages/zev-meine-rechnungen.html` });
  }
  return raus.map((a) => ({ ...a, beschreibung: 'Mein Haus', gruppe: 'Mein Haus', icon: gruppenSymbol('Mein Haus'), rechte: null, rechte_art: null }));
}

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
 * Programme, die jede Station anzeigen soll (ohne die Seiten des eigenen
 * Hauses, die haengen an der Station — siehe gruppenJeApp).
 *
 * Nur eigene Adressen (eigeneAdresse). Einträge mit stwegOnly zeigen in nav.js
 * relativ auf die STWEG-Seite (pages/reklamationen.html) und gäben auf www eine
 * 404; sie werden hier zurückgehalten und je Haus aufgelöst.
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
    icon: gruppenSymbol('Rosenweg'),
    rechte: null,
    rechte_art: null,
  }];
  for (const f of FESTE_SEITEN) {
    if (!eigeneAdresse(f.url)) continue;
    apps.push({ ...f, beschreibung: f.gruppe, icon: gruppenSymbol(f.gruppe), rechte: null, rechte_art: null });
  }

  for (const gruppe of gruppen || []) {
    for (const eintrag of gruppe.items || []) {
      const href = String(eintrag.href || '');
      if (!href) continue;
      const absolut = /^https?:\/\//i.test(href);
      if (absolut && !eigeneAdresse(href)) continue;      // fremde Oberfläche
      apps.push({
        id: absolut ? kennung(new URL(href).hostname.split('.')[0] + new URL(href).pathname) : kennung(href),
        name: eintrag.label,
        beschreibung: gruppe.title || '',
        url: absolut ? href : `${SITE_URL}/${href.replace(/^\/+/, '')}`,
        // relativer Pfad für die Auflösung je Haus (nur bei stwegOnly)
        stweg_pfad: eintrag.stwegOnly && !absolut ? href.replace(/^\/+/, '') : undefined,
        gruppe: gruppe.title || 'Rosenweg',
        icon: gruppenSymbol(gruppe.title || 'Rosenweg'),
        emoji: gruppe.icon || '',
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
    console.warn('[stations] nav.js nicht gefunden — nur die festen Seiten als Programme.');
  }
  // Doppelte Kennungen (zwei Menüpunkte auf dieselbe Seite) nur einmal.
  const gesehen = new Set();
  zwischenspeicher = apps.filter((a) => (gesehen.has(a.id) ? false : gesehen.add(a.id)));
  return zwischenspeicher;
}

/**
 * Die Liste für EINE Station: stwegOnly-Einträge auf die STWEG-Seite ihres
 * Hauses umgeschrieben (ohne Haus: weggelassen), dazu die Seiten des Hauses.
 */
function appsFuerHaus(haus) {
  const stweg = haus ? stwegVonHaus(haus) : null;
  const raus = [];
  for (const a of stationApps()) {
    const { stweg_pfad: pfad, ...rest } = a;
    if (pfad === undefined) { raus.push(rest); continue; }
    if (!stweg || stweg > 7) continue;
    raus.push({ ...rest, url: `${stwegUrl(stweg)}/${pfad}` });
  }
  return [...raus, ...hausSeiten(stweg)];
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

async function gruppenJeApp(pool, { haus = null } = {}) {
  const apps = appsFuerHaus(haus);
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

module.exports = { stationApps, appsFuerHaus, gruppenJeApp, eigeneAdresse, gruppenSymbol, SITE_URL };
