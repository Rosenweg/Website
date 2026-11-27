// Register der Rosenweg-Apps (apps-register.json im Repo-Wurzelverzeichnis).
//
// Eine Quelle für
//  - /apps und die Release-Annahme der PBX (pbx/api/app.py holt es über
//    GET /api/apps/register, alle 5 Minuten, mit Kopie auf der Platte),
//  - die Karten-Sitzungen (routes/app-karte.js: Anzeigename der App kommt
//    aus dem Register, nicht aus der Anfrage),
//  - die App-Kennung im Protokoll (lib/appkennung.js: bekannte Apps).
//
// Früher stand das Register fest in pbx/api/app.py (APPS_REGISTER,
// APPS_KATALOG_REPOS, APPS_KATALOG_INFO): jede neue App brauchte einen
// PBX-Deploy. Jetzt: Eintrag in apps-register.json, Haupt-API ausrollen.
//
//   apps:    Apps mit eigenem Repo für mehrere Plattformen (Flutter), Schlüssel
//            = kurzer Name ("vm", "salz"). Felder: name, repo, paket, logo,
//            reihenfolge, text, fuer, technik?
//   katalog: Android-Apps aus dem Katalog der geteilten Telefone, Schlüssel =
//            Paketname. Felder: repo, logo?, name?, text?, fuer?, technik?,
//            nicht_oeffentlich? (kein Download auf /apps)
//   Felder mit "_" am Anfang sind Notizen und werden nicht ausgewertet.
const fs = require('fs');
const path = require('path');

const PAKET_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,6}$/;
const SCHLUESSEL_RE = /^[a-z][a-z0-9-]{0,30}$/;
const REPO_RE = /^Rosenweg\/[A-Za-z0-9._-]{1,100}$/;

// Im Container liegt die Datei neben server.js, im Repo eine Ebene über api/.
const KANDIDATEN = [
  process.env.APPS_REGISTER_DATEI,
  path.join(__dirname, '..', 'apps-register.json'),
  path.join(__dirname, '..', '..', 'apps-register.json'),
].filter(Boolean);

/** Fehlerliste (leer = in Ordnung). Rein, für Tests und beim Laden. */
function pruefen(d) {
  const fehler = [];
  if (!d || typeof d !== 'object') return ['kein Objekt'];
  if (d.version !== 1) fehler.push('version muss 1 sein');
  const apps = d.apps && typeof d.apps === 'object' ? d.apps : null;
  const katalog = d.katalog && typeof d.katalog === 'object' ? d.katalog : null;
  if (!apps) fehler.push('apps fehlt');
  if (!katalog) fehler.push('katalog fehlt');
  const pakete = new Map(), repos = new Map();
  const merken = (art, wert, wo) => {
    const karte = art === 'paket' ? pakete : repos;
    if (karte.has(wert)) fehler.push(`${art} ${wert} doppelt (${karte.get(wert)}, ${wo})`);
    else karte.set(wert, wo);
  };
  const text = (v) => v === undefined || typeof v === 'string';
  for (const [k, e] of Object.entries(apps || {})) {
    const wo = `apps.${k}`;
    if (!SCHLUESSEL_RE.test(k)) fehler.push(`${wo}: Schlüssel ungültig`);
    if (!e || typeof e !== 'object') { fehler.push(`${wo}: kein Objekt`); continue; }
    if (typeof e.name !== 'string' || !e.name.trim()) fehler.push(`${wo}: name fehlt`);
    if (!REPO_RE.test(String(e.repo || ''))) fehler.push(`${wo}: repo ungültig`); else merken('repo', e.repo, wo);
    if (!PAKET_RE.test(String(e.paket || ''))) fehler.push(`${wo}: paket ungültig`); else merken('paket', e.paket, wo);
    if (!Number.isInteger(e.reihenfolge)) fehler.push(`${wo}: reihenfolge fehlt`);
    for (const f of ['logo', 'text', 'fuer']) if (!text(e[f])) fehler.push(`${wo}: ${f} ist kein Text`);
    if (e.technik !== undefined && typeof e.technik !== 'boolean') fehler.push(`${wo}: technik ist kein Ja/Nein`);
  }
  for (const [p, e] of Object.entries(katalog || {})) {
    const wo = `katalog.${p}`;
    if (!PAKET_RE.test(p)) fehler.push(`${wo}: Paketname ungültig`); else merken('paket', p, wo);
    if (!e || typeof e !== 'object') { fehler.push(`${wo}: kein Objekt`); continue; }
    if (!REPO_RE.test(String(e.repo || ''))) fehler.push(`${wo}: repo ungültig`); else merken('repo', e.repo, wo);
    for (const f of ['logo', 'name', 'text', 'fuer']) if (!text(e[f])) fehler.push(`${wo}: ${f} ist kein Text`);
    for (const f of ['technik', 'nicht_oeffentlich']) {
      if (e[f] !== undefined && typeof e[f] !== 'boolean') fehler.push(`${wo}: ${f} ist kein Ja/Nein`);
    }
  }
  return fehler;
}

let stand = { datei: null, mtime: 0, daten: null, geprueft: 0 };

/** Register lesen (neu, wenn sich die Datei geändert hat; höchstens alle 10 s nachsehen). */
function register() {
  const jetzt = Date.now();
  if (stand.daten && jetzt - stand.geprueft < 10 * 1000) return stand.daten;
  stand.geprueft = jetzt;
  for (const datei of KANDIDATEN) {
    let st;
    try { st = fs.statSync(datei); } catch { continue; }
    if (stand.daten && stand.datei === datei && stand.mtime === st.mtimeMs) return stand.daten;
    try {
      const d = JSON.parse(fs.readFileSync(datei, 'utf8'));
      const fehler = pruefen(d);
      if (fehler.length) {
        console.error(`[apps-register] ${datei} ungültig: ${fehler.slice(0, 5).join('; ')}`);
        break; // die letzte gute Fassung behalten
      }
      stand = { datei, mtime: st.mtimeMs, daten: d, geprueft: jetzt };
      return d;
    } catch (e) {
      console.error(`[apps-register] ${datei}: ${e.message}`);
      break;
    }
  }
  return stand.daten || { version: 1, apps: {}, katalog: {} };
}

/** Eintrag zu einem Paketnamen: { art:'app'|'katalog', schluessel, name, technik } oder null. */
function nachPaket(paket, d = register()) {
  const p = String(paket || '');
  for (const [k, e] of Object.entries(d.apps || {})) {
    if (e.paket === p) return { art: 'app', schluessel: k, name: e.name, technik: !!e.technik };
  }
  const e = d.katalog?.[p];
  if (e) return { art: 'katalog', schluessel: p, name: e.name || null, technik: !!e.technik };
  return null;
}

/** Für GET /api/apps/register: ohne Notizfelder (_…). */
function oeffentlich(d = register()) {
  const ohneNotiz = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')));
  const je = (obj) => Object.fromEntries(Object.entries(obj || {}).map(([k, e]) => [k, ohneNotiz(e)]));
  return { version: d.version, apps: je(d.apps), katalog: je(d.katalog) };
}

module.exports = { register, pruefen, nachPaket, oeffentlich, PAKET_RE };
