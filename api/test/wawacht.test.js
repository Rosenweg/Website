// node --test api/test/wawacht.test.js — Drossel des WhatsApp-Watchdogs (lib/wawacht.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const { alarmFaellig, ABSTAND_MS } = require('../lib/wawacht');

const MIN = 60 * 1000;
const jetzt = new Date('2026-11-27T12:00:00Z');
const vor = min => new Date(jetzt.getTime() - min * MIN);

test('kein Zustand, zu frisch -> kein Alarm', () => {
  assert.equal(alarmFaellig({ seit: null, letzterVersuch: null, jetzt }), false);
  assert.equal(alarmFaellig({ seit: vor(10), letzterVersuch: null, jetzt }), false);
});

test('nach 15 min der erste Alarm', () => {
  assert.equal(alarmFaellig({ seit: vor(15), letzterVersuch: null, jetzt }), true);
});

test('höchstens einmal je 6 h, auch wenn der letzte Versuch gescheitert ist', () => {
  assert.equal(ABSTAND_MS, 6 * 60 * MIN);
  assert.equal(alarmFaellig({ seit: vor(600), letzterVersuch: vor(1), jetzt }), false);
  assert.equal(alarmFaellig({ seit: vor(600), letzterVersuch: vor(359), jetzt }), false);
  assert.equal(alarmFaellig({ seit: vor(600), letzterVersuch: vor(360), jetzt }), true);
});

test('jede Minute geprüft: in 24 h höchstens 4 Alarme', () => {
  const seit = new Date(jetzt.getTime() - 15 * MIN);
  let letzter = null, n = 0;
  for (let m = 0; m < 24 * 60; m++) {
    const t = new Date(seit.getTime() + 15 * MIN + m * MIN);
    if (alarmFaellig({ seit, letzterVersuch: letzter, jetzt: t })) { n++; letzter = t; }
  }
  assert.equal(n, 4);
});
