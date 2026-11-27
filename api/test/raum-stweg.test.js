// node --test api/test/raum-stweg.test.js — Befund V4: Türschilder & Aushänge
// nur fuer Raeume der eigenen STWEG(s), Vorgabe je Typ nur mit Sicht auf alle.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const rs = require('../lib/raum-stweg');

test('Kurzname -> STWEG', () => {
  assert.equal(rs.stwegVonKurz('r9'), 3);
  assert.equal(rs.stwegVonKurz('R13'), 2);
  assert.equal(rs.stwegVonKurz('r1'), 6);
  assert.equal(rs.stwegVonKurz('meg'), 8);
  assert.equal(rs.stwegVonKurz('tg'), 8);
  assert.equal(rs.stwegVonKurz('r3'), null);   // kein Haus 3
  assert.equal(rs.stwegVonKurz('hof'), null);
  assert.equal(rs.stwegVonKurz(''), null);
});

test('Verwaltung STWEG 3 nur Räume in Haus 9, keine fremden, keine ohne STWEG', () => {
  const g = ['stweg3-verwaltung'];
  assert.equal(rs.raumErlaubt(g, { kurz: 'r9' }), true);
  assert.equal(rs.raumErlaubt(g, { kurz: 'r13' }), false);
  assert.equal(rs.raumErlaubt(g, { kurz: 'meg' }), false);
  assert.equal(rs.raumErlaubt(g, { kurz: 'hof' }), false);
  assert.equal(rs.typVorgabeErlaubt(g), false);
});

test('Technik alles; Verwaltung aller STWEGs (Übergang) auch Vorgabe', () => {
  assert.equal(rs.raumErlaubt(['technik'], { kurz: 'r13' }), true);
  assert.equal(rs.typVorgabeErlaubt(['technik']), true);
  assert.equal(rs.raumErlaubt(['Verwaltung'], { kurz: 'meg' }), true);
  assert.equal(rs.typVorgabeErlaubt(['Verwaltung']), true);
});

test('Ausschuss STWEG 2: eigene Häuser und Räume ohne STWEG, nicht Haus 9', () => {
  const g = ['stweg2-ausschuss'];
  assert.equal(rs.raumErlaubt(g, { kurz: 'r14' }), true);
  assert.equal(rs.raumErlaubt(g, { kurz: 'r9' }), false);
  assert.equal(rs.raumErlaubt(g, { kurz: 'hof' }), true);
});

// T1: Kurzname mit Zusatz (zweiter Raum im selben Haus) behält die STWEG des Hauses.
test('Kurzname mit Zusatz -> STWEG des Hauses', () => {
  assert.equal(rs.stwegVonKurz('r9b'), 3);
  assert.equal(rs.stwegVonKurz('r9keller'), 3);
  assert.equal(rs.stwegVonKurz('r13a2'), 2);
  assert.equal(rs.stwegVonKurz('r1b'), 6);
  assert.equal(rs.stwegVonKurz('megb'), 8);
  assert.equal(rs.stwegVonKurz('tg2'), 8);
  assert.equal(rs.stwegVonKurz('r92'), null);   // Haus 92 gibt es nicht, kein „r9“ + „2“
  assert.equal(rs.stwegVonKurz('r3b'), null);   // kein Haus 3
  assert.equal(rs.stwegVonKurz('rb9'), null);
  // Ausschuss/Verwaltung STWEG 3 sehen r9b, andere Ausschüsse nicht mehr
  assert.equal(rs.raumErlaubt(['stweg3-verwaltung'], { kurz: 'r9b' }), true);
  assert.equal(rs.raumErlaubt(['stweg3-ausschuss'], { kurz: 'r9b' }), true);
  assert.equal(rs.raumErlaubt(['stweg2-ausschuss'], { kurz: 'r9b' }), false);
});

test('Nur Seitenrecht ohne Ausschuss/Verwaltung: kein Raum', () => {
  assert.equal(rs.raumErlaubt(['stweg5-bewohner'], { kurz: 'r5' }), false);
});

test('routes/raum-qr.js prüft jeden Raum-Zugriff', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'raum-qr.js'), 'utf8');
  // Liste filtern, anlegen, stilllegen, erneuern, drucken, Texte speichern/entfernen
  assert.equal((src.match(/darf\(req, /g) || []).length, 7);
  assert.match(src, /b\.ebene === 'typ' && !raumStweg\.typVorgabeErlaubt/);
  assert.match(src, /M\.vorgabe\?'<button id="rw-typ"/);
});
