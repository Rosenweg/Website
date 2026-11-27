// Admin-Aktionen mit der Rosenweg-Karte (Entscheid Stefan 27.11.2026)
//
// "Die Karte wird wie ein Schlüssel behandelt": Eine Karten-, QR- oder
// Handy-Sitzung (rw_app_…) und ein geteiltes Telefon (Anlage-Token) haben
// dieselben Rechte wie das Rosenweg-Konto. Weil die Karten-UID aber kopierbar
// ist, wird jede Admin-Aktion damit sichtbar gemacht:
//
//  1. Protokoll: jede schreibende Admin-Aktion mit der Karte steht im
//     Kartenprotokoll (access_karten_protokoll, aktion 'admin-mit-karte'):
//     Person, Aktion, Route, Art (karte/qr/handy/anlage), Sitzung, Karte,
//     App, Gerät, IP, Ergebnis, Zeit. Die Technik sieht es unter
//     GET /api/karten-protokoll?aktion=admin-mit-karte.
//  2. Quittung per E-Mail an die Person: "Mit deiner Rosenweg-Karte wurde …
//     ausgeführt", mit Link zum Abmelden aller Apps. Nicht blockierend,
//     gebündelt (die erste nach KARTEN_QUITTUNG_ERSTE_S Sekunden, weitere
//     höchstens alle KARTEN_QUITTUNG_FENSTER_MIN Minuten in einer Mail).
//     Abschalten: KARTEN_QUITTUNG=aus.
//  3. Die zwölf heiklen Aktionen (Rechte, Proxmox-ACL, Konto löschen,
//     Personen zusammenführen, SSH-Schlüssel und -Zugang) laufen mit der
//     Karte NICHT sofort: Die API speichert sie (karten_bestaetigungen),
//     antwortet 202 { bestaetigung: 'email', id, ablauf, hinweis } und
//     schickt einen einmaligen Link. Erst "Bestätigen" führt die Aktion aus
//     — als Aufruf an die eigene API mit einem Einmal-Ausweis (rw_best_…),
//     der genau diese Methode und diesen Pfad abdeckt und die Gruppen der
//     Person frisch aus Authentik trägt. Jede Prüfung der Route läuft dabei
//     erneut. "Ablehnen" verwirft, meldet die Sitzung ab, die es ausgelöst
//     hat, meldet es der Technik und bietet an, alle Apps abzumelden.
//     Mit dem Konto (Website, App-Login) laufen die zwölf wie immer direkt.
//
// Mails gehen über loggedSendMail (direkter Versand mit email_log, wie
// Anmeldecode und "neues Gerät") — nicht über die Freigabe der
// Verwaltungs-Mails.
const crypto = require('crypto');
const { istKartenSitzung } = require('./stufen');

let deps = null;
/**
 * deps: { speicher, senden(mailOpts, trigger), MAIL_FROM, PORTAL_URL,
 *         protokollieren(aktion, felder), technikMelden(text), personLaden(email)
 *         -> { aktiv, groups } | null, sitzungenWiderrufen(where:{id}|{email}, grund),
 *         ausfuehren(eintrag, ausweis) -> { status, text } }
 */
function einrichten(d) { deps = d; quittung = neuerBuendler(); return modul; }

const zahl = (name, std, min, max) => {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : std;
};
const BESTAETIGUNG_MIN = zahl('KARTEN_BESTAETIGUNG_MIN', 15, 5, 120);
const quittungAn = () => !/^(aus|0|nein|false)$/i.test(process.env.KARTEN_QUITTUNG || '');

const zeitText = (ms) => new Date(ms).toLocaleString('de-CH', { timeZone: 'Europe/Zurich' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** /api/Foo//bar/ -> foo/bar (wie authMiddleware für Sperrliste und Anlage-Token). */
function pfadNormal(p) {
  return String(p || '').split('?')[0].toLowerCase()
    .replace(/\/{2,}/g, '/').replace(/^\/api\//, '').replace(/^\/+|\/+$/g, '');
}

// ─── Aktion in verständlichem Deutsch ───────────────────────────────────────
const BEREICHE = [
  ['permissions', 'Rechteverwaltung'], ['proxmox/acl', 'Proxmox-Rechte'], ['proxmox', 'Proxmox'],
  ['admin/users', 'Benutzerkonten'], ['admin/groups', 'Gruppen'], ['admin/pending-deletions', 'Kontolöschungen'],
  ['admin/email-alias', 'E-Mail-Aliase'], ['personen', 'Personen'],
  ['ssh/me/schluessel', 'Eigene SSH-Schlüssel'], ['ssh/me/github', 'SSH-Schlüssel von GitHub'],
  ['ssh/matrix', 'SSH-Zugriffsmatrix'], ['ssh', 'SSH-Zugang'],
  ['stations/v2', 'Stationen (Befehle)'], ['stations', 'Stationen'], ['sicherungen', 'Sicherungen'], ['scanner', 'Scanner-Konten'],
  ['pbx', 'Telefonanlage'], ['whatsapp', 'WhatsApp'], ['isp', 'Internet (ISP)'], ['pve-messages', 'Proxmox-Meldungen'],
  ['access', 'Türen und Zutritt'], ['wasch', 'Waschküche'], ['mqtt', 'MQTT'], ['display', 'Anzeigen'],
  ['mail-approval-config', 'Mail-Freigabe-Regeln'], ['verwaltung-mail-queue', 'Verwaltungs-Mails'],
  ['mail-templates', 'Mail-Vorlagen'], ['verteiler', 'Verteiler'], ['email', 'E-Mail-Versand'],
  ['kontakte', 'Kontakte'], ['stweg', 'STWEG-Termine'], ['alarmpanel', 'Alarmanlage'],
  ['energie-admin', 'Energie-Erfassung'], ['internal', 'Abgleich'], ['wohnungen', 'Wohnungen'],
];
const VERBEN = {
  unlock: 'Tür geöffnet', block: 'gesperrt', unblock: 'entsperrt', zuruecksetzen: 'zurückgesetzt',
  update: 'Update angefordert', freigeben: 'freigegeben', ablehnen: 'abgelehnt', send: 'gesendet',
  'test-send': 'Test gesendet', broadcast: 'an viele gesendet', 'test-call': 'Testanruf ausgelöst',
  start: 'gestartet', merge: 'zusammengeführt', 'ssh-wartung': 'SSH-Wartung geöffnet',
  wartungsschluessel: 'Wartungsschlüssel hinterlegt', publish: 'veröffentlicht', sync: 'abgeglichen',
  abgleich: 'abgeglichen', reactivate: 'wieder aktiviert', cancel: 'abgebrochen', provision: 'eingerichtet',
  bootstrap: 'eingerichtet', approve: 'genehmigt', reject: 'abgelehnt', befehle: 'Befehl geschickt',
  'add_user': 'Person aufgenommen', 'remove_user': 'Person entfernt',
  'passwort-drucken': 'neues Passwort gedruckt',
};
function aktionText(methode, pfad) {
  const p = pfadNormal(pfad);
  const b = BEREICHE.find(([pre]) => p === pre || p.startsWith(pre + '/'));
  const bereich = b ? b[1] : (p.split('/')[0] || 'Verwaltung');
  const letzte = p.split('/').filter(Boolean).pop() || '';
  const m = String(methode || '').toUpperCase();
  const verb = VERBEN[letzte] && m !== 'DELETE'
    ? VERBEN[letzte]
    : m === 'DELETE' ? 'gelöscht' : m === 'POST' ? 'angelegt bzw. ausgelöst' : 'geändert';
  return `${bereich}: ${verb}`;
}

function kontext(req) {
  const k = req.appKarte || {};
  return {
    email: String(req.user?.email || '').toLowerCase(),
    name: req.user?.name || '',
    art: req.auth?.art || 'karte',
    sitzung: k.id || (req.anlage ? 'anlage:' + req.anlage.ext : ''),
    karte: k.karte || '',
    app: req.rosenwegApp?.text || k.app_name || k.app || req.anlage?.paket || '',
    geraet: k.geraet || (req.anlage ? 'geteiltes Telefon ' + req.anlage.ext : ''),
    ip: req.absenderIp || req.ip || '',
    methode: req.method,
    pfad: String(req.originalUrl || ((req.baseUrl || '') + (req.path || ''))).split('?')[0],
    zeit: Date.now(),
  };
}

const herkunftText = (k) => [k.app && `App ${k.app}`, k.geraet && `Gerät ${k.geraet}`, k.ip && `IP ${k.ip}`]
  .filter(Boolean).join(', ');

// ─── 1 + 2: Protokoll und gebündelte Quittung ───────────────────────────────
/** Bündelt Einträge je Person: erste Mail nach ersteMs, weitere frühestens fensterMs nach der letzten. */
function neuerBuendler({ senden = (email, liste) => quittungSenden(email, liste),
  ersteMs = zahl('KARTEN_QUITTUNG_ERSTE_S', 60, 0, 3600) * 1000,
  fensterMs = zahl('KARTEN_QUITTUNG_FENSTER_MIN', 10, 1, 240) * 60 * 1000,
  jetzt = () => Date.now(), timer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; } } = {}) {
  const je = new Map(); // email -> { liste, timer, letzte }
  const raus = (email) => {
    const st = je.get(email);
    if (!st) return;
    const liste = st.liste; st.liste = []; st.timer = null; st.letzte = jetzt();
    if (liste.length) Promise.resolve(senden(email, liste)).catch(e => console.error('[karten-admin] Quittung:', e.message));
  };
  return {
    hinzu(email, eintrag) {
      if (!email) return;
      let st = je.get(email);
      if (!st) { st = { liste: [], timer: null, letzte: 0 }; je.set(email, st); }
      st.liste.push(eintrag);
      if (st.timer) return;
      const n = jetzt();
      const warte = st.letzte && n - st.letzte < fensterMs ? st.letzte + fensterMs - n : ersteMs;
      st.timer = timer(() => raus(email), warte);
    },
    _offen: (email) => je.get(email)?.liste.length || 0,
  };
}
let quittung = neuerBuendler();

function quittungMail(email, liste, PORTAL_URL) {
  const abmelden = `${PORTAL_URL}/profil.html#app-sitzungen`;
  const zeilen = liste.map(e => `${zeitText(e.zeit)}: ${e.text}${e.ok ? '' : ' (abgelehnt, Fehler ' + e.status + ')'}`
    + ` — ${herkunftText(e) || 'unbekannte Herkunft'}`);
  const subject = liste.length === 1
    ? `Mit deiner Rosenweg-Karte: ${liste[0].text}`
    : `Mit deiner Rosenweg-Karte: ${liste.length} Admin-Aktionen`;
  const text = `Hallo\n\nMit deiner Rosenweg-Karte wurde${liste.length === 1 ? '' : 'n'} im Portal ausgeführt:\n\n`
    + zeilen.map(z => '• ' + z).join('\n')
    + `\n\nWarst du das nicht? Karte sofort sperren: alle Apps abmelden unter ${abmelden} `
    + 'und die Technik informieren (technik@rosenweg4303.ch).\n\nRosenweg-Portal';
  const html = `<div style="font-family:sans-serif;max-width:560px">
<p>Hallo</p><p>Mit deiner Rosenweg-Karte wurde${liste.length === 1 ? '' : 'n'} im Portal ausgeführt:</p>
<ul>${zeilen.map(z => `<li>${esc(z)}</li>`).join('')}</ul>
<p><strong>Warst du das nicht?</strong> Karte sofort sperren: <a href="${esc(abmelden)}">alle Apps abmelden</a>
und die Technik informieren (<a href="mailto:technik@rosenweg4303.ch">technik@rosenweg4303.ch</a>).</p>
<p style="color:#6b7280;font-size:13px">Diese Nachricht kommt bei jeder Admin-Aktion mit der Karte; mit dem Rosenweg-Konto angemeldet nicht.</p></div>`;
  return { to: email, subject, text, html };
}

async function quittungSenden(email, liste) {
  if (!deps || !quittungAn()) return;
  await deps.senden({ from: deps.MAIL_FROM, ...quittungMail(email, liste, deps.PORTAL_URL) }, 'karten-admin-quittung');
}

/**
 * Für die Admin-Wächter: Schreibende Admin-Aktion mit der Karte -> nach der
 * Antwort ins Protokoll und in die Quittung. Blockiert nie. Einmal je Anfrage.
 */
function vermerken(req, res) {
  if (!istKartenSitzung(req) || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return false;
  if (req._kartenAdminVermerk) return false;
  req._kartenAdminVermerk = true;
  const k = kontext(req);
  const text = aktionText(k.methode, k.pfad);
  const fertig = () => {
    const status = res?.statusCode || 0;
    const e = { ...k, text, status, ok: status > 0 && status < 400 };
    if (deps?.protokollieren) {
      deps.protokollieren('admin-mit-karte', {
        displayId: k.karte || null, email: k.email, name: k.name, durch: `${k.art}:${k.sitzung}`, erfolg: e.ok,
        detail: `${text} · ${k.methode} ${k.pfad} · ${status}${herkunftText(k) ? ' · ' + herkunftText(k) : ''}`,
      });
    } else {
      console.warn(`[karten-admin] ${k.email} ${k.methode} ${k.pfad} ${status} (${k.art})`);
    }
    // Wartet die Aktion auf Bestätigung (202), kommt die Bestätigungs-Mail statt der Quittung
    if (status !== 202) quittung.hinzu(k.email, e);
  };
  if (res && typeof res.once === 'function') res.once('finish', fertig); else fertig();
  return true;
}

/** Middleware-Form von vermerken (für Routen ohne Admin-Wächter). */
function mitKarteProtokollieren(req, res, next) { vermerken(req, res); next(); }

// ─── 3: Bestätigung per E-Mail für die heiklen Aktionen ─────────────────────
const zufall = (n = 32) => crypto.randomBytes(n).toString('base64url');
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const BEST_TOKEN_RE = /^[A-Za-z0-9_-]{40,60}$/;

function bestaetigungsMail(e, token, PORTAL_URL) {
  const link = `${PORTAL_URL}/api/karten-bestaetigung/${token}`;
  const subject = `Bitte bestätigen: ${e.text}`;
  const text = `Hallo\n\nMit deiner Rosenweg-Karte soll im Portal ausgeführt werden:\n\n  ${e.text}\n  (${e.methode} ${e.pfad})\n\n`
    + `Wann: ${zeitText(e.zeit)}\nWoher: ${herkunftText(e) || 'unbekannt'}\n\n`
    + `Erst wenn du bestätigst, geschieht es. Der Link gilt ${BESTAETIGUNG_MIN} Minuten und nur einmal:\n${link}\n\n`
    + 'Warst du das nicht? Öffne den Link und wähle "Ablehnen – Karte sperren", oder melde dich bei der Technik (technik@rosenweg4303.ch).\n\nRosenweg-Portal';
  const html = `<div style="font-family:sans-serif;max-width:560px">
<p>Hallo</p><p>Mit deiner Rosenweg-Karte soll im Portal ausgeführt werden:</p>
<p style="font-size:17px"><strong>${esc(e.text)}</strong><br><span style="color:#6b7280;font-size:13px">${esc(e.methode)} ${esc(e.pfad)}</span></p>
<p>Wann: ${esc(zeitText(e.zeit))}<br>Woher: ${esc(herkunftText(e) || 'unbekannt')}</p>
<p>Erst wenn du bestätigst, geschieht es. Der Link gilt ${BESTAETIGUNG_MIN} Minuten und nur einmal.</p>
<p><a href="${esc(link)}" style="background:#1e40af;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Ansehen und bestätigen</a>
&nbsp; <a href="${esc(link)}#ablehnen" style="color:#b91c1c">Ablehnen – Karte sperren</a></p>
<p style="color:#6b7280;font-size:13px">Auf der Seite stehen beide Knöpfe; nur das Öffnen des Links führt nichts aus.</p></div>`;
  return { to: e.email, subject, text, html };
}

/**
 * Middleware für die zwölf heiklen Routen: mit Konto weiter, mit der Karte
 * speichern, Mail schicken, 202 { bestaetigung: 'email', id, ablauf, hinweis }.
 */
async function bestaetigungVerlangen(req, res, next) {
  if (!istKartenSitzung(req)) return next();
  if (!deps?.speicher) return res.status(503).json({ error: 'Bestätigung per E-Mail ist nicht eingerichtet' });
  const k = kontext(req);
  if (!k.email) return res.status(403).json({ error: 'Keine E-Mail-Adresse hinterlegt — bitte mit dem Rosenweg-Konto anmelden' });
  const token = zufall(32);
  const e = {
    ...k, id: 'kb_' + crypto.randomBytes(12).toString('hex'), text: aktionText(k.methode, k.pfad),
    url: String(req.originalUrl || k.pfad), body: req.body && typeof req.body === 'object' ? req.body : null,
    user_id: req.user?.id || req.user?.user_id || null, ablauf: k.zeit + BESTAETIGUNG_MIN * 60 * 1000,
  };
  try {
    await deps.speicher.anlegen(e, hash(token));
    await deps.senden({ from: deps.MAIL_FROM, ...bestaetigungsMail(e, token, deps.PORTAL_URL) }, 'karten-bestaetigung');
  } catch (err) {
    console.error('[karten-bestaetigung] anlegen/Mail:', err.message);
    deps.speicher.verwerfen?.(e.id).catch?.(() => {});
    return res.status(503).json({ error: 'Die Bestätigungs-Mail konnte nicht verschickt werden — bitte mit dem Rosenweg-Konto anmelden oder später erneut versuchen' });
  }
  deps.protokollieren?.('bestaetigung-angefragt', {
    displayId: k.karte || null, email: k.email, name: k.name, durch: `${k.art}:${k.sitzung}`, erfolg: true,
    detail: `${e.text} · ${k.methode} ${k.pfad} · ${e.id}${herkunftText(k) ? ' · ' + herkunftText(k) : ''}`,
  });
  const maskiert = k.email.replace(/^(.)[^@]*(@.*)$/, '$1…$2');
  res.status(202).json({
    bestaetigung: 'email', id: e.id, ablauf: new Date(e.ablauf).toISOString(), email: maskiert,
    hinweis: `Bitte bestätige in der E-Mail, die wir dir an ${maskiert} geschickt haben. Der Link gilt ${BESTAETIGUNG_MIN} Minuten.`,
  });
}

// Einmal-Ausweise für das Ausführen nach der Bestätigung (nur im Speicher, 60 s)
const ausweise = new Map(); // sha256(token) -> { email, user_id, groups, methode, pfad, id, bis }
const AUSWEIS_PRAEFIX = 'rw_best_';
function ausweisErzeugen(e, groups, jetzt = Date.now()) {
  for (const [k, v] of ausweise) if (v.bis < jetzt) ausweise.delete(k);
  const token = AUSWEIS_PRAEFIX + zufall(32);
  ausweise.set(hash(token), { email: e.email, user_id: e.user_id, groups, methode: e.methode,
    pfad: pfadNormal(e.url || e.pfad), id: e.id, bis: jetzt + 60 * 1000 });
  return token;
}
/** Für authMiddleware: gilt genau einmal, für genau diese Methode und diesen Pfad. */
function ausweisEinloesen(token, methode, vollerPfad, jetzt = Date.now()) {
  if (!String(token || '').startsWith(AUSWEIS_PRAEFIX)) return null;
  const k = hash(token);
  const a = ausweise.get(k);
  if (!a) return null;
  ausweise.delete(k);
  if (a.bis < jetzt || a.methode !== methode || a.pfad !== pfadNormal(vollerPfad)) return null;
  return a;
}

async function standLesen(token) {
  if (!BEST_TOKEN_RE.test(String(token || ''))) return null;
  return deps.speicher.lesen(hash(token));
}

/** Bestätigen: einmalig, nicht abgelaufen; Rechte frisch; ausführen. -> { ok, status, meldung, eintrag } */
async function bestaetigen(token, jetzt = Date.now()) {
  if (!deps?.speicher || !BEST_TOKEN_RE.test(String(token || ''))) return { ok: false, meldung: 'Dieser Link ist ungültig.' };
  const e = await deps.speicher.beanspruchen(hash(token), jetzt);
  if (!e) {
    const st = await deps.speicher.lesen(hash(token));
    if (!st) return { ok: false, meldung: 'Dieser Link ist ungültig.' };
    if (st.status !== 'wartet') return { ok: false, meldung: `Diese Aktion wurde schon ${st.status === 'abgelehnt' ? 'abgelehnt' : 'bestätigt'}.`, eintrag: st };
    return { ok: false, meldung: 'Der Link ist abgelaufen. Bitte die Aktion noch einmal auslösen.', eintrag: st };
  }
  let ergebnis;
  try {
    const person = await deps.personLaden(e.email);
    if (!person || !person.aktiv) ergebnis = { status: 403, text: 'Konto nicht aktiv' };
    else ergebnis = await deps.ausfuehren(e, ausweisErzeugen(e, person.groups || []));
  } catch (err) {
    ergebnis = { status: 500, text: err.message };
  }
  const ok = ergebnis.status >= 200 && ergebnis.status < 300;
  await deps.speicher.abschliessen(e.id, ok ? 'ausgefuehrt' : 'fehlgeschlagen', ergebnis.status, String(ergebnis.text || '').slice(0, 2000));
  deps.protokollieren?.('bestaetigt', {
    displayId: e.karte || null, email: e.email, name: e.name, durch: `${e.art}:${e.sitzung}`, erfolg: ok,
    detail: `${e.text} · ${e.methode} ${e.pfad} · ${e.id} · Ergebnis ${ergebnis.status}`,
  });
  let meldung = ok ? 'Erledigt.' : `Nicht ausgeführt (Fehler ${ergebnis.status}).`;
  try { const j = JSON.parse(ergebnis.text || ''); if (!ok && (j.error || j.fehler)) meldung += ' ' + (j.error || j.fehler); } catch {}
  return { ok, status: ergebnis.status, meldung, eintrag: e };
}

/** Ablehnen: verwerfen, auslösende Sitzung abmelden, Technik melden. */
async function ablehnen(token, jetzt = Date.now()) {
  if (!deps?.speicher || !BEST_TOKEN_RE.test(String(token || ''))) return { ok: false, meldung: 'Dieser Link ist ungültig.' };
  const e = await deps.speicher.ablehnen(hash(token), jetzt);
  if (!e) return { ok: false, meldung: 'Diese Aktion ist schon erledigt oder der Link ist ungültig.' };
  if (/^ks_/.test(e.sitzung || '')) await deps.sitzungenWiderrufen?.({ id: e.sitzung }, 'Karten-Aktion per E-Mail abgelehnt').catch?.(() => {});
  deps.protokollieren?.('abgelehnt', {
    displayId: e.karte || null, email: e.email, name: e.name, durch: `${e.art}:${e.sitzung}`, erfolg: true,
    detail: `${e.text} · ${e.methode} ${e.pfad} · ${e.id} · Sitzung abgemeldet`,
  });
  Promise.resolve(deps.technikMelden?.(`⚠️ Karten-Aktion abgelehnt: ${e.name || e.email} hat per E-Mail abgelehnt: `
    + `${e.text} (${e.methode} ${e.pfad}), ausgelöst ${zeitText(e.zeit)} — ${herkunftText(e) || 'Herkunft unbekannt'}. `
    + `Die auslösende Sitzung ist abgemeldet. Karte ${e.karte || '?'} prüfen und ggf. in UniFi Access sperren.`)).catch(() => {});
  return { ok: true, meldung: 'Abgelehnt. Nichts wurde ausgeführt, die App-Anmeldung, die es ausgelöst hat, ist abgemeldet und die Technik ist informiert.', eintrag: e };
}

/** Nach dem Ablehnen (höchstens 1 h): alle Karten-Anmeldungen der Person beenden. */
async function alleAbmelden(token, jetzt = Date.now()) {
  const e = await standLesen(token);
  if (!e || e.status !== 'abgelehnt' || jetzt - Number(e.erledigt || 0) > 60 * 60 * 1000) {
    return { ok: false, meldung: 'Das geht nur kurz nach dem Ablehnen. Bitte im Profil unter „Deine Handys mit Rosenweg-Apps“ abmelden.' };
  }
  await deps.sitzungenWiderrufen({ email: e.email }, 'alle abgemeldet nach abgelehnter Karten-Aktion');
  deps.protokollieren?.('app-abmeldung', { email: e.email, durch: 'bestaetigungslink', erfolg: true, detail: `alle (${e.id})` });
  return { ok: true, meldung: 'Alle Apps, die mit deiner Karte angemeldet waren, sind abgemeldet. Die Technik sperrt die Karte, wenn sie verloren ist.' };
}

// ─── Seiten (Bestätigungslink) ──────────────────────────────────────────────
function seite(titel, inhalt) {
  // Gleiches Bild wie /app-anmelden: blauer Grund, Wappen, helle Karte, breite Knöpfe.
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="robots" content="noindex"><title>${esc(titel)} – Rosenweg</title><link rel="icon" href="/logo-rosenweg.png">`
    + `<style>`
    + `*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#1e3a8a;color:#fff;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.45}`
    + `main{max-width:28rem;margin:0 auto;padding:2rem 1.25rem;text-align:center}`
    + `.kopf{color:#bfdbfe;font-size:.85rem;margin-bottom:1rem}.wappen{width:6rem;height:6rem;display:block;margin:0 auto 1.25rem}`
    + `h1{font-size:1.5rem;margin:0 0 1rem}.karte{background:rgba(30,64,175,.5);border:2px solid #2563eb;border-radius:1rem;padding:1rem;text-align:left;margin:0 0 1.25rem}`
    + `.karte p{margin:.35rem 0}.gross{font-size:1.1rem;font-weight:600}.klein{color:#bfdbfe;font-size:.85rem}`
    + `form{margin:0 0 .75rem}button{display:block;width:100%;padding:.85rem 1rem;border-radius:14px;border:1.2px solid #fff;color:#fff;font-size:1.05rem;cursor:pointer}`
    + `p.text{margin:0 0 1.25rem}`
    + `</style></head><body><main><div class="kopf">Rosenweg · Aktion bestätigen</div>`
    + `<img class="wappen" src="/logo-rosenweg.png" alt="Rosenweg"><h1>${esc(titel)}</h1>${inhalt}</main></body></html>`;
}
const knopf = (aktion, text, farbe) => `<form method="post" action="${esc(aktion)}">`
  + `<button type="submit" style="background:${farbe}">${esc(text)}</button></form>`;

function routen(app) {
  const kopf = (res) => res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' }).type('html');
  const basis = (t) => `/api/karten-bestaetigung/${encodeURIComponent(t)}`;
  // Ansehen führt nichts aus (Mail-Scanner öffnen Links von selbst)
  app.get('/api/karten-bestaetigung/:token', async (req, res) => {
    kopf(res);
    try {
      const e = await standLesen(req.params.token);
      if (!e) return res.status(404).send(seite('Link ungültig', '<p>Diesen Bestätigungslink gibt es nicht.</p>'));
      const angaben = `<div class="karte"><p class="gross">${esc(e.text)}</p>`
        + `<p>Ausgelöst: ${esc(zeitText(e.zeit))}<br>Von: ${esc(e.name || e.email)}<br>Woher: ${esc(herkunftText(e) || 'unbekannt')}</p>`
        + `<p class="klein">${esc(e.methode)} ${esc(e.pfad)}</p></div>`;
      if (e.status !== 'wartet') return res.send(seite('Schon erledigt', angaben + `<p>Status: ${esc(e.status)}.</p>`));
      if (Date.now() > e.ablauf) {
        return res.send(seite('Link abgelaufen', angaben + '<p>Bitte die Aktion noch einmal auslösen.</p>'
          + knopf(basis(req.params.token) + '/ablehnen', 'Das war ich nicht – Karte sperren', '#b91c1c')));
      }
      res.send(seite('Aktion bestätigen', angaben
        + '<p class="text">Mit deiner Rosenweg-Karte soll das ausgeführt werden. Erst mit „Bestätigen“ geschieht es.</p>'
        + knopf(basis(req.params.token) + '/bestaetigen', 'Bestätigen', '#2563eb')
        + `<span id="ablehnen"></span>` + knopf(basis(req.params.token) + '/ablehnen', 'Ablehnen – Karte sperren', '#b91c1c')));
    } catch (err) {
      console.error('[karten-bestaetigung] ansehen:', err.message);
      res.status(500).send(seite('Fehler', '<p>Die Bestätigung konnte nicht geladen werden.</p>'));
    }
  });
  app.post('/api/karten-bestaetigung/:token/bestaetigen', async (req, res) => {
    kopf(res);
    try {
      const r = await bestaetigen(req.params.token);
      res.status(r.ok ? 200 : (r.status ? 200 : 410)).send(seite(r.ok ? 'Bestätigt' : 'Nicht ausgeführt',
        (r.eintrag ? `<div class="karte"><p class="gross">${esc(r.eintrag.text)}</p></div>` : '') + `<p class="text">${esc(r.meldung)}</p>`));
    } catch (err) {
      console.error('[karten-bestaetigung] bestaetigen:', err.message);
      res.status(500).send(seite('Fehler', '<p>Die Aktion konnte nicht ausgeführt werden.</p>'));
    }
  });
  app.post('/api/karten-bestaetigung/:token/ablehnen', async (req, res) => {
    kopf(res);
    try {
      const r = await ablehnen(req.params.token);
      res.status(r.ok ? 200 : 410).send(seite(r.ok ? 'Abgelehnt' : 'Nicht möglich', `<p>${esc(r.meldung)}</p>`
        + (r.ok ? '<p>Ist die Karte verloren oder kennst du das Gerät nicht? Alle Apps abmelden, die mit deiner Karte angemeldet sind:</p>'
          + knopf(basis(req.params.token) + '/alle-abmelden', 'Alle Apps abmelden', '#b91c1c') : '')));
    } catch (err) {
      console.error('[karten-bestaetigung] ablehnen:', err.message);
      res.status(500).send(seite('Fehler', '<p>Das Ablehnen ist fehlgeschlagen. Bitte die Technik informieren.</p>'));
    }
  });
  app.post('/api/karten-bestaetigung/:token/alle-abmelden', async (req, res) => {
    kopf(res);
    try {
      const r = await alleAbmelden(req.params.token);
      res.status(r.ok ? 200 : 410).send(seite(r.ok ? 'Abgemeldet' : 'Nicht möglich', `<p>${esc(r.meldung)}</p>`));
    } catch (err) {
      console.error('[karten-bestaetigung] alle abmelden:', err.message);
      res.status(500).send(seite('Fehler', '<p>Abmelden fehlgeschlagen. Bitte im Profil oder bei der Technik.</p>'));
    }
  });
}

// ─── Speicher in PostgreSQL ─────────────────────────────────────────────────
function sqlSpeicher(pool) {
  let bereit = null;
  const tabelle = () => (bereit ??= pool.query(`CREATE TABLE IF NOT EXISTS karten_bestaetigungen (
      id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, email TEXT NOT NULL, name TEXT, user_id INTEGER,
      methode TEXT NOT NULL, pfad TEXT NOT NULL, url TEXT NOT NULL, body JSONB, text TEXT,
      art TEXT, sitzung TEXT, karte TEXT, app TEXT, geraet TEXT, ip TEXT,
      status TEXT NOT NULL DEFAULT 'wartet', created_at TIMESTAMPTZ DEFAULT NOW(), ablauf TIMESTAMPTZ NOT NULL,
      erledigt_at TIMESTAMPTZ, ergebnis_status INTEGER, ergebnis TEXT)`).catch(e => { bereit = null; throw e; }));
  const zeile = (r) => r && ({
    id: r.id, email: r.email, name: r.name, user_id: r.user_id, methode: r.methode, pfad: r.pfad, url: r.url,
    body: r.body, text: r.text, art: r.art, sitzung: r.sitzung, karte: r.karte, app: r.app, geraet: r.geraet,
    ip: r.ip, status: r.status, zeit: new Date(r.created_at).getTime(), ablauf: new Date(r.ablauf).getTime(),
    erledigt: r.erledigt_at ? new Date(r.erledigt_at).getTime() : null,
  });
  return {
    async anlegen(e, tokenHash) {
      await tabelle();
      await pool.query(`INSERT INTO karten_bestaetigungen (id, token_hash, email, name, user_id, methode, pfad, url, body, text,
          art, sitzung, karte, app, geraet, ip, ablauf) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,to_timestamp($17 / 1000.0))`,
        [e.id, tokenHash, e.email, e.name, e.user_id, e.methode, e.pfad, e.url, e.body ? JSON.stringify(e.body) : null, e.text,
          e.art, e.sitzung, e.karte, e.app, e.geraet, e.ip, e.ablauf]);
      // Alte Inhalte (Body) nicht aufbewahren
      pool.query(`UPDATE karten_bestaetigungen SET body = NULL WHERE body IS NOT NULL AND ablauf < NOW() - INTERVAL '1 day'`).catch(() => {});
    },
    async verwerfen(id) { await pool.query('DELETE FROM karten_bestaetigungen WHERE id = $1', [id]); },
    async lesen(tokenHash) {
      await tabelle();
      return zeile((await pool.query('SELECT * FROM karten_bestaetigungen WHERE token_hash = $1', [tokenHash])).rows[0]);
    },
    async beanspruchen(tokenHash) {
      await tabelle();
      return zeile((await pool.query(`UPDATE karten_bestaetigungen SET status = 'laeuft', erledigt_at = NOW()
          WHERE token_hash = $1 AND status = 'wartet' AND ablauf > NOW() RETURNING *`, [tokenHash])).rows[0]);
    },
    async abschliessen(id, status, code, text) {
      await pool.query(`UPDATE karten_bestaetigungen SET status = $2, ergebnis_status = $3, ergebnis = $4, body = NULL
          WHERE id = $1`, [id, status, code, text]);
    },
    async ablehnen(tokenHash) {
      await tabelle();
      return zeile((await pool.query(`UPDATE karten_bestaetigungen SET status = 'abgelehnt', erledigt_at = NOW(), body = NULL
          WHERE token_hash = $1 AND status = 'wartet' RETURNING *`, [tokenHash])).rows[0]);
    },
  };
}

/** Standard-Ausführung: Aufruf an die eigene API (Loopback) mit dem Einmal-Ausweis. */
function loopbackAusfuehren(port) {
  return async (e, ausweis) => {
    const r = await fetch(`http://127.0.0.1:${port}${e.url}`, {
      method: e.methode,
      headers: { Authorization: `Bearer ${ausweis}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: e.methode === 'GET' || e.methode === 'HEAD' ? undefined : JSON.stringify(e.body || {}),
      signal: AbortSignal.timeout(60 * 1000),
    });
    return { status: r.status, text: await r.text() };
  };
}

const modul = {
  einrichten, vermerken, mitKarteProtokollieren, bestaetigungVerlangen, routen, sqlSpeicher, loopbackAusfuehren,
  ausweisEinloesen, ausweisErzeugen, bestaetigen, ablehnen, alleAbmelden, aktionText, pfadNormal, neuerBuendler,
  quittungMail, bestaetigungsMail, AUSWEIS_PRAEFIX, BESTAETIGUNG_MIN,
  _quittung: () => quittung,
};
module.exports = modul;
