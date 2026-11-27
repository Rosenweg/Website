// Statusmeldung an die meldende Person einer Reklamation (E-Mail, WhatsApp).
// Die Notiz (intern) gehoert der Technik/dem Ausschuss und geht NIE an die
// meldende Person. Eine Bemerkung fuer sie kommt nur aus dem eigenen Feld
// melder_bemerkung (Seite: „Nachricht an die meldende Person“, Technik-Bot:
// Arbeitsschritt).

const MAX_BEMERKUNG = 500;

const LABEL = {
  weitergeleitet: 'an Handwerker weitergeleitet',
  erledigt: 'als erledigt markiert',
  abgewiesen: 'abgewiesen',
  offen: 'wieder geöffnet',
};

// Bemerkung fuer die meldende Person aus den Feldern eines Updates. Liest
// bewusst nur melder_bemerkung, nie notiz.
function melderBemerkung(felder) {
  const v = felder && felder.melder_bemerkung;
  return typeof v === 'string' ? v.trim().slice(0, MAX_BEMERKUNG) : '';
}

function statusLabel(status) {
  return LABEL[status] || String(status || '');
}

// E-Mail geht nur bei Abschluss (erledigt/abgewiesen), WhatsApp bei jedem Wechsel.
function mailBeiStatus(status) {
  return status === 'erledigt' || status === 'abgewiesen';
}

// Texte der Statusmeldung. rekl: {id, beschreibung}; name: Name der meldenden Person.
function nachricht({ rekl, name, status, bemerkung, siteUrl }) {
  const label = statusLabel(status);
  const kurz = String((rekl && rekl.beschreibung) || '');
  const b = typeof bemerkung === 'string' ? bemerkung : '';
  const emoji = status === 'erledigt' ? '✅' : status === 'abgewiesen' ? '❌' : status === 'weitergeleitet' ? '➡️' : '🔄';
  return {
    label,
    subject: `Deine Reklamation #${rekl.id} wurde ${label}`,
    text: `Hallo ${name},\n\ndeine Reklamation "${kurz.slice(0, 100)}" wurde ${label}.\n`
      + (b ? `\nBemerkung: ${b}\n` : '')
      + `\nDetails: ${siteUrl}/reklamationen.html`,
    whatsapp: `${emoji} *Reklamation #${rekl.id} ${label}*\n${kurz.slice(0, 80)}` + (b ? `\n\n_Bemerkung:_ ${b}` : ''),
  };
}

module.exports = { melderBemerkung, statusLabel, mailBeiStatus, nachricht, MAX_BEMERKUNG };
