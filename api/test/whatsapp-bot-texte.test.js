// node --test api/test/whatsapp-bot-texte.test.js — W24: Der Bot verspricht nichts,
// was nicht gebaut ist, verlinkt nur bestehende Seiten, und Meldungen ohne
// verknüpfte Wohnung erreichen die Technik.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const bot = src.slice(src.indexOf('function buildWhatsappMenu('), src.indexOf("app.post('/api/whatsapp/inbound'"));

test('keine Versprechen für Freitext und Belegfotos', () => {
  assert.doesNotMatch(bot, /in eigenen Worten beschreiben/);
  assert.doesNotMatch(bot, /Beleg als Foto/);
  assert.doesNotMatch(bot, /schick ein Foto vom Schaden/);
});

test('verlinkte Seiten gibt es', () => {
  const seiten = [...bot.matchAll(/\$\{SITE_URL\}\/([a-z0-9-]+\.html)/g)].map(m => m[1]);
  assert.ok(seiten.length > 3);
  for (const s of new Set(seiten)) assert.ok(fs.existsSync(path.join(root, s)), s);
  assert.ok(fs.existsSync(path.join(root, 'pwa', 'reparatur')));
});

test('Reklamation ohne STWEG geht an die Technik', () => {
  assert.match(bot, /notifyTechnik\(`🔧 \*Neue Reklamation per WhatsApp\*/);
  assert.match(bot, /ohne STWEG \(keine Wohnung verknüpft\)/);
});
