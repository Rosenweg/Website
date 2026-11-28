// Runner im NOC: Annahme des Berichts vom Runner-Waechter (pve2), Lesen fuers Cockpit.
// Logik in lib/nocrunner.js.
//
//   POST /api/isp/noc/runner          pve2 (X-Runner-Token, Absender-IP)
//   GET  /api/isp/noc/public/runner   NOC (X-Noc-Token)  | ohne public: angemeldet
//
// Der letzte Bericht liegt nur im Speicher: nach einem API-Neustart zeigt die
// Kachel hoechstens eine Minute "nie", dann kommt der naechste Lauf.
const { geheimnisGleich } = require('../lib/utils');
const nr = require('../lib/nocrunner');
const { loggedSendMail } = require('../lib/mail');
const { queueWhatsappMessage, resolveTechnikWhatsappGroupId } = require('../lib/whatsapp');

const TECHNIK_MAIL = process.env.RUNNER_STAU_MAIL || 'technik@rosenweg4303.ch';

// Meldung an die Technik wie bei der Dienstwacht / dem Android-Dauertest:
// WhatsApp-Gruppe Technik, ersatzweise Mail an technik@.
async function technikMelden(text, betreff) {
  try {
    const gid = await resolveTechnikWhatsappGroupId();
    if (gid) { await queueWhatsappMessage({ chatId: gid, body: text.slice(0, 3500), sourceType: 'runner-stau' }); return; }
    console.warn('[nocrunner] keine Technik-Gruppe gefunden - Mail an technik@');
  } catch (e) { console.warn('[nocrunner] WhatsApp:', e.message, '- Mail an technik@'); }
  try { await loggedSendMail({ to: TECHNIK_MAIL, subject: betreff, text }, 'runner-stau'); }
  catch (e) { console.warn('[nocrunner] Mail:', e.message); }
}

const stauZustand = { aktiv: false, gemeldet: false, zuletzt: 0 };

const TOKEN = process.env.RUNNER_WAECHTER_TOKEN || '';
const IPS = (process.env.RUNNER_WAECHTER_IPS ?? '100.64.2.21').split(/[\s,]+/).filter(Boolean);

let letzter = null; // { bericht, zeit }

function absender(req) {
  return String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

function annehmen(req, res) {
  if (!TOKEN) return res.status(503).json({ error: 'RUNNER_WAECHTER_TOKEN nicht gesetzt' });
  if (!geheimnisGleich(req.headers['x-runner-token'], TOKEN)) return res.status(403).json({ error: 'Token ungueltig' });
  if (IPS.length && !IPS.includes(absender(req))) {
    console.warn(`[nocrunner] POST von ${absender(req)} abgewiesen`);
    return res.status(403).json({ error: 'Absender nicht zugelassen' });
  }
  const e = nr.eingabePruefen(req.body);
  if (e.fehler) return res.status(400).json({ error: e.fehler });
  letzter = { bericht: e.bericht, zeit: Date.now() };
  res.json({ ok: true });
  // Stau-Alarm (nicht im Trockenlauf des Waechters)
  if (!e.bericht.trocken) {
    const was = nr.stauEntscheiden(stauZustand, e.bericht.stau);
    const st = e.bericht.stau;
    if (was === 'alarm') {
      technikMelden(`\u{1F7E0} Runner-Stau: ${st.lange} Jobs warten laenger als ${nr.STAU_S / 60} Minuten (Grenze: mehr als ${nr.STAU_JOBS} oder ein Job ueber ${nr.STAU_EINZEL_S / 60} Min; insgesamt ${st.wartend} wartend, aeltester ${Math.round((st.aeltester_s || 0) / 60)} Min).\nDetails im NOC, Kachel Runner.`, 'Runner-Stau');
    } else if (was === 'entwarnung') {
      technikMelden('\u2705 Runner-Stau abgebaut: die Warteschlange liegt wieder unter den Grenzen.', 'Runner-Stau abgebaut');
    }
  }
}

function lesen(req, res) {
  const z = nr.zusammenfassung(letzter?.bericht || null, letzter?.zeit || 0);
  res.json(req.nocOffen ? nr.oeffentlich(z) : z);
}

module.exports = { annehmen, lesen };
