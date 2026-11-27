// Android-Dauertest der Rosenweg-Apps (CT 149, noc/android-dauertest): reine Logik.
//
// Der CT schickt nach jedem Lauf einen POST mit dem Ergebnis je App (ok/Grund,
// Version, Schirmbild). Hier wird geprüft, was ankommt, und entschieden, wann
// die Technik eine Meldung bekommt (Entscheid Stefan 27.11.2026):
//   - rot: nach zweimal rot in Folge; sofort beim ersten Rot, wenn die Version
//     gegenüber dem letzten Lauf neu ist (gerade erschienenes Release)
//   - wieder grün: einmal, wenn vorher rot gemeldet wurde
//   - Prüfer still: kein Lauf seit CT_STILL_MS -> einmal melden
// Die Routen (routes/android-dauertest.js) machen Datenbank und Versand.

const KENNUNG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PAKET = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+){1,8}$/;
const PNG_KOPF = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_APPS = 60;
const MAX_BILD = 3 * 1024 * 1024;
// Läuft stündlich: älter als 2 h = Prüfer selbst kaputt (grau im NOC),
// nach 3 h eine Meldung an die Technik.
const ALT_MS = 2 * 60 * 60 * 1000;
const CT_STILL_MS = 3 * 60 * 60 * 1000;

const text = (v, max) => (v == null ? '' : String(v)).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

// Eingang des POST prüfen. Liefert { apps } oder { fehler }.
function eingabePruefen(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.apps)) return { fehler: 'apps fehlt' };
  if (body.apps.length > MAX_APPS) return { fehler: 'zu viele Apps' };
  const apps = [];
  const gesehen = new Set();
  for (const a of body.apps) {
    if (!a || typeof a !== 'object') return { fehler: 'App-Eintrag ungueltig' };
    const kennung = String(a.kennung || '');
    if (!KENNUNG.test(kennung)) return { fehler: `Kennung ungueltig: ${text(kennung, 40)}` };
    if (gesehen.has(kennung)) return { fehler: `Kennung doppelt: ${kennung}` };
    gesehen.add(kennung);
    const paket = String(a.paket || '');
    if (!PAKET.test(paket) || paket.length > 120) return { fehler: `Paket ungueltig bei ${kennung}` };
    if (typeof a.ok !== 'boolean') return { fehler: `ok fehlt bei ${kennung}` };
    let bild = null;
    if (a.schirmbild_png != null) {
      if (typeof a.schirmbild_png !== 'string') return { fehler: `Schirmbild ungueltig bei ${kennung}` };
      bild = Buffer.from(a.schirmbild_png, 'base64');
      if (bild.length > MAX_BILD) return { fehler: `Schirmbild zu gross bei ${kennung}` };
      if (bild.length < PNG_KOPF.length || !bild.subarray(0, PNG_KOPF.length).equals(PNG_KOPF)) {
        return { fehler: `Schirmbild ist kein PNG bei ${kennung}` };
      }
    }
    const dauer = Number.isFinite(Number(a.dauer_s)) ? Math.max(0, Math.min(86400, Math.round(Number(a.dauer_s)))) : null;
    apps.push({
      kennung,
      name: text(a.name, 80) || kennung,
      paket,
      version: text(a.version, 40),
      ok: a.ok,
      grund: a.ok ? null : (text(a.grund, 500) || 'ohne Grund'),
      dauer_s: dauer,
      schirmbild: bild,
    });
  }
  return { apps };
}

// Neuer Zustand einer App aus dem vorherigen (Zeile aus der Tabelle oder null)
// und dem neuen Ergebnis. meldung: null | 'rot' | 'gruen'.
function bewerten(vorher, neu) {
  const version = neu.version || vorher?.version || '';
  if (neu.ok) {
    return { rot_in_folge: 0, alarmiert: false, version, meldung: vorher?.alarmiert ? 'gruen' : null, neues_release: false };
  }
  const rot = (vorher?.rot_in_folge || 0) + 1;
  // Neues Release: eine andere Version als beim letzten Lauf. Ohne vorherigen
  // Lauf (App neu im Test) zählt das nicht - sonst meldet jede neue App sofort.
  const neuesRelease = !!(vorher && vorher.version && neu.version && vorher.version !== neu.version);
  const melden = !vorher?.alarmiert && (rot >= 2 || neuesRelease);
  return { rot_in_folge: rot, alarmiert: !!vorher?.alarmiert || melden, version, meldung: melden ? 'rot' : null, neues_release: neuesRelease };
}

function meldungText(app, art, { rot_in_folge = 1, neuesRelease = false } = {}) {
  const wer = `${app.name}${app.version ? ' ' + app.version : ''}`;
  if (art === 'gruen') return `✅ Android-Dauertest: ${wer} ist wieder grün.`;
  const warum = neuesRelease && rot_in_folge === 1 ? 'gleich nach dem neuen Release' : `${rot_in_folge}× in Folge`;
  return `🔴 Android-Dauertest: ${wer} rot (${warum}).\n${app.grund || ''}\nSchirmbild im NOC (ISP-Admin, Abschnitt Apps).`;
}

// Für das NOC: Ampel und Liste. zeilen = Tabelle ohne Schirmbild.
function zusammenfassung(zeilen, jetzt = Date.now()) {
  const apps = (zeilen || []).map(z => {
    const zeit = z.zeit ? new Date(z.zeit).getTime() : 0;
    return {
      kennung: z.kennung, name: z.name, paket: z.paket, version: z.version || '',
      ok: z.ok, grund: z.grund || null, dauer_s: z.dauer_s ?? null,
      zeit: z.zeit ? new Date(z.zeit).toISOString() : null,
      alter_min: zeit ? Math.round((jetzt - zeit) / 60000) : null,
      veraltet: !zeit || jetzt - zeit > ALT_MS,
      rot_in_folge: z.rot_in_folge || 0,
      schirmbild: !!z.hat_schirmbild,
    };
  }).sort((a, b) => (a.ok === b.ok ? a.name.localeCompare(b.name, 'de') : a.ok ? 1 : -1));
  const letzter = apps.reduce((m, a) => (a.zeit && (!m || a.zeit > m) ? a.zeit : m), null);
  let ampel = 'grau';
  if (apps.length && letzter && jetzt - new Date(letzter).getTime() <= ALT_MS) {
    ampel = apps.some(a => !a.ok && !a.veraltet) ? 'rot' : 'gruen';
  }
  return { ampel, letzter_lauf: letzter, gruen: apps.filter(a => a.ok).length, rot: apps.filter(a => !a.ok).length, apps };
}

// Ohne Token (NOC_PUBLIC_OPEN): Grund kann Pfade/Zertifikate nennen - weglassen.
function oeffentlich(z) {
  return { ...z, apps: z.apps.map(a => ({ ...a, grund: a.ok ? null : 'rot', schirmbild: false })) };
}

module.exports = { eingabePruefen, bewerten, meldungText, zusammenfassung, oeffentlich, ALT_MS, CT_STILL_MS, MAX_BILD };
