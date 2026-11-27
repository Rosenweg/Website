// ─── Telefonanlage für geteilte Telefone: /api/telefonanlage/* ──────────────
//
// Rosenweg Mein Telefon stellt auf eigenen Handys und am Computer die Anlage
// (pbx.rosenweg4303.ch, CT 220) direkt mit dem Token der Anmeldung. Auf einem
// GETEILTEN Telefon gibt es kein Token: Rosenweg Gerät reicht die Anfrage über
// die Anlage (POST /api/telefon/portal) als Anlage-Token hierher, und nur hierher.
// Entscheid Stefan 27.11.2026: Mein Telefon soll auch dort einstellen können –
// diese Routen reichen genau die Anfragen der App an die Anlage weiter.
//
//   GET    /api/telefonanlage/ich                  → GET    /api/telefon/ich
//   PUT    /api/telefonanlage/ich/erreichbarkeit   → PUT    /api/telefon/ich/erreichbarkeit
//   GET    /api/telefonanlage/meine                → GET    /api/telefon/meine
//   POST   /api/telefonanlage/ausweis              → POST   /api/telefon/ausweis
//   DELETE /api/telefonanlage/privat/:id           → DELETE /api/telefon/privat/:id
//   POST   /api/telefonanlage/:ext/abmelden        → POST   /api/telefon/:ext/abmelden
//   GET|POST /api/telefonanlage/:ext/suchen        → GET|POST /api/telefon/:ext/suchen
//
// Nur mit dem Anlage-Token (req.anlage): wer die Person ist, sagt die Sitzung am
// Telefon (Karte am Sperrbildschirm), Gruppen und "aktiv" kommen frisch aus users
// (middleware/auth.js). Alle anderen Anmeldungen sprechen die Anlage selbst an –
// hier: 403, damit kein zweiter Weg entsteht.
//
// Zur Anlage: Geheimnis PBX_SHARED_SECRET (X-PBX-Secret, wie Fernwartung/NOC) und
// die Person im Kopf X-Rosenweg-Im-Auftrag (base64url-JSON {id, email, name,
// groups}). Die Anlage nimmt den Kopf nur mit dem Geheimnis und nur für genau
// diese Pfade an und gibt der Person dort KEINE Technik-Rechte (nur die eigene
// Nummer, die eigenen Geräte) – pbx/api/app.py, _im_auftrag().
'use strict';

const PFX = '/api/telefonanlage/';
const ANTWORT_MAX = 512 * 1024;

/** [Methode, Muster des Restpfads] – mehr gibt es nicht. */
const ERLAUBT = [
  ['GET', /^ich$/],
  ['PUT', /^ich\/erreichbarkeit$/],
  ['GET', /^meine$/],
  ['POST', /^ausweis$/],
  ['DELETE', /^privat\/[0-9]{1,9}$/],
  ['POST', /^[0-9]{2,8}\/abmelden$/],
  ['GET', /^[0-9]{2,8}\/suchen$/],
  ['POST', /^[0-9]{2,8}\/suchen$/],
];

/** Methode + voller Pfad (mit /api/telefonanlage/) → Pfad der Anlage oder null. */
function zielPfad(methode, pfad) {
  const weg = String(pfad || '').split('?')[0];
  if (!weg.startsWith(PFX)) return null;
  const rest = weg.slice(PFX.length);
  return ERLAUBT.some(([m, re]) => m === methode && re.test(rest)) ? `/api/telefon/${rest}` : null;
}

/** Person für die Anlage: nur was sie braucht, base64url (Namen mit Umlauten im Kopf). */
function personKopf(user) {
  const u = user || {};
  const daten = {
    id: u.id ?? u.user_id ?? null,
    email: String(u.email || ''),
    name: String(u.name || ''),
    groups: Array.isArray(u.groups) ? u.groups.map(String) : [],
  };
  return Buffer.from(JSON.stringify(daten), 'utf8').toString('base64url');
}

function telefonanlageRoutes(app, deps) {
  const { authMiddleware, pbxUrl, pbxGeheimnis, fetchFn = (...a) => fetch(...a) } = deps;

  app.all(`${PFX}*`, authMiddleware, async (req, res) => {
    if (!req.anlage) {
      return res.status(403).json({ error: 'Nur für geteilte Telefone – sonst die Telefonanlage direkt fragen' });
    }
    const ziel = zielPfad(req.method, (req.baseUrl || '') + req.path);
    if (!ziel) return res.status(404).json({ error: 'Nicht gefunden' });
    if (!pbxGeheimnis() || !req.user?.email) return res.status(503).json({ error: 'Telefonanlage nicht eingerichtet' });
    const mitKoerper = req.method === 'PUT' || req.method === 'POST';
    try {
      const r = await fetchFn(`${pbxUrl}${ziel}`, {
        method: req.method,
        headers: {
          'X-PBX-Secret': pbxGeheimnis(),
          'X-Rosenweg-Im-Auftrag': personKopf(req.user),
          'X-Rosenweg-Telefon': req.anlage.ext,
          Accept: 'application/json',
          ...(mitKoerper ? { 'Content-Type': 'application/json' } : {}),
        },
        body: mitKoerper ? JSON.stringify(req.body || {}) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
      const text = await r.text();
      if (text.length > ANTWORT_MAX) return res.status(502).json({ error: 'Antwort der Telefonanlage zu gross' });
      let json;
      try { json = text ? JSON.parse(text) : {}; } catch { return res.status(502).json({ error: 'Telefonanlage antwortet nicht richtig' }); }
      if (req.method !== 'GET' || r.status >= 400) {
        console.log(`[telefonanlage] ${req.method} ${ziel} für ${req.user.email} (Telefon ${req.anlage.ext}) -> ${r.status}`);
      }
      res.set('Cache-Control', 'no-store');
      // 401 der Anlage hiesse fuer die App "abgemeldet" – die Person ist aber am Telefon angemeldet;
      // abgelehnt hat die Anlage den Weg (Geheimnis, Kopf). Ehrlich als Stoerung melden.
      if (r.status === 401) return res.status(502).json({ error: 'Telefonanlage hat die Anfrage abgelehnt' });
      return res.status(r.status).json(json);
    } catch (e) {
      console.warn('[telefonanlage]', req.method, ziel, e.name || e.message);
      return res.status(502).json({ error: 'Telefonanlage nicht erreichbar' });
    }
  });
}

module.exports = { telefonanlageRoutes, zielPfad, personKopf, ERLAUBT };
