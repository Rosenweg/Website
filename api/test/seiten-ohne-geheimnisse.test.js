// node --test api/test/seiten-ohne-geheimnisse.test.js — F5-1, F5-4, F6-3:
// PBX-Admin zeigt SIP-Passwörter nur auf Klick, Seitentexte ohne interne Adressen.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const W = path.join(__dirname, '..', '..');
const lies = (p) => fs.readFileSync(path.join(W, p), 'utf8');

test('PBX-Admin: SIP-Passwort verdeckt, anzeigen/kopieren', () => {
  const h = lies('pbx/web/pbx-admin.html');
  assert.doesNotMatch(h, /<td class="mono">\$\{esc\(x\.secret\)\}<\/td>/);
  assert.match(h, /onclick="pwZeigen\('\$\{esc\(x\.ext\)\}'\)"/);
  assert.match(h, /onclick="pwKopieren\('\$\{esc\(x\.ext\)\}'\)"/);
  assert.match(h, /function pwZeigen\(ext\)/);
});

test('Seitentexte ohne feste interne Server-Adressen (PBX, MQTT)', () => {
  assert.doesNotMatch(lies('pbx/web/pbx-admin.html'), /100\.64\.2\.29/);
  for (const p of ['mqtt.html', 'pwa/mqtt/index.html']) assert.doesNotMatch(lies(p), /mqtt:\/\/100\.64\./, p);
  assert.match(lies('mqtt.html'), /function brokerIntern\(d\)/);
  const src = lies('api/server.js');
  assert.match(src, /topic_filter, broker: MQTT_BROKER_HINT/);
  assert.match(src, /appPasswords: pws, broker: MQTT_BROKER_HINT/);
});
