// STWEG-Termine (Rosenweg Termine, STWEG-Seiten): Rechte, Pruefung der
// Formulardaten, Zusammenfuehren der Quellen. Rein funktional – DB und
// Google-Kalender bleiben in server.js.
//
// Lesen: Mitglieder der STWEG (Bewohner, Eigentuemer, Ausschuss), deren
// Hausverwaltung (stwegN-verwaltung), Technik, Praesident (requireStwegAccess).
// Schreiben: Technik/Praesident immer; sonst Seitenrecht 'stweg-termine'
// = write UND Ausschuss oder Hausverwaltung GENAU DIESER STWEG
// (STWEG-Bindung wie wiki/berechtigungen.md Abschnitt 3).
const {
  isTechnik, isPraesident, getAusschussStwegs, isVerwaltungFor, getStwegsMitVerwaltung, ALLE_STWEGS,
} = require('./groups');

const SEITE = 'stweg-termine';
const KATEGORIEN = ['versammlung', 'sitzung', 'wartung', 'reinigung', 'entsorgung', 'anlass', 'stweg', 'sonstiges'];
const GRENZEN = { title: 255, location: 255, description: 4000 };

function stwegName(n) {
  return Number(n) === 8 ? 'MEG' : `STWEG ${n}`;
}

function alles(groups) {
  return isTechnik(groups || []) || isPraesident(groups || []);
}

// Darf das Konto Termine der STWEG nr anlegen, aendern, loeschen?
// seitenRecht: 'none' | 'read' | 'write' aus permissions (getUserPermissions).
// istAdmin: alter Weg (req.user.isAdmin, role=admin) – bleibt erlaubt.
function termineSchreibErlaubt(groups, nr, seitenRecht, istAdmin = false) {
  const g = groups || [];
  const n = Number(nr);
  if (!ALLE_STWEGS.includes(n)) return false;
  if (istAdmin || alles(g)) return true;
  if (seitenRecht !== 'write') return false;
  return getAusschussStwegs(g).has(n) || isVerwaltungFor(g, n);
}

// STWEGs, die das Konto sehen darf, mit Schreibrecht je STWEG.
// eigene = Mitglied oder Verwaltung (diese zeigt die App zuerst);
// Technik/Praesident sehen dazu alle anderen (eigene: false).
function termineStwegs(groups, seitenRecht, istAdmin = false) {
  const g = groups || [];
  const eigene = getStwegsMitVerwaltung(g);
  const sicht = alles(g) ? ALLE_STWEGS : [...eigene].sort((a, b) => a - b);
  return sicht.map(nr => ({
    nr, name: stwegName(nr), eigene: eigene.has(nr),
    schreiben: termineSchreibErlaubt(g, nr, seitenRecht, istAdmin),
  }));
}

// ?stweg= der App: 'alle' | Liste "3,5" | leer (= eigene, ohne eigene = alle sichtbaren).
// -> { stwegs: [nr…] } oder { status, error }
function termineAuswahl(sichtbar, angefragt) {
  const erlaubt = new Set(sichtbar.map(s => s.nr));
  const a = angefragt == null ? '' : String(angefragt).trim();
  if (a === '') {
    const eigene = sichtbar.filter(s => s.eigene).map(s => s.nr);
    return { stwegs: eigene.length ? eigene : [...erlaubt] };
  }
  if (a === 'alle') return { stwegs: [...erlaubt] };
  const nrn = a.split(',').map(x => parseInt(x, 10));
  if (nrn.some(n => !Number.isFinite(n))) return { status: 400, error: 'Ungültige STWEG-Nummer' };
  const fremd = nrn.filter(n => !erlaubt.has(n));
  if (fremd.length) return { status: 403, error: `Kein Zugriff auf die Termine der ${stwegName(fremd[0])}` };
  return { stwegs: [...new Set(nrn)] };
}

function datum(v) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

// Formular (POST/PUT) pruefen. teilweise = PUT: nur gesendete Felder.
// -> { werte } oder { status: 400, error, feld }
function terminAusFormular(body, { teilweise = false } = {}) {
  const b = body || {};
  const w = {};
  const fehler = (feld, error) => ({ status: 400, error, feld });
  const hat = k => Object.prototype.hasOwnProperty.call(b, k);

  if (!teilweise || hat('title')) {
    const t = typeof b.title === 'string' ? b.title.trim() : '';
    if (!t) return fehler('title', 'Titel fehlt');
    if (t.length > GRENZEN.title) return fehler('title', `Titel höchstens ${GRENZEN.title} Zeichen`);
    w.title = t;
  }
  if (!teilweise || hat('start_date')) {
    const s = datum(b.start_date);
    if (!s) return fehler('start_date', s === undefined ? 'Beginn ist kein gültiges Datum' : 'Beginn fehlt');
    w.start_date = s;
  }
  if (!teilweise || hat('end_date')) {
    const e = datum(b.end_date);
    if (e === undefined) return fehler('end_date', 'Ende ist kein gültiges Datum');
    w.end_date = e;
  }
  for (const k of ['location', 'description']) {
    if (!teilweise || hat(k)) {
      const v = b[k] == null ? '' : String(b[k]).trim();
      if (v.length > GRENZEN[k]) return fehler(k, `${k === 'location' ? 'Ort' : 'Beschreibung'} höchstens ${GRENZEN[k]} Zeichen`);
      w[k] = v || null;
    }
  }
  if (!teilweise || hat('all_day')) w.all_day = b.all_day === true;
  if (!teilweise || hat('category')) {
    const c = b.category == null || b.category === '' ? 'sonstiges' : String(b.category).trim().toLowerCase();
    if (!KATEGORIEN.includes(c)) return fehler('category', `Unbekannte Art: ${c}`);
    w.category = c;
  }
  if (w.start_date && w.end_date && w.end_date < w.start_date) return fehler('end_date', 'Ende liegt vor dem Beginn');
  return { werte: w };
}

// Termine mehrerer STWEGs zu einer Liste: Kooperations-Termine (Google-
// Kalender) und Wartungen ohne STWEG kommen in jeder STWEG vor – nur einmal
// zeigen, mit allen STWEGs in 'stwegs'. Sortiert nach Beginn.
function termineZusammenfuehren(jeStweg) {
  const nachSchluessel = new Map();
  for (const { nr, termine } of jeStweg) {
    for (const t of termine || []) {
      const schluessel = t.source === 'stweg'
        ? `stweg-${t.id}`
        : t.source === 'kooperation'
          ? `kooperation-${t.title}-${t.start}`
          : `${t.source}-${t.id}`;
      const da = nachSchluessel.get(schluessel);
      if (da) {
        if (!da.stwegs.includes(nr)) da.stwegs.push(nr);
      } else {
        nachSchluessel.set(schluessel, { ...t, stweg: t.source === 'stweg' || t.source === 'doodle' ? nr : null, stwegs: [nr] });
      }
    }
  }
  return [...nachSchluessel.values()].sort((a, b) => new Date(a.start) - new Date(b.start));
}

// Nextcloud-Kalender, in dem die Termine einer STWEG schon stehen
// (Rosenweg Kalender gleicht CalDAV/Nextcloud ab). Aus der Umgebung
// TERMINE_NEXTCLOUD_KALENDER, JSON: {"3": {"name": "STWEG 3 – Termine",
// "url": "https://…"}}. Nicht gesetzt = keiner, die App bietet dann nur die
// Kalenderdatei an.
function nextcloudKalender(roh) {
  if (!roh) return {};
  let j;
  try { j = JSON.parse(roh); } catch { return {}; }
  if (!j || typeof j !== 'object') return {};
  const aus = {};
  for (const [k, v] of Object.entries(j)) {
    const nr = parseInt(k, 10);
    if (!ALLE_STWEGS.includes(nr) || !v || typeof v.name !== 'string' || !v.name.trim()) continue;
    const url = typeof v.url === 'string' && /^https:\/\//.test(v.url) ? v.url : null;
    aus[nr] = { name: v.name.trim(), url };
  }
  return aus;
}

module.exports = {
  SEITE, KATEGORIEN, GRENZEN, stwegName, termineSchreibErlaubt, termineStwegs, termineAuswahl,
  terminAusFormular, termineZusammenfuehren, nextcloudKalender,
};
