// Auth-Middleware — aus server.js ausgelagert (Router-Split). LOGIN-KRITISCH:
// authMiddleware authentifiziert PAT / Session / Authentik-Token pro Request.
// Helfer (validateAuthentikToken, resolveAncestorGroups, ACCESS_LEVELS) kommen
// aus lib/auth; pool + auditCtx aus lib/db; AUTHENTIK_CLIENT_ID aus lib/config.
const crypto = require('crypto');
const { pool, auditCtx } = require('../lib/db');
const { AUTHENTIK_CLIENT_ID } = require('../lib/config');
const { validateAuthentikToken, validateAppToken, istAppToken, resolveAncestorGroups, ACCESS_LEVELS } = require('../lib/auth');
const { istAnlageToken, anlageTokenPruefen } = require('../lib/anlagetoken');
const { isTechnik, isPraesident } = require('../lib/groups');
const { karteZugangPruefen } = require('../routes/app-karte');

// Pfade, die einen Ausweis erzeugen oder ändern — für Zugangstoken tabu.
// Relativ zu /api/, Präfix-Vergleich auf Segmentgrenze.
const PAT_GESPERRT = [
  'change-password',      // Passwort — das eigentliche Loch, siehe unten
  'me/tokens',            // weitere Token
  'me/passkeys',          // Passkeys
  'auth',                 // OAuth-Fluss, Profil-Login
  'mqtt/my-app-passwords',// MQTT-Zugangsdaten
  'mqtt/user-app-passwords',// MQTT-Zugangsdaten anderer (Technik)
];

// Scope-Grammatik. Ein Token ohne Scopes hat alle Rechte der Person.
// pfad ist relativ zu /api/ ("wasch/reservations"); GET zählt als read,
// alles andere als write. Wird auch vom MCP-Server benutzt, um die
// Werkzeugliste je Token zu filtern — dieselbe Regel an beiden Stellen.
function scopeErlaubt(scopes, pfad, method) {
  if (!Array.isArray(scopes) || scopes.length === 0) return true;
  const need = method === 'GET' ? 'read' : 'write';
  // Express liefert den Pfad roh: /api/zähler kommt als z%c3%a4hler an, der Scope
  // "zähler:read" passte so nie. Nur Mehrbyte-UTF-8-Folgen (Umlaute) dekodieren;
  // kodierte ASCII-Zeichen bleiben stehen (kein Umweg ueber %77asch o. ae.).
  const roh = String(pfad || '').replace(/%[c-f][0-9a-f](?:%[89ab][0-9a-f])+/gi, m => { try { return decodeURIComponent(m); } catch { return m; } });
  // Klein geschrieben auf beiden Seiten — Express routet ohnehin so.
  const teile = roh.toLowerCase().split('/').filter(Boolean);
  const segment = teile[0] || 'root';
  const unter = teile.length > 1 ? segment + '/' + teile[1] : null;
  const passt = (s, name) => s === name + ':*' || s === name + ':' + need;
  return scopes.map(s => String(s).toLowerCase()).some(s => s === '*' || s === 'all:' + need || passt(s, segment) || (unter && passt(s, unter)));
}

// Absender fuer die Bremse der App-Token-Pruefung. Der ERSTE
// X-Forwarded-For-Eintrag stammt vom Client und ist frei faelschbar (damit
// koennte jemand eine fremde Adresse sperren oder die Bremse umgehen); die
// Proxies haengen hinten an. Also die hinterste nicht-interne Adresse — wie
// vmSignaturIp() in server.js.
const net = require('net');
function absenderIp(req) {
  const intern = (a) => {
    const s = String(a || '').replace(/^::ffff:/i, '');
    if (net.isIP(s) === 4) {
      const [x, y] = s.split('.').map(Number);
      return x === 10 || x === 127 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168)
        || (x === 100 && y >= 64 && y <= 127) || (x === 169 && y === 254);
    }
    if (net.isIP(s) === 6) return /^(::1$|f[cd]|fe[89ab])/i.test(s);
    return true;
  };
  const kette = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  kette.push(req.socket?.remoteAddress || '');
  for (let i = kette.length - 1; i >= 0; i--) {
    if (!intern(kette[i])) return kette[i].replace(/^::ffff:/i, '');
  }
  return (req.socket?.remoteAddress || req.ip || '').replace(/^::ffff:/i, '') || 'intern';
}

async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Nicht authentifiziert' });

  try {
    // 0. Personal Access Token (PAT) — prefix-erkennbar, für M2M/AI-Agents
    //    Wirkt als 'login als der User der den Token erstellt hat'.
    if (token.startsWith('rw_pat_')) {
      const hash = crypto.createHash('sha256').update(token).digest('hex');
      const r = await pool.query(
        `SELECT t.*, u.id AS user_id, u.name, u.email, u.role, u.wohnung, u.stweg, u.groups_json
           FROM api_tokens t
           LEFT JOIN users u ON LOWER(u.email) = LOWER(t.user_email)
          WHERE t.token_hash = $1 AND t.revoked_at IS NULL
            AND (t.expires_at IS NULL OR t.expires_at > NOW())
            AND COALESCE(u.active, true)
          LIMIT 1`,
        [hash],
      );
      if (r.rows.length === 0) return res.status(401).json({ error: 'PAT ungueltig oder widerrufen' });
      const row = r.rows[0];
      req.user = {
        id: row.user_id, user_id: row.user_id,
        name: row.name, email: row.user_email, role: row.role,
        wohnung: row.wohnung, stweg: row.stweg,
        groups: (() => { try { return JSON.parse(row.groups_json || '[]'); } catch { return []; } })(),
      };
      req.user.isAdmin = req.user.role === 'admin' || req.user.groups.some(g => g.toLowerCase() === 'technik');
      req.pat = { id: row.id, name: row.name, scopes: row.scopes };
      // Innerhalb eines Routers (/api/ssh, /api/stations …) ist req.path nur der
      // Rest hinter dem Mount — der Scope-Check würde dort das falsche Segment
      // lesen. baseUrl + path ergibt in beiden Fällen den vollen Pfad.
      // Express routet ohne Rücksicht auf Gross-/Kleinschreibung und mit
      // Schrägstrich am Ende — /api/Change-Password/ träfe dieselbe Route.
      // Darum vor Sperrliste und Scope-Check normalisieren.
      const vollerPfad = ((req.baseUrl || '') + req.path).toLowerCase()
        .replace(/\/{2,}/g, '/').replace(/^\/api\//, '').replace(/^\/+|\/+$/g, '');
      // Ein Token darf nie ändern, womit man sich anmeldet. Token, Passkeys
      // und MQTT-Zugangsdaten schützt requireUserLogin an der Route schon;
      // /change-password hatte diese Sperre nicht und verlangt das alte
      // Passwort nicht — ein geleakter Token hätte das Konto übernehmen
      // können. Die Liste hier gilt zentral, unabhängig davon, ob jemand an
      // der Route daran denkt. SSH-Schlüssel bewusst nicht: requireUserLogin
      // sperrt sie ohnehin, und ein Agent, der sich seinen Shell-Zugang selbst
      // einrichtet, wäre ein gewollter Anwendungsfall (Entscheid 5.9.2026).
      if (PAT_GESPERRT.some(pfx => vollerPfad === pfx || vollerPfad.startsWith(pfx + '/'))) {
        return res.status(403).json({ error: 'Mit einem Zugangstoken nicht erlaubt — nur angemeldet im Profil' });
      }
      // Scope-Check: wenn token.scopes gesetzt, prüfen ob aktueller Endpoint erlaubt.
      // Grammatik: "*", "all:read|write", "segment:*", "segment:read|write" — und
      // feiner "segment/unter:…" (z. B. "isp/vpn-accounts:read"), damit ein Token
      // nicht gleich alle 79 ISP-Endpunkte bekommt, wenn er nur sein VPN-Profil will.
      // Der MCP-Transport (/mcp) liegt nicht unter /api/ und ist kein
      // Bereich, den ein Scope benennt. Die Scopes greifen dort an den
      // Loopback-Aufrufen der Werkzeuge — die Route sagt das mit req.scopeAmZiel.
      if (!req.scopeAmZiel && !scopeErlaubt(row.scopes, vollerPfad, req.method)) {
        const segment = vollerPfad.split('/').filter(Boolean)[0] || 'root';
        return res.status(403).json({ error: `PAT-Scope fehlt: ${segment}:${req.method === 'GET' ? 'read' : 'write'}` });
      }
      // last_used async (kein await damit Antwort nicht blockiert)
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.socket.remoteAddress;
      pool.query('UPDATE api_tokens SET last_used_at=NOW(), last_used_ip=$1 WHERE id=$2', [ip, row.id]).catch(() => {});
      return auditCtx.run({ userEmail: req.user.email || 'pat:' + row.id }, next);
    }

    // 0b. Anlage-Portal-Token: App auf einem geteilten Telefon, ueber Rosenweg
    //     Geraet und die PBX-API (lib/anlagetoken.js). Gilt fuer genau eine
    //     Anfrage (Methode + Pfad), einmal, hoechstens 120 s. Wie ein PAT darf
    //     es nichts aendern, womit man sich anmeldet (PAT_GESPERRT) — nur das
    //     Lesen der eigenen Angaben (GET /api/auth/me) ist frei.
    if (istAnlageToken(token)) {
      // Zweiter authMiddleware in derselben Anfrage (App- und Routen-Ebene): schon geprueft
      if (req.anlage && req.anlage.token === token) return next();
      const p = anlageTokenPruefen(token);
      if (!p) return res.status(401).json({ error: 'Anmeldung am Telefon abgelaufen' });
      const vollerPfad = ((req.baseUrl || '') + req.path).toLowerCase()
        .replace(/\/{2,}/g, '/').replace(/^\/api\//, '').replace(/^\/+|\/+$/g, '');
      if (p.methode !== req.method || p.pfad !== vollerPfad) {
        return res.status(403).json({ error: 'Anlage-Token gilt fuer eine andere Anfrage' });
      }
      const nurLesen = req.method === 'GET' && vollerPfad === 'auth/me';
      if (!nurLesen && PAT_GESPERRT.some(pfx => vollerPfad === pfx || vollerPfad.startsWith(pfx + '/'))) {
        return res.status(403).json({ error: 'Auf einem geteilten Telefon nicht erlaubt — bitte im Portal' });
      }
      const u = await pool.query(
        `SELECT id, email, name, wohnung, stweg, role, active, groups_json
           FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`, [p.email]);
      const zeile = u.rows[0];
      if (!zeile || zeile.active === false) return res.status(401).json({ error: 'Konto unbekannt oder gesperrt' });
      const groups = (() => { try { return JSON.parse(zeile.groups_json || '[]'); } catch { return []; } })();
      req.user = {
        id: zeile.id, user_id: zeile.id, email: zeile.email, name: zeile.name,
        wohnung: zeile.wohnung, stweg: zeile.stweg, role: zeile.role, groups,
        auth_source: 'anlage',
      };
      req.user.isAdmin = zeile.role === 'admin' || isTechnik(groups) || isPraesident(groups);
      // requireUserLogin sperrt Token-Verwaltung & Co. auch fuer diesen Weg
      req.anlage = { ext: String(p.ext || ''), paket: String(p.paket || ''), token };
      return auditCtx.run({ userEmail: zeile.email || 'anlage:' + req.anlage.ext }, next);
    }

    // 0c. Karten-Sitzung einer Rosenweg-App auf einem privaten Geraet
    //     (routes/app-karte.js): wie ein App-Token, aber die Karte ist ein
    //     schwaecherer Ausweis als das Passwort — darum dieselbe Sperrliste
    //     wie fuer PATs (kein Token, Passkey, Passwort, MQTT-Zugang).
    if (token.startsWith('rw_app_')) {
      const k = await karteZugangPruefen(pool, token, absenderIp(req));
      if (!k) return res.status(401).json({ error: 'Anmeldung abgelaufen' });
      const vollerPfad = ((req.baseUrl || '') + req.path).toLowerCase()
        .replace(/\/{2,}/g, '/').replace(/^\/api\//, '').replace(/^\/+|\/+$/g, '');
      if (PAT_GESPERRT.some(pfx => vollerPfad === pfx || vollerPfad.startsWith(pfx + '/'))) {
        return res.status(403).json({ error: 'Mit der Karten-Anmeldung nicht erlaubt — bitte im Portal mit dem Rosenweg-Konto anmelden' });
      }
      req.user = k.user;
      req.appKarte = k.sitzung;
      return auditCtx.run({ userEmail: req.user.email || 'karte:' + k.sitzung.id }, next);
    }

    // 1. Try local session token first
    const result = await pool.query(
      `SELECT s.user_id, s.expires_at, u.name, u.email, u.role, u.wohnung, u.stweg, u.groups_json
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = $1 AND s.expires_at > NOW() AND u.active IS NOT FALSE`,
      [token]
    );
    if (result.rows.length > 0) {
      req.user = result.rows[0];
      req.user.id = req.user.user_id; // Ensure both .id and .user_id are set consistently
      req.user.isAdmin = req.user.role === 'admin';
      req.user.groups = (() => { try { return JSON.parse(req.user.groups_json || '[]'); } catch { return []; } })();
      // Sliding-Expiry: aktive Sessions automatisch verlaengern (kein staendiges
      // Neu-Anmelden). Nur schreiben wenn die Session naeher als 1 Tag an ihre
      // 30-Tage-Marke gerueckt ist -> max. 1 DB-Write pro Tag/Session, non-blocking.
      const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
      const exp = new Date(req.user.expires_at).getTime();
      if (exp < Date.now() + SESSION_TTL_MS - 24 * 60 * 60 * 1000) {
        pool.query('UPDATE sessions SET expires_at = $1 WHERE token = $2',
          [new Date(Date.now() + SESSION_TTL_MS), token]).catch(() => {});
      }
      return auditCtx.run({ userEmail: req.user.email || req.user.name || 'unknown' }, next);
    }

    // 2. Access-Token der Rosenweg-Apps (Authentik "rosenweg-apps", PKCE).
    //    Vorsortiert nach aud/azp im JWT, damit App-Tokens nicht erst die
    //    Introspektion des Website-Clients durchlaufen (die kennt sie nicht).
    //    Geprueft wird danach ueber userinfo, siehe lib/auth.js.
    if (istAppToken(token)) {
      const user = await validateAppToken(token, absenderIp(req));
      if (user?.gebremst) return res.status(429).json({ error: 'Zu viele Anmeldeversuche — bitte kurz warten.' });
      if (user) {
        req.user = user;
        return auditCtx.run({ userEmail: user.email || user.name || 'unknown' }, next);
      }
      return res.status(401).json({ error: 'Anmeldung abgelaufen' });
    }

    // 3. Try Authentik OAuth2 token (Website-Client, Introspektion)
    if (AUTHENTIK_CLIENT_ID) {
      const user = await validateAuthentikToken(token);
      if (user) {
        req.user = user;
        return auditCtx.run({ userEmail: user.email || user.name || 'unknown' }, next);
      }
    }

    return res.status(401).json({ error: 'Session abgelaufen' });
  } catch (err) {
    console.error('[auth] error:', err.message);
    res.status(500).json({ error: 'Auth-Fehler' });
  }
}

function adminOnly(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: 'Admin-Rechte erforderlich' });
  next();
}

function requirePermission(page, level = 'read') {
  return async (req, res, next) => {
    const groups = req.user.groups || (() => { try { return JSON.parse(req.user.groups_json || '[]'); } catch { return []; } })();
    // Technik and Präsident always have full access
    if (groups.some(g => { const gl = g.toLowerCase(); return gl === 'technik' || gl === 'präsident' || gl === 'praesident'; })) return next();

    try {
      const allGroups = await resolveAncestorGroups(groups);
      const result = await pool.query(
        'SELECT access FROM permissions WHERE LOWER(group_name) = ANY($1) AND page = $2',
        [allGroups, page]
      );
      const maxAccess = result.rows.reduce((max, r) => Math.max(max, ACCESS_LEVELS[r.access] || 0), 0);
      if (maxAccess >= (ACCESS_LEVELS[level] || 0)) return next();
    } catch (err) {
      console.error('Permission check error:', err);
    }
    res.status(403).json({ error: 'Keine Berechtigung' });
  };
}

// PATs werden NUR via Authentik-/Session-Login erstellt/widerrufen (nicht via PAT
// selbst), damit ein kompromittierter PAT keine neuen PATs anlegen oder andere
// widerrufen kann. Wir checken req.pat (gesetzt durch PAT-Auth) und lehnen ab.
function requireUserLogin(req, res, next) {
  if (req.pat || req.anlage) return res.status(403).json({ error: 'Token-Verwaltung nur via Browser-Login (Authentik) möglich' });
  // Karten-Sitzung (routes/app-karte.js): gleich wie ein PAT, nur Browser-Login
  if (req.appKarte) return res.status(403).json({ error: 'Nur mit Browser-Login (Rosenweg-Konto) möglich, nicht mit der Karte' });
  next();
}

module.exports = { authMiddleware, adminOnly, requirePermission, requireUserLogin, scopeErlaubt, absenderIp };
