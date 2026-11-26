// Auth-Helfer — aus server.js ausgelagert (Router-Split). Die Middleware
// (authMiddleware, adminOnly, requirePermission, requireUserLogin) bleibt
// vorerst in server.js und nutzt die hier exportierten Helfer (kleinerer
// Risikoschritt; Middleware-Move folgt separat).
const crypto = require('crypto');
const { AUTHENTIK_URL, AUTHENTIK_EXTERNAL_URL, AUTHENTIK_CLIENT_ID, AUTHENTIK_CLIENT_SECRET, AUTHENTIK_API_TOKEN, MQTT_ROPC_CLIENT_ID, MQTT_ROPC_CLIENT_SECRET } = require('./config');
const { pool } = require('./db');
const { isAusschussForAny, isTechnik, isPraesident } = require('./groups');

// ─── Authentik API (oeffentliche URL, damit generierte Links klickbar sind) ──
async function authentikAPI(method, path, body = null) {
  // INTERNE URL (.37:9000) — die api laeuft intern (CT128) und erreicht die
  // public authentik.rosenweg4303.ch NICHT (De-Swarm: vorher Swarm-intern ok).
  const url = `${AUTHENTIK_URL}/api/v3${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${AUTHENTIK_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  opts.signal = AbortSignal.timeout(15000);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Authentik API ${res.status}: ${text}`);
  }
  const text = await res.text();
  if (!text || !text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// ─── Token-Introspection-Cache ──────────────────────────────────────
const tokenCache = new Map();
const TOKEN_CACHE_TTL = 60 * 1000; // 1 minute
// Purge expired entries every 5 minutes to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of tokenCache) { if (now - v.time > TOKEN_CACHE_TTL) tokenCache.delete(k); }
}, 5 * 60 * 1000);

let usersSubSpalte = null; // einmalig: ALTER TABLE users ADD COLUMN authentik_sub
async function validateAuthentikToken(token) {
  const cached = tokenCache.get(token);
  if (cached && Date.now() - cached.time < TOKEN_CACHE_TTL) return cached.user;

  try {
    const params = new URLSearchParams({
      token,
      client_id: AUTHENTIK_CLIENT_ID,
      client_secret: AUTHENTIK_CLIENT_SECRET,
    });
    const resp = await fetch(`${AUTHENTIK_URL}/application/o/introspect/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(5000),
    });
    const data = await resp.json();
    if (!data.active) return null;

    // Map Authentik user to our user format, create/update in DB
    const email = data.email || data.sub;
    const name = data.name || data.preferred_username || email;
    const role = (data.groups?.some(g => { const gl = g.toLowerCase(); return gl === 'technik' || gl === 'präsident' || gl === 'praesident'; })) ? 'admin' : 'bewohner';

    // users-Zeile an das Authentik-Konto (sub) binden wie beim Browser-Login
    // (R3-S2b): ein zweites Konto mit derselben E-Mail darf die Zeile (Rechte,
    // Daten) des ersten nicht uebernehmen. role wird hier nicht geschrieben
    // (das macht der Browser-Login), nur fuer diese Anfrage aus den Gruppen gesetzt.
    const sub = String(data.sub || '');
    if (!usersSubSpalte) usersSubSpalte = pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS authentik_sub TEXT').catch(e => { usersSubSpalte = null; throw e; });
    await usersSubSpalte;
    const result = await pool.query(
      `INSERT INTO users (email, name, role, authentik_sub)
       VALUES ($1, $2, $3, NULLIF($4, ''))
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name,
                                         authentik_sub = COALESCE(users.authentik_sub, EXCLUDED.authentik_sub)
       WHERE users.authentik_sub IS NULL OR users.authentik_sub = EXCLUDED.authentik_sub
       RETURNING id, email, name, wohnung, stweg, role`,
      [email.toLowerCase(), name, role, sub]
    );
    // Kein RETURNING = Zeile gehoert zu einem anderen Konto (oder Token ohne sub
    // trifft eine gebundene Zeile) -> nicht anmelden.
    if (!result.rows.length) {
      console.warn(`[auth] Bearer-Token abgewiesen: users-Zeile ${email.toLowerCase()} gehoert zu anderem Authentik-Konto`);
      return null;
    }
    const user = result.rows[0];
    user.role = role;
    user.isAdmin = user.role === 'admin';
    user.user_id = user.id;
    user.auth_source = 'authentik';
    user.groups = data.groups || [];

    tokenCache.set(token, { user, time: Date.now() });
    return user;
  } catch (err) {
    console.error('Authentik token validation error:', err.message);
    return null;
  }
}

// ─── Access-Tokens der Rosenweg-Apps (Authentik "rosenweg-apps") ────
// Die Flutter-Apps melden sich als oeffentlicher Client mit PKCE an. Ihre
// Tokens kennt die Introspektion oben nicht (sie fragt mit dem Website-Client
// und bekommt fuer fremde Tokens active:false). Geprueft wird deshalb wie in
// routes/app-tunnel.js: Authentik bestaetigt das Token ueber userinfo, danach
// sagen aud/azp, fuer welchen Client es ausgestellt ist, und die users-Zeile
// muss es schon geben (aktiv, gleiches authentik_sub). Angelegt wird hier
// nichts — das bleibt dem Browser-Login vorbehalten.
//
// req.user sieht danach genauso aus wie bei einem Website-Token: dieselben
// Felder, Gruppen aus Authentik (userinfo liefert dieselbe Gruppenliste wie
// die Introspektion), Rolle aus den Gruppen.
//
// Zwischenspeicher nach sha256(Token), nie nach dem Token selbst: der Schluessel
// taucht so in keinem Speicherabbild als brauchbarer Ausweis auf. Erfolg 60 s,
// Fehlschlag 15 s. Fehlversuche je Absender-IP begrenzt, damit niemand ueber
// uns Authentik mit Ratetokens zuschuettet.
const APPS_CLIENT_ID = process.env.ROSENWEG_APPS_CLIENT_ID || 'rosenweg-apps';
const appTokenCache = new Map(); // sha256(token) -> { user, time, ttl }
const appTokenFehlversuche = new Map(); // ip -> { first, count }
const APP_FEHL_FENSTER = 60 * 1000;
const APP_FEHL_MAX = 30;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of appTokenCache) { if (now - v.time > v.ttl) appTokenCache.delete(k); }
  for (const [k, v] of appTokenFehlversuche) { if (now - v.first > APP_FEHL_FENSTER) appTokenFehlversuche.delete(k); }
}, 5 * 60 * 1000).unref?.();

// Claims eines JWT OHNE Signaturpruefung. Nur zum Vorsortieren und NACHDEM
// userinfo dasselbe Token bestaetigt hat (siehe routes/app-tunnel.js).
function jwtClaims(token) {
  try {
    const teil = String(token).split('.')[1];
    if (!teil) return null;
    return JSON.parse(Buffer.from(teil, 'base64url').toString('utf8'));
  } catch { return null; }
}

/** Ist das (unbestaetigte) Token fuer die Rosenweg-Apps ausgestellt? */
function istAppToken(token) {
  const c = jwtClaims(token);
  if (!c || typeof c !== 'object') return false;
  return [].concat(c.aud || [], c.azp || []).includes(APPS_CLIENT_ID);
}

const istTechnikOderPraesident = (groups) => (groups || []).some(g => {
  const gl = String(g).toLowerCase(); return gl === 'technik' || gl === 'präsident' || gl === 'praesident';
});

/**
 * Prueft ein Access-Token der Rosenweg-Apps. Rueckgabe: req.user-Objekt,
 * null (ungueltig/fremd), oder { gebremst: true } bei zu vielen Fehlversuchen.
 * Wirft bei Netzwerkfehlern nicht, sondern liefert null (nicht gecacht).
 */
async function validateAppToken(token, ip = '') {
  if (!token || token.length > 4096) return null;
  const schluessel = crypto.createHash('sha256').update(token).digest('hex');
  const gemerkt = appTokenCache.get(schluessel);
  if (gemerkt && Date.now() - gemerkt.time < gemerkt.ttl) return gemerkt.user;

  const fehl = appTokenFehlversuche.get(ip);
  if (fehl && Date.now() - fehl.first < APP_FEHL_FENSTER && fehl.count >= APP_FEHL_MAX) return { gebremst: true };

  const merken = (user) => {
    if (appTokenCache.size > 10000) appTokenCache.clear();
    appTokenCache.set(schluessel, { user, time: Date.now(), ttl: user ? 60 * 1000 : 15 * 1000 });
    if (!user) {
      const f = appTokenFehlversuche.get(ip);
      if (f && Date.now() - f.first < APP_FEHL_FENSTER) f.count++;
      else appTokenFehlversuche.set(ip, { first: Date.now(), count: 1 });
    }
    return user;
  };

  try {
    const r = await fetch(`${AUTHENTIK_URL}/application/o/userinfo/`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return merken(null);
    const info = await r.json();
    // Erst jetzt sind die Claims echt (userinfo hat genau dieses Token
    // angenommen) — und userinfo nimmt Tokens JEDER Authentik-Anwendung an.
    if (!istAppToken(token)) return merken(null);

    const email = String(info.email || '').trim().toLowerCase();
    if (!email) return merken(null);
    const sub = String(info.sub || '');
    const u = await pool.query(
      `SELECT id, email, name, wohnung, stweg, role, active, authentik_sub, groups_json
         FROM users WHERE LOWER(email) = $1 LIMIT 1`, [email]);
    const zeile = u.rows[0];
    if (!zeile || zeile.active === false) return merken(null);
    if (zeile.authentik_sub && sub && zeile.authentik_sub !== sub) {
      console.warn(`[auth] App-Token abgewiesen: users-Zeile ${email} gehoert zu anderem Authentik-Konto`);
      return merken(null);
    }
    // Gruppen frisch aus Authentik; fehlen sie in userinfo (Scope 'profile'
    // nicht angefragt), die zuletzt beim Browser-Login gespeicherten.
    let groups = Array.isArray(info.groups) ? info.groups.map(String) : null;
    if (!groups) { try { groups = JSON.parse(zeile.groups_json || '[]'); } catch { groups = []; } }
    const role = istTechnikOderPraesident(groups) ? 'admin' : 'bewohner';
    const user = {
      id: zeile.id, email: zeile.email, name: zeile.name,
      wohnung: zeile.wohnung, stweg: zeile.stweg, role,
      isAdmin: role === 'admin', user_id: zeile.id,
      auth_source: 'authentik', auth_client: APPS_CLIENT_ID,
      groups,
    };
    return merken(user);
  } catch (err) {
    console.error('[auth] App-Token-Pruefung:', err.message);
    return null;
  }
}

/** Zwischengespeicherte App-Anmeldungen einer Person vergessen (Kontoloeschung). */
function appTokensVergessen(email) {
  const e = String(email || '').toLowerCase();
  for (const [k, v] of appTokenCache) { if (String(v.user?.email || '').toLowerCase() === e) appTokenCache.delete(k); }
}

// ─── Nicht-interaktiver Login fuer MQTT-Clients ─────────────────────
// Erlaubt Authentik-Usern, sich bei MQTT ohne Browser-Token-Flow anzumelden.
// Authentik kennt kein ROPC mit echtem Login-Passwort: der Client sendet
// username = Authentik-User/E-Mail und password = ein am Konto erzeugtes
// App-Passwort-Token. Der Grant (grant_type=password, von Authentik wie
// client_credentials behandelt) wird gegen den token-Endpoint validiert;
// Identitaet + Gruppen kommen aus userinfo (providerunabhaengig, kein
// Introspect-Client-Mismatch). Ergebnis (auch Fehlschlag) wird kurz gecacht,
// damit wiederholte Reconnects Authentik nicht ueberrollen.
// Rueckgabe: { email, groups, is_technik } | null.
const pwLoginCache = new Map(); // sha256(user\0pass) -> { user, time, ttl }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pwLoginCache) { if (now - v.time > v.ttl) pwLoginCache.delete(k); }
}, 5 * 60 * 1000);

async function authentikPasswordLogin(username, password) {
  if (!username || !password) return null;
  const cacheKey = crypto.createHash('sha256').update(`${username}\0${password}`).digest('hex');
  const cached = pwLoginCache.get(cacheKey);
  if (cached && Date.now() - cached.time < cached.ttl) return cached.user;

  const clientId = MQTT_ROPC_CLIENT_ID;
  if (!clientId) return null;
  const remember = (user) => {
    // Speicher begrenzen: viele fehlgeschlagene Versuche (je unterschiedliches
    // Passwort = eigener Key) sollen den Cache nicht aufblaehen.
    if (pwLoginCache.size > 10000) pwLoginCache.clear();
    // Erfolg 60s cachen, Fehlschlag nur 15s (schnellere Wiederholung nach PW-Aenderung).
    pwLoginCache.set(cacheKey, { user, time: Date.now(), ttl: user ? 60 * 1000 : 15 * 1000 });
    return user;
  };
  try {
    const params = new URLSearchParams({
      grant_type: 'password',
      client_id: clientId,
      username: String(username),
      password: String(password),
      scope: 'openid email profile',
    });
    if (MQTT_ROPC_CLIENT_SECRET) params.set('client_secret', MQTT_ROPC_CLIENT_SECRET);
    const tok = await fetch(`${AUTHENTIK_URL}/application/o/token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(5000),
    });
    if (!tok.ok) return remember(null);            // 400/401 = falsche Credentials
    const data = await tok.json();
    if (!data.access_token) return remember(null);
    const ui = await fetch(`${AUTHENTIK_URL}/application/o/userinfo/`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${data.access_token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!ui.ok) return remember(null);
    const info = await ui.json();
    const email = String(info.email || info.preferred_username || '').toLowerCase();
    if (!email) return remember(null);
    const groups = Array.isArray(info.groups) ? info.groups : [];
    return remember({ email, groups, is_technik: isTechnik(groups) || isPraesident(groups) });
  } catch (err) {
    console.error('[mqtt] password login error:', err.message);
    return null;                                   // Netzwerkfehler nicht cachen
  }
}

// ─── Permission System ──────────────────────────────────────────────
const MANAGED_PAGES = [
  { id: 'bewohner-verwaltung', label: 'Bewohner-Verwaltung' },
  { id: 'energie-monitor', label: 'Energie-Monitor' },
  { id: 'energie-config', label: 'Energie-Konfiguration' },
  { id: 'email-verteiler', label: 'E-Mail-Verteiler' },
  { id: 'zähler', label: 'Zähler & Verbrauch' },
  { id: 'waschküche', label: 'Waschküche' },
  { id: 'waschküche-admin', label: 'Waschküche-Admin' },
  { id: 'kontakte', label: 'Kontakte' },
  { id: 'verwaltung', label: 'Verwaltung' },
  { id: 'rechteverwaltung', label: 'Rechteverwaltung' },
  { id: 'wohnungsverwaltung', label: 'Wohnungsverwaltung' },
  { id: 'proxmox-verwaltung', label: 'Proxmox-Verwaltung' },
  { id: 'handwerker', label: 'Handwerker & Lieferanten' },
  { id: 'auslagen', label: 'Auslagen / Vorschuesse' },
  { id: 'verwaltung-mail-outbox', label: 'Verwaltungs-Mail Outbox' },
  { id: 'personen', label: 'Personen (Eigentümer/Bewohner)' },
  { id: 'mail-empfänger', label: 'Mail-Empfänger (Stammdaten)' },
  { id: 'mail-compose', label: 'Mail schreiben (Ad-hoc)' },
  { id: 'mail-approval-config', label: 'Mail-Freigabe-Regeln' },
  { id: 'mail-templates', label: 'Mail-Templates' },
  { id: 'auslagen-stundensatz', label: 'Auslagen-Stundensatz' },
  { id: 'whatsapp-bot', label: 'WhatsApp-Bot' },
  { id: 'reklamationen', label: 'Reklamationen' },
];

const ACCESS_LEVELS = { none: 0, read: 1, write: 2 };

// Resolve user's direct groups to include all ancestor groups via Authentik hierarchy.
// Caches the group hierarchy for 5 minutes.
let _groupHierarchyCache = null;
let _groupHierarchyCacheTime = 0;
const GROUP_HIERARCHY_TTL = 5 * 60 * 1000;

async function resolveAncestorGroups(directGroupNames) {
  // Fetch and cache group hierarchy from Authentik
  const now = Date.now();
  if (!_groupHierarchyCache || now - _groupHierarchyCacheTime > GROUP_HIERARCHY_TTL) {
    try {
      const data = await authentikAPI('GET', '/core/groups/?page_size=500');
      const groups = data.results || data;
      // Build name->parent_name lookup
      const byPk = {};
      for (const g of groups) byPk[g.pk] = g;
      const parentNameOf = {};
      for (const g of groups) {
        if (g.parent && byPk[g.parent]) {
          parentNameOf[g.name.toLowerCase()] = byPk[g.parent].name.toLowerCase();
        }
      }
      _groupHierarchyCache = parentNameOf;
      _groupHierarchyCacheTime = now;
    } catch (err) {
      console.error('Failed to fetch group hierarchy:', err.message);
      // Fall back to direct groups only
      return directGroupNames.map(g => g.toLowerCase());
    }
  }

  // Walk up parent chain for each group
  const result = new Set(directGroupNames.map(g => g.toLowerCase()));
  for (const name of directGroupNames) {
    let current = name.toLowerCase();
    while (_groupHierarchyCache[current]) {
      const parent = _groupHierarchyCache[current];
      if (result.has(parent)) break;
      result.add(parent);
      current = parent;
    }
  }
  return [...result];
}

async function getUserPermissions(groups) {
  const permissions = {};
  // Technik and Präsident get write on everything
  if (groups.some(g => { const gl = g.toLowerCase(); return gl === 'technik' || gl === 'präsident' || gl === 'praesident'; })) {
    for (const p of MANAGED_PAGES) permissions[p.id] = 'write';
    return permissions;
  }
  try {
    const allGroups = await resolveAncestorGroups(groups);
    const result = await pool.query(
      'SELECT page, access FROM permissions WHERE LOWER(group_name) = ANY($1)',
      [allGroups]
    );
    for (const row of result.rows) {
      const current = ACCESS_LEVELS[permissions[row.page]] || 0;
      if ((ACCESS_LEVELS[row.access] || 0) > current) {
        permissions[row.page] = row.access;
      }
    }
  } catch (err) {
    console.error('getUserPermissions error:', err);
  }
  // Ausschuss members get bewohner-verwaltung access for their own STWEG
  if (isAusschussForAny(groups) && !permissions['bewohner-verwaltung']) {
    permissions['bewohner-verwaltung'] = 'write';
  }
  return permissions;
}

module.exports = {
  authentikAPI, tokenCache, validateAuthentikToken, authentikPasswordLogin,
  validateAppToken, istAppToken, appTokensVergessen, APPS_CLIENT_ID,
  MANAGED_PAGES, ACCESS_LEVELS, resolveAncestorGroups, getUserPermissions,
};
