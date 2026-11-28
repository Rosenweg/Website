// node --test api/test/nocfernwartung.test.js — NOC-Sicht auf die Fernwartung (lib/nocfernwartung.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const n = require('../lib/nocfernwartung');

const JETZT = Date.parse('2026-11-27T20:00:00Z');
const sek = Math.floor(JETZT / 1000);
const tel = (x) => ({ ext: '2002', name: 'Rosenweg Smartphone 2', stand: 'bereit', ampel: 'gruen', registriert: true,
  letzter_handshake: sek - 60, sitzung: null, fremd: false, ...x });

test('alles gut: grün, Kontakt „jetzt"', () => {
  const d = n.fernwartungFuerNoc({ eingerichtet: true, zentrale: true, telefone: [tel()] }, JETZT);
  assert.equal(d.zusammenfassung.ampel, 'gruen');
  assert.equal(d.telefone[0].kontakt, 'jetzt');
});

test('rot zuerst, Not-Aus und fremde Rückfrage als Hinweis', () => {
  const d = n.fernwartungFuerNoc({ eingerichtet: true, zentrale: true, telefone: [
    tel({ ext: '2001' }), tel({ ext: '2003', stand: 'aus', ampel: 'rot', fremd: true })] }, JETZT);
  assert.equal(d.telefone[0].ext, '2003');
  assert.deepEqual(d.telefone[0].hinweise, ['Not-Aus', 'fremde adb-Rückfrage']);
  assert.equal(d.zusammenfassung.ampel, 'rot');
});

test('wartet auf Bestätigung: gelb; Sitzung: blau ohne Person', () => {
  const d = n.fernwartungFuerNoc({ eingerichtet: true, zentrale: true, telefone: [
    tel({ ext: '2001', stand: 'wartet', ampel: 'grau' }),
    tel({ ext: '2002', ampel: 'blau', sitzung: { zweck: 'shell', seit: sek - 100, person: 'x' } })] }, JETZT);
  assert.equal(d.telefone[0].ampel, 'gelb');
  assert.equal(d.telefone[1].ampel, 'blau');
  assert.deepEqual(d.telefone[1].hinweise, ['Sitzung (shell)']);
  assert.ok(!JSON.stringify(d).includes('"person"'));
});

test('Zentrale nicht erreichbar: rot; nicht eingerichtet: grau', () => {
  assert.equal(n.fernwartungFuerNoc({ eingerichtet: true, zentrale: false, telefone: [tel()] }, JETZT).zusammenfassung.ampel, 'rot');
  assert.equal(n.fernwartungFuerNoc({ eingerichtet: false, telefone: [] }, JETZT).zusammenfassung.ampel, 'grau');
});

test('öffentlich mit Gerätenamen wie auf /smartphones', () => {
  const d = n.fernwartungOeffentlich(n.fernwartungFuerNoc({ eingerichtet: true, zentrale: true, telefone: [tel()] }, JETZT));
  assert.equal(d.telefone[0].name, 'Rosenweg Smartphone 2');
});
