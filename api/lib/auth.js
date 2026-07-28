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

    const result = await pool.query(
      `INSERT INTO users (email, name, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role
       RETURNING id, email, name, wohnung, stweg, role`,
      [email.toLowerCase(), name, (data.groups?.some(g => { const gl = g.toLowerCase(); return gl === 'technik' || gl === 'präsident' || gl === 'praesident'; })) ? 'admin' : 'bewohner']
    );
    const user = result.rows[0];
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
  MANAGED_PAGES, ACCESS_LEVELS, resolveAncestorGroups, getUserPermissions,
};
