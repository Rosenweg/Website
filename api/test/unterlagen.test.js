// node --test api/test/unterlagen.test.js — Ablage fuer die App „Rosenweg
// Unterlagen“ (Entscheide Stefan 28.11.2026): Ordner einzeln, Datum, Rechte,
// Suche, neu seit, Kennungen, Ausblenden, Dateinamen, Vorschau je Fassung,
// Range, abgeleitetes Recht „dokumente“, KI-Suche ehrlich.
// Nur erfundene Dateien in einem Temp-Ordner, nie die echte Ablage.
const test = require('node:test');
const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const u = require('../lib/unterlagen');

const W = path.join(__dirname, '..', '..');
const src = fsSync.readFileSync(path.join(W, 'api', 'server.js'), 'utf8');
const route = (kopf) => { const i = src.indexOf(kopf); assert.ok(i > 0, kopf); return src.slice(i, src.indexOf('\n});', i)); };

async function ablage(dateien, leer = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unterlagen-'));
  let t = Date.parse('2026-11-01T10:00:00Z');
  for (const [p, inhalt] of Object.entries(dateien)) {
    const v = path.join(root, p);
    await fs.mkdir(path.dirname(v), { recursive: true });
    await fs.writeFile(v, inhalt);
    t += 3600e3;
    await fs.utimes(v, t / 1000, t / 1000);
  }
  for (const o of leer) await fs.mkdir(path.join(root, o), { recursive: true });
  return root;
}

const DATEIEN = {
  'reglement.pdf': 'r',
  'allgemein/hausordnung.pdf': 'h',
  'allgemein/drivers/hp/treiber.inf': 'x',
  'allgemein/.DS_Store': 'x',
  'allgemein/desktop.ini': 'x',
  'stweg3/bewohner/schilder/heizung.pdf': 'hz',
  'stweg3/06-protokolle/2026-05-12-protokoll-versammlung.pdf': 'p1',
  'stweg3/05-abrechnungen/jahresrechnung-2025.pdf': 'a',
  'stweg3/reklamationen/foto.jpg': 'f',
  'stweg5/06-protokolle/protokoll.pdf': 'p5',
  'projekte/dach/offerte.pdf': 'o',
  'archiv/alt.eml': 'e',
  'README.md': 'nie',
  '.papierkorb/1-x.pdf': 'nie',
};

// Regeln wie server.js (vereinfacht fuer den Test): Mieter STWEG 3
const MIETER3 = {
  lesen: (p) => {
    const t = p.split('/');
    if (t.length === 1 || t[0] === 'allgemein') return true;
    if (t[0] === 'stweg3') return t[1] === 'bewohner' && !p.includes('reklamationen');
    return false;
  },
  schreiben: () => false,
};
const AUSSCHUSS3 = {
  lesen: (p) => { const t = p.split('/'); return (t.length === 1 || ['allgemein', 'stweg3'].includes(t[0])) && !p.includes('/reklamationen/'); },
  schreiben: (p) => p.includes('/') && ['allgemein', 'stweg3'].includes(p.split('/')[0]) && !p.includes('/reklamationen/'),
};
const TECHNIK = { lesen: () => true, schreiben: () => true };

test('Verzeichnis: Dateien mit Aenderungszeit, Punkt-Ordner und Repo-Reste nie', async () => {
  const root = await ablage(DATEIEN, ['stweg3/01-stammdaten']);
  const v = await u.verzeichnisLesen(fs, root);
  const pfade = v.dateien.map(d => d.pfad);
  assert.ok(pfade.includes('stweg3/06-protokolle/2026-05-12-protokoll-versammlung.pdf'));
  assert.ok(!pfade.some(p => p.includes('.papierkorb')));
  assert.ok(!pfade.includes('README.md'));
  assert.ok(v.ordner.has('stweg3/01-stammdaten'));
  assert.ok(v.dateien.every(d => d.geaendert > 0 && d.groesse >= 0));
});

test('Ordner einzeln: Mieter sieht in STWEG 3 nur bewohner/, Wurzel mit Datum und Typ', async () => {
  const v = await u.verzeichnisLesen(fs, await ablage(DATEIEN));
  const wurzel = u.ordnerInhalt(v, '', MIETER3);
  assert.deepEqual(wurzel.ordner.map(o => o.name), ['allgemein', 'stweg3']);
  assert.deepEqual(wurzel.dateien.map(d => d.name), ['reglement.pdf']);
  assert.equal(wurzel.dateien[0].typ, 'pdf');
  assert.match(wurzel.dateien[0].geaendert, /^2026-11-01T\d\d:/);
  assert.match(wurzel.dateien[0].etag, /^".+-.+"$/);
  const s3 = u.ordnerInhalt(v, 'stweg3', MIETER3);
  assert.deepEqual(s3.ordner.map(o => o.name), ['bewohner']);
  assert.equal(s3.dateien.length, 0);
  assert.equal(s3.darf.schreiben, false);
  // Anzahl und neueste Aenderung je Ordner
  assert.equal(s3.ordner[0].anzahl, 1);
});

test('Ausblenden (E12): Druckertreiber, .DS_Store, desktop.ini; Technik mit alles=1', async () => {
  const v = await u.verzeichnisLesen(fs, await ablage(DATEIEN));
  const a = u.ordnerInhalt(v, 'allgemein', TECHNIK);
  assert.deepEqual(a.ordner.map(o => o.name), []);
  assert.deepEqual(a.dateien.map(d => d.name), ['hausordnung.pdf']);
  assert.equal(a.ausgeblendet, 2); // drivers-Ordner, desktop.ini (.DS_Store ist ein Punkt-Name)
  const alles = u.ordnerInhalt(v, 'allgemein', TECHNIK, { alles: true });
  assert.deepEqual(alles.ordner.map(o => o.name), ['drivers']);
  assert.ok(alles.dateien.some(d => d.name === 'desktop.ini'));
  assert.equal(u.ausgeblendet('allgemein/drivers/x.inf'), true);
  assert.equal(u.ausgeblendet('allgemein/driversammlung.pdf'), false);
  assert.equal(u.ausgeblendet('stweg3/Desktop.ini'), true);
});

test('Schreiben je Ordner (L3) und leere Ordner nur mit Leserecht', async () => {
  const v = await u.verzeichnisLesen(fs, await ablage(DATEIEN, ['stweg3/01-stammdaten', 'stweg5/leer']));
  const s3 = u.ordnerInhalt(v, 'stweg3', AUSSCHUSS3);
  assert.equal(s3.darf.schreiben, true);
  assert.deepEqual(s3.ordner.map(o => o.name), ['01-stammdaten', '05-abrechnungen', '06-protokolle', 'bewohner']);
  assert.ok(s3.ordner.every(o => o.schreiben));
  assert.equal(u.ordnerInhalt(v, '', AUSSCHUSS3).darf.schreiben, false);
  // Mieter: leerer Eigentuemer-Ordner bleibt unsichtbar
  assert.deepEqual(u.ordnerInhalt(v, 'stweg3', MIETER3).ordner.map(o => o.name), ['bewohner']);
});

test('Suche nach Name und Pfad (E11): Umlaute egal, nur Lesbares, Name zuerst', async () => {
  const v = await u.verzeichnisLesen(fs, await ablage({ ...DATEIEN, 'stweg3/bewohner/Gebühren Übersicht.pdf': 'g' }));
  const r = u.suchen(v, 'protokoll', AUSSCHUSS3);
  assert.deepEqual(r.treffer.filter(t => t.art === 'datei').map(t => t.pfad), ['stweg3/06-protokolle/2026-05-12-protokoll-versammlung.pdf']);
  assert.ok(r.treffer.some(t => t.art === 'ordner' && t.pfad === 'stweg3/06-protokolle'));
  assert.equal(u.suchen(v, 'protokoll', MIETER3).treffer.length, 0); // Mieter: keine Protokolle
  assert.equal(u.suchen(v, 'gebuehren', MIETER3).treffer[0].name, 'Gebühren Übersicht.pdf');
  assert.equal(u.suchen(v, 'GEBÜHREN übersicht', MIETER3).treffer.length, 1);
  assert.equal(u.suchen(v, 'treiber', TECHNIK).treffer.length, 0);
  assert.equal(u.suchen(v, 'treiber', TECHNIK, { alles: true }).treffer.length, 1);
  assert.equal(u.suchen(v, 'a', TECHNIK).treffer.length, 0); // zu kurz
});

test('Neu seit (L1, L11): nach mtime, gewaehlte Ordner, Rechte', async () => {
  const v = await u.verzeichnisLesen(fs, await ablage(DATEIEN));
  const alle = v.dateien.map(d => d.geaendert).sort((a, b) => a - b);
  const mitte = alle[Math.floor(alle.length / 2)];
  const r = u.neuSeit(v, mitte, AUSSCHUSS3);
  assert.ok(r.dateien.every(d => Date.parse(d.geaendert) > mitte));
  assert.ok(r.dateien.every(d => AUSSCHUSS3.lesen(d.pfad)));
  const nurProt = u.neuSeit(v, 0, AUSSCHUSS3, { ordner: ['stweg3/06-protokolle'] });
  assert.deepEqual(nurProt.dateien.map(d => d.name), ['2026-05-12-protokoll-versammlung.pdf']);
  // neueste zuerst
  const z = u.neuSeit(v, 0, TECHNIK).dateien.map(d => d.geaendert);
  assert.deepEqual(z, [...z].sort().reverse());
  assert.equal(u.seitLesen('2026-11-01T00:00:00Z'), Date.parse('2026-11-01T00:00:00Z'));
  assert.equal(u.seitLesen('1700000000000'), 1700000000000);
  assert.equal(u.seitLesen('quatsch'), null);
});

test('Zwischenspeicher: teilt Laeufe, leeren liest neu', async () => {
  const root = await ablage({ 'allgemein/a.pdf': 'a' });
  let laeufe = 0;
  const zaehlFs = { ...fs, readdir: (...a) => { if (a[0] === root) laeufe++; return fs.readdir(...a); }, stat: fs.stat };
  const sp = u.verzeichnisSpeicher(zaehlFs, root, { ms: 60000 });
  await Promise.all([sp.holen(), sp.holen()]);
  await sp.holen();
  assert.equal(laeufe, 1);
  await fs.writeFile(path.join(root, 'allgemein', 'b.pdf'), 'b');
  sp.leeren();
  assert.equal((await sp.holen()).dateien.length, 2);
  assert.equal(laeufe, 2);
});

test('Dateinamen (E15): Umlaute und Leerzeichen bleiben, Gefaehrliches nicht', () => {
  assert.equal(u.dateinameBereinigen('Protokoll Versammlung März 2026.PDF'), 'Protokoll Versammlung März 2026.pdf');
  assert.equal(u.dateinameBereinigen('a/b\\c:d*e?f"g<h>i|j%k#l.pdf'), 'a-b-c-d-e-f-g-h-i-j-k-l.pdf');
  assert.equal(u.dateinameBereinigen('.papierkorb.pdf'), 'papierkorb.pdf');
  assert.equal(u.dateinameBereinigen('  ..versteckt.txt  '), 'versteckt.txt');
  assert.equal(u.dateinameBereinigen('ende. . '), 'ende');
  assert.equal(u.dateinameBereinigen('zeile\nzwei.pdf'), 'zeile-zwei.pdf');
  assert.equal(u.dateinameBereinigen('...'), null);
  assert.equal(u.dateinameBereinigen('Cafe\u0301.pdf'), 'Café.pdf'); // NFC
  const lang = u.dateinameBereinigen('x'.repeat(300) + '.pdf');
  assert.ok(lang.length <= 180 && lang.endsWith('.pdf'));
  assert.equal(u.ordnernameBereinigen('06 Protokolle / Versammlungen'), '06 Protokolle - Versammlungen');
  assert.equal(u.ordnernameBereinigen('.papierkorb'), 'papierkorb');
});

test('Nummern-Vorlage (E16) und Nextcloud-Sprung (E7)', () => {
  const namen = u.NUMMERN_VORLAGE.map(v => v.name);
  assert.ok(namen.includes('06-protokolle') && namen.includes('99-kontaktdaten') && namen.includes('bewohner'));
  assert.equal(u.nextcloudLink('stweg3/06-protokolle/p.pdf'),
    'https://nextcloud.rosenweg4303.ch/apps/files/files?dir=%2Fstweg3%2F06-protokolle&scrollto=p.pdf');
  assert.equal(u.nextcloudLink('meg', undefined, { ordner: true }), 'https://nextcloud.rosenweg4303.ch/apps/files/files?dir=%2Fmeg');
  assert.equal(u.nextcloudLink('allgemein/x.pdf'), null);
  assert.equal(u.nextcloudLink('projekte/dach/o.pdf'), null);
});

test('Range: ein Bereich, Ende, ungueltig', () => {
  assert.deepEqual(u.bereichLesen('bytes=0-99', 1000), { von: 0, bis: 99 });
  assert.deepEqual(u.bereichLesen('bytes=900-', 1000), { von: 900, bis: 999 });
  assert.deepEqual(u.bereichLesen('bytes=-100', 1000), { von: 900, bis: 999 });
  assert.deepEqual(u.bereichLesen('bytes=500-5000', 1000), { von: 500, bis: 999 });
  assert.equal(u.bereichLesen('bytes=1000-', 1000), 'ungueltig');
  assert.equal(u.bereichLesen('bytes=0-1,5-6', 1000), 'ungueltig');
  assert.equal(u.bereichLesen(undefined, 1000), null);
});

test('Kennungen (L5): anlegen, wiederfinden, beim Verschieben mitziehen', async () => {
  const zeilen = new Map(); // pfad -> id
  const anh = [{ doc_path: 'stweg3/a.pdf' }];
  const pool = {
    async query(sql, p = []) {
      if (/^\s*CREATE/.test(sql)) return { rows: [] };
      if (sql.startsWith('SELECT id, pfad')) return { rows: p[0].filter(x => zeilen.has(x)).map(x => ({ id: zeilen.get(x), pfad: x })) };
      if (sql.startsWith('INSERT INTO dokument_kennungen')) { p[1].forEach((x, i) => { if (!zeilen.has(x)) zeilen.set(x, p[0][i]); }); return { rows: [] }; }
      if (sql.startsWith('SELECT pfad')) { for (const [k, v] of zeilen) if (v === p[0]) return { rows: [{ pfad: k }] }; return { rows: [] }; }
      if (sql.startsWith('DELETE FROM dokument_kennungen')) { if (zeilen.has(p[1])) zeilen.delete(p[0]); return { rows: [] }; }
      if (sql.startsWith('UPDATE dokument_kennungen')) { if (zeilen.has(p[0])) { zeilen.set(p[1], zeilen.get(p[0])); zeilen.delete(p[0]); } return { rows: [] }; }
      if (sql.startsWith('UPDATE project_attachments')) { for (const a of anh) if (a.doc_path === p[0]) a.doc_path = p[1]; return { rows: [] }; }
      throw new Error('unerwartet: ' + sql);
    },
  };
  const m = await u.kennungenFuer(pool, ['stweg3/a.pdf', 'stweg3/b.pdf', 'stweg3/a.pdf']);
  assert.equal(m.size, 2);
  const id = m.get('stweg3/a.pdf');
  assert.match(id, u.KENNUNG_FORM);
  assert.equal((await u.kennungenFuer(pool, ['stweg3/a.pdf'])).get('stweg3/a.pdf'), id); // stabil
  await u.verschoben(pool, 'stweg3/a.pdf', 'stweg3/06-protokolle/a-neu.pdf');
  assert.equal(await u.pfadZuKennung(pool, id), 'stweg3/06-protokolle/a-neu.pdf');
  assert.equal(anh[0].doc_path, 'stweg3/06-protokolle/a-neu.pdf');
  assert.equal(await u.pfadZuKennung(pool, '../etc/passwd'), null);
});

test('Server: neue Routen nur lesend, mit Rechten wie die Liste', () => {
  for (const r of ["app.get('/api/documents-ordner'", "app.get('/api/documents-suche'", "app.get('/api/documents-neu'",
    "app.get('/api/documents-rechte'", "app.get('/api/documents-kennung/:id'", "app.get('/api/documents-fassungen'",
    "app.get('/api/documents-fassungen/:id/datei'"]) {
    const t = route(r);
    assert.match(t, /authMiddleware/, r);
  }
  assert.match(route("app.get('/api/documents-ordner'"), /docDarf\(req\)/);
  assert.match(route("app.get('/api/documents-ordner'"), /darf\.technik && req\.query\.alles === '1'/);
  assert.match(route("app.get('/api/documents-kennung/:id'"), /!darf\.lesen\(pfad\)\) return res\.status\(404\)/);
  assert.match(route("app.get('/api/documents-fassungen/:id/datei'"), /e\.grund !== 'ersetzt' \|\| !darf\.lesen\(e\.pfad\)/);
  // ?path= wird nicht mehr ignoriert (L2), Datum in der Liste (L1)
  const liste = route("app.get('/api/documents', authMiddleware");
  assert.match(liste, /req\.query\.path/);
  assert.match(liste, /geaendert:/);
  assert.match(liste, /isDocPathAllowed\(d\.pfad, groups, ctx\)/);
});

test('Server: Schreib-Routen leeren das Verzeichnis, Verschieben zieht Kennung mit, If-Match', () => {
  for (const r of ["app.put('/api/documents/:path(*)'", "app.delete('/api/documents/:path(*)'", "app.post('/api/documents/move'",
    "app.post('/api/documents/folder'", "app.post('/api/documents-papierkorb/:id/wiederherstellen'", "app.post('/api/scan-upload'"]) {
    assert.match(route(r), /docVerzeichnis\.leeren\(\)/, r);
  }
  assert.match(route("app.post('/api/documents/move'"), /unterlagen\.verschoben\(pool, from, to\)/);
  const put = route("app.put('/api/documents/:path(*)'");
  assert.match(put, /unterlagen\.dateinameBereinigen/);
  assert.match(put, /req\.headers\['if-match'\]/);
  assert.ok(put.indexOf("if-match") < put.indexOf('fs.writeFile(fullPath'));
  assert.match(route("app.post('/api/documents/folder'"), /unterlagen\.ordnernameBereinigen/);
});

test('Server: Vorschau je Fassung (L12), Range beim Herunterladen', () => {
  assert.match(src, /app\.get\('\/api\/documents-preview', authMiddleware/);
  const v = route('async function dokumentVorschau(');
  assert.match(v, /cacheKey = `\$\{filePath\}\|\$\{stVorschau\.size\}\|\$\{Math\.floor\(stVorschau\.mtimeMs\)\}`/);
  assert.match(v, /previewCache\.get\(cacheKey\)/);
  assert.match(v, /previewCache\.set\(cacheKey,/);
  const d = route("app.get('/api/documents/:path(*)'");
  assert.match(d, /unterlagen\.bereichLesen\(req\.headers\.range/);
  assert.match(d, /res\.status\(206\)/);
  assert.match(d, /'ETag'/);
});

test('auth/me: dokumente = write nur, wer irgendwo schreibt (E2, L6)', () => {
  assert.match(route("app.get('/api/auth/me'"), /if \(docSchreibtIrgendwo\(groups, permissions\['projekte'\]\)\) permissions\['dokumente'\] = 'write';/);
  const i = src.indexOf('function docSchreibtIrgendwo');
  const f = new Function('isTechnik', 'isPraesident', 'isVerwaltungForAny',
    src.slice(i, src.indexOf('\n}\n', i) + 2) + '\nreturn docSchreibtIrgendwo;');
  const groups = require('../lib/groups');
  const schreibt = f(groups.isTechnik, groups.isPraesident, groups.isVerwaltungForAny);
  assert.equal(schreibt(['Technik'], undefined), true);
  assert.equal(schreibt(['stweg3-ausschuss'], undefined), true);
  assert.equal(schreibt(['stweg3-verwaltung'], 'read'), false);
  assert.equal(schreibt(['stweg3-verwaltung'], 'write'), true);
  assert.equal(schreibt(['r9-eigentuemer', 'r9-bewohner'], 'write'), false);
  assert.equal(schreibt(['r9-bewohner'], undefined), false);
});

test('KI-Suche: Dokumente nach Name, Hilfe ehrlich (L13)', () => {
  const ki = route("app.post('/api/ki-search'");
  assert.match(ki, /unterlagen\.suchen\(await docVerzeichnis\.holen\(\), q, await docDarf\(req\)/);
  const hilfe = fsSync.readFileSync(path.join(W, 'hilfe.html'), 'utf8');
  assert.ok(!hilfe.includes('findet Dokumente auch nach Inhalt'));
  assert.match(hilfe, /nach Dateiname und Ordner, nicht nach dem Inhalt/);
});

test('Web: STWEG 3 sortiert nach geaendert, Dateinamen wie die API', () => {
  const s3 = fsSync.readFileSync(path.join(W, 'stweg3', 'index.html'), 'utf8');
  assert.ok(!s3.includes('.modified'));
  assert.match(s3, /b\.geaendert/);
  const js = fsSync.readFileSync(path.join(W, 'js', 'documents.js'), 'utf8');
  const i = js.indexOf('sanitizeFileName(name) {');
  const body = js.slice(i, js.indexOf('\n  },', i));
  const san = new Function('name', body.slice(body.indexOf('{') + 1));
  for (const n of ['Protokoll März 2026.PDF', 'a/b:c?.pdf', '..x.txt']) assert.equal(san(n), u.dateinameBereinigen(n), n);
});
