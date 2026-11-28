// node --test api/test/vollmacht-app.test.js — API fuer Rosenweg Vollmachten (App):
// L1 Einzelabfrage, L2 Rechte je Zeile, V1 Art der Bestaetigung, V3 Versammlung
// und Weisung, V4 Vertretungen mit Wertquote, V5/V6 Neuigkeiten, V8
// Bevollmaechtigter ueber Person/Verwaltungsfirma, MCP-Prompt.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const va = require('../lib/vollmacht-app');
const { signierenErlaubt, anmeldung } = require('../lib/stufen');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const route = (kopf) => {
  const i = SRC.indexOf(kopf);
  assert.ok(i > 0, kopf);
  return SRC.slice(i, SRC.indexOf('\napp.', i + 10));
};

const eig3 = [{ wohnung_id: 7, stweg: 3, rolle: 'eigentuemer' }];
const geber = (extra = {}) => ({
  id: 1, status: 'entwurf', stweg: 3, wohnung_id: 7, art: 'spezifisch',
  vollmachtgeber_email: 'anna@example.org', created_by_user_email: 'anna@example.org',
  bevollmaechtigter_email: 'bruno@example.org', bevollmaechtigter_name: 'Bruno Muster',
  vollmachtgeber_liste: [{ email: 'anna@example.org', name: 'Anna', signed_at: null }],
  vg_signed: 0, ...extra,
});
const ctxA = (extra = {}) => ({ groups: ['r9-eigentuemer'], email: 'anna@example.org', perm: undefined, kontakte: eig3, personIds: [], ...extra });

// ─── V8 ──────────────────────────────────────────────────────────────────
test('V8: Bevollmächtigter über E-Mail, Person und Verwaltungsfirma', () => {
  const v = geber({ bevollmaechtigter_email: null, bevollmaechtigter_person_id: 42 });
  assert.equal(va.istBevollmaechtigter({ email: 'x@example.org', personIds: [42] }, v), true);
  assert.equal(va.istBevollmaechtigter({ email: 'x@example.org', personIds: [43] }, v), false);
  assert.equal(va.istBevollmaechtigter({ email: 'BRUNO@example.org' }, geber()), true);
  // Verwaltungsfirma -> Gruppe stwegN-verwaltung
  const f = geber({ bevollmaechtigter_email: null, bevollmaechtigter_verwaltung_id: 5, verwaltung_stweg: 3 });
  assert.equal(va.istBevollmaechtigter({ email: 'v@example.org', groups: ['stweg3-verwaltung'] }, f), true);
  assert.equal(va.istBevollmaechtigter({ email: 'v@example.org', groups: ['stweg5-verwaltung'] }, f), false);
  assert.equal(va.istBevollmaechtigter({ email: 'v@example.org', groups: ['stweg3-ausschuss'] }, f), false);
  assert.equal(va.istBevollmaechtigter({ email: 'v@example.org', groups: ['r9-eigentuemer'] }, f), false);
  // Firma ohne STWEG: die der Vollmacht
  const g = geber({ bevollmaechtigter_email: null, bevollmaechtigter_verwaltung_id: 5, verwaltung_stweg: null });
  assert.equal(va.istBevollmaechtigter({ email: 'v@example.org', groups: ['stweg3-verwaltung'] }, g), true);
  assert.equal(va.istBevollmaechtigter({ email: 'v@example.org', groups: [] }, null), false);
});

test('V8: Liste, Einzelabfrage und PDF erkennen über Person und Verwaltungsfirma', () => {
  const liste = route("async function vmZeilen(");
  assert.match(liste, /v\.bevollmaechtigter_person_id = ANY\(/);
  assert.match(liste, /v\.bevollmaechtigter_verwaltung_id IS NOT NULL/);
  assert.match(route("app.get('/api/vollmachten/:id/pdf'"), /vollmachtApp\.istBevollmaechtigter\(/);
});

// ─── L2 ──────────────────────────────────────────────────────────────────
test('L2: Geber eines Entwurfs: bearbeiten, signieren, hochladen, löschen, kein KI', () => {
  const z = va.zeilenRechte(ctxA(), geber());
  assert.equal(z.ich_geber, true);
  assert.equal(z.ich_bevollmaechtigter, false);
  assert.equal(z.darf_bearbeiten, true);
  assert.equal(z.darf_signieren, true);
  assert.equal(z.darf_hochladen, true);
  assert.equal(z.darf_loeschen, true);
  assert.equal(z.darf_ki, false);
});

test('L2: nach der ersten Unterschrift nicht mehr bearbeiten; wer signiert hat, nicht nochmals', () => {
  const v = geber({
    vg_signed: 1,
    vollmachtgeber_liste: [{ email: 'anna@example.org', signed_at: 'x', signatur_typ: 'digital' }, { email: 'bea@example.org', signed_at: null }],
  });
  const z = va.zeilenRechte(ctxA(), v);
  assert.equal(z.darf_bearbeiten, false);
  assert.equal(z.darf_signieren, false);
  assert.equal(z.darf_hochladen, false);
  assert.equal(z.ich_unterschrieben, true);
  // Papier-Zeile darf ersetzt werden
  const p = geber({ vg_signed: 1, vollmachtgeber_liste: [{ email: 'anna@example.org', signed_at: 'x', signatur_typ: 'papier' }] });
  assert.equal(va.zeilenRechte(ctxA(), p).darf_hochladen, true);
});

test('L2: Mieter und Bevollmächtigte erteilen, signieren und laden nichts', () => {
  const mieter = ctxA({ groups: ['r9-bewohner'], email: 'anna@example.org', kontakte: [{ wohnung_id: 7, stweg: 3, rolle: 'mieter' }] });
  const z = va.zeilenRechte(mieter, geber());
  assert.equal(z.darf_signieren, false);
  assert.equal(z.darf_hochladen, false);
  assert.equal(z.darf_bearbeiten, false);
  const bv = va.zeilenRechte({ groups: [], email: 'bruno@example.org', kontakte: [] }, geber({ status: 'aktiv' }));
  assert.equal(bv.ich_bevollmaechtigter, true);
  assert.equal(bv.darf_signieren, false);
  assert.equal(bv.darf_loeschen, false);
});

test('L2: PAT und MCP signieren nie (R1), KI-Prüfung nur auf Knopfdruck der Verwaltung', () => {
  assert.equal(va.zeilenRechte(ctxA({ pat: true }), geber()).darf_signieren, false);
  assert.equal(va.zeilenRechte(ctxA({ kanal: 'mcp' }), geber()).darf_signieren, false);
  const mitPdf = geber({ status: 'aktiv', papier_pdf_path: 'Vollmachten/x.pdf' });
  const verw = { groups: ['stweg3-verwaltung'], email: 'v@example.org', perm: 'read', kontakte: [] };
  assert.equal(va.zeilenRechte(verw, mitPdf).darf_ki, true);
  assert.equal(va.zeilenRechte({ ...verw, pat: true }, mitPdf).darf_ki, false);
  assert.equal(va.zeilenRechte({ ...verw, perm: undefined }, mitPdf).darf_ki, false);
  assert.equal(va.zeilenRechte({ groups: ['stweg3-ausschuss'], email: 'a@example.org', perm: 'read', kontakte: [] }, mitPdf).darf_ki, false);
  assert.equal(va.zeilenRechte(verw, geber({ status: 'aktiv' })).darf_ki, false); // keine PDF
});

test('L2: Technik/Präsident dürfen löschen und laden hoch; Verwaltung nur eigene Entwürfe', () => {
  const tp = { groups: ['technik'], email: 't@example.org', kontakte: [] };
  const z = va.zeilenRechte(tp, geber({ status: 'aktiv' }));
  assert.equal(z.darf_loeschen, true);
  assert.equal(z.darf_hochladen, true);
  const verw = { groups: ['stweg3-verwaltung'], email: 'v@example.org', perm: 'write', kontakte: [] };
  assert.equal(va.zeilenRechte(verw, geber()).darf_loeschen, false);
  assert.equal(va.zeilenRechte(verw, geber({ created_by_user_email: 'v@example.org' })).darf_loeschen, true);
});

test('L2/L1: Liste und Einzelabfrage nutzen dieselben Zeilen mit Rechten', () => {
  const z = route('async function vmZeilen(');
  // Gueltigkeit als reines Datum (kein Zeitzonen-Versatz im Client)
  assert.match(z, /to_char\(v\.gueltig_ab, 'YYYY-MM-DD'\) AS gueltig_ab_iso/);
  assert.match(z, /to_char\(v\.gueltig_bis, 'YYYY-MM-DD'\) AS gueltig_bis_iso/);
  assert.match(z, /Object\.assign\(row, vollmachtApp\.zeilenRechte\(ctx, row\)\)/);
  assert.match(route("app.get('/api/vollmachten', authMiddleware"), /vmZeilen\(ctx\)/);
  const eins = route("app.get('/api/vollmachten/:id(\\\\d+)'");
  assert.match(eins, /vmZeilen\(ctx, \{ id:/);
  assert.match(eins, /status\(404\)/);
  // Kopf der Liste: was das Konto darf
  const kopf = route('async function vmKopfRechte(');
  for (const f of ['darf_erteilen', 'darf_erfassen_fuer_andere', 'darf_vorlagen', 'darf_versammlung_sehen']) assert.match(kopf, new RegExp(f));
});

test('Routen: feste Pfade vor /:id, Einzelabfrage nur mit Zahl', () => {
  const i = (k) => SRC.indexOf(k);
  assert.ok(i("app.get('/api/vollmachten/neuigkeiten'") < i("app.get('/api/vollmachten/:id(\\\\d+)'"));
  assert.ok(i("app.get('/api/vollmachten/versammlung/:termin_id'") < i("app.get('/api/vollmachten/:id(\\\\d+)'"));
  assert.ok(i("app.get('/api/vollmachten/templates'") < i("app.get('/api/vollmachten/:id(\\\\d+)'"));
});

// ─── V1 ──────────────────────────────────────────────────────────────────
test('V1: Signieren bleibt an der frischen Anmeldung; die Art der Bestätigung steht auf dem PDF', () => {
  const jetzt = Math.floor(Date.now() / 1000);
  // Die Karte frischt die Anmeldung nicht auf (Entscheid #207): nur Konto, frisch
  assert.equal(signierenErlaubt(anmeldung('karte', jetzt)), false);
  assert.equal(signierenErlaubt(anmeldung('app', jetzt - 30)), true);
  const t = va.bestaetigungText({ art: 'app', stufe: 'frisch', auth_time: jetzt });
  assert.match(t, /^Rosenweg-Konto, frisch angemeldet in der App am \d\d\.\d\d\.\d{4} um \d\d:\d\d Uhr$/);
  assert.match(va.bestaetigungText({ art: 'website', auth_time: jetzt }), /im Portal/);
  const sign = route("app.post('/api/vollmachten/:id/sign-digital'");
  assert.match(sign, /vollmachtApp\.bestaetigungText\(req\.auth\)/);
  assert.match(sign, /signed_bestaetigung=\$6/);
  // Der Text auf dem PDF kommt nie vom Client: aus der Anmeldung oder aus der
  // eingeloesten Karten-/QR-Bestaetigung (Server-Zeile, lib/signaturbestaetigung.js)
  assert.doesNotMatch(sign, /bestaetigung = req\.body|bestaetigungText\(req\.body/);
  assert.match(sign, /bestaetigung = b\.text;/);
  assert.match(SRC, /g\.signed_bestaetigung \? `<tr><td class="lbl">Bestätigung/);
});

// ─── V3 ──────────────────────────────────────────────────────────────────
test('V3: Versammlung muss ein Termin „versammlung“ derselben STWEG sein', () => {
  assert.deepEqual(va.terminPruefen({ id: 5, stweg: 3, category: 'versammlung' }, 3), { ok: true });
  assert.deepEqual(va.terminPruefen({ id: 5, stweg: 3, category: 'versammlung' }, '3'), { ok: true });
  assert.ok(va.terminPruefen({ id: 5, stweg: 4, category: 'versammlung' }, 3).fehler);
  assert.ok(va.terminPruefen({ id: 5, stweg: 3, category: 'wartung' }, 3).fehler);
  assert.ok(va.terminPruefen(null, 3).fehler);
  assert.ok(va.terminPruefen({ id: 5, stweg: 3, category: 'versammlung' }, null).fehler);
});

test('V3: Weisung als Freitext, begrenzt', () => {
  assert.deepEqual(va.weisungPruefen('  Ja zu Traktandum 2  '), { wert: 'Ja zu Traktandum 2' });
  assert.deepEqual(va.weisungPruefen(''), { wert: null });
  assert.deepEqual(va.weisungPruefen(undefined), { wert: null });
  assert.ok(va.weisungPruefen('x'.repeat(va.WEISUNG_MAX + 1)).fehler);
});

test('V3: POST und PUT prüfen Versammlung und Weisung; Spalten angelegt', () => {
  assert.match(route("app.post('/api/vollmachten', authMiddleware"), /vmTerminUndWeisung\(b\.termin_id, b\.weisung, stwegEff\)/);
  assert.match(route("app.put('/api/vollmachten/:id'"), /vmTerminUndWeisung\(/);
  assert.match(SRC, /ADD COLUMN IF NOT EXISTS termin_id INTEGER/);
  assert.match(SRC, /ADD COLUMN IF NOT EXISTS weisung TEXT/);
  assert.match(route('async function vmTerminUndWeisung('), /Eine Weisung gibt es nur zusammen mit einer Versammlung/);
  // Formular: Versammlungen der eigenen STWEG, nur für Berechtigte
  const l = route("app.get('/api/vollmachten/lookup/versammlungen'");
  assert.match(l, /category = 'versammlung'/);
  assert.match(l, /status\(403\)/);
  assert.match(l, /vmSichtErlaubt\(vollmachtRechte\.vmSicht\(ctx\.groups, ctx\.perm\), stweg\)/); // Ausschuss/Verwaltung mit Sicht
});

// ─── V4 ──────────────────────────────────────────────────────────────────
test('V4: Wertquote als Anteil, ohne Stimmenzählung', () => {
  assert.equal(va.wertquoteAnteil([{ wertquote_zaehler: 85, wertquote_nenner: 1000 }, { wertquote_zaehler: 15, wertquote_nenner: 1000 }]), 0.1);
  assert.equal(va.wertquoteAnteil([{ wertquote_zaehler: null, wertquote_nenner: null }]), 0);
  assert.equal(va.wertquoteAnteil([]), 0);
});

test('V4: Gilt eine Vollmacht für die Versammlung?', () => {
  const t = { id: 9, stweg: 3, start: '2026-12-10T18:00:00Z' };
  const basis = { status: 'aktiv', stweg: 3, art: 'generell', termin_id: null, gueltig_ab: '2026-01-01', gueltig_bis: null };
  assert.equal(va.gilt(basis, t), true);
  assert.equal(va.gilt({ ...basis, art: 'auskunft' }, t), false);                 // nur Auskunft
  assert.equal(va.gilt({ ...basis, gueltig_bis: '2026-12-01' }, t), false);       // vorher abgelaufen
  assert.equal(va.gilt({ ...basis, gueltig_ab: '2027-01-01' }, t), false);        // noch nicht gültig
  assert.equal(va.gilt({ ...basis, termin_id: 9 }, t), true);
  assert.equal(va.gilt({ ...basis, termin_id: 8 }, t), false);                    // andere Versammlung
  assert.equal(va.gilt({ ...basis, status: 'entwurf' }, t), false);
  assert.equal(va.gilt({ ...basis, stweg: 4 }, t), false);
});

test('V4: Liste „wer vertritt wen“ nur mit Sicht auf die STWEG, ohne Weisung und Stimmenzählung', () => {
  const r = route("app.get('/api/vollmachten/versammlung/:termin_id'");
  assert.match(r, /vmSichtErlaubt\(vollmachtRechte\.vmSicht\(ctx\.groups, ctx\.perm\), t\.stweg\)/);
  assert.match(r, /status\(403\)/);
  assert.match(r, /wertquote_anteil: vollmachtApp\.wertquoteAnteil\(w\)/);
  assert.doesNotMatch(r, /weisung/i);
  assert.doesNotMatch(r, /signed_ip|signed_user_agent|authentik/);
  assert.match(r, /category !== 'versammlung'/);
});

// ─── V5/V6 ───────────────────────────────────────────────────────────────
const JETZT = new Date('2026-12-01T10:00:00Z');
const zeile = (extra) => ({
  id: 1, doc_hash: 'AB12CD34', status: 'aktiv', stweg: 3, art: 'generell', termin_id: null, gueltig_ab: '2026-01-01', gueltig_bis: null,
  vollmachtgeber_name: 'Anna', bevollmaechtigter_name: 'Bruno', created_by_user_email: 'anna@example.org',
  ich_geber: false, ich_bevollmaechtigter: false, vollmachtgeber_liste: [], updated_at: '2026-11-30T10:00:00Z', ...extra,
});
const terminIn = (tage, id = 9) => ({ id, stweg: 3, title: 'Eigentümerversammlung', start_date: new Date(JETZT.getTime() + tage * 86400000) });

test('V6: bitte unterschreiben, aktiv, widerrufen, Ablauf in 30 Tagen', () => {
  const ctx = { groups: [], email: 'bea@example.org' };
  const n = va.neuigkeiten({
    ctx, jetzt: JETZT, termine: [],
    zeilen: [
      zeile({ id: 1, status: 'entwurf', ich_geber: true, vollmachtgeber_liste: [{ email: 'bea@example.org', signed_at: null }] }),
      zeile({ id: 2, status: 'entwurf', ich_geber: true, created_by_user_email: 'bea@example.org', vollmachtgeber_liste: [{ email: 'bea@example.org', signed_at: null }] }),
      zeile({ id: 3, status: 'aktiv', ich_bevollmaechtigter: true }),
      zeile({ id: 4, status: 'widerrufen', ich_bevollmaechtigter: true, widerrufen_von_user_email: 'anna@example.org' }),
      zeile({ id: 5, status: 'widerrufen', ich_geber: true, widerrufen_von_user_email: 'bea@example.org' }),
      zeile({ id: 6, status: 'aktiv', ich_geber: true, gueltig_bis: '2026-12-20' }),
      zeile({ id: 7, status: 'aktiv', ich_geber: true, gueltig_bis: '2027-03-01' }),
    ],
  });
  assert.deepEqual(n.unterschreiben.map(x => x.id), [1]);       // eigener Entwurf: keine Meldung
  assert.deepEqual(n.aktiv.map(x => x.id), [3]);
  assert.deepEqual(n.widerrufen.map(x => x.id), [4]);           // selbst widerrufen: keine Meldung
  assert.deepEqual(n.laeuft_ab.map(x => [x.id, x.tage]), [[6, 19]]);
  assert.deepEqual(n.neu_aktiv, []);
});

test('V6: Verwaltung der STWEG sieht neue aktive Vollmachten, nicht ihre eigenen und keine alten', () => {
  const ctx = { groups: ['stweg3-verwaltung'], email: 'v@example.org', perm: 'read' };
  const n = va.neuigkeiten({
    ctx, jetzt: JETZT, termine: [],
    zeilen: [
      zeile({ id: 1 }),
      zeile({ id: 2, updated_at: '2026-01-02T00:00:00Z' }),
      zeile({ id: 3, ich_bevollmaechtigter: true }),
      zeile({ id: 4, stweg: 5 }),
    ],
  });
  assert.deepEqual(n.neu_aktiv.map(x => x.id), [1]);
  const ohneRecht = va.neuigkeiten({ ctx: { ...ctx, perm: undefined }, jetzt: JETZT, termine: [], zeilen: [zeile({ id: 1 })] });
  assert.deepEqual(ohneRecht.neu_aktiv, []);
});

test('V5: Versammlungen bis 14 Tage, mit/ohne Vollmacht und offenen Unterschriften', () => {
  const ctx = { groups: [], email: 'anna@example.org' };
  const n = va.neuigkeiten({
    ctx, jetzt: JETZT,
    termine: [terminIn(3, 9), terminIn(10, 10), terminIn(20, 11)],
    zeilen: [
      zeile({ id: 1, ich_geber: true, termin_id: 9 }),                           // aktiv für 9
      zeile({ id: 2, ich_geber: true, status: 'entwurf', termin_id: 10, vollmachtgeber_liste: [{ email: 'anna@example.org', signed_at: null }] }),
    ],
  });
  assert.deepEqual(n.versammlungen.map(v => [v.termin_id, v.tage, v.vertreten, v.offen]), [[9, 3, true, []], [10, 10, false, [2]]]);
});

test('V5: allgemeine Vollmacht vertritt an jeder Versammlung, Auskunft nicht', () => {
  const ctx = { groups: [], email: 'anna@example.org' };
  const mit = va.neuigkeiten({ ctx, jetzt: JETZT, termine: [terminIn(3)], zeilen: [zeile({ ich_geber: true })] });
  assert.equal(mit.versammlungen[0].vertreten, true);
  const auskunft = va.neuigkeiten({ ctx, jetzt: JETZT, termine: [terminIn(3)], zeilen: [zeile({ ich_geber: true, art: 'auskunft' })] });
  assert.equal(auskunft.versammlungen[0].vertreten, false);
});

test('V5/V6: Neuigkeiten-Route: keine Mail, Versammlungen nur der eigenen STWEGs', () => {
  const r = route("app.get('/api/vollmachten/neuigkeiten'");
  assert.match(r, /category = 'versammlung'/);
  assert.match(r, /stweg = ANY\(\$1::int\[\]\)/);
  assert.doesNotMatch(r, /mailSenden|loggedSendMail/);
  assert.equal(va.ERINNERUNG_TAGE, 14);
  assert.equal(va.ABLAUF_TAGE, 30);
});

// ─── MCP-Prompt ──────────────────────────────────────────────────────────
test('MCP: vollmacht_versammlung verweist auf kein fehlendes Werkzeug', () => {
  // als Text gelesen: erweiterungen.js braucht zod (nicht in jeder Umgebung installiert)
  const q = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'erweiterungen.js'), 'utf8');
  const i = q.indexOf("name: 'vollmacht_versammlung'");
  assert.ok(i > 0);
  const text = q.slice(i, q.indexOf('\n  },', i));
  assert.doesNotMatch(text, /vollmacht_erstellen|termine_liste/);
  assert.match(text, /kann keine Vollmachten anlegen und nicht signieren/);
  assert.match(text, /Rosenweg Vollmachten/);
  assert.match(text, /Weisung/);
});
