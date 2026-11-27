// node --test api/test/kontaktformular.test.js — W1: Kontaktformular der
// Startseite schickt eine Mail an technik@ (vorher ohne Ziel und Handler).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const kf = require('../lib/kontaktformular');

const GUT = { name: 'Max Muster', email: 'max@example.org', betreff: 'Frage', nachricht: 'Wann ist die nächste Versammlung?' };

test('Prüfung: Pflichtfelder, gültige Adresse, Honigtopf', () => {
  assert.deepEqual(kf.pruefen(GUT), { name: 'Max Muster', email: 'max@example.org', betreff: 'Frage', nachricht: GUT.nachricht });
  assert.ok(kf.pruefen({ ...GUT, name: '' }).fehler);
  assert.ok(kf.pruefen({ ...GUT, email: 'kein-mail' }).fehler);
  assert.ok(kf.pruefen({ ...GUT, email: 'a@b.ch, c@d.ch' }).fehler);
  assert.ok(kf.pruefen({ ...GUT, nachricht: 'hi' }).fehler);
  assert.deepEqual(kf.pruefen({ ...GUT, website: 'http://spam.example' }), { spam: true });
});

test('Kopfzeilen ohne Zeilenumbruch, Längen begrenzt', () => {
  const k = kf.pruefen({ ...GUT, betreff: 'a\r\nBcc: x@example.org', name: 'X\nY', nachricht: 'z'.repeat(9000) });
  assert.doesNotMatch(k.betreff, /[\r\n]/);
  assert.doesNotMatch(k.name, /[\r\n]/);
  assert.equal(k.nachricht.length, 5000);
});

test('Mail an technik@, Absender nur als Reply-To', () => {
  const m = kf.mail(kf.pruefen(GUT), 'noreply@rosenweg4303.ch');
  assert.equal(m.to, 'technik@rosenweg4303.ch');
  assert.equal(m.from, 'noreply@rosenweg4303.ch');
  assert.equal(m.replyTo, 'max@example.org');
  assert.match(m.subject, /^\[Kontaktformular\] Frage$/);
});

test('Route mit Drossel, Startseite mit Formular-Handler', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = src.indexOf("app.post('/api/kontakt'");
  const teil = src.slice(i, src.indexOf('\n});', i));
  assert.match(teil, /otpIpErlaubt\(req\)/);
  assert.match(teil, /otpGlobalErlaubt\('kontakt'\)/);
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
  assert.match(html, /<form id="kontakt-form"/);
  assert.match(html, /fetch\('\/api\/kontakt'/);
  assert.match(html, /id="kontakt-website" tabindex="-1"/);
});
