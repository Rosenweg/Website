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
}

function lesen(req, res) {
  const z = nr.zusammenfassung(letzter?.bericht || null, letzter?.zeit || 0);
  res.json(req.nocOffen ? nr.oeffentlich(z) : z);
}

module.exports = { annehmen, lesen };
