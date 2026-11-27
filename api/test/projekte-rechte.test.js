// node --test api/test/projekte-rechte.test.js — Befund V1: die Verwaltung liest
// Projekte mit Recht „projekte“, Auslagen eines Projekts nur ihrer STWEG(s).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pr = require('../lib/projekte-rechte');
const { sichtErlaubt } = require('../lib/stweg-sicht');

test('lesen: Eigentümer und T/P wie bisher, Verwaltung nur mit Recht', () => {
  assert.equal(pr.projekteLesen(['stweg5-eigentuemer'], undefined), true);
  assert.equal(pr.projekteLesen(['technik'], undefined), true);
  assert.equal(pr.projekteLesen(['stweg3-verwaltung'], 'read'), true);
  assert.equal(pr.projekteLesen(['stweg3-verwaltung'], 'write'), true);
  assert.equal(pr.projekteLesen(['stweg3-verwaltung'], undefined), false);
  assert.equal(pr.projekteLesen(['Verwaltung'], 'read'), true); // ÜBERGANG
  assert.equal(pr.projekteLesen(['stweg5-bewohner'], 'read'), false); // Recht allein reicht nicht
});

test('kommentieren: nur Eigentümer und T/P, die Verwaltung liest nur', () => {
  assert.equal(pr.projekteKommentieren(['stweg5-eigentuemer']), true);
  assert.equal(pr.projekteKommentieren(['praesident']), true);
  assert.equal(pr.projekteKommentieren(['stweg3-verwaltung']), false);
});

test('Auslagen eines Projekts: Verwaltung STWEG 3 sieht nur STWEG 3', () => {
  assert.equal(pr.projektAuslagenSicht(['stweg5-eigentuemer']), null);
  assert.equal(pr.projektAuslagenSicht(['technik']), null);
  const s = pr.projektAuslagenSicht(['stweg3-verwaltung']);
  assert.equal(sichtErlaubt(s, 3), true);
  assert.equal(sichtErlaubt(s, 5), false);
  assert.equal(sichtErlaubt(s, null), false);
});

test('server.js: Lese-Routen nutzen requireProjekteLesen, Kommentieren bleibt Eigentümer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(src.includes("app.get('/api/projects', authMiddleware, requireProjekteLesen,"));
  assert.ok(src.includes("app.get('/api/projects/:slug', authMiddleware, requireProjekteLesen,"));
  assert.ok(src.includes("app.get('/api/projects/:slug/auslagen', authMiddleware, requireProjekteLesen,"));
  assert.ok(src.includes("app.post('/api/projects/:slug/comments', authMiddleware, requireEigentuemer,"));
});

test('projekte.html: ohne Kommentarrecht kein Kommentarfeld', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'projekte.html'), 'utf8');
  assert.match(html, /p\.darf_kommentieren === false/);
});

// ─── Anlegen und bearbeiten je STWEG (Entscheid Stefan 27.11.2026) ───
test('bearbeiten: Ausschuss und Verwaltung (Recht schreiben) nur eigene STWEG', () => {
  assert.equal(pr.projektBearbeiten(['technik'], undefined, 5), true);
  assert.equal(pr.projektBearbeiten(['praesident'], undefined, null), true);
  assert.equal(pr.projektBearbeiten(['stweg3-ausschuss'], undefined, 3), true);
  assert.equal(pr.projektBearbeiten(['stweg3-ausschuss'], undefined, 5), false);
  assert.equal(pr.projektBearbeiten(['stweg3-ausschuss'], undefined, null), true);    // Kooperation wie bisher
  assert.equal(pr.projektBearbeiten(['stweg3-verwaltung'], 'write', 3), true);
  assert.equal(pr.projektBearbeiten(['stweg3-verwaltung'], 'read', 3), false);
  assert.equal(pr.projektBearbeiten(['stweg3-verwaltung'], 'write', 5), false);
  assert.equal(pr.projektBearbeiten(['stweg3-verwaltung'], 'write', null), false);
  assert.equal(pr.projektBearbeiten(['Verwaltung'], 'write', null), true);           // Übergang = alle
  assert.equal(pr.projektBearbeiten(['stweg5-eigentuemer'], 'write', 5), false);
});

test('Auswahl „Neues Projekt“ und Kürzel', () => {
  assert.deepEqual(pr.projektAnlegenAuswahl(['stweg3-verwaltung'], 'write'), { alle: false, stwegs: [3], ohneStweg: false });
  assert.deepEqual(pr.projektAnlegenAuswahl(['stweg2-ausschuss', 'stweg3-verwaltung'], 'read'), { alle: false, stwegs: [2], ohneStweg: true });
  assert.equal(pr.darfAnlegen(pr.projektAnlegenAuswahl(['stweg5-eigentuemer'], undefined)), false);
  assert.equal(pr.darfAnlegen(pr.projektAnlegenAuswahl(['technik'])), true);
  assert.equal(pr.slugAusTitel('Fassade Süd 2027!'), 'fassade-sued-2027');
  assert.equal(pr.slugAusTitel('***'), 'projekt');
  assert.ok(pr.slugAusTitel('x'.repeat(200)).length <= 60);
});

test('server.js: Bearbeiten-Routen nach STWEG, Anlegen-Route, Spalte stweg, Recht Verwaltung', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(src, /app\.(put|post|delete)\('\/api\/projects\/:slug[^']*', authMiddleware, requireAusschussOrTechnik/);
  assert.equal((src.match(/'\/api\/projects\/:slug[^']*', authMiddleware, requireProjektBearbeiten,/g) || []).length, 12);
  assert.ok(src.includes("app.post('/api/projects', authMiddleware, async"));
  assert.match(src, /ALTER TABLE projects ADD COLUMN IF NOT EXISTS stweg INTEGER;/);
  assert.match(src, /\['projekte', 'write'\]/);
  assert.match(src, /darf_bearbeiten: projekteRechte\.projektBearbeiten\(/);
  // Suche nutzt die echten Spalten
  assert.match(src, /SELECT slug, title AS titel, status FROM projects WHERE de_norm\(title\)/);
});

test('projekte.html: Knopf „Neues Projekt“, Bearbeiten nach Server-Antwort', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'projekte.html'), 'utf8');
  assert.match(html, /id="btn-neues-projekt"/);
  assert.match(html, /canEdit = currentProject\.darf_bearbeiten === true;/);
  assert.doesNotMatch(html, /gl\.endsWith\('-ausschuss'\) \|\| gl === 'präsident'/);
});

// P1: Projekt-Dokumente (projekte/<slug>/…) folgen den Projektrechten.
test('Dokumente: Verwaltung liest und lädt in Projekte ihrer STWEG, Ausschuss nur eigene STWEG/Kooperation', () => {
  const projekte = new Map([['dach-haus9', 3], ['fassade-haus5', 5], ['spielplatz', null]]);
  const r = (g, perm, p) => pr.projektDokRecht(g, perm, p, projekte);
  assert.equal(pr.projektDokRecht(['stweg3-ausschuss'], undefined, 'stweg3/x.pdf', projekte), null);
  // Verwaltung STWEG 3
  assert.deepEqual(r(['stweg3-verwaltung'], 'write', 'projekte/dach-haus9/offerte.pdf'), { lesen: true, schreiben: true });
  assert.deepEqual(r(['stweg3-verwaltung'], 'read', 'projekte/dach-haus9/offerte.pdf'), { lesen: true, schreiben: false });
  assert.deepEqual(r(['stweg3-verwaltung'], 'write', 'projekte/fassade-haus5/offerte.pdf'), { lesen: false, schreiben: false });
  assert.deepEqual(r(['stweg3-verwaltung'], 'write', 'projekte/spielplatz/plan.pdf'), { lesen: true, schreiben: false });
  assert.deepEqual(r(['stweg3-verwaltung'], undefined, 'projekte/dach-haus9/offerte.pdf'), { lesen: false, schreiben: false });
  // Ausschuss STWEG 3
  assert.equal(r(['stweg3-ausschuss'], undefined, 'projekte/dach-haus9/timeline/4/a.pdf').schreiben, true);
  assert.equal(r(['stweg3-ausschuss'], undefined, 'projekte/fassade-haus5/a.pdf').schreiben, false);
  assert.equal(r(['stweg3-ausschuss'], undefined, 'projekte/spielplatz/a.pdf').schreiben, true);
  // Eigentümer lesen wie bisher alle Projekte, schreiben nicht
  assert.deepEqual(r(['stweg5-eigentuemer'], undefined, 'projekte/dach-haus9/a.pdf'), { lesen: true, schreiben: false });
  // Unbekanntes Projekt / Datei direkt unter projekte/: nur Technik/Präsident schreiben
  assert.equal(r(['stweg3-ausschuss'], undefined, 'projekte/gibt-es-nicht/a.pdf').schreiben, false);
  assert.equal(r(['stweg3-ausschuss'], undefined, 'projekte/liste.pdf').schreiben, false);
  assert.deepEqual(r(['technik'], undefined, 'projekte/liste.pdf'), { lesen: true, schreiben: true });
  // Ohne Projektliste (Fehler beim Laden): nichts schreiben
  assert.equal(pr.projektDokRecht(['stweg3-ausschuss'], undefined, 'projekte/dach-haus9/a.pdf', undefined).schreiben, false);
});

test('server.js: Dokumenten-API prüft Projekt-Dokumente mit Kontext, Verwaltung kommt durch canManageDocs', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /if \(folder === 'projekte'\) return projekteRechte\.projektDokRecht\(groups, ctx\.projektePerm, filePath, ctx\.projekte\)\.lesen;/);
  assert.match(src, /if \(folder === 'projekte'\) return projekteRechte\.projektDokRecht\(groups, ctx\.projektePerm, filePath, ctx\.projekte\)\.schreiben;/);
  assert.doesNotMatch(src, /folder === 'allgemein' \|\| folder === 'projekte'\) return true/);
  const i = src.indexOf('function canManageDocs(');
  assert.match(src.slice(i, i + 600), /istVerwaltungsGruppenName\(gl\)/);
  // Jeder Aufruf ausser den Definitionen bekommt einen Kontext
  const aufrufe = (src.match(/(isDocPathAllowed|canWriteDocPath)\((?:[^()]|\([^()]*\))*\)/g) || [])
    .filter(a => !a.includes('ctx = {}') && !/^\w+\(filePath, groups\)$/.test(a));
  assert.ok(aufrufe.length >= 8);
  for (const a of aufrufe) assert.match(a, /, (ctx|await docRechteKontext\(req\))\)$/, a);
});
