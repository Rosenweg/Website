// Anmeldung gegen das Samba-AD (CT 108, dc1).
//
// Warum AD und nicht Authentik: Authentik kennt kein ROPC mit dem echten
// Login-Passwort (siehe lib/config.js) — grant_type=password erwartet ein
// vorher erzeugtes App-Passwort-Token. Wer vor einer neuen Station steht,
// soll aber einfach sein Rosenweg-Passwort eintippen können. Authentik
// synchronisiert Benutzer und Gruppen ohnehin alle zwei Minuten ins AD, und
// die Stationen melden sich später über genau dieses AD an.
//
// Nur für den Stations-Installer gedacht. Alles Browserbasierte läuft
// unverändert über Authentik.
const { Client } = require('ldapts');

const AD_URL = process.env.AD_URL || 'ldap://100.64.2.30:389';
const AD_DOMAIN = process.env.AD_DOMAIN || 'ad.rosenweg4303.ch';
const AD_BASE_DN = process.env.AD_BASE_DN
  || 'DC=' + AD_DOMAIN.split('.').join(',DC=');

// CN aus einem DN ziehen: 'CN=technik,CN=Users,DC=…' -> 'technik'
function cnOf(dn) {
  const m = /^CN=([^,]+)/i.exec(dn || '');
  return m ? m[1] : null;
}

/**
 * Zugangsdaten gegen das AD prüfen.
 *
 * @returns {Promise<null|{username,displayName,email,dn,groups:string[]}>}
 *          null, wenn die Zugangsdaten nicht stimmen.
 * @throws  wenn das AD nicht erreichbar ist — das ist etwas anderes als
 *          ein falsches Passwort und muss dem Installer auch anders
 *          gemeldet werden.
 */
async function authenticateAD(username, password) {
  if (!username || !password) return null;
  // Kein anonymer Bind: leeres Passwort würde am AD als erfolgreicher
  // unauthenticated bind durchgehen.
  if (!String(password).trim()) return null;

  const user = String(username).trim();
  const upn = user.includes('@') ? user : `${user}@${AD_DOMAIN}`;
  const client = new Client({ url: AD_URL, timeout: 8000, connectTimeout: 8000 });

  try {
    try {
      await client.bind(upn, password);
    } catch (e) {
      // 49 = invalidCredentials. Alles andere ist ein Betriebsproblem.
      if (e && (e.code === 49 || /invalid credentials/i.test(e.message || ''))) return null;
      throw e;
    }

    const sam = upn.split('@')[0];
    const { searchEntries } = await client.search(AD_BASE_DN, {
      scope: 'sub',
      filter: `(&(objectClass=user)(|(sAMAccountName=${sam})(userPrincipalName=${upn})))`,
      attributes: ['distinguishedName', 'displayName', 'mail', 'sAMAccountName', 'memberOf'],
      sizeLimit: 2,
    });

    const entry = searchEntries[0];
    if (!entry) return null;

    const memberOf = [].concat(entry.memberOf || []);
    return {
      username: String(entry.sAMAccountName || sam),
      displayName: String(entry.displayName || entry.sAMAccountName || sam),
      email: entry.mail ? String(entry.mail) : null,
      dn: String(entry.distinguishedName || entry.dn || ''),
      groups: memberOf.map(cnOf).filter(Boolean),
    };
  } finally {
    await client.unbind().catch(() => {});
  }
}

module.exports = { authenticateAD, AD_DOMAIN, AD_BASE_DN };
