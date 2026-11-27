// node --test api/test/whatsapp-profilbild.test.js — Befund F6-7: Profilbild im
// WhatsApp-Gateway liess sich bei bestehender Verbindung nicht setzen.
// Ursache: die Karte „Profilbild“ lag im Reiter „Pairing“, und der Reiter wurde
// ausgeblendet, sobald WhatsApp verbunden war – ohne Verbindung lehnt der Server
// das Setzen aber ab (503). Jetzt heisst der Reiter „Verbindung“ und bleibt sichtbar.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BOT = path.join(__dirname, '..', '..', 'whatsapp-bot');
const html = fs.readFileSync(path.join(BOT, 'public', 'index.html'), 'utf8');

test('Profilbild-Karte liegt im Reiter, der bei Verbindung sichtbar bleibt', () => {
  const panel = html.slice(html.indexOf('data-tab="pairing"'), html.indexOf('data-tab="forwards"'));
  assert.match(panel, /id="ppBtn"/);
  assert.match(html, /\{ id:'pairing',\s+label:'Verbindung' \}/);
  // kein Ausblenden des Reiters mehr, wenn verbunden
  assert.doesNotMatch(html, /pairBtn\.classList\.toggle\('hidden'/);
  assert.doesNotMatch(html, /initial==='pairing' && health && health\.wa_ready/);
});

test('Knopf nur bei Verbindung aktiv, sonst Hinweis', () => {
  assert.match(html, /function ppZustand\(verbunden\)/);
  assert.match(html, /ppZustand\(!!h\.wa_ready\)/);
  assert.match(html, /id="ppHinweis"/);
});

test('Server: Profilbild nur bei bereitem Client (unveraendert)', () => {
  const gw = fs.readFileSync(path.join(BOT, 'gateway.js'), 'utf8');
  assert.match(gw, /app\.post\('\/gateway\/ui\/profile-picture', jsonBody, uiAuth, profilePicture\)/);
  assert.match(gw, /if \(!botCore\.isReady\(\)\) return res\.status\(503\)/);
});
