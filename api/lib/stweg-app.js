// Rosenweg STWEG (App „Meine Gemeinschaft“): Rollen, Sicht, Rechte, Pruefung
// der Mitteilungen und die Druckvorlagen. Rein, ohne DB (node --test).
// Entscheide Stefan 28.11.2026 (Klaerung STWEG): Mitteilungen schreiben
// Ausschuss und Verwaltung der STWEG (Seitenrecht 'stweg-mitteilungen'),
// Kooperation (stweg 0) schreibt nur Technik/Praesident.
const {
  STWEG_GROUPS, ALLE_STWEGS, isTechnik, isPraesident, getAusschussStwegs, isVerwaltungFor, getStwegsMitVerwaltung,
} = require('./groups');
const { STWEG_HAEUSER } = require('./haeuser');
const { stwegDokZugang } = require('./dok-stweg-sicht');
const { esc } = require('./mitteilungen-text');

const SEITE = 'stweg-mitteilungen';
const KOOPERATION = 0;
const SICHTBARKEITEN = ['bewohner', 'eigentuemer', 'oeffentlich'];
const MODULE = ['waschkueche']; // Positivliste fuer POST /api/stweg-modules (seiten-editor entfaellt)
const GRENZEN = { titel: 200, text: 20000 };
const BILD_TYPEN = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const BILD_MAX = 8 * 1024 * 1024;

const alles = (g) => isTechnik(g || []) || isPraesident(g || []);
const stwegName = (n) => (Number(n) === KOOPERATION ? 'Kooperation' : Number(n) === 8 ? 'MEG' : `STWEG ${n}`);
const gueltigeNr = (n) => Number(n) === KOOPERATION || ALLE_STWEGS.includes(Number(n));

function adresse(nr) {
  const h = STWEG_HAEUSER[nr] || [];
  return h.length ? `Rosenweg ${h.join(', ')}` : (Number(nr) === 8 ? 'Tiefeinstellhalle' : '');
}

// Rollen des Kontos in der STWEG nr: bewohner, eigentuemer, ausschuss, verwaltung (+ technik, praesident)
function rollenIn(groups, nr) {
  const g = groups || [];
  const lower = new Set(g.map(x => String(x).toLowerCase()));
  const m = STWEG_GROUPS[Number(nr)] || {};
  const r = [];
  for (const k of ['bewohner', 'eigentuemer', 'ausschuss']) if (m[k] && lower.has(m[k].toLowerCase())) r.push(k);
  if (isVerwaltungFor(g, Number(nr))) r.push('verwaltung');
  if (isTechnik(g)) r.push('technik');
  if (isPraesident(g)) r.push('praesident');
  return r;
}

// Welche Sichtbarkeiten darf das Konto in der STWEG nr lesen? (nr 0 = Kooperation:
// Mitglied irgendeiner STWEG). Ohne Anmeldung (groups null) nur 'oeffentlich'.
function sichtbarkeitenFuer(groups, nr) {
  const aus = new Set(['oeffentlich']);
  if (!groups) return aus;
  const liste = Number(nr) === KOOPERATION ? ALLE_STWEGS : [Number(nr)];
  for (const n of liste) {
    const r = rollenIn(groups, n);
    if (!r.length) continue;
    aus.add('bewohner');
    if (r.some(x => x !== 'bewohner')) aus.add('eigentuemer');
  }
  return aus;
}

// Schreiben: T/P und alter Admin immer; Kooperation nur diese; sonst Seitenrecht
// 'stweg-mitteilungen' = write UND Ausschuss oder Verwaltung genau dieser STWEG.
function mitteilungSchreibenErlaubt(groups, nr, seitenRecht, istAdmin = false) {
  const g = groups || [];
  const n = Number(nr);
  if (!gueltigeNr(n)) return false;
  if (istAdmin || alles(g)) return true;
  if (n === KOOPERATION || seitenRecht !== 'write') return false;
  return getAusschussStwegs(g).has(n) || isVerwaltungFor(g, n);
}

// GET /api/stweg/meine: Gemeinschaften des Kontos mit Rollen und Rechten
function meineStwegs(groups, rechte, istAdmin = false) {
  const g = groups || [];
  const eigene = getStwegsMitVerwaltung(g);
  const sicht = alles(g) ? ALLE_STWEGS : [...eigene].sort((a, b) => a - b);
  const mRecht = (rechte || {})[SEITE] || 'none';
  const tRecht = (rechte || {})['stweg-termine'] || 'none';
  const termineLib = require('./termine');
  const meg = require('./meg');
  return sicht.map(nr => ({
    nr, name: stwegName(nr), adresse: adresse(nr), eigene: eigene.has(nr),
    rollen: rollenIn(g, nr),
    darf: {
      mitteilungen: mitteilungSchreibenErlaubt(g, nr, mRecht, istAdmin),
      termine: termineLib.termineSchreibErlaubt(g, nr, tRecht, istAdmin),
      einstellplaetze: nr === 8 && meg.darfMegPlaetzeVerwalten({ groups: g, isAdmin: istAdmin }),
    },
    einstellplaetze: nr === 8 && meg.darfMegPlaetzeSehen({ groups: g, isAdmin: istAdmin }),
    dokZugang: alles(g) ? 'voll' : stwegDokZugang(g, nr),
  }));
}

// Formular einer Mitteilung (POST/PUT). teilweise = PUT.
function mitteilungAusFormular(body, { teilweise = false } = {}) {
  const b = body || {};
  const hat = k => Object.prototype.hasOwnProperty.call(b, k);
  const fehler = (feld, error) => ({ status: 400, error, feld });
  const w = {};
  if (!teilweise || hat('titel')) {
    const t = typeof b.titel === 'string' ? b.titel.trim() : '';
    if (!t) return fehler('titel', 'Titel fehlt');
    if (t.length > GRENZEN.titel) return fehler('titel', `Titel höchstens ${GRENZEN.titel} Zeichen`);
    w.titel = t;
  }
  if (!teilweise || hat('text')) {
    const t = typeof b.text === 'string' ? b.text.replace(/\r\n?/g, '\n').trim() : '';
    if (!t) return fehler('text', 'Text fehlt');
    if (t.length > GRENZEN.text) return fehler('text', `Text höchstens ${GRENZEN.text} Zeichen`);
    w.text = t;
  }
  if (!teilweise || hat('sichtbarkeit')) {
    const s = b.sichtbarkeit == null || b.sichtbarkeit === '' ? 'bewohner' : String(b.sichtbarkeit);
    if (!SICHTBARKEITEN.includes(s)) return fehler('sichtbarkeit', 'Sichtbarkeit: bewohner, eigentuemer oder oeffentlich');
    w.sichtbarkeit = s;
  }
  if (!teilweise || hat('gueltig_bis')) {
    if (b.gueltig_bis == null || b.gueltig_bis === '') w.gueltig_bis = null;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(String(b.gueltig_bis)) && !Number.isNaN(Date.parse(b.gueltig_bis))) w.gueltig_bis = String(b.gueltig_bis);
    else return fehler('gueltig_bis', 'Gültig bis ist kein Datum (JJJJ-MM-TT)');
  }
  for (const k of ['wichtig', 'angeheftet']) if (!teilweise || hat(k)) w[k] = b[k] === true;
  return { werte: w };
}

// Bild: Typ und Magic Bytes
function bildTypPruefen(typ, buf) {
  if (!BILD_TYPEN.includes(typ) || !Buffer.isBuffer(buf) || buf.length < 12) return false;
  if (typ === 'image/jpeg') return buf[0] === 0xff && buf[1] === 0xd8;
  if (typ === 'image/png') return buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (typ === 'image/gif') return buf.slice(0, 3).toString() === 'GIF';
  return buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP';
}

// ─── Druck (PDF vom Server, Vermerk „vertraulich“) ───────────────────
const CSS = `body{font:11pt/1.35 Helvetica,Arial,sans-serif;color:#111}h1{font-size:17pt;margin:0 0 2pt}
.v{border:1.5pt solid #b00;color:#b00;padding:4pt 8pt;font-weight:bold;margin:8pt 0}
table{border-collapse:collapse;width:100%}td,th{border-bottom:.5pt solid #bbb;padding:3pt 4pt;text-align:left;vertical-align:top}
th{background:#eee}.k{color:#555;font-size:9pt}`;

function druckRahmen(titel, fuer, jetzt, inhalt) {
  const datum = new Date(jetzt).toLocaleString('de-CH', { timeZone: 'Europe/Zurich' });
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<h1>${esc(titel)}</h1><div class="k">Stand ${esc(datum)}</div>
<div class="v">VERTRAULICH – erstellt für ${esc(fuer)} am ${esc(datum)}. Nicht weitergeben.</div>${inhalt}</body></html>`;
}

function kontaktlisteHtml({ stweg, wohnungen, ausschuss }, fuer, jetzt = Date.now()) {
  const zeile = (k) => `${esc(k.name)}${k.rolle ? ` <span class="k">(${esc(k.rolle)})</span>` : ''}<br>${esc(k.email || '')}<br>${esc(k.telefon || '')}`;
  let h = '';
  if ((ausschuss || []).length) {
    h += `<h2>Ausschuss</h2><table>${ausschuss.map(a => `<tr><td>${esc(a.name)}<br><span class="k">${esc(a.funktion || '')}</span></td><td>${esc(a.email || '')}<br>${esc(a.telefon || '')}</td></tr>`).join('')}</table>`;
  }
  h += `<h2>Kontakte nach Wohnung</h2><table><tr><th>Wohnung</th><th>Kontakte</th></tr>${(wohnungen || []).map(w =>
    `<tr><td>${esc(w.bezeichnung)}</td><td>${(w.bewohner || []).map(zeile).join('<br><br>')}</td></tr>`).join('')}</table>`;
  return druckRahmen(`Kontaktliste ${stwegName(stweg)}`, fuer, jetzt, h);
}

function wohnungslisteHtml(stweg, rows, fuer, jetzt = Date.now()) {
  const q = (w) => (w.wertquote_zaehler && w.wertquote_nenner ? `${w.wertquote_zaehler}/${w.wertquote_nenner}` : '');
  const h = `<table><tr><th>Wohnung</th><th>Etage</th><th>Zimmer</th><th>m²</th><th>Wertquote</th><th>Belegung</th><th>Besonderheiten</th></tr>${(rows || []).map(w =>
    `<tr><td>${esc(w.bezeichnung)}</td><td>${esc(w.stockwerk ?? '')}</td><td>${esc(w.zimmer ?? '')}</td><td>${esc(w.flaeche_m2 ?? '')}</td><td>${esc(q(w))}</td><td>${esc(w.bewohnt_von || '')}</td><td>${esc(w.besonderheiten || '')}</td></tr>`).join('')}</table>`;
  return druckRahmen(`Wohnungsliste ${stwegName(stweg)}`, fuer, jetzt, h);
}

function einstellplaetzeHtml(rows, fuer, jetzt = Date.now()) {
  const h = `<table><tr><th>Platz</th><th>Typ</th><th>Status</th><th>Zugeordnet</th><th>Notiz</th></tr>${(rows || []).map(p =>
    `<tr><td>${esc(p.platz_nr)}</td><td>${esc(p.typ)}</td><td>${esc(p.status)}</td><td>${esc(p.zugeordnet_name || '')}${p.zugeordnet_email ? `<br><span class="k">${esc(p.zugeordnet_email)}</span>` : ''}</td><td>${esc(p.notizen || '')}</td></tr>`).join('')}</table>`;
  return druckRahmen('Einstellplätze MEG', fuer, jetzt, h);
}

module.exports = {
  SEITE, KOOPERATION, SICHTBARKEITEN, MODULE, GRENZEN, BILD_TYPEN, BILD_MAX, stwegName, gueltigeNr, adresse,
  rollenIn, sichtbarkeitenFuer, mitteilungSchreibenErlaubt, meineStwegs, mitteilungAusFormular, bildTypPruefen,
  kontaktlisteHtml, wohnungslisteHtml, einstellplaetzeHtml,
};
