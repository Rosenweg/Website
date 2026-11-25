// ─── Tunnel für Rosenweg-Apps auf eigenen Geräten ───────────────────────────
//
// Die App „Rosenweg Virtuelle Computer" baut ausser Haus selbst einen
// WireGuard-Tunnel auf (im Prozess der App, ohne Systemtunnel), um an die
// Proxmox-API und den SPICE-Proxy zu kommen. Dafür braucht sie einen Peer bei
// wg-control — so wie eine Laptop-Station (POST /api/stations/:id/tunnel).
//
// Unterschied zur Station: Es gibt kein Stationstoken und keine App-Sitzung
// mit AD-Passwort. Die App meldet die PERSON mit dem Rosenweg-Konto an
// (Authentik, Anwendung "rosenweg-apps", öffentlicher Client mit PKCE) und
// schickt deren Access-Token. Das prüfen wir hier über userinfo — die
// Introspektion in lib/auth.js kennt nur Tokens des Website-Clients, so wie
// es die PBX-Schnittstelle schon festgestellt hat (pbx/api/app.py).
//
// Was gleich bleibt wie bei den Laptops:
//  - Der private Schlüssel entsteht auf dem Gerät; hierher kommt nur der
//    öffentliche. wg-control kennt den privaten nie.
//  - Nur das Hausnetz durch den Tunnel (100.64.0.0/16, wg-control hängt das
//    Tunnelnetz 192.168.2.0/24 an), Internet bleibt direkt.
//  - VLAN = Wohnung der Person (getUserVlanOptions), kein Technik-VLAN: die
//    App braucht nur Proxmox, und ein Gerät ausser Haus soll nicht mehr dürfen
//    als ein Gerät in der Wohnung.
//  - Die Peers stehen in isp_vpn_accounts und lassen sich in der
//    ISP-Verwaltung zurückziehen (Notausschalter bei verlorenem Gerät).
//
// Grenzen (docs/sicherheit.md, Abschnitt 5): 10 Anfragen pro Stunde und
// höchstens 5 App-Tunnel je Konto. Ein zweiter Aufruf vom selben Gerät
// ersetzt den eigenen alten Peer, statt einen weiteren anzulegen.

const crypto = require('crypto');
const { AUTHENTIK_URL } = require('../lib/config');

const APPS_CLIENT_ID = process.env.ROSENWEG_APPS_CLIENT_ID || 'rosenweg-apps';
const GERAET_RE = /^[a-z0-9][a-z0-9-]{7,39}$/;
const MAX_JE_KONTO = 5;

// userinfo kurz merken: die App fragt beim Start einmal, nicht im Sekundentakt;
// eine Minute reicht, damit ein Doppelklick Authentik nicht zweimal fragt.
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

function appTunnelRoutes(app, { pool, wgControl, getUserVlanOptions, rateLimitGuard, wgControlBereit }) {
  async function rosenwegKonto(req, res, next) {
    try {
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!token || token.length > 4096) return res.status(401).json({ error: 'Nicht angemeldet' });
      const schluessel = crypto.createHash('sha256').update(token).digest('hex');
      const gemerkt = kontoCache.get(schluessel);
      if (gemerkt && Date.now() - gemerkt.zeit < 60 * 1000) { req.konto = gemerkt.konto; return next(); }

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
      if (!email || info.email_verified === false) {
        return res.status(400).json({ error: 'Zu diesem Konto ist keine bestätigte Mailadresse hinterlegt' });
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
      const konto = { email, name: String(info.name || info.preferred_username || '') };
      kontoCache.set(schluessel, { konto, zeit: Date.now() });
      req.konto = konto;
      next();
    } catch (e) {
      console.error('[app-tunnel] Anmeldung:', e.message);
      res.status(503).json({ error: 'Anmeldedienst nicht erreichbar' });
    }
  }

  // Name bei wg-control: eindeutig je Gerät und Person, nur unbedenkliche
  // Zeichen (er landet als Kommentar in wg0.conf).
  function peerName(geraet, email) {
    const kurz = email.split('@')[0].replace(/[^a-z0-9._-]/gi, '').slice(0, 16);
    const hash = crypto.createHash('sha256').update(email).digest('hex').slice(0, 8);
    return `app-${geraet}-${kurz}-${hash}`;
  }

  async function eigeneAbraeumen(name, email) {
    const alt = await pool.query(
      `SELECT id, username FROM isp_vpn_accounts
        WHERE bezeichnung = $1 AND active = true AND LOWER(user_email) = $2 AND notizen LIKE 'App %'`,
      [name, email]);
    for (const row of alt.rows) {
      await wgControl('DELETE', `/peers/${row.username}`).catch(() => {});
      // Löschen statt active=false: siehe Stations-Tunnel (sonst zählt das NOC
      // Grabsteine als offene VPN-Anträge).
      await pool.query('DELETE FROM isp_vpn_accounts WHERE id = $1', [row.id]);
    }
    return alt.rows.length;
  }

  // POST /api/apps/tunnel  { geraet, geraet_name?, schluessel }
  //   -> { tunnel: { peer, vlan, adresse, config } }
  app.post('/api/apps/tunnel', rosenwegKonto, async (req, res) => {
    try {
      if (!wgControlBereit()) return res.status(503).json({ error: 'wg-control nicht konfiguriert' });
      const email = req.konto.email;
      const geraet = String(req.body?.geraet || '').trim().toLowerCase();
      if (!GERAET_RE.test(geraet)) return res.status(400).json({ error: 'Ungültige Gerätekennung' });
      const schluessel = String(req.body?.schluessel || '').trim();
      // WireGuard-Schlüssel: 32 Byte in Base64 = 44 Zeichen mit '=' am Ende.
      if (!/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(schluessel)) {
        return res.status(400).json({ error: 'Öffentlicher Schlüssel fehlt oder ist ungültig' });
      }
      if (!rateLimitGuard('app-tunnel', email, 10, 60 * 60 * 1000).ok) {
        return res.status(429).json({ error: 'Zu viele Tunnel-Anfragen — bitte später erneut.' });
      }

      const name = peerName(geraet, email);
      await eigeneAbraeumen(name, email);

      const bestand = await pool.query(
        "SELECT COUNT(*)::int AS n FROM isp_vpn_accounts WHERE LOWER(user_email) = $1 AND notizen LIKE 'App %'", [email]);
      if ((bestand.rows[0]?.n || 0) >= MAX_JE_KONTO) {
        return res.status(429).json({ error: 'Zu viele Geräte mit Tunnel — bitte ein altes in der Verwaltung entfernen.' });
      }

      const optionen = await getUserVlanOptions(email);
      const vlan = optionen[0]?.vlan || null;
      if (!vlan) return res.status(400).json({ error: 'Keine Wohnung in der Objektverwaltung — Tunnel nicht möglich' });

      const antwort = await wgControl('POST', '/peers', {
        name, email, vlan, allowed_ips: '100.64.0.0/16', public_key: schluessel,
      });
      const peer = await antwort.json();
      // Anzeigename nur für die Verwaltung, gekürzt und entschärft.
      const anzeige = String(req.body?.geraet_name || '').replace(/[^\p{L}\p{N} ._()'-]/gu, ' ').trim().slice(0, 60);
      await pool.query(
        `INSERT INTO isp_vpn_accounts (user_email, backend, username, public_key, assigned_ip,
                                       config_path, active, notizen, bezeichnung)
         VALUES ($1, 'wireguard', $2, $3, $4, $5, true, $6, $7)`,
        [email, peer.id, peer.public_key, peer.assigned_ip, `wg-control/${peer.id}`,
          `App ${geraet}${anzeige ? ` (${anzeige})` : ''}, VLAN ${vlan}`, name]);

      console.log(`[app-tunnel] ${email}: Gerät ${geraet}, VLAN ${vlan}`);
      res.json({ tunnel: { peer: name, vlan, adresse: peer.assigned_ip, config: peer.config } });
    } catch (err) {
      console.error('[app-tunnel]', err.message);
      res.status(500).json({ error: 'Tunnel konnte nicht eingerichtet werden' });
    }
  });

  // DELETE /api/apps/tunnel/:geraet — beim Abmelden in der App.
  app.delete('/api/apps/tunnel/:geraet', rosenwegKonto, async (req, res) => {
    try {
      if (!wgControlBereit()) return res.status(503).json({ error: 'wg-control nicht konfiguriert' });
      const geraet = String(req.params.geraet || '').toLowerCase();
      if (!GERAET_RE.test(geraet)) return res.status(400).json({ error: 'Ungültige Gerätekennung' });
      const n = await eigeneAbraeumen(peerName(geraet, req.konto.email), req.konto.email);
      res.json({ entfernt: n });
    } catch (err) {
      console.error('[app-tunnel-delete]', err.message);
      res.status(500).json({ error: 'Tunnel konnte nicht entfernt werden' });
    }
  });
}

module.exports = { appTunnelRoutes, claimsLesen };
