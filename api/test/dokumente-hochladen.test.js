// node --test api/test/dokumente-hochladen.test.js — F3-4: Hochladen fragt bei
// gleichem Namen nach; „Ersetzen“ löscht die alte Datei erst nach dem Upload.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const W = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(W, 'api', 'server.js'), 'utf8');
const js = fs.readFileSync(path.join(W, 'js', 'documents.js'), 'utf8');

test('Server: If-None-Match: * -> 412 statt still überschreiben', () => {
  const i = src.indexOf("app.put('/api/documents/:path(*)'");
  const teil = src.slice(i, src.indexOf('\n});', i));
  assert.match(teil, /req\.headers\['if-none-match'\]/);
  assert.match(teil, /res\.status\(412\)/);
  assert.ok(teil.indexOf('status(412)') < teil.indexOf('fs.writeFile(fullPath'));
});

test('Seite: Hochladen fragt nach, Ersetzen löscht erst nach dem Upload', () => {
  assert.match(js, /if \(ohneUeberschreiben\) xhr\.setRequestHeader\('If-None-Match', '\*'\);/);
  const i = js.indexOf('async doReplace()');
  const teil = js.slice(i, js.indexOf('async viewFile(', i));
  const upload = teil.indexOf('_uploadFile(');
  const loeschen = teil.indexOf("method: 'DELETE'");
  assert.ok(upload > 0 && loeschen > upload, 'DELETE erst nach dem Upload');
  const j = js.indexOf('async doUpload()');
  assert.match(js.slice(j, i), /confirm\(`„\$\{safeName\}“ gibt es in diesem Ordner schon/);
});
