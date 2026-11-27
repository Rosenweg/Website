// Kerberos-Anmeldung der Agenten (Protokoll v2, routes/stationen-v2.js).
//
// Ein Rechner der Domäne weist sich mit seinem Computerkonto aus: der Agent
// läuft als SYSTEM (Windows) und holt sich beim KDC ein Ticket für den Dienst
// der API (STATION_KRB5_SPN, Vorgabe HTTP/www.rosenweg4303.ch). Auf dem Gerät
// liegt dafür kein Geheimnis von uns — den Schlüssel des Computerkontos hat
// Windows ohnehin, und er wechselt von selbst alle 30 Tage.
//
// Geprüft wird das Ticket von api/kerberos-pruefer (Go, gokrb5) mit der Keytab
// des Dienstkontos (STATION_KRB5_KEYTAB). Warum ein eigenes Programm: siehe
// dort. Hier: Aufruf, Zeitgrenze, und die Wiederholungssperre, die der
// kurzlebige Prüfprozess selbst nicht halten kann.
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PRUEFER = process.env.STATION_KRB5_PRUEFER || '/usr/local/bin/kerberos-pruefer';
const KEYTAB = process.env.STATION_KRB5_KEYTAB || '/run/secrets/stationen-api.keytab';
const SPN = process.env.STATION_KRB5_SPN || 'HTTP/www.rosenweg4303.ch';
// Der Realm des AD — Kerberos-Realms schreibt man gross.
const REALM = (process.env.STATION_KRB5_REALM || process.env.AD_DOMAIN || 'ad.rosenweg4303.ch').toUpperCase();

/** Ist Kerberos eingerichtet (Prüfprogramm und Keytab vorhanden)? */
function bereit() {
  try {
    fs.accessSync(PRUEFER, fs.constants.X_OK);
    fs.accessSync(KEYTAB, fs.constants.R_OK);
    return true;
  } catch { return false; }
}

// Schon gesehene Tokens. Ein Authenticator gilt fünf Minuten (Uhrabweichung);
// wer ein Token mitliest — es läuft über TLS, aber trotzdem —, soll es in
// dieser Zeit nicht ein zweites Mal einreichen können. Bei mehreren
// API-Instanzen hält jede ihre eigene Liste; das Fenster bleibt dasselbe.
const gesehen = new Map(); // sha256 -> Ablauf (ms)
const SPERRE_MS = 10 * 60 * 1000;
function wiederholt(token, jetzt = Date.now()) {
  for (const [k, bis] of gesehen) if (bis < jetzt) gesehen.delete(k);
  const h = crypto.createHash('sha256').update(token).digest('hex');
  if (gesehen.has(h)) return true;
  gesehen.set(h, jetzt + SPERRE_MS);
  return false;
}

/**
 * Den Inhalt eines "Authorization: Negotiate …"-Headers prüfen.
 * @returns {Promise<{ok:true, principal, realm}|{ok:false, grund}>}
 */
function pruefen(header, { pruefer = PRUEFER, keytab = KEYTAB, spn = SPN, ausfuehren = execFile } = {}) {
  const m = /^Negotiate\s+([A-Za-z0-9+/=]{16,90000})$/.exec(String(header || '').trim());
  if (!m) return Promise.resolve({ ok: false, grund: 'kein Negotiate-Token' });
  const token = m[1];
  if (wiederholt(token)) return Promise.resolve({ ok: false, grund: 'Token schon einmal benutzt' });
  return new Promise((ok) => {
    const p = ausfuehren(pruefer, ['-keytab', keytab, '-spn', spn],
      { timeout: 10000, maxBuffer: 64 * 1024, env: {} },
      (fehler, stdout) => {
        let e = null;
        try { e = JSON.parse(String(stdout || '').trim().split('\n').pop()); } catch { e = null; }
        if (e && e.ok === true && typeof e.principal === 'string') {
          return ok({ ok: true, principal: e.principal, realm: String(e.realm || '') });
        }
        ok({ ok: false, grund: (e && e.grund) || (fehler ? `Prüfung gescheitert: ${fehler.message}` : 'ungültig') });
      });
    p.stdin.end(token + '\n');
  });
}

module.exports = { bereit, pruefen, wiederholt, SPN, REALM };
