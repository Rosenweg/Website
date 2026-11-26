// Anmeldung der Rosenweg-Apps (Authentik-Anwendung "rosenweg-apps") an der API.
//
// Dieselben Regeln wie routes/app-tunnel.js (Rosenweg Virtuelle Computer):
// Token über userinfo prüfen, dann nachsehen, ob es für rosenweg-apps
// ausgestellt wurde, und die users-Zeile an dasselbe Authentik-Konto binden.
// Zusätzlich hier: die Gruppen der Person, damit Routen Rechte prüfen können
// (die Tunnel-Route braucht keine, der Gateway fragt Proxmox).
//
// Die Introspektion in lib/auth.js kennt nur Tokens des Website-Clients;
// deshalb dieser eigene Weg. app-tunnel.js kann später auf diese Datei
// umgestellt werden — bewusst nicht im selben Schritt, die Route ist live.

const crypto = require('crypto');
const { AUTHENTIK_URL } = require('./config');
const { pool, auditCtx } = require('./db');

const APPS_CLIENT_ID = process.env.ROSENWEG_APPS_CLIENT_ID || 'rosenweg-apps';
const CACHE_MS = 60 * 1000;

const cache = new Map(); // sha256(token) -> { user, zeit }
setInterval(() => {
  const jetzt = Date.now();
  for (const [k, v] of cache) if (jetzt - v.zeit > CACHE_MS) cache.delete(k);
}, 5 * 60 * 1000).unref();

// Claims OHNE Signaturprüfung — nur zur Wahl des Weges und, NACHDEM
// userinfo das Token bestätigt hat, für die Frage nach dem Client.
function claimsLesen(token) {
  try {
    const teil = String(token).split('.')[1];
    return JSON.parse(Buffer.from(teil, 'base64url').toString('utf8'));
  } catch { return null; }
}

function istAppToken(token) {
  const c = claimsLesen(token);
  if (!c) return false;
  return [].concat(c.aud || [], c.azp || []).includes(APPS_CLIENT_ID);
}

/** Prüft ein rosenweg-apps-Token. Wirft {status, error} bei Ablehnung. */
async function appKontoPruefen(token) {
  const schluessel = crypto.createHash('sha256').update(token).digest('hex');
  const gemerkt = cache.get(schluessel);
  if (gemerkt && Date.now() - gemerkt.zeit < CACHE_MS) return gemerkt.user;

  let r;
  try {
    r = await fetch(`${AUTHENTIK_URL}/application/o/userinfo/`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(6000),
    });
  } catch (e) {
    throw { status: 503, error: 'Anmeldedienst nicht erreichbar' };
  }
  if (r.status >= 500) throw { status: 503, error: 'Anmeldedienst nicht erreichbar' };
  if (!r.ok) throw { status: 401, error: 'Anmeldung abgelaufen' };
  let info;
  try { info = await r.json(); } catch { throw { status: 503, error: 'Anmeldedienst nicht erreichbar' }; }
  if (!istAppToken(token)) throw { status: 401, error: 'Token gehört nicht zu den Rosenweg-Apps' };

  const email = String(info.email || '').trim().toLowerCase();
  if (!email) throw { status: 400, error: 'Zu diesem Konto ist keine Mailadresse hinterlegt' };
  const sub = String(info.sub || '');
  const u = await pool.query(
    'SELECT id, name, role, active, authentik_sub, groups_json FROM users WHERE LOWER(email) = $1 LIMIT 1', [email]);
  const zeile = u.rows[0];
  if (zeile?.active === false) throw { status: 401, error: 'Konto deaktiviert' };
  if (zeile?.authentik_sub && sub && zeile.authentik_sub !== sub) {
    console.warn(`[appkonto] abgewiesen: users-Zeile ${email} gehoert zu anderem Authentik-Konto`);
    throw { status: 403, error: 'Diese Mailadresse gehört zu einem anderen Konto' };
  }
  // Gruppen: was Authentik jetzt sagt (Claim "groups" im Bereich profile);
  // fehlt der Claim, der zuletzt abgeglichene Stand der users-Zeile.
  let groups = Array.isArray(info.groups) ? info.groups.map(String) : null;
  if (!groups) { try { groups = JSON.parse(zeile?.groups_json || '[]'); } catch { groups = []; } }
  const technik = groups.some(g => g.toLowerCase() === 'technik');
  const user = {
    id: zeile?.id || null, user_id: zeile?.id || null,
    email, name: info.name || zeile?.name || email,
    groups, isAdmin: technik || zeile?.role === 'admin', app: APPS_CLIENT_ID,
  };
  cache.set(schluessel, { user, zeit: Date.now() });
  return user;
}

/**
 * Middleware: nimmt Tokens der Rosenweg-Apps UND alles, was authMiddleware
 * kennt (Browser-Sitzung, Website-Token, PAT). Damit dient eine Route der
 * App und der Portal-Seite zugleich.
 */
function appOderPortal(authMiddleware) {
  return async function (req, res, next) {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token || token.length > 4096) return res.status(401).json({ error: 'Nicht angemeldet' });
    if (token.startsWith('rw_pat_') || !istAppToken(token)) return authMiddleware(req, res, next);
    try {
      req.user = await appKontoPruefen(token);
      return auditCtx.run({ userEmail: req.user.email }, next);
    } catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: e.error });
      console.error('[appkonto]', e?.message);
      return res.status(503).json({ error: 'Anmeldedienst nicht erreichbar' });
    }
  };
}

module.exports = { APPS_CLIENT_ID, claimsLesen, istAppToken, appKontoPruefen, appOderPortal };
