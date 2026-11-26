// node --test api/test/geraet-gruppe.test.js — Geraetekennung/Gruppenschluessel (lib/geraet-gruppe.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const gg = require('../lib/geraet-gruppe');

const k = crypto.createHash('sha256').update('rosenweg:1234abcd').digest('hex');

test('Kennung: nur 64 Hex, Grossbuchstaben werden klein', () => {
  assert.equal(gg.kennung(k), k);
  assert.equal(gg.kennung(k.toUpperCase()), k);
  assert.equal(gg.kennung(''), null);
  assert.equal(gg.kennung('abc'), null);
  assert.equal(gg.kennung(k + '0'), null);
  assert.equal(gg.kennung(null), null);
});

test('Gruppe: je Person verschieden, E-Mail ohne Gross/Klein, ohne Kennung null', () => {
  const a = gg.gruppe('Stefan@Example.ch', k);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, gg.gruppe('stefan@example.ch ', k));
  assert.notEqual(a, gg.gruppe('andere@example.ch', k));
  assert.equal(gg.gruppe('stefan@example.ch', ''), null);
  assert.equal(gg.gruppe('stefan@example.ch', null), null);
});

test('Gruppe: gleiche Formel wie pbx/api/app.py _geraet_gruppe', () => {
  // python3 -c 'import hashlib;print(hashlib.sha256(b"a@b.ch|"+K).hexdigest()[:16])'
  const erwartet = crypto.createHash('sha256').update('a@b.ch|' + k).digest('hex').slice(0, 16);
  assert.equal(gg.gruppe('a@b.ch', k), erwartet);
});
