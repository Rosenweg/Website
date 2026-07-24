// Zentrale env-Konfiguration — inkrementell aus server.js ausgelagert.
// Start mit den Authentik/OAuth/PVE-Konstanten (von der Auth-Schicht gebraucht);
// weitere Domaenen-Consts (PBX_*, NOC_*, WG_* …) folgen mit ihren Domaenen.

// ─── Authentik OAuth2 Config ─────────────────────────────────────────
const AUTHENTIK_URL = process.env.AUTHENTIK_URL || 'https://authentik-server:9443';
const AUTHENTIK_EXTERNAL_URL = process.env.AUTHENTIK_EXTERNAL_URL || 'https://authentik.rosenweg4303.ch';
const AUTHENTIK_CLIENT_ID = process.env.AUTHENTIK_CLIENT_ID || '';
const AUTHENTIK_CLIENT_SECRET = process.env.AUTHENTIK_CLIENT_SECRET || '';
const AUTHENTIK_API_TOKEN = process.env.AUTHENTIK_API_TOKEN || '';
const SITE_URL = process.env.SITE_URL || 'https://www.rosenweg4303.ch';

// ─── Proxmox VE Config ──────────────────────────────────────────────
const PVE_API_URL = process.env.PVE_API_URL || 'https://100.64.2.20:8006';
const PVE_API_TOKEN = process.env.PVE_API_TOKEN || '';

// Welche Hosts duerfen als OAuth-Redirect dienen. Muss mit den in Authentik
// hinterlegten Redirect-URIs uebereinstimmen. Whitelist verhindert dass jemand
// ueber Host-Header einen open redirect ausloest.
const OAUTH_ALLOWED_HOSTS = new Set([
  'www.rosenweg4303.ch',
  'rosenweg4303.ch',
  'isp.rosenweg4303.ch',
  // MQTT-Topic-Browser (eigener Host, Seite via www-Frontend, WS-Upgrade -> Broker).
  'mqtt.rosenweg4303.ch',
  // Zutrittsverwaltung + PWA (eigener Host, Seite via www-Frontend; "/" -> /access.html).
  'access.rosenweg4303.ch',
  // Audience-Subdomains (fokussierte Nav, Seiten via www-Frontend).
  'admin.rosenweg4303.ch',
  'ausschuss.rosenweg4303.ch',
  // PWA-Subdomain (dedizierter Frontend-LXC CT130, eigener OAuth-Callback-Origin).
  'pwa.rosenweg4303.ch',
  // Messenger-PWA (dedizierter Stack CT131, eigener OAuth-Callback-Origin).
  'chat.rosenweg4303.ch',
  // STWEG-Frontend-Container (stweg1..8.rosenweg4303.ch) — eigener
  // OAuth-Callback je Subdomain, damit die Session auf demselben Origin
  // landet von dem der Login startet. Authentik-Provider hat dazu eine
  // Regex-Redirect-URI fuer ^https://stweg[1-8]\.rosenweg4303\.ch/...
  'stweg1.rosenweg4303.ch',
  'stweg2.rosenweg4303.ch',
  'stweg3.rosenweg4303.ch',
  'stweg4.rosenweg4303.ch',
  'stweg5.rosenweg4303.ch',
  'stweg6.rosenweg4303.ch',
  'stweg7.rosenweg4303.ch',
  'meg.rosenweg4303.ch',
  // Messaging-Gateway-Web-UI (eigener Bot-Container, Reverse-Proxy auf /api/*).
  'whatsapp.rosenweg4303.ch',
  // PBX-Admin-Web-UI (eigenstaendige PBX-API in CT 220, Reverse-Proxy auf /api/*).
  'pbx.rosenweg4303.ch',
  // STWEG 3 hat zusaetzlich die eigene Domain rosenweg9.ch (serviert denselben
  // Container). Login muss von dort denselben Origin-Callback bauen.
  'rosenweg9.ch',
  'www.rosenweg9.ch',
]);

function oauthRedirectUri(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  // Whitelisted hosts werden in Production immer ueber HTTPS bedient
  // (CF/Traefik). X-Forwarded-Proto ist intern oft "http" und wuerde
  // sonst falsche Callback-URLs erzeugen.
  if (OAUTH_ALLOWED_HOSTS.has(host)) return `https://${host}/api/auth/callback`;
  return `${SITE_URL}/api/auth/callback`;
}

module.exports = {
  AUTHENTIK_URL, AUTHENTIK_EXTERNAL_URL, AUTHENTIK_CLIENT_ID, AUTHENTIK_CLIENT_SECRET,
  AUTHENTIK_API_TOKEN, SITE_URL, PVE_API_URL, PVE_API_TOKEN,
  OAUTH_ALLOWED_HOSTS, oauthRedirectUri,
};
