// node --test api/test/proxmox-energie-zugang.test.js — W20: Proxmox-Seite lässt
// den Präsidenten hinein (wie die API); Energie-Konfiguration prüft genaue Gruppen.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const lies = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');

test('Proxmox: Technik und Präsident', () => {
  const html = lies('proxmox-verwaltung.html');
  assert.match(html, /\['technik', 'präsident', 'praesident'\]\.includes/);
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /app\.get\('\/api\/proxmox\/resources', authMiddleware, adminOnly/);
});

test('Energie-Konfiguration: kein Teilstring „technik“', () => {
  const html = lies('energie-config.html');
  assert.doesNotMatch(html, /includes\('technik'\)/);
  assert.match(html, /hasPermission\('energie-config', 'read'\)/);
});
