// Gateway-User für den Mailversand der API (ohne Abhängigkeiten, damit testbar).
//
// Die API sendet über Mailcow-Submission (587, STARTTLS). Jede Funktion hat ihren
// eigenen Mailcow-Benutzer ("Gateway-User"), der zugleich Login und Absender ist.
// Mailcow lässt nur die eigene Adresse als Umschlag-Absender zu (553 "not owned
// by user"), deshalb ist die Gateway-Adresse immer der Umschlag-Absender.
//
// Konfiguration (je Gateway <NAME> aus MAIL_GATEWAYS, Vorgabe "2fa,noreply"):
//   MAIL_<NAME>_USER  z. B. MAIL_2FA_USER=2fa@rosenweg4303.ch
//   MAIL_<NAME>_PASS  Passwort des Mailcow-Postfachs (nur .env)
// Ein neuer Gateway-User: Postfach in Mailcow anlegen, Name in MAIL_GATEWAYS,
// USER/PASS in die .env und die Trigger unten in GATEWAY_REGELN zuordnen.

const RUECKFALL = 'noreply';

// trigger (Slug in email_log) -> Gateway. Erste passende Regel gewinnt;
// alles andere geht über RUECKFALL, bis es einen eigenen Gateway-User bekommt.
const GATEWAY_REGELN = [
  // Bestätigungen und Zweitfaktor: Karten-Bestätigungslinks, Codes, neue Geräte
  ['2fa', /^(karten-bestaetigung|karten-admin-quittung|otp-login|reklamation-code|doodle-code)$/],
  ['2fa', /-neues-geraet$/],
];

function envName(gateway) {
  return String(gateway).toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/** Liest die Gateway-User aus der Umgebung -> { name: { name, user, pass } } (nur vollständige). */
function gatewaysLesen(env = process.env) {
  const namen = String(env.MAIL_GATEWAYS || `2fa,${RUECKFALL}`)
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!namen.includes(RUECKFALL)) namen.push(RUECKFALL);
  const gw = {};
  for (const name of namen) {
    const user = String(env[`MAIL_${envName(name)}_USER`] || '').trim();
    const pass = String(env[`MAIL_${envName(name)}_PASS`] || '');
    if (user && pass) gw[name] = { name, user, pass };
  }
  return gw;
}

/** Welcher Gateway ist für diesen trigger vorgesehen (ohne Rücksicht auf Konfiguration)? */
function gatewayFuerTrigger(trigger) {
  const t = String(trigger || '');
  for (const [name, re] of GATEWAY_REGELN) if (re.test(t)) return name;
  return RUECKFALL;
}

/** Gateway für den trigger, falls nicht eingerichtet der Rückfall; null = gar keiner. */
function gatewayWaehlen(trigger, gateways) {
  const wunsch = gatewayFuerTrigger(trigger);
  return gateways[wunsch] || gateways[RUECKFALL] || null;
}

/** "Name" <adr> | adr | {name,address} -> { name, address } */
function adresseZerlegen(from) {
  if (from && typeof from === 'object') return { name: from.name || null, address: String(from.address || '').trim() };
  const s = String(from || '').trim();
  const m = s.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
  if (m) return { name: m[1].trim() || null, address: m[2].trim() };
  return { name: null, address: s };
}

// Systemabsender der API: MAIL_FROM und jede noreply@-Adresse. Diese werden durch
// die Gateway-Adresse ersetzt (Anzeigename bleibt, sonst "Rosenweg").
function istSystemAbsender(address, mailFrom) {
  const a = String(address || '').toLowerCase();
  if (!a) return true;
  if (mailFrom && a === String(mailFrom).toLowerCase()) return true;
  return /^(noreply|no-reply)@/.test(a);
}

/**
 * Setzt Absender und Umschlag für den Versand über einen Gateway-User.
 * - Systemabsender -> From = "<Name|Rosenweg>" <gateway>
 * - fremder From (z. B. Verteiler-Adresse "X via Liste" <liste@>) bleibt im Kopf,
 *   Sender: und Umschlag-Absender werden der Gateway-User.
 * Gibt neue mailOpts zurück (das Original bleibt unverändert).
 */
function absenderSetzen(mailOpts, gateway, mailFrom) {
  const { name, address } = adresseZerlegen(mailOpts.from || mailFrom);
  const opts = { ...mailOpts };
  delete opts.sender;
  delete opts.envelope;
  if (istSystemAbsender(address, mailFrom) || address.toLowerCase() === gateway.user.toLowerCase()) {
    // nodemailer leitet den Umschlag-Absender aus From ab -> Gateway-Adresse
    opts.from = { name: name || 'Rosenweg', address: gateway.user };
  } else {
    // Umschlag ausdrücklich, Empfänger parst nodemailer selbst (auch Gruppen wie
    // "undisclosed-recipients:;"), wie es das ohne envelope aus den Kopfzeilen täte.
    opts.sender = gateway.user;
    opts.envelope = { from: gateway.user, to: mailOpts.to, cc: mailOpts.cc, bcc: mailOpts.bcc };
  }
  return opts;
}

module.exports = {
  RUECKFALL, GATEWAY_REGELN, gatewaysLesen, gatewayFuerTrigger, gatewayWaehlen,
  adresseZerlegen, istSystemAbsender, absenderSetzen,
};
