// node --test api/test/assetlinks.test.js — Android App Links der Rosenweg-Apps
// (pwa/.well-known/assetlinks.json auf pwa.rosenweg4303.ch). Melde-Ort-QR-Codes
// (https://pwa.rosenweg4303.ch/reparatur/?ort=…) oeffnen Rosenweg Reparatur,
// wenn sie installiert ist; sonst die PWA.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WURZEL = path.join(__dirname, '..', '..');
const links = JSON.parse(fs.readFileSync(path.join(WURZEL, 'pwa', '.well-known', 'assetlinks.json'), 'utf8'));
const register = JSON.parse(fs.readFileSync(path.join(WURZEL, 'apps-register.json'), 'utf8'));

test('assetlinks.json: nur Apps aus dem Register, Rosenweg-Schluessel', () => {
  const pakete = new Set(Object.values(register.apps).map((a) => a.paket));
  assert.ok(links.length >= 1);
  for (const e of links) {
    assert.deepEqual(e.relation, ['delegate_permission/common.handle_all_urls']);
    assert.equal(e.target.namespace, 'android_app');
    assert.ok(pakete.has(e.target.package_name), e.target.package_name);
    for (const f of e.target.sha256_cert_fingerprints) assert.match(f, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  }
  assert.ok(links.some((e) => e.target.package_name === 'ch.rosenweg4303.reparatur'));
  // Rosenweg ZEV: zev-meine-rechnungen.html (Link aus Rosenweg Energie), gleicher Schluessel
  const zev = links.find((e) => e.target.package_name === 'ch.rosenweg4303.zev');
  const rep = links.find((e) => e.target.package_name === 'ch.rosenweg4303.reparatur');
  assert.ok(zev);
  assert.deepEqual(zev.target.sha256_cert_fingerprints, rep.target.sha256_cert_fingerprints);
});

test('nginx der PWA liefert /.well-known/*.json aus', () => {
  const conf = fs.readFileSync(path.join(WURZEL, 'frontends-lxc', 'nginx', 'pwa.conf'), 'utf8');
  // Sperre fuer Punkt-Pfade nimmt .well-known aus; .json-Location kommt vor der allgemeinen Sperre
  assert.match(conf, /\(\?!well-known\/\)/);
  assert.ok(conf.indexOf('location ~* \\.json$') < conf.indexOf('location ~ /\\.'));
});
