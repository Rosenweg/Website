// node --test api/test/schluessel-freigaben.test.js — Karte wie Schluessel (28.11.2026):
// C App-QR auch mit Karte/geteiltem Telefon, E Signieren mit Karte oder QR,
// F Profil-Angaben und Profilbild mit der Karte. Passwort, SSH, Tokens bleiben zu.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sl = require('../lib/sperrliste');
const ak = require('../lib/appkarte');
const ka = require('../lib/kartenadmin');
const sb = require('../lib/signaturbestaetigung');

const lies = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');

// ─── F: Sperrliste ──────────────────────────────────────────────────────────
test('F: Karte darf Profil-Angaben und Profilbild, sonst nichts unter auth/', () => {
  assert.equal(sl.karteGesperrt('PUT', 'auth/profile'), false);
  assert.equal(sl.karteGesperrt('put', 'auth/avatar'), false);
  assert.equal(sl.karteGesperrt('GET', 'auth/me'), false);
  // andere Methode, Unterpfad oder anderer auth-Pfad: weiter gesperrt
  assert.equal(sl.karteGesperrt('POST', 'auth/profile'), true);
  assert.equal(sl.karteGesperrt('DELETE', 'auth/avatar'), true);
  assert.equal(sl.karteGesperrt('PUT', 'auth/profile/x'), true);
  assert.equal(sl.karteGesperrt('GET', 'auth/login'), true);
  assert.equal(sl.karteGesperrt('PUT', 'auth/me'), true);
});

test('F: Passwort, Token, Passkeys, MQTT bleiben fuer Karte und PAT gesperrt', () => {
  for (const p of ['change-password', 'me/tokens', 'me/tokens/5', 'me/passkeys', 'mqtt/my-app-passwords', 'mqtt/user-app-passwords/3']) {
    assert.equal(sl.karteGesperrt('POST', p), true, p);
    assert.equal(sl.karteGesperrt('PUT', p), true, p);
    assert.equal(sl.patGesperrt(p), true, p);
  }
  // PAT: auch Profil und Bild bleiben zu (Ausnahme gilt nur fuer die Karte)
  assert.equal(sl.patGesperrt('auth/profile'), true);
  assert.equal(sl.patGesperrt('auth/avatar'), true);
  assert.equal(sl.patGesperrt('salz/lager'), false);
});

test('F: pfadNormal wie authMiddleware (Gross/klein, Schraegstriche)', () => {
  assert.equal(sl.pfadNormal('/api/Auth//Profile/'), 'auth/profile');
  assert.equal(sl.karteGesperrt('PUT', sl.pfadNormal('/api/AUTH/avatar/')), false);
  assert.equal(sl.karteGesperrt('POST', sl.pfadNormal('/api/Change-Password/')), true);
});

test('F: authMiddleware nutzt die Sperrliste fuer PAT, Anlage und Karte', () => {
  const src = lies('api/middleware/auth.js');
  assert.match(src, /require\('\.\.\/lib\/sperrliste'\)/);
  assert.equal((src.match(/if \(karteGesperrt\(req\.method, vollerPfad\)\)/g) || []).length, 2, 'Anlage-Token und rw_app_');
  assert.equal((src.match(/if \(patGesperrt\(vollerPfad\)\)/g) || []).length, 1);
  assert.doesNotMatch(src, /PAT_GESPERRT\.some/);
  // requireUserLogin (SSH-Schluessel, Token-Verwaltung) sperrt Karte und Anlage weiter
  assert.match(src, /function requireUserLogin[\s\S]*?if \(req\.pat \|\| req\.anlage\)[\s\S]*?if \(req\.appKarte\)/);
});

test('F: SSH-Schluessel und Token bleiben hinter requireUserLogin', () => {
  const ssh = lies('api/routes/ssh-zugang.js');
  assert.match(ssh, /router\.post\('\/me\/schluessel', authMiddleware, kartenAdmin\.bestaetigungVerlangen, requireUserLogin/);
  const server = lies('api/server.js');
  assert.match(server, /app\.post\('\/api\/me\/tokens', authMiddleware, requireUserLogin/);
  assert.match(server, /app\.post\('\/api\/change-password', authMiddleware,/);
});

test('F: Profil und Profilbild protokollieren mit Karten-Vermerk', () => {
  const server = lies('api/server.js');
  assert.match(server, /async function profilKartenProtokoll\(req, aktion, felder\) \{[\s\S]*?kartenAdmin\.herkunftVermerk\(req\)[\s\S]*?bereich: 'profil'/);
  const profil = server.slice(server.indexOf("app.put('/api/auth/profile'"), server.indexOf("// GET /api/me/person-data"));
  assert.match(profil, /await profilKartenProtokoll\(req, 'angaben-geaendert'/);
  const avatar = server.slice(server.indexOf("app.put('/api/auth/avatar'"), server.indexOf('// USERS'));
  assert.match(avatar, /await profilKartenProtokoll\(req, 'profilbild-geaendert'/);
  assert.match(server, /app\.get\('\/api\/admin-protokoll\/:bereich'[\s\S]*?isTechnik\(g\) && !isPraesident\(g\)/);
});

test('herkunftVermerk: nur mit der Karte, mit Karte, Sitzung, Geraet', () => {
  assert.equal(ka.herkunftVermerk({ auth: { art: 'website' }, user: { email: 'a@example.ch' } }), '');
  assert.equal(ka.herkunftVermerk({ auth: { art: 'pat' }, pat: { id: 1 }, user: { email: 'a@example.ch' } }), '');
  const karte = ka.herkunftVermerk({ auth: { art: 'karte' }, user: { email: 'a@example.ch' },
    appKarte: { id: 'ks_abc', karte: '4F2A', app_name: 'Rosenweg Profil', geraet: 'Pixel' }, absenderIp: '198.51.100.7' });
  assert.match(karte, /mit karte · Karte 4F2A · Sitzung ks_abc · App Rosenweg Profil, Gerät Pixel, IP 198\.51\.100\.7/);
  const anlage = ka.herkunftVermerk({ auth: { art: 'anlage' }, user: { email: 'a@example.ch' }, anlage: { ext: '2098', paket: 'ch.rosenweg4303.profil' } });
  assert.match(anlage, /Sitzung anlage:2098 .*Gerät geteiltes Telefon 2098/);
});

// ─── C: App-QR ──────────────────────────────────────────────────────────────
test('C: App-QR mit Konto, Karte und geteiltem Telefon, nie mit PAT', () => {
  const person = { email: 'anna@example.ch', id: 7 };
  for (const art of ['website', 'app', 'karte', 'qr', 'handy', 'anlage']) {
    assert.equal(ak.qrAusstellenErlaubt({ user: person, auth: { art } }).ok, true, art);
  }
  assert.equal(ak.qrAusstellenErlaubt({ user: person, auth: { art: 'pat' }, pat: { id: 1 } }).ok, false);
  assert.equal(ak.qrAusstellenErlaubt({ user: person, auth: { art: 'bestaetigt' }, kartenBestaetigung: { id: 'kb_1' } }).ok, false);
  assert.equal(ak.qrAusstellenErlaubt({ user: { email: 'anna@example.ch' }, auth: { art: 'anlage' } }).ok, false);
});

test('C: Routen nehmen Karte an, protokollieren, Herkunft an der Sitzung, Mail bei QR aus Karte', () => {
  const src = lies('api/routes/app-karte.js');
  assert.match(src, /app\.post\('\/api\/apps\/qr-ausweis', authMiddleware, qrAusstellen,/);
  assert.match(src, /app\.get\('\/api\/apps\/qr-ausweis\/:id', authMiddleware, qrAusstellen,/);
  assert.doesNotMatch(src, /qr-ausweis'?[^\n]*requireUserLogin/);
  assert.match(src, /aktion: 'app-qr-ausgestellt'/);
  assert.match(src, /ausgestellt_art, ausgestellt_vermerk, herkunft_karte, herkunft_karte_token, herkunft_karte_besitzer\)/);
  assert.match(src, /ADD COLUMN IF NOT EXISTS herkunft TEXT/);
  assert.match(src, /if \(!bekannt \|\| ausKarte\) \{\s*neuesGeraetMelden/);
  // Lebensdauer und Einmal-Nutzung unveraendert
  assert.match(src, /const QR_TTL_S = Math\.min\(600, Math\.max\(30, parseInt\(process\.env\.APP_QR_TTL_S \|\| '90', 10\) \|\| 90\)\);/);
  assert.match(src, /WHERE token_hash = \$1 AND eingeloest_at IS NULL AND expires_at > NOW\(\)/);
  // Handy-Code bestaetigen bleibt nur mit dem Konto
  assert.match(src, /handy-code\/:code\/:wahl\(bestaetigen\|ablehnen\)', authMiddleware, requireUserLogin/);
});

test('C/E: nur ein QR vom Konto bestaetigt eine Signatur', () => {
  for (const a of ['website', 'otp', 'app', 'authentik']) assert.equal(ak.qrVomKonto(a), true, a);
  for (const a of ['karte', 'qr', 'handy', 'anlage', 'pat', 'bestaetigt', '', null, undefined]) assert.equal(ak.qrVomKonto(a), false, String(a));
});

// ─── E: Signieren mit Karte oder QR ─────────────────────────────────────────
test('E: wer darf mit Karte/QR bestaetigen', () => {
  assert.equal(sb.darfMitKarteBestaetigen({ auth: { art: 'anlage' }, headers: {} }), true);
  assert.equal(sb.darfMitKarteBestaetigen({ auth: { art: 'karte' }, headers: {} }), true);
  assert.equal(sb.darfMitKarteBestaetigen({ auth: { art: 'qr' }, headers: {} }), true);
  assert.equal(sb.darfMitKarteBestaetigen({ auth: { art: 'handy' }, headers: {} }), true);
  assert.equal(sb.darfMitKarteBestaetigen({ auth: { art: 'website' }, headers: {} }), false);
  assert.equal(sb.darfMitKarteBestaetigen({ auth: { art: 'bestaetigt' }, headers: {} }), false);
  assert.equal(sb.darfMitKarteBestaetigen({ auth: { art: 'karte' }, pat: { id: 1 }, headers: {} }), false);
  assert.equal(sb.darfMitKarteBestaetigen({ auth: { art: 'karte' }, headers: { 'x-rosenweg-kanal': 'MCP' } }), false);
  assert.equal(sb.darfMitKarteBestaetigen(null), false);
});

test('E: Anfrage pruefen', () => {
  assert.deepEqual(sb.anfragePruefen({ methode: 'karte', uid: '04:d4:c2:27:c2:2a:81' }), { ok: true, methode: 'karte', uid: '04D4C227C22A81' });
  assert.equal(sb.anfragePruefen({ methode: 'karte', uid: 'xyz' }).ok, false);
  const qr = sb.anfragePruefen({ methode: 'qr', code: 'RWAPP1:abcdefghijklmnopqrstuvwxyz012345' });
  assert.equal(qr.ok, true);
  assert.equal(qr.token, 'abcdefghijklmnopqrstuvwxyz012345');
  assert.match(sb.anfragePruefen({ methode: 'qr', code: 'RWTEL1:abcdefghijklmnopqrstuvwxyz012345' }).fehler, /geteilte Telefone/);
  assert.equal(sb.anfragePruefen({ methode: 'passwort' }).ok, false);
  assert.equal(sb.anfragePruefen(null).ok, false);
});

test('E: Karte muss zugewiesen sein und der Person dieser Anmeldung gehoeren', () => {
  const n = { found: true, assigned: true, person: { email: 'Anna@Example.ch' } };
  assert.equal(sb.karteGehoertPerson(n, 'anna@example.ch'), true);
  assert.equal(sb.karteGehoertPerson({ ...n, assigned: false }, 'anna@example.ch'), false);
  assert.equal(sb.karteGehoertPerson({ ...n, found: false }, 'anna@example.ch'), false);
  assert.equal(sb.karteGehoertPerson(n, 'bert@example.ch'), false);
  assert.equal(sb.karteGehoertPerson({ found: true, assigned: true, person: null }, 'anna@example.ch'), false);
  assert.equal(sb.karteGehoertPerson(n, ''), false);
});

test('E: Text auf dem PDF nennt Methode, Karte, Zeit und Anmeldung', () => {
  const zeitMs = Date.UTC(2026, 10, 28, 13, 3);   // 14:03 in Zuerich
  assert.equal(sb.bestaetigungText({ methode: 'karte', karte: '4F2A9C', art: 'anlage', geraet: 'geteiltes Telefon 2098', zeitMs }),
    'Rosenweg-Karte 4F2A9C erneut vorgelegt am 28.11.2026 um 14:03 Uhr (angemeldet am geteilten Telefon 2098)');
  assert.equal(sb.bestaetigungText({ methode: 'qr', art: 'karte', zeitMs }),
    'Anmelde-QR aus dem Rosenweg-Konto gescannt am 28.11.2026 um 14:03 Uhr (angemeldet mit der Rosenweg-Karte)');
});

test('E: Bestaetigung gilt kurz (Standard 2 Minuten, hoechstens 5)', () => {
  assert.equal(sb.TTL_S, 120);
  assert.ok(sb.FEHL_GRENZE > 0 && sb.FEHL_GRENZE <= 10);
});

function attrappePool(antworten = {}) {
  const anfragen = [];
  return {
    anfragen,
    async query(sql, params) {
      anfragen.push({ sql, params });
      for (const [muster, rows] of Object.entries(antworten)) if (sql.includes(muster)) return { rows, rowCount: rows.length };
      return { rows: [], rowCount: 0 };
    },
  };
}

test('E: Einloesen nur einmal, nur diese Vollmacht und Person, nicht abgelaufen', async () => {
  const pool = attrappePool({ 'UPDATE vollmacht_sign_bestaetigungen': [{ id: 'vsb_1', methode: 'karte', text: 't' }] });
  assert.equal(await sb.einloesen(pool, { token: 'falsch', vollmachtId: 3, email: 'a@example.ch' }), null);
  const token = 'rw_sigb_' + 'A'.repeat(43);
  const z = await sb.einloesen(pool, { token, vollmachtId: 3, email: 'a@example.ch' });
  assert.equal(z.id, 'vsb_1');
  const u = pool.anfragen.find(a => a.sql.includes('UPDATE vollmacht_sign_bestaetigungen'));
  assert.match(u.sql, /used_at IS NULL AND expires_at > NOW\(\)\s+AND vollmacht_id = \$2 AND LOWER\(email\) = LOWER\(\$3\)/);
  assert.match(u.sql, /WHERE token_hash = \$1 AND erfolg/);
  assert.equal(u.params[0], sb.hash(token));
  assert.deepEqual(u.params.slice(1), [3, 'a@example.ch']);
});

test('E: QR verbrauchen nur, wenn er der Person gehoert und vom Konto stammt', async () => {
  const pool = attrappePool({ 'UPDATE app_qr_ausweise': [{ id: 'qa_1' }] });
  const q = await sb.qrVerbrauchen(pool, { token: 'abcdefghijklmnopqrstuvwxyz012345', email: 'a@example.ch', vollmachtId: 9, geraet: 'x', ip: '198.51.100.1' });
  assert.equal(q.id, 'qa_1');
  const u = pool.anfragen[0];
  assert.match(u.sql, /eingeloest_at IS NULL AND expires_at > NOW\(\)\s+AND LOWER\(email\) = LOWER\(\$2\) AND ausgestellt_art = ANY\(\$7::text\[\]\)/);
  assert.deepEqual([...u.params[6]].sort(), ['app', 'authentik', 'otp', 'website']);
  assert.equal(u.params[5], 'vollmacht:9');
});

test('E: Fehlversuch ohne Token, Erfolg mit Token und Ablauf', async () => {
  const pool = attrappePool();
  const f = await sb.eintragen(pool, { vollmachtId: 1, email: 'A@example.ch', methode: 'karte', erfolg: false, grund: 'karte-fremd' });
  assert.equal(f.token, null);
  const e = await sb.eintragen(pool, { vollmachtId: 1, email: 'a@example.ch', methode: 'qr', erfolg: true, text: 't' });
  assert.match(e.token, sb.TOKEN_RE);
  assert.ok(e.ablauf.getTime() - Date.now() <= sb.TTL_S * 1000 + 50);
  const ins = pool.anfragen.filter(a => a.sql.includes('INSERT INTO vollmacht_sign_bestaetigungen'));
  assert.equal(ins[0].params[1], null);
  assert.equal(ins[0].params[3], 'a@example.ch');
  assert.equal(ins[1].params[1], sb.hash(e.token));   // nur der Hash wird gespeichert
});

test('E: Routen — Bestaetigung vor dem Signieren, erst nach allen Pruefungen verbraucht', () => {
  const server = lies('api/server.js');
  const best = server.slice(server.indexOf("app.post('/api/vollmachten/:id/sign-bestaetigung'"), server.indexOf('// R1 (Entscheid Stefan 28.11.2026): Signieren mit dem Rosenweg-Konto'));
  assert.match(best, /if \(!sb\.darfMitKarteBestaetigen\(req\)\)/);
  assert.match(best, /sb\.fehlversuche\(pool, email\) >= sb\.FEHL_GRENZE/);
  assert.match(best, /await vmSignVorpruefen\(req, id\)/);
  assert.match(best, /sb\.karteGehoertPerson\(n, email\)/);
  assert.match(best, /bereich: 'vollmachten-signatur', aktion: `bestaetigt-\$\{p\.methode\}`/);
  const sign = server.slice(server.indexOf("app.post('/api/vollmachten/:id/sign-digital'"), server.indexOf('// Signierte Papier-PDF einer Vollmacht'));
  assert.match(sign, /const mitKonto = signierenErlaubt\(req\.auth, \{ pat: !!req\.pat, kanal: req\.headers\['x-rosenweg-kanal'\] \}\);/);
  assert.match(sign, /const mitKarte = !mitKonto && signaturBestaetigung\.darfMitKarteBestaetigen\(req\);/);
  assert.match(sign, /if \(mitKarte && !req\.body\?\.bestaetigung\) return res\.status\(403\)\.json\(kartenHinweis\);/);
  // Verbrauchen nach Vorpruefung und Kontoname, direkt vor dem Schreiben
  const iVor = sign.indexOf('vmSignVorpruefen(req, id)');
  const iName = sign.indexOf('const signName');
  const iEin = sign.indexOf('signaturBestaetigung.einloesen(');
  const iUpd = sign.indexOf('UPDATE vollmachten_vollmachtgeber');
  assert.ok(iVor > 0 && iVor < iName && iName < iEin && iEin < iUpd);
  assert.match(sign, /signed_bestaetigung_art=\$7, signed_bestaetigung_ref=\$8/);
  assert.match(server, /ADD COLUMN IF NOT EXISTS signed_bestaetigung_art TEXT/);
});

test('E: Signieren per PAT/MCP bleibt aus, Konto braucht weiter "frisch"', () => {
  const st = require('../lib/stufen');
  assert.equal(st.signierenErlaubt({ stufe: 'frisch', art: 'website' }, { pat: true }), false);
  assert.equal(st.signierenErlaubt({ stufe: 'frisch', art: 'app' }, { kanal: 'mcp' }), false);
  assert.equal(st.signierenErlaubt({ stufe: 'karte', art: 'karte' }), false);
  assert.equal(st.signierenErlaubt({ stufe: 'frisch', art: 'website' }), true);
});

test('Portal der geteilten Telefone (PBX): Profil und Bild als Ausnahmen der Sperrliste', () => {
  const py = lies('pbx/api/app.py');
  // seit #255: jede Rosenweg-App erreicht /api/, gesperrt bleibt PORTAL_GESPERRT
  assert.match(py, /PORTAL_PFADE_STANDARD = \{"\*": \["\/api\/"\]\}/);
  assert.match(py, /PORTAL_AUSNAHMEN = \(\("GET", "auth\/me"\), \("PUT", "auth\/profile"\), \("PUT", "auth\/avatar"\)\)/);
  assert.match(py, /PORTAL_GESPERRT = \("change-password", "me\/tokens", "me\/passkeys", "auth",/);
});
