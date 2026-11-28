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
  assert.equal((src.match(/'\/api\/projects\/:slug[^']*', authMiddleware, requireProjektBearbeiten,/g) || []).length, 13); // + Anhang öffentlich (D1)
  assert.ok(src.includes("app.post('/api/projects', authMiddleware, async"));
  assert.match(src, /ALTER TABLE projects ADD COLUMN IF NOT EXISTS stweg INTEGER;/);
  assert.match(src, /\['projekte', 'write'\]/);
  assert.match(src, /darf_bearbeiten: projekteRechte\.projektBearbeiten\(/);
  // Suche nutzt die echten Spalten
  assert.match(src, /SELECT slug, title AS titel, status, stweg FROM projects WHERE de_norm\(title\)/);
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
  // F5 (28.11.2026): Eigentümer lesen Projekte ihrer STWEG und Kooperation, schreiben nicht
  assert.deepEqual(r(['stweg5-eigentuemer'], undefined, 'projekte/dach-haus9/a.pdf'), { lesen: false, schreiben: false });
  assert.deepEqual(r(['stweg5-eigentuemer'], undefined, 'projekte/fassade-haus5/a.pdf'), { lesen: true, schreiben: false });
  assert.deepEqual(r(['stweg5-eigentuemer'], undefined, 'projekte/spielplatz/a.pdf'), { lesen: true, schreiben: false });
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

// ─── Funde R1, R2, F5, D1–D4 (Entscheid Stefan 28.11.2026) ─────────────
test('R1: Verwaltung liest nur Projekte ihrer STWEG(s) und Kooperations-Projekte', () => {
  assert.equal(pr.projektLesen(['stweg3-verwaltung'], 'read', 3), true);
  assert.equal(pr.projektLesen(['stweg3-verwaltung'], 'read', 5), false);
  assert.equal(pr.projektLesen(['stweg3-verwaltung'], 'read', null), true);
  assert.equal(pr.projektLesen(['stweg3-verwaltung'], undefined, 3), false);
  assert.equal(pr.projektLesen(['Verwaltung'], 'read', 5), true); // ÜBERGANG = alle STWEGs
});

test('R2: Ausschuss ohne Eigentümergruppe liest die Projekte seiner STWEG', () => {
  assert.equal(pr.projekteLesen(['stweg3-ausschuss'], undefined), true);
  assert.equal(pr.projektLesen(['stweg3-ausschuss'], undefined, 3), true);
  assert.equal(pr.projektLesen(['stweg3-ausschuss'], undefined, null), true);
  assert.equal(pr.projektLesen(['stweg3-ausschuss'], undefined, 5), false);
});

test('F5: Eigentümer nur eigene STWEG + Kooperation, Mieter nichts', () => {
  assert.equal(pr.projektLesen(['r9-eigentuemer'], undefined, 3), true);
  assert.equal(pr.projektLesen(['r9-eigentuemer'], undefined, 5), false);
  assert.equal(pr.projektLesen(['meg-eigentuemer'], undefined, null), true);
  assert.equal(pr.projektLesen(['stweg5-bewohner'], 'read', 5), false);
  assert.equal(pr.projekteLesen(['stweg5-bewohner'], undefined), false);
  const liste = [{ slug: 'a', stweg: 3 }, { slug: 'b', stweg: 5 }, { slug: 'c', stweg: null }];
  assert.deepEqual(pr.lesbareProjekte(['r9-eigentuemer'], undefined, liste).map(p => p.slug), ['a', 'c']);
  assert.deepEqual(pr.lesbareProjekte(['stweg5-bewohner'], undefined, liste), []);
  assert.equal(pr.lesbareProjekte(['technik'], undefined, liste).length, 3);
});

test('D3: E-Mail bei Auslagen nur Technik/Präsident und Verwaltung der STWEG', () => {
  assert.equal(pr.auslageEmailSehen(['technik'], 5), true);
  assert.equal(pr.auslageEmailSehen(['Präsident'], 5), true);
  assert.equal(pr.auslageEmailSehen(['stweg3-verwaltung'], 3), true);
  assert.equal(pr.auslageEmailSehen(['stweg3-verwaltung'], 5), false);
  assert.equal(pr.auslageEmailSehen(['r9-eigentuemer'], 3), false);
  assert.equal(pr.auslageEmailSehen(['stweg3-ausschuss'], 3), false);
});

test('D4: Kommentare ohne E-Mail, eigener Kommentar erkennbar', () => {
  const k = { id: 1, user_name: 'Anna', user_email: 'Anna@example.org', text: 'x' };
  const a = pr.kommentarOhneEmail(k, 'anna@example.org');
  assert.equal(a.user_email, undefined);
  assert.equal(a.user_name, 'Anna');
  assert.equal(a.eigener, true);
  assert.equal(pr.kommentarOhneEmail(k, 'b@example.org').eigener, false);
});

test('D1: öffentlich ohne Offerten/Bewertungen, nur markierte Anhänge', () => {
  const k = pr.oeffentlicherKandidat({ id: 1, name: 'Firma', webseite: 'w', status: 's', offerte_betrag: 9, offerte_details: 'd', bewertung: 5, email: 'e', telefon: 't', notizen: 'n', kontakt: 'k' });
  assert.deepEqual(Object.keys(k).sort(), ['id', 'name', 'status', 'webseite']);
  const an = pr.oeffentlicheAnhaenge([{ id: 1, doc_path: 'a', oeffentlich: true }, { id: 2, doc_path: 'b', oeffentlich: false }, { id: 3, doc_path: 'c' }]);
  assert.deepEqual(an.map(a => a.id), [1]);
});

test('server.js: Projekt-Routen nach den neuen Regeln', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(src.includes("app.get('/api/projects/:slug', authMiddleware, requireProjekteLesen, requireProjektLesen,"));
  assert.ok(src.includes("app.get('/api/projects/:slug/auslagen', authMiddleware, requireProjekteLesen, requireProjektLesen,"));
  assert.ok(src.includes("app.post('/api/projects/:slug/comments', authMiddleware, requireEigentuemer, requireProjektLesen,"));
  assert.match(src, /projekteRechte\.lesbareProjekte\(groups, perm, rows\)/);                 // Liste
  assert.match(src, /projekteRechte\.lesbareProjekte\(req\.user\?\.groups \|\| \[\], perm, r\.rows\)/); // projects-mini
  assert.match(src, /comments: comments\.rows\.map\(k => projekteRechte\.kommentarOhneEmail\(/);
  assert.match(src, /projekteRechte\.auslageEmailSehen\(groups, a\.stweg\)/);
  // öffentlich: nur markierte Anhänge, Einschalten mit Bestätigung, Spalte mit Vorgabe false
  assert.match(src, /AND doc_path = \$2 AND oeffentlich = true/);
  assert.match(src, /if \(public_access && req\.body\?\.bestaetigt !== true\)/);
  assert.match(src, /ADD COLUMN IF NOT EXISTS oeffentlich BOOLEAN NOT NULL DEFAULT false/);
  assert.doesNotMatch(src, /SELECT id, name, webseite, offerte_betrag, offerte_details, bewertung, status FROM project_candidates/);
});

test('doodle.js: Projekt-Umfragen und Projektliste nur für Leser des Projekts', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'doodle.js'), 'utf8');
  assert.match(src, /projekteRechte\.lesbareProjekte\(/);
  assert.equal((src.match(/conds\.push\(projektBedingung\(await lesbareProjektSlugs\(/g) || []).length, 2); // /polls und /next
  assert.match(src, /slugs\.includes\(poll\.project_slug\)/);  // Einzelansicht/Abstimmen
  assert.match(src, /Dieses Projekt darfst du nicht lesen/);   // Anlegen
});
