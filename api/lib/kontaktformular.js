// Kontaktformular der Startseite (Befund W1): Nachricht an technik@ ueber das
// Mailcow-Gateway (lib/mail.js), ohne Anmeldung. Hier nur Pruefung und Mail-
// Inhalt (rein, testbar); Drossel und Versand macht die Route in server.js.
//
// Schutz: Honigtopf-Feld „website“ (Menschen sehen es nicht; ist es gefuellt,
// antwortet die Route ohne Versand mit ok), Laengengrenzen, gueltige Absender-
// adresse nur als Reply-To (nie als From), Drossel je IP und gesamt.
const ZIEL = 'technik@rosenweg4303.ch';
const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;.]+(?:\.[^\s@<>,;.]+)+$/;

function sauber(v, max) {
  // Steuerzeichen und Zeilenumbrueche in Kopfzeilen raus
  return String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}

/** -> { fehler } oder { name, email, betreff, nachricht, spam } */
function pruefen(body) {
  const b = body || {};
  if (String(b.website || '').trim()) return { spam: true };
  const name = sauber(b.name, 100).replace(/[\r\n]+/g, ' ');
  const email = sauber(b.email, 254).toLowerCase();
  const betreff = sauber(b.betreff, 150).replace(/[\r\n]+/g, ' ');
  const nachricht = sauber(b.nachricht, 5000);
  if (!name) return { fehler: 'Bitte Ihren Namen angeben.' };
  if (!EMAIL_RE.test(email)) return { fehler: 'Bitte eine gültige E-Mail-Adresse angeben, damit wir antworten können.' };
  if (nachricht.length < 5) return { fehler: 'Bitte eine Nachricht schreiben.' };
  return { name, email, betreff, nachricht };
}

function mail(k, from) {
  return {
    from,
    to: ZIEL,
    replyTo: k.email,
    subject: `[Kontaktformular] ${k.betreff || 'Nachricht von ' + k.name}`,
    text: `Nachricht über das Kontaktformular der Website\n\nVon: ${k.name} <${k.email}>\n`
      + (k.betreff ? `Betreff: ${k.betreff}\n` : '') + `\n${k.nachricht}\n\n`
      + '— Antworten geht direkt an die Absenderin bzw. den Absender (Reply-To).',
  };
}

module.exports = { ZIEL, pruefen, mail };
