// node --test api/test/projekt-oeffentlich.test.js — öffentliche Projektseite /projekt.html?p=<slug>
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'projekt.html'), 'utf8');

test('Seite liest nur die öffentliche API und zeigt Titel, Status, Zeitachse, Anhänge', () => {
  assert.match(HTML, /\/api\/public\/project\//);
  assert.doesNotMatch(HTML, /\/api\/projects/); // nie die angemeldete API
  for (const f of ['p.title', 'p.status', 'p.timeline', 'p.attachments']) assert.ok(HTML.includes(f), f);
  assert.ok(!HTML.includes("candidates")); // keine Kandidaten/Offerten
});

test('nicht öffentlich (404), kein Link und Netzfehler haben klare Meldungen', () => {
  assert.match(HTML, /r\.status === 404/);
  assert.match(HTML, /nicht öffentlich/);
  assert.match(HTML, /Kein Projekt angegeben/);
  assert.match(HTML, /Keine Verbindung/);
});

test('Inhalte nur als Text (kein innerHTML), Dokumentlinks über die öffentliche Dokument-Route', () => {
  assert.doesNotMatch(HTML, /innerHTML/);
  assert.match(HTML, /\/document\//);
  assert.match(HTML, /noindex/);
});
