/**
 * Cast-Wächter: hält einen Chromecast auf der Anzeige — ohne Datenbank und
 * ohne Netz, damit sich die Entscheidungen prüfen lassen
 * (api/test/castwaechter.test.js). Die Verbindung zum Gerät macht
 * lib/castverbindung.js, das Speichern routes/stations.js.
 *
 * Ein Chromecast ist für Technik eine Anzeige-Station wie die mit der Rolle
 * 'display' (os-stationen/roles/display): dieselbe Seite
 * display.rosenweg4303.ch?haus=N, dieselben retained MQTT-Nachrichten
 * (display/announcements, display/emergency), die die Seite selbst abonniert.
 * Ein Chromecast hat nur kein Betriebssystem, das die Seite von sich aus
 * öffnet — das übernimmt der Wächter: Er prüft periodisch, was läuft, und
 * startet den Empfänger mit der Anzeige neu, wenn das Gerät neu gestartet hat
 * oder jemand anderes darauf castet.
 */

// Der öffentliche DashCast-Empfänger (github.com/madmod/dashcast): lädt eine
// beliebige Adresse. Mit force=true navigiert er die ganze Seite dorthin
// (statt in ein iframe) — nötig, weil display.rosenweg4303.ch fremdes
// Einbetten verbietet (X-Frame-Options SAMEORIGIN, frontends-lxc).
const DASHCAST = { art: 'dashcast', appId: '84912283', namespace: 'urn:x-cast:com.madmod.dashcast' };

// Der eigene Empfänger (cast-empfaenger.html unter cast.rosenweg4303.ch/empfaenger/).
const EIGEN_NAMESPACE = 'urn:x-cast:ch.rosenweg4303.anzeige';

// Was ein Chromecast zeigt, wenn niemand castet. Backdrop meldet sich mit
// isIdleScreen: true; die Kennung steht hier für ältere Firmware, die das
// Feld nicht kennt.
const LEERLAUF_APPS = ['E8C28D3C'];

// Nach einem gescheiterten Start nicht im Takt des Wächters weiterhämmern:
// 30 s, 1, 2, 4, 8 min, höchstens 10 min.
const STARTPAUSE_MS = 30 * 1000;
const STARTPAUSE_MAX_MS = 10 * 60 * 1000;

/**
 * Welcher Empfänger? Mit eigener App-ID (Google Cast Developer Console) der
 * eigene, sonst DashCast als Übergang.
 */
function empfaengerWahl(appId) {
  const id = String(appId || '').trim().toUpperCase();
  if (/^[0-9A-F]{8}$/.test(id)) return { art: 'eigen', appId: id, namespace: EIGEN_NAMESPACE };
  return { ...DASHCAST };
}

/** Die Nachricht, mit der der Empfänger die Anzeige lädt. */
function ladeNachricht(empfaenger, url, reloadMinuten) {
  if (empfaenger.art === 'dashcast') {
    // reload/reload_time gelten nur fürs iframe — mit force ist DashCasts
    // eigene Seite weg. Neu lädt dann display.html sich selbst (Prüfsumme,
    // alle 5 min) und der Wächter, wenn das Gerät die App schliesst.
    return { url, force: true, reload: false, reload_time: 0 };
  }
  return { type: 'LADEN', url, reload_minuten: Number(reloadMinuten) || 0 };
}

const istLeerlauf = (app) => !!app && (app.isIdleScreen === true || LEERLAUF_APPS.includes(app.appId));

/** Die App im Vordergrund — null, wenn nur der Leerlauf läuft. */
function vordergrund(status) {
  const apps = (status && status.applications) || [];
  return apps.find((x) => !istLeerlauf(x)) || null;
}

function startpause(fehlversuche) {
  const n = Math.max(0, Number(fehlversuche) || 0);
  if (!n) return 0;
  return Math.min(STARTPAUSE_MAX_MS, STARTPAUSE_MS * 2 ** (n - 1));
}

const ms = (t) => (t == null ? null : (typeof t === 'number' ? t : new Date(t).getTime()));
const iso = (t) => (t == null ? null : new Date(t).toISOString());

/**
 * Was der Wächter mit einem Chromecast tun soll.
 *
 *   erreichbar  Verbindung auf TCP 8009 gelungen
 *   status      RECEIVER_STATUS des Geräts ({applications: [...]})
 *   meldung     Antwort des eigenen Empfängers auf STATUS ({url}), sonst null
 *   empfaenger  empfaengerWahl(...)
 *   url         die Anzeigeadresse dieses Geräts (wie bei einer display-Station)
 *   zustand     was der letzte Lauf gespeichert hat (fremd_seit, geladen_session, ...)
 *   pauseMs     so lange darf jemand anderes casten, bevor übernommen wird
 *               (0: sofort zurück)
 *   notfall     display/emergency ist aktiv — dann gilt keine Pause
 *   erzwingen   Technik hat „Jetzt auf die Anzeige holen" gedrückt
 *   gesperrt    die Station ist gesperrt — der Wächter lässt das Gerät in Ruhe
 *
 * aktion: 'aus' | 'unerreichbar' | 'gut' | 'laden' | 'starten' | 'warten'
 * Dazu der neue Zustand (ohne Ergebnis des Starts; das trägt der Aufrufer
 * mit gestartet()/gescheitert() nach).
 */
function entscheiden({
  erreichbar, status, meldung, empfaenger, url, zustand, jetzt, pauseMs, notfall, erzwingen, gesperrt,
}) {
  const z = { ...(zustand || {}) };
  const t = ms(jetzt) ?? Date.now();
  z.geprueft_am = iso(t);
  z.empfaenger = empfaenger.art;

  if (gesperrt) return { aktion: 'aus', grund: 'gesperrt — der Wächter lässt das Gerät in Ruhe', zustand: z };

  if (!erreichbar) {
    z.erreichbar = false;
    if (!z.unerreichbar_seit) z.unerreichbar_seit = iso(t);
    return { aktion: 'unerreichbar', grund: 'keine Verbindung auf TCP 8009', zustand: z };
  }
  z.erreichbar = true;
  z.unerreichbar_seit = null;

  const app = vordergrund(status);
  z.app = app ? { id: app.appId, name: app.displayName || app.appId } : null;

  // Unser Empfänger läuft.
  if (app && app.appId === empfaenger.appId) {
    z.fremd_seit = null;
    z.fremd_app = null;
    if (empfaenger.art === 'eigen') {
      // Der eigene Empfänger sagt, was er zeigt. Antwortet er nicht oder zeigt
      // er etwas anderes (Haus geändert, Adresse überschrieben), neu laden.
      if (meldung && meldung.url === url) return { aktion: 'gut', grund: 'zeigt die Anzeige', zustand: z };
      return { aktion: 'laden', grund: meldung ? 'zeigt eine andere Adresse' : 'Empfänger meldet keinen Inhalt', zustand: z };
    }
    // DashCast lässt sich nach dem Navigieren nicht mehr fragen. Eine Sitzung,
    // in die wir geladen haben, gilt als gut; eine fremde DashCast-Sitzung
    // (jemand anderes hat DashCast gestartet) bekommt unsere Adresse.
    if (z.geladen_session === app.sessionId && z.geladen_url === url) {
      return { aktion: 'gut', grund: 'zeigt die Anzeige', zustand: z };
    }
    return { aktion: 'laden', grund: 'DashCast-Sitzung ohne unsere Adresse', zustand: z };
  }

  const pause = startpause(z.fehlversuche);
  const letzterStart = ms(z.letzter_start);
  const nochPause = !erzwingen && pause && letzterStart != null && t - letzterStart < pause;

  // Nichts läuft: Gerät neu gestartet, App geschlossen, Cast beendet.
  if (!app) {
    z.fremd_seit = null;
    z.fremd_app = null;
    if (nochPause) return { aktion: 'warten', grund: `letzter Start gescheitert, nächster Versuch ${iso(letzterStart + pause)}`, zustand: z };
    return { aktion: 'starten', grund: 'Leerlauf — Anzeige wird gestartet', zustand: z };
  }

  // Jemand anderes castet. Rücksicht: eine Weile lassen, dann übernehmen.
  // Läuft eine andere fremde App als vorher, beginnt die Pause nicht neu —
  // sonst hielte ein Wechsel YouTube → Spotify die Anzeige ewig fern.
  if (!z.fremd_seit) z.fremd_seit = iso(t);
  z.fremd_app = app.displayName || app.appId;
  const fremdSeit = ms(z.fremd_seit);
  const p = Math.max(0, Number(pauseMs) || 0);
  if (notfall || erzwingen || t - fremdSeit >= p) {
    if (nochPause) return { aktion: 'warten', grund: `letzter Start gescheitert, nächster Versuch ${iso(letzterStart + pause)}`, zustand: z };
    const warum = notfall ? 'Notfall' : (erzwingen ? 'von Hand' : 'Pause abgelaufen');
    return { aktion: 'starten', grund: `${z.fremd_app} übernommen (${warum})`, zustand: z };
  }
  return {
    aktion: 'warten',
    grund: `${z.fremd_app} läuft — Anzeige kommt zurück, wenn es endet, spätestens ${iso(fremdSeit + p)}`,
    zustand: z,
  };
}

/** Nach erfolgreichem Start oder Laden. */
function gestartet(zustand, { jetzt, sessionId, url, wiederherstellung }) {
  const z = { ...(zustand || {}) };
  const t = iso(ms(jetzt) ?? Date.now());
  z.letzter_start = t;
  z.fehlversuche = 0;
  z.fehler = null;
  z.geladen_session = sessionId || null;
  z.geladen_url = url;
  z.fremd_seit = null;
  z.fremd_app = null;
  if (wiederherstellung) {
    z.wiederhergestellt_am = t;
    z.wiederherstellungen = (Number(z.wiederherstellungen) || 0) + 1;
  }
  return z;
}

function gescheitert(zustand, { jetzt, fehler }) {
  const z = { ...(zustand || {}) };
  z.letzter_start = iso(ms(jetzt) ?? Date.now());
  z.fehlversuche = (Number(z.fehlversuche) || 0) + 1;
  z.fehler = String(fehler || 'unbekannt').slice(0, 300);
  return z;
}

/**
 * Die Adresse für den eigenen Empfänger: display.rosenweg4303.ch verbietet
 * das Einbetten durch fremde Herkunft. Der Empfänger liegt deshalb unter
 * cast.rosenweg4303.ch, das dasselbe Frontend ausliefert — dort ist
 * /display.html dieselbe Herkunft wie /empfaenger/. Diese Abbildung macht der
 * Empfänger selbst (cast-empfaenger.html); hier nur, welche Hosts er
 * überhaupt annimmt: die allowed_domains der Rolle display.
 */
function adresseErlaubt(url, erlaubt) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (erlaubt || []).includes(u.hostname);
  } catch { return false; }
}

/**
 * Welche Seite ein Chromecast bekommt: die schlanke Anzeige statt display.html.
 *
 * Ein Chromecast der ersten Generation (Chrome 90, 512 MB für alles) stürzt
 * an display.html ab — nicht an der Syntax und nicht an MQTT, sondern am
 * Aushangbild: /api/display/pdfbild rechnet ein A4 mit 600 dpi
 * (4961×7016, rund 140 MB entpackt). Lädt er das, beendet das Gerät die App
 * binnen Sekunden (am 26. November 2026 am Gerät nachgestellt). display-lite.html
 * holt dieselben Aushänge in kleiner Auflösung, ohne Fremdbibliothek.
 *
 * Abgebildet wird nur die Anzeige selbst (/ und /display.html); eine von Hand
 * überschriebene andere Adresse bleibt, wie sie ist. seite 'voll' (overrides
 * roles.display.cast_seite) lässt display.html stehen — für neuere Geräte.
 */
const LITE_PFAD = '/display-lite.html';
function castAdresse(url, seite) {
  if (seite === 'voll' || !url) return url;
  let u;
  try { u = new URL(url); } catch { return url; }
  if (u.pathname !== '/' && u.pathname !== '' && u.pathname !== '/display.html') return url;
  return `${u.protocol}//${u.host}${LITE_PFAD}${u.search}${u.hash}`;
}

/** IPv4 oder Hostname — nichts, was nach Pfad, Port oder Schema aussieht. */
function adressePruefen(roh) {
  const a = String(roh || '').trim().toLowerCase();
  if (/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(a)) return a;
  if (/^[\d.]+$/.test(a)) return null;   // sieht aus wie IPv4, ist aber keine
  if (/^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(a)) return a;
  return null;
}

function macPruefen(roh) {
  const m = String(roh || '').trim().toLowerCase().replace(/-/g, ':');
  return /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(m) ? m : null;
}

module.exports = {
  DASHCAST, EIGEN_NAMESPACE, LEERLAUF_APPS,
  empfaengerWahl, ladeNachricht, vordergrund, istLeerlauf, startpause,
  entscheiden, gestartet, gescheitert, adresseErlaubt, adressePruefen, macPruefen,
  LITE_PFAD, castAdresse,
};
