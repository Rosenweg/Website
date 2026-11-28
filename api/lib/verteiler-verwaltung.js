// Hausverwaltung und STWEG-Mailverteiler (email_verteiler).
//
// Empfangen: Ein Bewohner-/Eigentuemer-Verteiler einer STWEG (Rundmail) geht
// auch an die Hausverwaltung dieser STWEG (Gruppe stwegN-verwaltung bzw.
// meg-verwaltung). Frueher bekam sie die Mails nur, weil ihr Konto zusaetzlich
// in der Bewohnergruppe stand; ein Verwalter ist aber kein Bewohner.
//
// Senden: An einen geschuetzten Verteiler (allowed_sender_groups) darf die
// Verwaltung nur, wenn sie die STWEG des Verteilers verwaltet – nicht mehr an
// jeden Verteiler aller STWEGs.
const { STWEG_GROUPS, VERWALTUNG_GROUPS, verwaltungGruppenStwegs, verwaltungStwegs } = require('./groups');

function verteilerStweg(verteiler) {
  const n = parseInt(verteiler && verteiler.stweg, 10);
  return Number.isFinite(n) && VERWALTUNG_GROUPS[n] ? n : null;
}

function gruppenNamen(verteiler) {
  if (!verteiler) return [];
  if (Array.isArray(verteiler.group_names) && verteiler.group_names.length) return verteiler.group_names.map(String);
  return verteiler.group_name ? [String(verteiler.group_name)] : [];
}

// Ist der Verteiler eine Rundmail an Bewohner/Eigentuemer seiner STWEG?
// Ja, wenn er eine Bewohner-/Eigentuemergruppe dieser STWEG aufloest oder eine
// Live-Liste aus der Objektverwaltung (verwaltung:bewohner|eigentuemer|mieter).
function istBewohnerRundmail(verteiler) {
  const nr = verteilerStweg(verteiler);
  if (!nr) return false;
  const m = STWEG_GROUPS[nr] || {};
  const eigene = new Set([m.bewohner, m.eigentuemer].filter(Boolean).map(x => x.toLowerCase()));
  return gruppenNamen(verteiler).some((gn) => {
    const g = gn.toLowerCase();
    if (eigene.has(g)) return true;
    const live = g.match(/^verwaltung:(bewohner|eigentuemer|mieter)(:|$)/);
    return !!live;
  });
}

// Gruppe der Hausverwaltung, die diese Rundmail zusaetzlich bekommt (oder null).
function verwaltungsGruppeFuerVerteiler(verteiler) {
  return istBewohnerRundmail(verteiler) ? VERWALTUNG_GROUPS[verteilerStweg(verteiler)] : null;
}

// Darf ein Absender mit diesen Authentik-Gruppen als Hausverwaltung an den
// Verteiler senden? Nur die Verwaltung DIESER STWEG (ohne Übergangsgruppe: die
// alte Gruppe „Verwaltung“ prueft der Server ueber den Vertrag, siehe
// verwaltungDarfSenden in server.js).
function verwaltungsGruppeDarfSenden(userGroupNames, verteiler) {
  const nr = verteilerStweg(verteiler);
  return !!nr && verwaltungGruppenStwegs(userGroupNames || []).has(nr);
}

// ─── Portal: Seite email-verteiler.html fuer die Verwaltung (Befund V2) ───
// Entscheid Stefan: Die Verwaltung bekommt die Rundmails ihrer STWEG und darf an
// deren Verteiler senden (per Mail an die Adresse geht das schon, s. oben).
// Im Portal sieht sie mit Seitenrecht „email-verteiler“ (ab lesen) nur die
// Verteiler ihrer STWEG(s) – Name, Adresse, Anzahl Empfaenger, ohne
// Mitgliederliste – und kann an diese ueber das Formular senden. Verwalten,
// Testversand und Versand-Protokoll bleiben bei Technik/Praesident.
const STUFE = { read: 1, write: 2 };

/** STWEGs, deren Verteiler die Verwaltung im Portal sieht (leer = keine). */
function portalVerteilerStwegs(groups, perm) {
  if ((STUFE[perm] || 0) < 1) return new Set();
  return verwaltungStwegs(groups || []);
}

/** Darf die Verwaltung im Portal senden? Recht „email-verteiler“ = schreiben
 *  (Entscheid Stefan 27.11.2026, Befund V10); lesen zeigt nur die Liste. */
function portalDarfSendenRecht(perm) {
  return (STUFE[perm] || 0) >= 2;
}

/** Darf die Verwaltung im Portal an diesen Verteiler senden? */
function portalDarfSenden(groups, perm, verteiler) {
  const nr = verteilerStweg(verteiler);
  return portalDarfSendenRecht(perm) && !!nr && !!(verteiler && verteiler.active !== false)
    && portalVerteilerStwegs(groups, perm).has(nr);
}

/** Anzeigename des Absenders („Ihr Name (optional)“, V10): ohne Steuerzeichen,
 *  Anfuehrungszeichen und spitze Klammern, hoechstens 80 Zeichen; leer = Kontoname. */
function absenderName(eingabe, kontoName) {
  const sauber = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f"<>\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim();
  return sauber(eingabe) || sauber(kontoName) || 'Rosenweg';
}

/** Zeile fuer email_archive aus einer Portal-Rundmail (V10). An: die
 *  Verteiler-Adresse, ohne Verteiler die Anzahl – nie die Empfaengerliste. */
function portalRundmailArchiv({ absenderEmail, absenderName: name, verteilerAdresse, anzahl, subject, text, html, messageId }) {
  return {
    from_email: String(absenderEmail || '').slice(0, 255),
    from_name: name || null,
    to_addresses: verteilerAdresse || `${Number(anzahl) || 0} Empfänger (BCC)`,
    subject: subject || '(kein Betreff)',
    text_body: text || '',
    html_body: html || '',
    message_id: String(messageId || `<portal-verteiler-${require('crypto').randomUUID()}@rosenweg>`).slice(0, 500),
  };
}

/** Felder eines Verteilers fuer die Verwaltung (ohne Mitglieder/Gruppen). */
function fuerVerwaltung(v) {
  return {
    id: v.id, stweg: v.stweg, name: v.name, email_address: v.email_address,
    active: v.active, member_count: v.member_count,
  };
}

/**
 * PUT /api/verteiler/:id (L4): neue Werte aus dem Body, fehlende Felder behalten
 * den alten Wert. Frueher wurde members ohne Feld geleert, active ohne Feld true
 * und stweg ohne Feld NULL. Explizit gesendete Werte gelten wie bisher
 * (members: [] leert, active: false deaktiviert).
 */
function verteilerAenderung(alt, body) {
  const b = body || {};
  const da = (k) => Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined;
  const liste = (v) => (Array.isArray(v) ? v : []);
  let groupNames = gruppenNamen(alt);
  if (da('group_names') || da('group_name')) {
    groupNames = Array.isArray(b.group_names) && b.group_names.length ? b.group_names : (b.group_name ? [b.group_name] : []);
  }
  return {
    stweg: da('stweg') ? b.stweg : alt.stweg,
    name: da('name') ? b.name : alt.name,
    email_address: da('email_address') ? b.email_address : alt.email_address,
    members: da('members') ? liste(b.members) : liste(alt.members),
    active: da('active') ? b.active !== false : alt.active !== false,
    reply_to: da('reply_to') ? (b.reply_to || 'sender') : (alt.reply_to || 'sender'),
    subject_prefix: da('subject_prefix') ? (b.subject_prefix || null) : (alt.subject_prefix ?? null),
    group_name: groupNames[0] || null,
    group_names: groupNames,
    allowed_sender_groups: da('allowed_sender_groups') ? liste(b.allowed_sender_groups) : liste(alt.allowed_sender_groups),
    whatsapp_group_id: da('whatsapp_group_id') ? (b.whatsapp_group_id || null) : (alt.whatsapp_group_id ?? null),
    whatsapp_group_name: da('whatsapp_group_name') ? (b.whatsapp_group_name || null) : (alt.whatsapp_group_name ?? null),
    external_allowed: da('external_allowed') ? b.external_allowed === true : alt.external_allowed === true,
  };
}

/** L11: Idempotency-Key pruefen. -> Schluessel | null (keiner) | false (ungueltig). */
function idempotenzSchluessel(wert) {
  if (wert === undefined || wert === null || wert === '') return null;
  const s = String(wert).trim();
  return /^[A-Za-z0-9._:-]{8,128}$/.test(s) ? s : false;
}

/** L11: Fingerabdruck des Inhalts; derselbe Schluessel fuer anderen Inhalt wird abgewiesen. */
function sendeFingerabdruck(body) {
  const b = body || {};
  const inhalt = JSON.stringify([
    b.verteiler_id == null ? null : String(b.verteiler_id),
    String(b.subject ?? ''), String(b.body ?? ''), String(b.sender_name ?? ''),
    Array.isArray(b.recipients) ? b.recipients.map(String) : [],
  ]);
  return require('crypto').createHash('sha256').update(inhalt).digest('hex');
}

module.exports = {
  verteilerAenderung, idempotenzSchluessel, sendeFingerabdruck,
  istBewohnerRundmail, verwaltungsGruppeFuerVerteiler, verwaltungsGruppeDarfSenden, verteilerStweg,
  portalVerteilerStwegs, portalDarfSenden, portalDarfSendenRecht, absenderName, portalRundmailArchiv, fuerVerwaltung,
};
