// Drossel für die Alarm-Mails des WhatsApp-Watchdogs (server.js, checkBotNotReady).
//
// Bis 11/2026 setzte ein gescheiterter Versand die Sperre zurück; als der Mailversand
// ab 16.11. ausfiel, ging "⚠ WhatsApp-Bot nicht verbunden" deshalb jede Minute erneut
// raus (1019 Versuche in 24 h). Jetzt zählt jeder Versuch, ob er klappt oder nicht:
// höchstens ein Alarm je ABSTAND_MS, solange der Zustand gleich bleibt.

const SCHWELLE_MS = 15 * 60 * 1000;     // erst melden, wenn der Zustand so lange anhält
const ABSTAND_MS = 6 * 60 * 60 * 1000;  // danach höchstens einmal je 6 h

/**
 * Ist jetzt ein Alarm fällig?
 * seit: Beginn des Zustands (Date|null), letzterVersuch: letzter Alarmversuch (Date|null).
 */
function alarmFaellig({ seit, letzterVersuch, jetzt = new Date(), schwelleMs = SCHWELLE_MS, abstandMs = ABSTAND_MS }) {
  if (!seit) return false;
  if (jetzt - seit < schwelleMs) return false;
  if (letzterVersuch && jetzt - letzterVersuch < abstandMs) return false;
  return true;
}

module.exports = { SCHWELLE_MS, ABSTAND_MS, alarmFaellig };
