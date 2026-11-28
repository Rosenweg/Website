// node --test api/test/karte-protokoll-w26.test.js — W26: Kiosk-PIN, Telefonanlage,
// WhatsApp-Gateway, Hausverwaltungen, STWEG-Module und Salz laufen mit der Karte
// durchs Kartenprotokoll (nur protokollieren, nie sperren).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ka = require('../lib/kartenadmin');

const lies = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');

test('fremdVermerken: nur Karte, nur schreibend, nur bekannte Dienste', () => {
  const eintraege = [];
  ka.einrichten({ protokollieren: (aktion, f) => eintraege.push([aktion, f]), senden: async () => {} });
  const karte = { method: 'POST', user: { email: 'tina@example.ch', name: 'Tina Technik' }, auth: { art: 'karte' }, appKarte: { id: 'ks_1', karte: '4F2A' } };
  assert.equal(ka.fremdVermerken(karte, { dienst: 'pbx', methode: 'PUT', pfad: '/api/pbx/config', status: 200 }), true);
  assert.equal(eintraege.length, 1);
  assert.equal(eintraege[0][0], 'admin-mit-karte');
  assert.match(eintraege[0][1].detail, /^Telefonanlage: geändert · PUT pbx:\/api\/pbx\/config · 200/);
  assert.equal(ka.fremdVermerken(karte, { dienst: 'pbx', methode: 'GET', pfad: '/x' }), false);
  assert.equal(ka.fremdVermerken(karte, { dienst: 'unbekannt', methode: 'POST', pfad: '/x' }), false);
  const konto = { ...karte, auth: { art: 'website' }, appKarte: null };
  assert.equal(ka.fremdVermerken(konto, { dienst: 'whatsapp', methode: 'POST', pfad: '/gateway/ui/send' }), false);
  assert.equal(eintraege.length, 1);
});

test('Texte der Quittung', () => {
  assert.equal(ka.aktionText('PUT', '/api/stations/admin/5/kiosk-pin'), 'Kiosk-PIN einer Station: gesetzt');
  assert.equal(ka.aktionText('POST', '/api/stations/admin/5/kiosk-pin/anzeigen'), 'Kiosk-PIN einer Station: angezeigt');
  assert.equal(ka.aktionText('PUT', '/api/verwaltungen/3'), 'Hausverwaltungen: geändert');
  assert.equal(ka.aktionText('POST', '/api/stweg-modules'), 'STWEG-Module: angelegt bzw. ausgelöst');
  assert.equal(ka.aktionText('PUT', '/api/salz/lager/1'), 'Salz: geändert');
});

test('Routen und Dienste melden', () => {
  const server = lies('api/server.js');
  for (const r of ["post('/api/verwaltungen'", "put('/api/verwaltungen/:id'", "delete('/api/verwaltungen/:id'",
    "post('/api/verwaltungen/:id/kontakte'", "put('/api/verwaltungen/kontakte/:kid'", "delete('/api/verwaltungen/kontakte/:kid'"]) {
    // Die Hausverwaltung pflegt ihren eigenen Eintrag (requireVerwaltungenZugang, Entscheid Stefan 28.11.2026)
    assert.ok(server.includes(`app.${r}, authMiddleware, requireAusschussOrTechnik, kartenAdmin.mitKarteProtokollieren`)
      || server.includes(`app.${r}, authMiddleware, requireVerwaltungenZugang, kartenAdmin.mitKarteProtokollieren`), r);
  }
  assert.ok(server.includes("app.post('/api/stweg-modules', authMiddleware, kartenAdmin.mitKarteProtokollieren"));
  assert.match(server, /app\.post\('\/api\/karten-admin\/vermerk', authMiddleware/);
  assert.match(lies('api/routes/stations.js'), /function nurTechnikOderPraesident\(req, res, next\) \{[\s\S]*?kartenAdmin\.vermerken\(req, res\);/);
  assert.match(lies('api/routes/salz.js'), /const nurVerwalter = \(req, res, next\) => \{[\s\S]*?kartenAdmin\.vermerken\(req, res\);/);
  assert.match(lies('pbx/api/app.py'), /flask_g\.karten_vermerk = True/);
  assert.match(lies('pbx/api/app.py'), /\/api\/karten-admin\/vermerk/);
  assert.match(lies('whatsapp-bot/gateway.js'), /\/api\/karten-admin\/vermerk/);
});
