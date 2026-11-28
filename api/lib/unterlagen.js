// Unterlagen: die Ablage (/documents) fuer die App „Rosenweg Unterlagen“ und
// die Web-Seite (Entscheide Stefan 28.11.2026, Klaerung unterlagen).
//
// Was hier liegt (reine Funktionen, ohne Express; Rechte kommen als Funktion
// herein, damit die Regel genau eine bleibt: isDocPathAllowed/canWriteDocPath
// in server.js, lib/dok-stweg-sicht.js, lib/projekte-rechte.js):
//
//   Verzeichnis    ein Abbild der Ablage (Pfad, Groesse, Aenderungszeit),
//                  kurz zwischengespeichert; jede Schreib-Route leert es.
//                  Daraus: Ordner einzeln laden (L2), Suche nach Name und Pfad
//                  (L4, E11), „neu seit“ fuer die Abfrage im Hintergrund (L11).
//                  Weil es die mtime vergleicht, faengt es auch, was ueber
//                  Samba oder die Nextcloud an der API vorbei kommt.
//   Ausblenden     Druckertreiber (allgemein/drivers), .DS_Store, desktop.ini
//                  (E12). Technik/Praesident sehen mit alles=1 alles.
//   Dateinamen     Umlaute und Leerzeichen erlaubt, nur gefaehrliche Zeichen
//                  werden ersetzt (E15).
//   Nummern-Vorlage  Ordner je STWEG (E16): nur Ordner, keine Schlagwoerter.
//   Nextcloud      Sprung „In Nextcloud bearbeiten“ (E7) fuer die Ordner der
//                  STWEGs, die die Nextcloud einbindet (nextcloud/einbindungen-ablage.md).
//   Kennungen      stabile Kennung je Datei (L5, E9): Tabelle dokument_kennungen,
//                  Verschieben/Umbenennen ueber die API zieht sie mit.
const pathModule = require('path');
const crypto = require('crypto');

// ─── Ausblenden (E12) ────────────────────────────────────────────────
const AUSGEBLENDET_DATEIEN = new Set(['.ds_store', 'desktop.ini']);
const AUSGEBLENDET_ORDNER = ['allgemein/drivers'];
// Repo-Reste der GitHub-Sicherung nie zeigen
const NIE_ZEIGEN = new Set(['README.md', 'LICENSE', '.gitignore', '.gitkeep', '.gitattributes']);

/** Blendet die App/das Verzeichnis diesen Pfad aus (ohne „alles zeigen“)? */
function ausgeblendet(pfad) {
  const p = String(pfad || '');
  const name = p.split('/').pop().toLowerCase();
  if (AUSGEBLENDET_DATEIEN.has(name)) return true;
  const klein = p.toLowerCase();
  return AUSGEBLENDET_ORDNER.some(o => klein === o || klein.startsWith(o + '/'));
}

// ─── Dateityp ───────────────────────────────────────────────────────
const TYPEN = {
  pdf: 'pdf',
  png: 'bild', jpg: 'bild', jpeg: 'bild', gif: 'bild', webp: 'bild', bmp: 'bild', tif: 'bild', tiff: 'bild', heic: 'bild', svg: 'bild',
  doc: 'office', docx: 'office', dotx: 'office', xls: 'office', xlsx: 'office', ppt: 'office', pptx: 'office',
  odt: 'office', ods: 'office', odp: 'office',
  txt: 'text', csv: 'text', md: 'text',
  eml: 'mail', msg: 'mail',
  zip: 'archiv',
};
function endung(name) {
  const n = String(name || '').split('/').pop();
  const i = n.lastIndexOf('.');
  return i > 0 ? n.slice(i + 1).toLowerCase() : '';
}
/** pdf | bild | office | text | mail | archiv | andere */
function dateiTyp(name) {
  return TYPEN[endung(name)] || 'andere';
}

// ─── Dateinamen (E15) ───────────────────────────────────────────────
// Erlaubt: Buchstaben aller Sprachen (Umlaute), Ziffern, Leerzeichen und
// . , _ - ( ) + & ' . Ersetzt: / \ : * ? " < > | % # und Steuerzeichen
// (Windows/Samba verbieten sie, % und # brechen URLs). Kein fuehrender Punkt
// (versteckte Dateien, .papierkorb), keine Punkte/Leerzeichen am Ende
// (Windows), hoechstens 180 Zeichen. Leer = null.
const ZEICHEN_VERBOTEN = /[\\/:*?"<>|%#\u0000-\u001f\u007f]/g;
function namensteilBereinigen(name) {
  let s = String(name || '').normalize('NFC')
    .replace(ZEICHEN_VERBOTEN, '-')
    .replace(/\s+/g, ' ')
    .replace(/-{2,}/g, '-')
    .trim()
    .replace(/^[.\s-]+/, '')
    .replace(/[.\s]+$/, '');
  if (s.length > 180) {
    const e = endung(s);
    const stamm = e ? s.slice(0, s.length - e.length - 1) : s;
    s = e ? `${stamm.slice(0, 179 - e.length).trim()}.${e}` : s.slice(0, 180).trim();
  }
  return s || null;
}
/** Dateiname beim Hochladen: lesbar, die Endung klein. */
function dateinameBereinigen(name) {
  const s = namensteilBereinigen(name);
  if (!s) return null;
  const e = endung(s);
  return e ? `${s.slice(0, s.length - e.length)}${e}` : s;
}
/** Ordnername: wie ein Dateiname, ohne Endungslogik. */
function ordnernameBereinigen(name) {
  return namensteilBereinigen(name);
}
/** Vorschlag fuer das Namensschema im Hochlade-Dialog: JJJJ-MM-TT-typ-beschreibung. */
const NAMENSSCHEMA = 'JJJJ-MM-TT-typ-beschreibung (z. B. 2026-11-28-protokoll-versammlung.pdf)';

// ─── Nummern-Vorlage je STWEG (E16) ─────────────────────────────────
// Nach der Ablage, wie sie in STWEG 2 und 3 gewachsen ist. Die App schlaegt
// diese Namen beim Ordner-Anlegen direkt im Ordner einer STWEG vor; eigene
// Nummern (07 … 98) bleiben moeglich. „bewohner“ ist der Ordner, den auch
// Mieter sehen (lib/dok-stweg-sicht.js).
const NUMMERN_VORLAGE = [
  { name: '01-stammdaten', text: 'Stammdaten (Begründung, Reglement, Pläne)' },
  { name: '02-servicevertraege', text: 'Serviceverträge' },
  { name: '04-versicherungen', text: 'Versicherungen' },
  { name: '05-abrechnungen', text: 'Abrechnungen' },
  { name: '06-protokolle', text: 'Protokolle' },
  { name: '99-kontaktdaten', text: 'Kontaktdaten' },
  { name: 'bewohner', text: 'Für Bewohner und Mieter (Hausordnung, Schilder)' },
];

// ─── Nextcloud (E7) ─────────────────────────────────────────────────
// Die Nextcloud bindet je STWEG den Ordner am Punkt /stwegN (MEG /meg) ein,
// beschreibbar fuer Ausschuss, Technik, Praesident. Der Sprung ist nur dort
// sinnvoll, wo man schreiben darf. allgemein, Scans, projekte usw. sind nicht
// (gleich) eingebunden: kein Knopf.
const NEXTCLOUD_STANDARD = 'https://nextcloud.rosenweg4303.ch';
function nextcloudLink(pfad, basis = NEXTCLOUD_STANDARD, { ordner = false } = {}) {
  const teile = String(pfad || '').split('/').filter(Boolean);
  if (!teile.length || !/^(stweg[1-8]|meg)$/.test(teile[0])) return null;
  const name = ordner ? null : teile.pop();
  const dir = '/' + teile.join('/');
  const q = new URLSearchParams({ dir });
  if (name) q.set('scrollto', name);
  return `${String(basis).replace(/\/+$/, '')}/apps/files/files?${q.toString()}`;
}

// ─── Bezeichnungen der obersten Ordner (wie js/documents.js) ─────────
const BEREICHE = {
  allgemein: 'Allgemein',
  Scans: 'Scans',
  stweg1: 'STWEG 1 – Rosenweg 17/18',
  stweg2: 'STWEG 2 – Rosenweg 13/14/16',
  stweg3: 'STWEG 3 – Rosenweg 9',
  stweg4: 'STWEG 4 – Rosenweg 10/12',
  stweg5: 'STWEG 5 – Rosenweg 5/6/8',
  stweg6: 'STWEG 6 – Rosenweg 1',
  stweg7: 'STWEG 7 – Rosenweg 2/4',
  meg: 'MEG – Tiefeinstellhalle',
  projekte: 'Projekte',
};

// ─── ETag (L9) ──────────────────────────────────────────────────────
function etagVon(groesse, geaendertMs) {
  return `"${Number(groesse).toString(36)}-${Math.floor(Number(geaendertMs)).toString(36)}"`;
}

// ─── Verzeichnis der Ablage ─────────────────────────────────────────
/**
 * Ganze Ablage einlesen. -> { dateien: [{pfad, groesse, geaendert}], ordner: Map pfad -> geaendert, stand }
 * Punkt-Ordner (.papierkorb, .recycle, .git…) und Punkt-Dateien nie.
 */
async function verzeichnisLesen(fs, root) {
  const dateien = [];
  const ordner = new Map();
  async function lauf(dir, prefix) {
    let eintraege;
    try { eintraege = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of eintraege) {
      if (e.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const voll = pathModule.join(dir, e.name);
      if (e.isDirectory()) {
        let m = 0;
        try { m = (await fs.stat(voll)).mtimeMs; } catch { /* egal */ }
        ordner.set(rel, m);
        await lauf(voll, rel);
      } else if (e.isFile() || e.isSymbolicLink()) {
        if (NIE_ZEIGEN.has(e.name)) continue;
        try {
          const st = await fs.stat(voll);
          if (st.isFile()) dateien.push({ pfad: rel, groesse: st.size, geaendert: st.mtimeMs });
        } catch { /* unlesbar: weglassen */ }
      }
    }
  }
  await lauf(root, '');
  return { dateien, ordner, stand: Date.now() };
}

/** Zwischenspeicher fuer das Verzeichnis: hoechstens alle `ms` neu lesen, gleichzeitige Anfragen teilen sich einen Lauf. */
function verzeichnisSpeicher(fs, root, { ms = 30000, jetzt = () => Date.now() } = {}) {
  let stand = null;
  let laeuft = null;
  return {
    async holen() {
      if (stand && jetzt() - stand.stand < ms) return stand;
      if (!laeuft) {
        laeuft = verzeichnisLesen(fs, root).then(v => { stand = v; return v; }).finally(() => { laeuft = null; });
      }
      return laeuft;
    },
    leeren() { stand = null; },
  };
}

function elternOrdner(pfad) {
  const i = pfad.lastIndexOf('/');
  return i < 0 ? '' : pfad.slice(0, i);
}

function zeitIso(ms) {
  return ms ? new Date(ms).toISOString() : null;
}

/**
 * Inhalt eines Ordners (eine Ebene) fuer eine Person.
 * darf: { lesen(pfad), schreiben(pfad) } – die Regeln aus server.js.
 * Ein Unterordner erscheint, wenn darin etwas Lesbares liegt, oder wenn er
 * (bis ganz unten) leer ist und man darin lesen darf.
 * -> { pfad, darf: {lesen, schreiben}, ordner: [...], dateien: [...], ausgeblendet }
 */
function ordnerInhalt(verz, pfad, darf, { alles = false } = {}) {
  const ziel = String(pfad || '').replace(/^\/+|\/+$/g, '');
  const vorne = ziel ? ziel + '/' : '';
  const sichtbar = [];
  let ausgeblendetN = 0;
  for (const d of verz.dateien) {
    if (!d.pfad.startsWith(vorne)) continue;
    if (!darf.lesen(d.pfad)) continue;
    if (!alles && ausgeblendet(d.pfad)) { if (elternOrdner(d.pfad) === ziel) ausgeblendetN++; continue; }
    sichtbar.push(d);
  }
  // je direktem Unterordner: Anzahl, neueste Aenderung
  const unter = new Map();
  const dateien = [];
  for (const d of sichtbar) {
    const rest = d.pfad.slice(vorne.length);
    const i = rest.indexOf('/');
    if (i < 0) { dateien.push(d); continue; }
    const name = rest.slice(0, i);
    const u = unter.get(name) || { anzahl: 0, geaendert: 0 };
    u.anzahl++;
    if (d.geaendert > u.geaendert) u.geaendert = d.geaendert;
    unter.set(name, u);
  }
  // leere Ordner (auch mit nur leeren Unterordnern)
  const mitDateien = new Set();
  for (const d of verz.dateien) {
    let p = elternOrdner(d.pfad);
    while (p && !mitDateien.has(p)) { mitDateien.add(p); p = elternOrdner(p); }
  }
  for (const [o, m] of verz.ordner) {
    if (elternOrdner(o) !== ziel) continue;
    const name = o.slice(vorne.length);
    if (unter.has(name) || mitDateien.has(o)) continue;
    if (!alles && ausgeblendet(o)) continue;
    if (darf.lesen(`${o}/x`)) unter.set(name, { anzahl: 0, geaendert: m });
  }
  // ausgeblendete Ordner zaehlen (fuer den Hinweis „n ausgeblendet“)
  if (!alles) {
    for (const o of verz.ordner.keys()) {
      if (elternOrdner(o) === ziel && ausgeblendet(o) && darf.lesen(`${o}/x`)) ausgeblendetN++;
    }
  }
  const sortName = (a, b) => a.name.localeCompare(b.name, 'de', { numeric: true, sensitivity: 'base' });
  return {
    pfad: ziel,
    darf: { lesen: true, schreiben: !!darf.schreiben(ziel ? `${ziel}/x` : 'x') },
    ordner: [...unter].map(([name, u]) => {
      const p = vorne + name;
      return { name, pfad: p, anzahl: u.anzahl, geaendert: zeitIso(u.geaendert), schreiben: !!darf.schreiben(`${p}/x`) };
    }).sort(sortName),
    dateien: dateien.map(d => dateiEintrag(d)).sort(sortName),
    ausgeblendet: ausgeblendetN,
  };
}

function dateiEintrag(d) {
  const name = d.pfad.split('/').pop();
  return {
    name,
    pfad: d.pfad,
    ordner: elternOrdner(d.pfad),
    groesse: d.groesse,
    geaendert: zeitIso(d.geaendert),
    typ: dateiTyp(name),
    etag: etagVon(d.groesse, d.geaendert),
  };
}

// ─── Suche (L4, E11: zuerst Name und Pfad) ──────────────────────────
/** klein, ohne Akzente, ä/ö/ü = ae/oe/ue, Trenner = Leerzeichen */
function suchform(text) {
  return String(text || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[_\-./]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Dateien und Ordner, deren Pfad alle Woerter von q enthaelt (Treffer im
 * Namen zuerst, dann neuere). -> { treffer: [...], mehr }
 */
function suchen(verz, q, darf, { pfad = '', alles = false, grenze = 50 } = {}) {
  const woerter = suchform(q).split(' ').filter(w => w.length >= 1);
  if (!woerter.length || suchform(q).length < 2) return { treffer: [], mehr: false };
  const vorne = pfad ? String(pfad).replace(/^\/+|\/+$/g, '') + '/' : '';
  const passt = (p) => { const s = suchform(p); return woerter.every(w => s.includes(w)); };
  const wertung = (p) => {
    const name = suchform(p.split('/').pop());
    return woerter.filter(w => name.includes(w)).length;
  };
  const gefunden = [];
  for (const d of verz.dateien) {
    if (vorne && !d.pfad.startsWith(vorne)) continue;
    if (!passt(d.pfad) || !darf.lesen(d.pfad)) continue;
    if (!alles && ausgeblendet(d.pfad)) continue;
    gefunden.push({ art: 'datei', w: wertung(d.pfad), m: d.geaendert, e: dateiEintrag(d) });
  }
  for (const [o, m] of verz.ordner) {
    if (vorne && !o.startsWith(vorne)) continue;
    const name = o.split('/').pop();
    if (!woerter.every(w => suchform(name).includes(w))) continue;
    if (!alles && ausgeblendet(o)) continue;
    if (!darf.lesen(`${o}/x`) && !verz.dateien.some(d => d.pfad.startsWith(o + '/') && darf.lesen(d.pfad))) continue;
    gefunden.push({ art: 'ordner', w: woerter.length + 1, m, e: { name, pfad: o, ordner: elternOrdner(o), art: 'ordner', geaendert: zeitIso(m) } });
  }
  gefunden.sort((a, b) => (b.w - a.w) || (b.m - a.m));
  return {
    treffer: gefunden.slice(0, grenze).map(g => (g.art === 'datei' ? { art: 'datei', ...g.e } : g.e)),
    mehr: gefunden.length > grenze,
  };
}

// ─── Neu seit (L1, L11, E3) ─────────────────────────────────────────
/**
 * Dateien mit Aenderungszeit nach `seit` (ms), optional nur in `ordner`
 * (Liste von Ordnerpfaden, auch Unterordner zaehlen). Neueste zuerst.
 */
function neuSeit(verz, seit, darf, { ordner = [], alles = false, grenze = 200 } = {}) {
  const vorne = (ordner || []).map(o => String(o).replace(/^\/+|\/+$/g, '')).filter(Boolean).map(o => o + '/');
  const liste = [];
  for (const d of verz.dateien) {
    if (!(d.geaendert > seit)) continue;
    if (vorne.length && !vorne.some(v => d.pfad.startsWith(v))) continue;
    if (!darf.lesen(d.pfad)) continue;
    if (!alles && ausgeblendet(d.pfad)) continue;
    liste.push(d);
  }
  liste.sort((a, b) => b.geaendert - a.geaendert);
  return { dateien: liste.slice(0, grenze).map(dateiEintrag), mehr: liste.length > grenze, stand: zeitIso(verz.stand) };
}

/** `seit` aus der Anfrage: ISO-Zeit oder Millisekunden; sonst null. */
function seitLesen(wert) {
  if (wert === undefined || wert === null || wert === '') return null;
  const s = String(wert);
  const n = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  return Number.isFinite(n) ? n : null;
}

// ─── Stabile Kennungen (L5, E9) ─────────────────────────────────────
const SQL_KENNUNGEN = `
  CREATE TABLE IF NOT EXISTS dokument_kennungen (
    id TEXT PRIMARY KEY,
    pfad TEXT NOT NULL UNIQUE,
    erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    verschoben_am TIMESTAMPTZ
  );`;
const kennungenBereit = new WeakMap();
function kennungTabelle(pool) {
  if (!kennungenBereit.has(pool)) {
    kennungenBereit.set(pool, pool.query(SQL_KENNUNGEN).catch(e => { kennungenBereit.delete(pool); throw e; }));
  }
  return kennungenBereit.get(pool);
}
/** 12 Zeichen base64url, zufaellig (nicht fortlaufend). */
function neueKennung() {
  return crypto.randomBytes(9).toString('base64url');
}
const KENNUNG_FORM = /^[A-Za-z0-9_-]{12}$/;

/** Kennungen fuer diese Pfade (fehlende werden angelegt). -> Map pfad -> id */
async function kennungenFuer(pool, pfade) {
  const liste = [...new Set(pfade)].filter(Boolean);
  const map = new Map();
  if (!liste.length) return map;
  await kennungTabelle(pool);
  const { rows } = await pool.query('SELECT id, pfad FROM dokument_kennungen WHERE pfad = ANY($1::text[])', [liste]);
  for (const r of rows) map.set(r.pfad, r.id);
  const fehlen = liste.filter(p => !map.has(p));
  if (fehlen.length) {
    const ids = fehlen.map(() => neueKennung());
    await pool.query(
      `INSERT INTO dokument_kennungen (id, pfad) SELECT * FROM unnest($1::text[], $2::text[]) ON CONFLICT (pfad) DO NOTHING`,
      [ids, fehlen]);
    const r2 = await pool.query('SELECT id, pfad FROM dokument_kennungen WHERE pfad = ANY($1::text[])', [fehlen]);
    for (const r of r2.rows) map.set(r.pfad, r.id);
  }
  return map;
}
/** Pfad zu einer Kennung (null = unbekannt). */
async function pfadZuKennung(pool, id) {
  if (!KENNUNG_FORM.test(String(id || ''))) return null;
  await kennungTabelle(pool);
  const { rows } = await pool.query('SELECT pfad FROM dokument_kennungen WHERE id = $1', [id]);
  return rows[0]?.pfad || null;
}
/**
 * Datei verschoben/umbenannt: Kennung und Projekt-Verknuepfungen
 * (project_attachments.doc_path) ziehen mit. Fehler in den Nebentabellen
 * brechen das Verschieben nicht ab (die Datei liegt schon am neuen Ort).
 */
async function verschoben(pool, von, nach) {
  await kennungTabelle(pool);
  await pool.query('DELETE FROM dokument_kennungen WHERE pfad = $1 AND EXISTS (SELECT 1 FROM dokument_kennungen WHERE pfad = $2)', [nach, von]);
  await pool.query('UPDATE dokument_kennungen SET pfad = $2, verschoben_am = NOW() WHERE pfad = $1', [von, nach]);
  await pool.query('UPDATE project_attachments SET doc_path = $2 WHERE doc_path = $1', [von, nach])
    .catch(e => { if (e.code !== '42P01' && e.code !== '23505') throw e; });
}

// ─── Range (geteilte Telefone stueckweise, grosse PDFs) ──────────────
/** `Range: bytes=a-b` (ein Bereich). -> {von, bis} | 'ungueltig' | null (kein Range) */
function bereichLesen(kopf, groesse) {
  if (!kopf) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(kopf).trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'ungueltig';
  let von, bis;
  if (m[1] === '') { // letzte n Bytes
    const n = Number(m[2]);
    if (n === 0) return 'ungueltig';
    von = Math.max(0, groesse - n); bis = groesse - 1;
  } else {
    von = Number(m[1]);
    bis = m[2] === '' ? groesse - 1 : Math.min(Number(m[2]), groesse - 1);
  }
  if (von >= groesse || bis < von) return 'ungueltig';
  return { von, bis };
}

module.exports = {
  AUSGEBLENDET_ORDNER, ausgeblendet, dateiTyp, endung,
  dateinameBereinigen, ordnernameBereinigen, NAMENSSCHEMA, NUMMERN_VORLAGE,
  BEREICHE, NEXTCLOUD_STANDARD, nextcloudLink, etagVon,
  verzeichnisLesen, verzeichnisSpeicher, ordnerInhalt, dateiEintrag,
  suchform, suchen, neuSeit, seitLesen,
  SQL_KENNUNGEN, kennungTabelle, neueKennung, KENNUNG_FORM, kennungenFuer, pfadZuKennung, verschoben,
  bereichLesen,
};
