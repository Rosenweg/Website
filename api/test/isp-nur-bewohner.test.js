// node --test api/test/isp-nur-bewohner.test.js — Internet/ISP (Entscheid Stefan 28.11.2026):
// Haus-WLAN, Anschluss (Ansicht, MAC) und VPN nur fuer Personen, die dort WOHNEN, ab dem
// Einzugsdatum; VPN beim Auszug und bei der Kontoloeschung sperren (Altbestand nur melden);
// oeffentlicher Schluessel vom Geraet; Protokoll, wenn Technik/Praesident Passwoerter oder
// fremde VPN-Konfigurationen ansieht (auch mit der Karte); Filter ?nur=meine.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const z = require('../lib/isp-zugang');
const ka = require('../lib/kartenadmin');
const { anmeldung } = require('../lib/stufen');

const lies = rel => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
const server = lies('api/server.js');
const route = (methode, pfad) => {
  const i = server.indexOf(`app.${methode}('${pfad}'`);
  assert.ok(i >= 0, `${methode} ${pfad} fehlt`);
  const j = server.indexOf('\napp.', i + 10);
  return server.slice(i, j < 0 ? undefined : j);
};
const HEUTE = new Date(2026, 10, 28);

test('wohnt dort: Mieter, Mitbewohner, selbst bewohnender Eigentuemer', () => {
  assert.equal(z.wohntDort({ rolle: 'mieter', bewohnt_von: 'mieter' }, HEUTE), true);
  assert.equal(z.wohntDort({ rolle: 'bewohner', bewohnt_von: 'mieter' }, HEUTE), true);
  assert.equal(z.wohntDort({ rolle: 'eigentuemer', bewohnt_von: 'eigentuemer' }, HEUTE), true);
  assert.equal(z.wohntDort({ rolle: 'eigentuemer', bewohnt_von: null }, HEUTE), true); // Standard der Tabelle
});

test('wohnt nicht: Eigentuemer der vermieteten Wohnung, Verwalter, sonstige, ausgezogen', () => {
  assert.equal(z.wohntDort({ rolle: 'eigentuemer', bewohnt_von: 'mieter' }, HEUTE), false);
  assert.equal(z.wohntDort({ rolle: 'eigentuemer', bewohnt_von: 'leer' }, HEUTE), false);
  // Wohnungs-Verwalter vertritt den Eigentuemer, wohnt aber nicht dort - auch nicht bei Selbstbewohnung
  assert.equal(z.wohntDort({ rolle: 'verwalter', bewohnt_von: 'eigentuemer' }, HEUTE), false);
  assert.equal(z.wohntDort({ rolle: 'sonstige', bewohnt_von: 'mieter' }, HEUTE), false);
  assert.equal(z.wohntDort({ rolle: 'mieter', bewohnt_von: 'mieter', archiviert_am: '2026-10-01' }, HEUTE), false);
});

test('erst ab dem Einzugsdatum', () => {
  assert.equal(z.wohntDort({ rolle: 'mieter', gueltig_ab: '2026-12-01' }, HEUTE), false);
  assert.equal(z.wohntDort({ rolle: 'mieter', gueltig_ab: '2026-11-28' }, HEUTE), true);
  assert.equal(z.wohntDort({ rolle: 'mieter', gueltig_ab: new Date(2026, 10, 28) }, HEUTE), true); // pg: lokale Mitternacht
  assert.equal(z.wohntDort({ rolle: 'mieter', gueltig_ab: new Date(2026, 10, 29) }, HEUTE), false);
});

test('SQL-Bedingung entspricht der JS-Regel', () => {
  const sql = z.wohntSql('k', 'w').replace(/\s+/g, ' ');
  assert.match(sql, /k\.archiviert_am IS NULL/);
  assert.match(sql, /k\.gueltig_ab IS NULL OR k\.gueltig_ab <= CURRENT_DATE/);
  assert.match(sql, /k\.rolle IN \('mieter', 'bewohner'\)/);
  assert.match(sql, /k\.rolle = 'eigentuemer' AND COALESCE\(w\.bewohnt_von, 'eigentuemer'\) = 'eigentuemer'/);
  assert.doesNotMatch(sql, /verwalter/);
});

test('alle drei Stellen nutzen die Bewohner-Regel (Befund R1)', () => {
  // getUserVlanOptions: Haus-WLAN, VPN-Optionen, VPN anlegen, Laptop-Tunnel, Netz-Antrag
  assert.match(server, /async function getUserVlanOptions\(email, \{ alleKontakte = false \} = \{\}\) \{[\s\S]{0,600}ispZugang\.wohntSql\('wk', 'w'\)/);
  assert.match(route('get', '/api/isp/subscribers/me'), /ispZugang\.wohntSql\('k', 'w'\)/);
  assert.match(route('put', '/api/isp/subscribers/me/:id/mac'), /ispZugang\.wohntSql\('k', 'w'\)/);
  assert.match(route('get', '/api/isp/fixed-ips'), /ispZugang\.wohntSql\('k', 'kw'\)/);
  // alle Kontakte nur dort, wo die Technik einen bestehenden Netz-Antrag bearbeitet
  const alle = server.match(/getUserVlanOptions\([^)]*alleKontakte: true/g) || [];
  assert.equal(alle.length, 2);
});

test('/api/wifi: Haus-WLAN nur ueber die Wohnungen, keine Gruppen, kein Strassen-Rueckfall', () => {
  const r = route('get', '/api/wifi');
  assert.match(r, /getUserVlanOptions\(userEmailForHaus\)/);
  assert.doesNotMatch(r, /r\(\\d\+\)-\(bewohner\|eigentuemer\)/);
  assert.doesNotMatch(r, /SELECT strasse FROM users/);
  assert.doesNotMatch(r, /req\.user\.isAdmin/);
  // alle PPSKs nur fuer ispIsAdmin, nur auf Anfrage und mit Protokoll
  assert.match(r, /const admin = ispIsAdmin\(req\);/);
  assert.match(r, /if \(admin && \/\^\(1\|ja\|true\)\$\/i\.test\(String\(req\.query\.alle/);
  assert.match(r, /await ispAdminSichtProtokoll\(req, 'wlan-passwoerter-angesehen'/);
  assert.equal(z.hausAusVlan(99), 9);
  assert.equal(z.hausAusVlan(139), 13);
  assert.equal(z.hausAusVlan(19), 1);
  assert.equal(z.hausAusVlan(9), null);   // Kooperation, kein Haus
  assert.equal(z.hausAusVlan(90), null);  // Technik RW9
  assert.equal(z.hausAusVlan(911), null); // eigenes Netz
});

test('Wohnsitz-Art fuer die Liste', () => {
  const k = (rolle, bewohnt_von, extra = {}) => ({ rolle, bewohnt_von, ...extra });
  assert.equal(z.wohnsitzArt([k('mieter', 'mieter')], HEUTE), 'wohnt');
  assert.equal(z.wohnsitzArt([k('mieter', 'mieter', { gueltig_ab: '2027-01-01' })], HEUTE), 'kuenftig');
  assert.equal(z.wohnsitzArt([k('eigentuemer', 'mieter')], HEUTE), 'eigentuemer');
  assert.equal(z.wohnsitzArt([k('verwalter', 'eigentuemer')], HEUTE), 'verwalter');
  assert.equal(z.wohnsitzArt([k('sonstige', 'mieter')], HEUTE), 'sonstige');
  assert.equal(z.wohnsitzArt([k('mieter', 'mieter', { archiviert_am: true })], HEUTE), 'ausgezogen');
  assert.equal(z.wohnsitzArt([], HEUTE), 'ohne_wohnung');
  // eine Wohnung reicht: ausgezogen aus Haus 9, wohnt jetzt in Haus 13
  assert.equal(z.wohnsitzArt([k('mieter', 'mieter', { archiviert_am: true }), k('mieter', 'mieter')], HEUTE), 'wohnt');
  for (const a of ['kuenftig', 'eigentuemer', 'verwalter', 'sonstige', 'ausgezogen', 'ohne_wohnung', 'anderes_haus']) {
    assert.ok(z.ART_TEXT[a], a);
  }
});

test('Abgleich: Bewohner merken, beim Auszug sperren, Altbestand nur melden (Befund R2)', () => {
  const kontakte = new Map([
    ['wohnt@example.org', [{ rolle: 'mieter', bewohnt_von: 'mieter', vlan: 99 }]],
    ['weg@example.org', [{ rolle: 'mieter', bewohnt_von: 'mieter', archiviert_am: true, vlan: 99 }]],
    ['eig@example.org', [{ rolle: 'eigentuemer', bewohnt_von: 'mieter', vlan: 99 }]],
    ['umzug@example.org', [{ rolle: 'mieter', archiviert_am: true, vlan: 99 }, { rolle: 'mieter', vlan: 139 }]],
  ]);
  const plan = z.vpnAbgleichPlan([
    { id: 1, user_email: 'Wohnt@example.org', notizen: 'vlan=99 name=x' },
    { id: 2, user_email: 'weg@example.org', notizen: 'vlan=99 name=x', wohnsitz_gesehen_am: '2026-11-28' }, // Auszug nach der Aenderung
    { id: 3, user_email: 'weg@example.org', notizen: 'vlan=99 name=y' },                                    // Altbestand
    { id: 4, user_email: 'eig@example.org', notizen: 'vlan=99 name=z' },
    { id: 5, user_email: 'service@example.org', notizen: 'vlan=9 name=s' },
    { id: 6, user_email: 'umzug@example.org', notizen: 'vlan=99 name=u', wohnsitz_gesehen_am: '2026-11-28' },
    { id: 7, user_email: 'umzug@example.org', notizen: 'vlan=139 name=u' },
    { id: 8, user_email: 'wohnt@example.org', notizen: 'Station laptop-1, VLAN 9' },                         // Technik-Tunnel VLAN 9
    { id: 9, user_email: 'weg@example.org', notizen: 'vlan=99', gesperrt_am: '2026-11-01', wohnsitz_gesehen_am: '2026-10-01' },
  ], kontakte, HEUTE);
  assert.deepEqual(plan.gesehen, [1, 7, 8]);
  assert.deepEqual(plan.sperren.map(p => [p.id, p.art]), [[2, 'ausgezogen'], [6, 'anderes_haus']]);
  assert.deepEqual(plan.melden.map(p => [p.id, p.art]), [[3, 'ausgezogen'], [4, 'eigentuemer'], [5, 'ohne_wohnung']]);
});

test('VLAN aus den Notizen', () => {
  assert.equal(z.vlanAusNotiz('vlan=139 name=Laptop'), 139);
  assert.equal(z.vlanAusNotiz('Station laptop-1, VLAN 99'), 99);
  assert.equal(z.vlanAusNotiz(''), null);
  assert.equal(z.vlanAusNotiz(null), null);
});

test('Sperren: Peer entfernen, Zeile bleibt; Kontoloeschung; Hooks; NOC zaehlt Gesperrte nicht als offen', () => {
  assert.match(server, /async function vpnZugangSperren\(v, grund\) \{[\s\S]{0,400}wgControl\('DELETE'[\s\S]{0,400}UPDATE isp_vpn_accounts SET active = false, gesperrt_am = NOW\(\), gesperrt_grund = \$2/);
  assert.doesNotMatch(server.match(/async function vpnZugangSperren[\s\S]*?\n\}/)[0], /DELETE FROM isp_vpn_accounts/);
  assert.match(server, /async function lokalesKontoNachLoeschung\(email\) \{[\s\S]{0,2500}if \(!nochKonto\) \{\s*const n = await vpnSperrenFuerEmail\(e, 'Konto gelöscht'\)/);
  assert.match(server, /trackRemovedKontakte\(wohnungId, stweg, oldKontakte, incoming\)[^\n]*\n[^\n]*\n\s*vpnAbgleichBald\(\);/);
  assert.match(server, /async function autoArchiveSupersededKontakte\(\) \{[\s\S]{0,4000}vpnAbgleichBald\(0\);/);
  assert.match(server, /COUNT\(\*\) FILTER \(WHERE NOT active AND gesperrt_am IS NULL\) AS pen/);
  assert.match(server, /ADD COLUMN IF NOT EXISTS gesperrt_am TIMESTAMPTZ/);
  assert.match(server, /ADD COLUMN IF NOT EXISTS wohnsitz_gesehen_am TIMESTAMPTZ/);
  assert.match(server, /VPN_AUSZUG_SPERREN/);
  // Liste und Sperren von Hand nur fuer Technik/Praesident; die Liste sperrt nie selbst
  const liste = route('get', '/api/isp/vpn-accounts/wohnsitz');
  assert.match(liste, /if \(!ispIsAdmin\(req\)\) return res\.status\(403\)/);
  assert.match(liste, /vpnWohnsitzAbgleich\(\{ nurMelden: true \}\)/);
  assert.match(route('post', '/api/isp/vpn-accounts/:id/sperren'), /if \(!ispIsAdmin\(req\)\) return res\.status\(403\)/);
  // die Liste muss vor den :id-Routen stehen
  assert.ok(server.indexOf("app.get('/api/isp/vpn-accounts/wohnsitz'") < server.indexOf("app.get('/api/isp/vpn-accounts/:id/config'"));
});

test('Oeffentlicher Schluessel vom Geraet (Befund L3/R3)', () => {
  assert.equal(z.wgPublicKeyGueltig('xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg='), true);
  assert.equal(z.wgPublicKeyGueltig(' xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg= '), true);
  assert.equal(z.wgPublicKeyGueltig('xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg'), false);
  assert.equal(z.wgPublicKeyGueltig('xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=\n[Peer]'), false);
  assert.equal(z.wgPublicKeyGueltig(''), false);
  assert.equal(z.wgPublicKeyGueltig(null), false);
  const r = route('post', '/api/isp/vpn-accounts');
  assert.match(r, /ispZugang\.wgPublicKeyGueltig\(publicKey\)/);
  assert.match(r, /\.\.\.\(publicKey \? \{ public_key: publicKey \} : \{\}\)/);
  // mit Schluessel vom Geraet: keine Konfiguration mit privatem Schluessel in der Antwort
  assert.match(r, /if \(publicKey\) \{[\s\S]{0,400}return res\.json\(\{ \.\.\.r\.rows\[0\], vlan, schluessel: 'geraet', config_vorlage: peer\.config/);
  assert.doesNotMatch(r.match(/if \(publicKey\) \{[\s\S]*?\n    \}/)[0], /config: peer\.config/);
  // Server-Weg bleibt als Rueckfall, gekennzeichnet
  assert.match(r, /schluessel: 'server',\s*hinweis: 'Rückfall/);
  assert.match(server, /ADD COLUMN IF NOT EXISTS schluessel_ort TEXT/);
  // Konfiguration/QR: gesperrt -> 410, Schluessel auf dem Geraet -> 409
  for (const p of ['/api/isp/vpn-accounts/:id/config', '/api/isp/vpn-accounts/:id/qr']) {
    assert.match(route('get', p), /const sperre = vpnAbrufSperre\(v\);/);
  }
  // Web-Seite schickt den Schluessel und zeigt die Vorlage
  const seite = lies('isp-mein-zugang.html');
  assert.match(seite, /public_key: document\.getElementById\('v-pub'\)\.value\.trim\(\) \|\| null/);
  assert.match(seite, /else if \(created\.config_vorlage\) showVorlage\(created\);/);
  assert.match(seite, /Schlüssel auf dem Server \(Rückfall\)/);
});

test('Protokoll beim Ansehen: alle PPSKs, privates Netz, fremde VPN-Konfiguration', () => {
  assert.match(server, /async function ispAdminSichtProtokoll\(req, aktion, ziel, detail, kartenText\) \{[\s\S]{0,300}adminProtokoll\.eintragen\(pool, null, req, \{ bereich: 'isp'[\s\S]{0,200}kartenAdmin\.vermerken\(req, req\.res, \{ lesend: true/);
  for (const p of ['/api/isp/vpn-accounts/:id/config', '/api/isp/vpn-accounts/:id/qr']) {
    assert.match(route('get', p), /await vpnFremdSichtProtokoll\(req, v, /);
  }
  assert.match(server, /async function vpnFremdSichtProtokoll\(req, v, was\) \{[\s\S]{0,200}if \(eigene\) return;/);
  const pw = route('get', '/api/isp/vlan-requests/:id/wlan-passwort');
  assert.match(pw, /if \(!eigen && !ispIsAdmin\(req\)\) return res\.status\(403\)/);
  assert.match(pw, /if \(!eigen\) \{\s*await ispAdminSichtProtokoll\(req, 'wlan-passwort-angesehen'/);
  // in der Liste der Netz-Antraege kein fremdes WLAN-Passwort mehr
  assert.match(route('get', '/api/isp/vlan-requests'), /const pw = \(isOwner \|\| isMitnutzer\) \? \{\} : \{ wlan_password: null \};/);
  assert.match(route('get', '/api/isp/protokoll'), /adminProtokoll\.lesen\(pool, 'isp'/);
  // Seiten: Passwoerter erst auf Knopfdruck
  assert.match(lies('wlan.html'), /fetch\('\/api\/wifi\?alle=1'/);
  assert.match(lies('isp-admin.html'), /\/api\/isp\/vlan-requests\/' \+ id \+ '\/wlan-passwort'/);
});

test('Karte: Lesezugriff mit lesend:true protokolliert, ohne nicht; nie gesperrt', () => {
  const protokoll = [];
  ka.einrichten({
    speicher: {}, senden: async () => {}, MAIL_FROM: 'a@b', PORTAL_URL: 'https://p',
    protokollieren: (aktion, f) => protokoll.push({ aktion, ...f }),
  });
  const anfrage = (art) => {
    const req = { method: 'GET', originalUrl: '/api/wifi?alle=1', user: { email: 'erika@example.org', name: 'Erika' },
      headers: {}, appKarte: { id: 'ks_1', karte: '1234' } };
    req.auth = anmeldung(art === 'karte' ? 'karte' : 'website');
    return req;
  };
  const res = () => { const l = []; return { statusCode: 200, once: (e, f) => l.push(f), fertig: () => l.forEach(f => f()) }; };
  // ohne lesend: GET wird nicht vermerkt (bisheriges Verhalten)
  let r1 = res(); assert.equal(ka.vermerken(anfrage('karte'), r1), false);
  // mit lesend: vermerkt, mit eigenem Text
  let r2 = res(); assert.equal(ka.vermerken(anfrage('karte'), r2, { lesend: true, text: 'Internet (ISP): alle WLAN-Passwörter angesehen' }), true);
  r2.fertig();
  assert.equal(protokoll.length, 1);
  assert.equal(protokoll[0].aktion, 'admin-mit-karte');
  assert.match(protokoll[0].detail, /alle WLAN-Passwörter angesehen · GET \/api\/wifi/);
  // mit dem Konto: kein Kartenprotokoll (der Eintrag steht im admin_protokoll)
  let r3 = res(); assert.equal(ka.vermerken(anfrage('website'), r3, { lesend: true }), false);
});

test('Filter ?nur=meine in VPN-Konten, Netz-Antraegen und Mailboxen (Befund L1)', () => {
  assert.equal(z.nurMeine({ nur: 'meine' }), true);
  assert.equal(z.nurMeine({ nur: '1' }), true);
  assert.equal(z.nurMeine({ nur_meine: 'true' }), true);
  assert.equal(z.nurMeine({}), false);
  assert.equal(z.nurMeine({ nur: 'alle' }), false);
  for (const p of ['/api/isp/vpn-accounts', '/api/isp/vlan-requests', '/api/isp/mailbox-requests']) {
    assert.match(route('get', p), /const admin = istAdmin && !ispZugang\.nurMeine\(req\.query\);/, p);
  }
  const seite = lies('isp-mein-zugang.html');
  for (const ep of ['vpn-accounts', 'vlan-requests', 'mailbox-requests']) {
    assert.ok(seite.includes(`apiFetch('/api/isp/${ep}?nur=meine')`), ep);
  }
});
