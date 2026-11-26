// ─── Tunnel für die App „Rosenweg Virtuelle Computer“ ───────────────────────
//
// Die App erreicht Proxmox nie direkt, sondern nur über den vm-gateway (eigener
// CT, Code im Repo Rosenweg/rosenweg-vm, Ordner gateway/). Dort endet ihr
// WireGuard-Tunnel — getrennt von wg-control und den Wohnungs-VLANs
// (Entscheid Stefan 25.11.2026: „ein CT, der direkt Verbindung zu den Hosts
// aufbaut“). Durch den Tunnel erreicht die App nur zwei Ports des Gateways.
//
// Diese Route ist nur die öffentliche Tür: sie prüft das Token, begrenzt die
// Rate und reicht die Anfrage an die Steuerung des Gateways im LAN weiter —
// mit ZWEI Ausweisen: dem Steuer-Token (VM_GATEWAY_TOKEN, „kommt von der API“)
// und dem Token der Person (X-Rosenweg-Token). Der Gateway prüft das Token
// der Person selbst noch einmal; ein geleakter Steuer-Token allein reicht ihm
// nicht.
//
// Anmeldung: Bearer-Token der Authentik-Anwendung "rosenweg-apps" (öffentlicher
// Client mit PKCE), geprüft über userinfo — die Introspektion in lib/auth.js
// kennt nur Tokens des Website-Clients (wie pbx/api/app.py festgestellt hat).
//
// Der private Schlüssel entsteht auf dem Gerät, pro App-Start neu; hierher
// kommt nur der öffentliche. Der Gateway hält die Peers nur im Speicher und
// entfernt sie beim Schliessen der App bzw. nach wenigen Minuten ohne
// Lebenszeichen. Deshalb gibt es hier keine Zeilen in isp_vpn_accounts: es
// gibt keinen dauerhaften Zugang, der zurückgezogen werden müsste. Sperren
// geht über das Konto (Authentik/users.active) — der Gateway prüft das Token
// bei jeder Anfrage.
//
// Grenzen (docs/sicherheit.md, Abschnitt 5): 30 Anfragen pro Stunde je Geraet, 60 je Konto;
// höchstens 5 Geräte gleichzeitig je Person (prüft der Gateway).

const crypto = require('crypto');
const { AUTHENTIK_URL } = require('../lib/config');

const APPS_CLIENT_ID = process.env.ROSENWEG_APPS_CLIENT_ID || 'rosenweg-apps';
const VM_GATEWAY_URL = process.env.VM_GATEWAY_URL || '';
const VM_GATEWAY_TOKEN = process.env.VM_GATEWAY_TOKEN || '';
const GERAET_RE = /^[a-z0-9][a-z0-9-]{7,39}$/;

// userinfo kurz merken: die App fragt beim Start einmal, nicht im Sekundentakt.
const kontoCache = new Map(); // sha256(token) -> { konto, zeit }
setInterval(() => {
  const jetzt = Date.now();
  for (const [k, v] of kontoCache) if (jetzt - v.zeit > 60 * 1000) kontoCache.delete(k);
}, 5 * 60 * 1000).unref();

// Liest die Claims eines JWT OHNE Signaturprüfung. Nur zulässig, NACHDEM
// Authentik dasselbe Token über userinfo als gültig bestätigt hat — dann ist
// der Inhalt echt, und wir brauchen nur noch, für welchen Client es ausgestellt
// wurde. userinfo selbst nimmt Tokens JEDER Authentik-Anwendung an.
function claimsLesen(token) {
  try {
    const teil = String(token).split('.')[1];
    return JSON.parse(Buffer.from(teil, 'base64url').toString('utf8'));
  } catch { return null; }
}

async function gatewayRuf(methode, pfad, personToken, body) {
  const r = await fetch(VM_GATEWAY_URL + pfad, {
    method: methode,
    headers: {
      Authorization: `Bearer ${VM_GATEWAY_TOKEN}`,
      'X-Rosenweg-Token': personToken,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  let daten = {};
  try { daten = await r.json(); } catch { daten = {}; }
  return { status: r.status, daten };
}

function appTunnelRoutes(app, { pool, rateLimitGuard }) {
  async function rosenwegKonto(req, res, next) {
    try {
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!token || token.length > 4096) return res.status(401).json({ error: 'Nicht angemeldet' });
      const schluessel = crypto.createHash('sha256').update(token).digest('hex');
      const gemerkt = kontoCache.get(schluessel);
      if (gemerkt && Date.now() - gemerkt.zeit < 60 * 1000) {
        req.konto = gemerkt.konto; req.personToken = token; return next();
      }

      const r = await fetch(`${AUTHENTIK_URL}/application/o/userinfo/`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) return res.status(401).json({ error: 'Anmeldung abgelaufen' });
      const info = await r.json();

      const claims = claimsLesen(token);
      const aud = claims ? [].concat(claims.aud || [], claims.azp || []) : [];
      if (!aud.includes(APPS_CLIENT_ID)) {
        return res.status(401).json({ error: 'Token gehört nicht zu den Rosenweg-Apps' });
      }
      const email = String(info.email || '').trim().toLowerCase();
      // Kein Blick auf email_verified (26.11.2026): Authentik meldet fuer alle
      // Rosenweg-Konten false, weil die Verwaltung die Adressen eintraegt und
      // niemand sie per Mail bestaetigt. Die Bindung an die Person leisten die
      // Pruefungen darunter (Zeile aktiv, gleiches authentik_sub) - wie beim
      // Browser-Login, der email_verified ebenfalls nicht verlangt.
      if (!email) {
        return res.status(400).json({ error: 'Zu diesem Konto ist keine Mailadresse hinterlegt' });
      }
      // Dieselben Regeln wie beim Login im Browser: deaktivierte Zeile oder
      // Zeile eines anderen Authentik-Kontos mit gleicher Mail -> nein.
      const sub = String(info.sub || '');
      const u = await pool.query('SELECT active, authentik_sub FROM users WHERE LOWER(email) = $1 LIMIT 1', [email]);
      if (u.rows[0]?.active === false) return res.status(401).json({ error: 'Konto deaktiviert' });
      if (u.rows[0]?.authentik_sub && sub && u.rows[0].authentik_sub !== sub) {
        console.warn(`[app-tunnel] abgewiesen: users-Zeile ${email} gehoert zu anderem Authentik-Konto`);
        return res.status(403).json({ error: 'Diese Mailadresse gehört zu einem anderen Konto' });
      }
      const konto = { email };
      kontoCache.set(schluessel, { konto, zeit: Date.now() });
      req.konto = konto;
      req.personToken = token;
      next();
    } catch (e) {
      console.error('[app-tunnel] Anmeldung:', e.message);
      res.status(503).json({ error: 'Anmeldedienst nicht erreichbar' });
    }
  }

  const bereit = () => Boolean(VM_GATEWAY_URL && VM_GATEWAY_TOKEN);

  // POST /api/apps/tunnel  { geraet, geraet_name?, schluessel }
  //   -> { tunnel: { config, adresse, gateway, endpoint_intern } }
  app.post('/api/apps/tunnel', rosenwegKonto, async (req, res) => {
    try {
      if (!bereit()) return res.status(503).json({ error: 'vm-gateway nicht konfiguriert' });
      const email = req.konto.email;
      const geraet = String(req.body?.geraet || '').trim().toLowerCase();
      if (!GERAET_RE.test(geraet)) return res.status(400).json({ error: 'Ungültige Gerätekennung' });
      const schluessel = String(req.body?.schluessel || '').trim();
      // WireGuard-Schlüssel: 32 Byte in Base64 = 44 Zeichen mit '=' am Ende.
      if (!/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(schluessel)) {
        return res.status(400).json({ error: 'Öffentlicher Schlüssel fehlt oder ist ungültig' });
      }
      // Je Geraet statt je Konto (26.11.2026): die App baut bei jedem Start
      // einen frischen Tunnel auf; mit 10/h je Konto war Stefans erster
      // Testnachmittag nach ein paar Neustarts gesperrt. Die Zahl der Geraete
      // je Person begrenzt ohnehin der Gateway (GW_MAX_JE_PERSON).
      if (!rateLimitGuard('app-tunnel-geraet', `${email}:${geraet}`, 30, 60 * 60 * 1000).ok
          || !rateLimitGuard('app-tunnel', email, 60, 60 * 60 * 1000).ok) {
        return res.status(429).json({ error: 'Zu viele Verbindungsanfragen — bitte später erneut.' });
      }
      const { status, daten } = await gatewayRuf('POST', '/peers', req.personToken, { geraet, schluessel });
      if (status !== 200) {
        // Fehlertexte des Gateways sind für Menschen geschrieben (z. B.
        // „höchstens 5 Geräte“); 5xx nicht weiterreichen.
        if (status >= 500) return res.status(502).json({ error: 'Verbindung ins Haus nicht möglich' });
        return res.status(status).json({ error: daten.error || 'Abgelehnt' });
      }
      console.log(`[app-tunnel] ${email}: Gerät ${geraet}, ${daten.adresse}`);
      res.json({ tunnel: daten });
    } catch (err) {
      console.error('[app-tunnel]', err.message);
      res.status(502).json({ error: 'Verbindung ins Haus nicht möglich' });
    }
  });

  // DELETE /api/apps/tunnel/:geraet — Rückfallweg, falls die App den Gateway
  // beim Schliessen nicht mehr erreicht hat.
  app.delete('/api/apps/tunnel/:geraet', rosenwegKonto, async (req, res) => {
    try {
      if (!bereit()) return res.status(503).json({ error: 'vm-gateway nicht konfiguriert' });
      const geraet = String(req.params.geraet || '').toLowerCase();
      if (!GERAET_RE.test(geraet)) return res.status(400).json({ error: 'Ungültige Gerätekennung' });
      const { status, daten } = await gatewayRuf('DELETE', `/peers/${geraet}`, req.personToken);
      res.status(status >= 500 ? 502 : status).json(daten);
    } catch (err) {
      console.error('[app-tunnel-delete]', err.message);
      res.status(502).json({ error: 'Verbindung ins Haus nicht möglich' });
    }
  });
}

module.exports = { appTunnelRoutes, claimsLesen };
