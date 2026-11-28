// Vier-Augen-Prinzip der Outbox (Befund F2, Rundmail-Prüfung Nov. 2026):
// Wer eine Mail eingestellt oder ihren Inhalt zuletzt bearbeitet hat, darf sie
// nicht selbst freigeben – auch nicht als Technik oder Präsident. Verglichen
// wird ueber die Konto-ID (users.id); die E-Mail-Adresse zaehlt nur, wenn zu
// einer alten Zeile keine Konto-ID bekannt ist.

const norm = (e) => String(e || '').trim().toLowerCase();
const id = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : null; };

/** Ist eine Person (Konto-ID, E-Mail) dieselbe wie die Beteiligte (Konto-ID, E-Mail)? */
function gleichePerson(kontoId, email, beteiligtId, beteiligtEmail) {
  const a = id(kontoId), b = id(beteiligtId);
  if (a && b) return a === b;
  const e = norm(email), f = norm(beteiligtEmail);
  return !!e && e === f;
}

/**
 * Waere die Freigabe eine Selbstfreigabe?
 * @param {{id?, email?}} freigeber   req.user
 * @param {{created_by_id?, created_by?, edited_by_id?, edited_by?}} mail  Zeile der Queue
 * @returns {null|'ersteller'|'bearbeiter'}
 */
function selbstfreigabe(freigeber, mail) {
  const fid = freigeber && (freigeber.id || freigeber.user_id);
  const fmail = freigeber && freigeber.email;
  if (!mail) return null;
  if ((mail.created_by_id || mail.created_by) && gleichePerson(fid, fmail, mail.created_by_id, mail.created_by)) return 'ersteller';
  if ((mail.edited_by_id || mail.edited_by) && gleichePerson(fid, fmail, mail.edited_by_id, mail.edited_by)) return 'bearbeiter';
  return null;
}

const MELDUNG = {
  ersteller: 'Vier-Augen-Prinzip: Die eigene Mail muss eine andere Person freigeben.',
  bearbeiter: 'Vier-Augen-Prinzip: Wer den Inhalt zuletzt bearbeitet hat, darf nicht selbst freigeben.',
};

module.exports = { selbstfreigabe, gleichePerson, MELDUNG };
