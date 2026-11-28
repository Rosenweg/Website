// node --test api/test/vollmacht-rechte.test.js — Wer darf eine Vollmacht
// widerrufen (Befund B11): Server und Knopf nach derselben Regel.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vr = require('../lib/vollmacht-rechte');

const aktiv = {
  status: 'aktiv',
  vollmachtgeber_email: 'geber@example.org',
  vollmachtgeber_liste: [{ email: 'geber@example.org' }, { email: 'Mitgeber@Example.org' }],
};

test('Technik und Präsident dürfen widerrufen', () => {
  assert.equal(vr.darfWiderrufen({ groups: ['technik'], email: 'x@example.org' }, aktiv), true);
  assert.equal(vr.darfWiderrufen({ groups: ['Präsident'], email: 'x@example.org' }, aktiv), true);
});

test('Ausschuss und Verwaltung ohne eigene Vollmacht dürfen nicht', () => {
  assert.equal(vr.darfWiderrufen({ groups: ['stweg3-ausschuss'], email: 'a@example.org' }, aktiv), false);
  assert.equal(vr.darfWiderrufen({ groups: ['Verwaltung'], email: 'v@example.org' }, aktiv), false);
  assert.equal(vr.darfWiderrufenRecht(['stweg3-ausschuss', 'Verwaltung'], false), false);
});

test('Vollmachtgeber (Primär-Adresse oder Liste) dürfen, Gross/Klein egal', () => {
  assert.equal(vr.darfWiderrufen({ groups: [], email: 'GEBER@example.org' }, aktiv), true);
  assert.equal(vr.darfWiderrufen({ groups: [], email: 'mitgeber@example.org' }, aktiv), true);
  assert.equal(vr.darfWiderrufen({ groups: [], email: 'bevollmaechtigt@example.org' }, aktiv), false);
  assert.equal(vr.istVollmachtgeber('', 'geber@example.org', []), false);
});

test('Knopf nur bei aktiven Vollmachten', () => {
  for (const status of ['entwurf', 'widerrufen', 'abgelaufen']) {
    assert.equal(vr.darfWiderrufen({ groups: ['technik'], email: 'geber@example.org' }, { ...aktiv, status }), false, status);
  }
  assert.equal(vr.darfWiderrufen({ groups: ['technik'] }, null), false);
});

test('Server und Seite nutzen die gemeinsame Regel', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /vollmachtRechte\.darfWiderrufenRecht\(groups, isGeber\)/);
  assert.match(server, /row\.darf_widerrufen = vollmachtRechte\.darfWiderrufen\(/);
  const seite = fs.readFileSync(path.join(__dirname, '..', '..', 'vollmachten.html'), 'utf8');
  assert.match(seite, /const canRevoke = v\.darf_widerrufen === true;/);
});

test('F2-6: Typ „Person“ mit getipptem Namen wird extern, nie ein ungültiger Typ', () => {
  assert.equal(vr.bvTyp('person'), 'extern');
  assert.equal(vr.bvTyp('Eigentuemer'), 'eigentuemer');
  assert.equal(vr.bvTyp('mieter'), 'mieter');
  assert.equal(vr.bvTyp('verwaltung'), 'verwaltung');
  assert.equal(vr.bvTyp(''), null);
  assert.equal(vr.bvTyp('irgendwas'), null);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.equal((server.match(/vollmachtRechte\.bvTyp\(b\.bevollmaechtigter_typ\)/g) || []).length, 2); // POST und PUT
  const seite = fs.readFileSync(path.join(__dirname, '..', '..', 'vollmachten.html'), 'utf8');
  assert.match(seite, /bevollmaechtigter_typ: bvTypFuerServer\(/);
  assert.match(seite, /if \(uiTyp === 'person'\) return 'extern';/);
});

// ─── Funde D1–D4, R1, R2 (Entscheid Stefan 28.11.2026) ──────────────────
const { signierenErlaubt, anmeldung } = require('../lib/stufen');

test('D1: nur Eigentümer/Wohnungs-Verwalter erteilen, ohne Objekt abgelehnt', () => {
  const eig = [{ wohnung_id: 7, stweg: 3, rolle: 'eigentuemer' }];
  const verw = [{ wohnung_id: 8, stweg: 3, rolle: 'verwalter' }];
  const mieter = [{ wohnung_id: 9, stweg: 3, rolle: 'mieter' }];
  assert.deepEqual(vr.vmGeberErlaubt({ wohnungId: 7 }, eig, []), { ok: true, stweg: 3 });
  assert.equal(vr.vmGeberErlaubt({ wohnungId: '8' }, verw, []).ok, true);
  assert.equal(vr.vmGeberErlaubt({ wohnungId: 9 }, mieter, ['r9-bewohner']).ok, false);
  assert.equal(vr.vmGeberErlaubt({ wohnungId: 7 }, mieter, []).ok, false);        // fremde Wohnung
  assert.equal(vr.vmGeberErlaubt({ stweg: 3 }, eig, []).ok, true);
  assert.equal(vr.vmGeberErlaubt({ stweg: 3 }, mieter, ['r9-bewohner']).ok, false);
  assert.equal(vr.vmGeberErlaubt({ stweg: 3 }, [], ['r9-eigentuemer']).ok, true);   // Eigentümergruppe
  assert.equal(vr.vmGeberErlaubt({ stweg: 5 }, [], ['r9-eigentuemer']).ok, false);
  assert.equal(vr.vmGeberErlaubt({}, eig, ['r9-eigentuemer']).ok, false);          // ohne Objekt
  assert.equal(vr.vmDarfErteilenIrgendwo(mieter, ['r9-bewohner']), false);
  assert.equal(vr.vmDarfErteilenIrgendwo(eig, []), true);
  assert.equal(vr.vmDarfErteilenIrgendwo([], ['meg-eigentuemer']), true);
});

test('D2: IP, User-Agent, Authentik-Kennung nur für Technik/Präsident', () => {
  const v = {
    id: 1, digital_signed_ip: '1.2.3.4', digital_signed_user_agent: 'UA', digital_signed_authentik_sub: 's',
    vollmachtgeber_liste: [{ email: 'a@example.org', signed_at: 'x', signatur_typ: 'digital', signed_ip: '1.2.3.4', signed_user_agent: 'UA', signed_authentik_sub: 's' }],
  };
  const o = vr.vmOhneNachweis(v, ['r9-eigentuemer', 'stweg3-ausschuss', 'stweg3-verwaltung']);
  assert.equal(o.digital_signed_ip, undefined);
  assert.equal(o.vollmachtgeber_liste[0].signed_ip, undefined);
  assert.equal(o.vollmachtgeber_liste[0].signed_user_agent, undefined);
  assert.equal(o.vollmachtgeber_liste[0].signed_authentik_sub, undefined);
  assert.equal(o.vollmachtgeber_liste[0].signed_at, 'x');
  assert.equal(v.vollmachtgeber_liste[0].signed_ip, '1.2.3.4');                    // Original unverändert
  assert.equal(vr.vmOhneNachweis(v, ['technik']).vollmachtgeber_liste[0].signed_ip, '1.2.3.4');
  assert.equal(vr.vmOhneNachweis(v, ['Präsident']).digital_signed_ip, '1.2.3.4');
});

test('D3: KI-Prüfung nur Verwaltung der STWEG (mit Recht) und Technik/Präsident', () => {
  assert.equal(vr.vmDarfKiPruefen(['technik'], undefined, 3), true);
  assert.equal(vr.vmDarfKiPruefen(['stweg3-verwaltung'], 'read', 3), true);
  assert.equal(vr.vmDarfKiPruefen(['stweg3-verwaltung'], undefined, 3), false);
  assert.equal(vr.vmDarfKiPruefen(['stweg3-verwaltung'], 'read', 5), false);
  assert.equal(vr.vmDarfKiPruefen(['stweg3-ausschuss'], 'read', 3), false);
  assert.equal(vr.vmDarfKiPruefen(['r9-eigentuemer'], 'read', 3), false);
});

test('D4: Personensuche nur in STWEGs mit Eigentümer-Sicht, Mieter nichts', () => {
  assert.deepEqual([...vr.vmSucheStwegs(['r9-bewohner'], undefined)], []);
  assert.deepEqual([...vr.vmSucheStwegs(['r9-eigentuemer'], undefined)], [3]);
  assert.deepEqual([...vr.vmSucheStwegs(['stweg5-ausschuss'], undefined)], [5]);
  assert.deepEqual([...vr.vmSucheStwegs(['stweg2-verwaltung'], 'read')], [2]);
  assert.deepEqual([...vr.vmSucheStwegs(['stweg2-verwaltung'], undefined)], []);
});

test('R1: Signieren nur frisch über Website/App, nie per PAT/MCP/Karte', () => {
  const jetzt = Math.floor(Date.now() / 1000);
  assert.equal(signierenErlaubt(anmeldung('website', jetzt - 60)), true);
  assert.equal(signierenErlaubt(anmeldung('app', jetzt - 60)), true);
  assert.equal(signierenErlaubt(anmeldung('website', jetzt - 3600)), false);       // nicht frisch
  assert.equal(signierenErlaubt(anmeldung('pat')), false);
  assert.equal(signierenErlaubt(anmeldung('website', jetzt - 60), { pat: true }), false);
  assert.equal(signierenErlaubt(anmeldung('website', jetzt - 60), { kanal: 'mcp' }), false);
  assert.equal(signierenErlaubt(anmeldung('karte')), false);
  assert.equal(signierenErlaubt(anmeldung('otp')), false);
});

test('R2: Vorlagen pro STWEG, global nur Technik/Präsident', () => {
  assert.equal(vr.vmVorlageBearbeiten(['technik'], null), true);
  assert.equal(vr.vmVorlageBearbeiten(['stweg3-ausschuss'], null), false);
  assert.equal(vr.vmVorlageBearbeiten(['stweg3-ausschuss'], 3), true);
  assert.equal(vr.vmVorlageBearbeiten(['stweg3-ausschuss'], 5), false);
  assert.equal(vr.vmVorlageSichtbar(['r9-eigentuemer'], null), true);
  assert.equal(vr.vmVorlageSichtbar(['r9-eigentuemer'], 3), true);
  assert.equal(vr.vmVorlageSichtbar(['r9-eigentuemer'], 5), false);
  assert.equal(vr.vmVorlagenAnlegenStwegs(['technik']), null);
  assert.deepEqual(vr.vmVorlagenAnlegenStwegs(['stweg3-ausschuss', 'r9-eigentuemer']), [3]);
});

test('server.js, MCP und Seite: Regeln eingebaut', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = server.indexOf("app.post('/api/vollmachten/:id/sign-digital'");
  assert.match(server.slice(i, i + 500), /signierenErlaubt\(req\.auth, \{ pat: !!req\.pat/);
  assert.match(server, /vollmachten: rows\.map\(row => vmAusgabe\(row, ctx\)\)/);
  assert.match(server, /function vmAusgabe\(row, ctx\) \{\n  return vollmachtRechte\.vmOhneNachweis\(row, ctx\.groups\);/);
  assert.match(server, /req\.body\?\.bestaetigt_extern !== true/);
  assert.match(server, /vollmachtRechte\.vmDarfKiPruefen\(groups, await vmPerm\(req\), v\.stweg\)/);
  assert.match(server, /vollmachtRechte\.vmSucheStwegs\(groups, perm\)/);
  assert.match(server, /ALTER TABLE vollmachten_templates ADD COLUMN IF NOT EXISTS stweg INTEGER/);
  assert.match(server, /generateVollmachtPdf\(v, \{ nachweis: vollmachtRechte\.vmNachweisSehen\(groups\) \}\)/);
  assert.doesNotMatch(server, /function canEditTemplates/);
  const mcp = fs.readFileSync(path.join(__dirname, '..', '..', 'mcp', 'src', 'index.js'), 'utf8');
  assert.doesNotMatch(mcp, /name: 'vollmachten_sign_digital'/);
  assert.doesNotMatch(mcp, /name: 'vollmachten_verify_ai'/);
  const seite = fs.readFileSync(path.join(__dirname, '..', '..', 'vollmachten.html'), 'utf8');
  assert.doesNotMatch(seite, /Jetzt automatisch von der KI prüfen lassen/);
  assert.match(seite, /bestaetigt_extern: true/);
  assert.match(seite, /externen Dienst geschickt: OpenRouter/);
  assert.match(seite, /v\.darf_ki_pruefen === true/);
  assert.match(seite, /d\.darf_erteilen !== true/);
  const mig = require('../lib/rechte-migrationen');
  const m = (mig.RECHTE_MIGRATIONEN || []).find(x => x.name === '2026-11-28-vollmachten-ausschuss-read');
  assert.ok(m && m.page === 'vollmachten' && m.access === 'read' && m.gruppen.includes('stweg3-ausschuss'));
});
