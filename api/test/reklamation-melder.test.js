// node --test api/test/reklamation-melder.test.js — Statusmeldung an die meldende
// Person: die Notiz (intern) darf nie mitgehen (Befund B14).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const rm = require('../lib/reklamation-melder');

const rekl = { id: 42, beschreibung: 'Licht im Treppenhaus defekt' };

test('melderBemerkung liest nur melder_bemerkung, nie notiz', () => {
  assert.equal(rm.melderBemerkung({ notiz: 'intern: Handwerker ist teuer' }), '');
  assert.equal(rm.melderBemerkung({ notiz: 'intern', melder_bemerkung: '' }), '');
  assert.equal(rm.melderBemerkung({ notiz: 'intern', melder_bemerkung: '  Lampe ersetzt.  ' }), 'Lampe ersetzt.');
  assert.equal(rm.melderBemerkung({ melder_bemerkung: 123 }), '');
  assert.equal(rm.melderBemerkung(null), '');
  assert.equal(rm.melderBemerkung({ melder_bemerkung: 'x'.repeat(900) }).length, rm.MAX_BEMERKUNG);
});

test('Nachricht ohne Bemerkung enthaelt keine Bemerkungszeile', () => {
  const felder = { status: 'erledigt', notiz: 'GEHEIM-INTERN' };
  const n = rm.nachricht({ rekl, name: 'Erika Beispiel', status: 'erledigt', bemerkung: rm.melderBemerkung(felder), siteUrl: 'https://example.org' });
  for (const t of [n.subject, n.text, n.whatsapp]) {
    assert.ok(!t.includes('GEHEIM-INTERN'), t);
    assert.ok(!t.includes('Bemerkung'), t);
  }
  assert.equal(n.subject, 'Deine Reklamation #42 wurde als erledigt markiert');
});

test('Nachricht mit ausdruecklicher Bemerkung', () => {
  const felder = { status: 'abgewiesen', notiz: 'GEHEIM-INTERN', melder_bemerkung: 'Bitte an die Verwaltung wenden.' };
  const n = rm.nachricht({ rekl, name: 'Erika Beispiel', status: 'abgewiesen', bemerkung: rm.melderBemerkung(felder), siteUrl: 'https://example.org' });
  assert.match(n.text, /Bemerkung: Bitte an die Verwaltung wenden\./);
  assert.match(n.whatsapp, /_Bemerkung:_ Bitte an die Verwaltung wenden\./);
  assert.ok(!n.text.includes('GEHEIM-INTERN'));
  assert.ok(!n.whatsapp.includes('GEHEIM-INTERN'));
});

test('E-Mail nur bei Abschluss, Labels mit Umlaut', () => {
  assert.equal(rm.mailBeiStatus('erledigt'), true);
  assert.equal(rm.mailBeiStatus('abgewiesen'), true);
  assert.equal(rm.mailBeiStatus('weitergeleitet'), false);
  assert.equal(rm.mailBeiStatus('offen'), false);
  assert.equal(rm.statusLabel('offen'), 'wieder geöffnet');
});

test('server.js reicht der Statusmeldung nie die Notiz weiter', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const aufrufe = src.match(/notifyMelderStatus\([^)]*\)/g) || [];
  assert.ok(aufrufe.length >= 2, 'Definition und mindestens ein Aufruf erwartet');
  for (const a of aufrufe) assert.ok(!/notiz/.test(a), a);
});

test('F2-7: Verlauf für die meldende Person nur Erfassung, Status und Nachricht an sie', () => {
  for (const e of ['Erstellt (Web-Formular) · 📍 Keller', 'Status: offen → weitergeleitet',
    '💬 Nachricht an meldende Person: "Lampe bestellt"']) assert.equal(rm.melderSiehtEreignis(e), true, e);
  for (const e of ['Zugewiesen an: Technik A', 'Zuweisung entfernt', 'Handwerker zugewiesen: Firma X',
    'Handwerker-Zuweisung entfernt', 'Auto-zugewiesen an Handwerker: Firma X', '📦 Archiviert',
    '↩ Aus Archiv zurückgeholt', 'Notiz geändert: "intern"', '🔧 Sicherung getauscht',
    '🤖 Aus Technik-Chat erkannt (conf 0.9): "…"', 'Muster benachrichtigt', 'Kategorie korrigiert: x',
    '💰 Entschädigungs-Entwurf für A angelegt', '', null]) assert.equal(rm.melderSiehtEreignis(e), false, String(e));
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // beide Wege, auf denen die meldende Person den Verlauf sieht
  assert.equal((src.match(/reklMelder\.melderSiehtEreignis\(e\.event\)/g) || []).length, 2);
});
