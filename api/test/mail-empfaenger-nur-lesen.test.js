// node --test api/test/mail-empfaenger-nur-lesen.test.js — W7: Schreiben braucht
// mail-empfänger = write; die Seite zeigt mit Leserecht keine Schreib-Knöpfe.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'mail-empfaenger-admin.html'), 'utf8');

test('API: POST/PUT/DELETE verlangen write', () => {
  for (const m of ['post', 'put', 'delete']) {
    assert.match(src, new RegExp(`app\\.${m}\\(encodeURI\\('/api/mail-empfänger[^']*'\\), authMiddleware, requirePermission\\('mail-empfänger', 'write'\\)`));
  }
});

test('Seite: Knöpfe nur mit Schreibrecht', () => {
  assert.match(html, /DARF_SCHREIBEN = AuthentikAuth\.hasPermission\('mail-empfänger', 'write'\)/);
  assert.match(html, /id="btn-new" class="hidden /);
  assert.match(html, /m-felder'\)\.disabled = !DARF_SCHREIBEN/);
  assert.match(html, /m-save'\)\.classList\.toggle\('hidden', !DARF_SCHREIBEN\)/);
  assert.match(html, /m-del'\)\.classList\.toggle\('hidden', !DARF_SCHREIBEN \|\| neu\)/);
  assert.match(html, /m-add-kontakt'\)\.classList\.toggle\('hidden', !DARF_SCHREIBEN\)/);
  assert.match(html, /id="nur-lesen"/);
});
