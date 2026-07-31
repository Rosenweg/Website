// Anmeldung gegen das Samba-AD (CT 108, dc1).
//
// Warum AD und nicht Authentik: Authentik kennt kein ROPC mit dem echten
// Login-Passwort (siehe lib/config.js) — grant_type=password erwartet ein
// vorher erzeugtes App-Passwort-Token. Wer vor einer neuen Station steht,
// soll aber einfach sein Rosenweg-Passwort eintippen können. Authentik
// synchronisiert Benutzer und Gruppen ohnehin alle zwei Minuten ins AD, und
// die Stationen melden sich später über genau dieses AD an.
//
// Immer über LDAPS: das AD lehnt einfache Binds auf Port 389 von sich aus ab
// ("Transport encryption required"), und hier geht ein Klartextpasswort über
// die Leitung. Das Zertifikat des DC ist selbst ausgestellt und trägt keine
// SAN, nur CN=DC1.ad.rosenweg4303.ch — deshalb wird die CA gepinnt und der
// Name von Hand geprüft, statt die Prüfung abzuschalten.
//
// Nur für den Stations-Installer gedacht. Alles Browserbasierte läuft
// unverändert über Authentik.
const { Client } = require('ldapts');

const AD_URL = process.env.AD_URL || 'ldaps://100.64.2.30:636';
const AD_DOMAIN = process.env.AD_DOMAIN || 'ad.rosenweg4303.ch';
const AD_BASE_DN = process.env.AD_BASE_DN
  || 'DC=' + AD_DOMAIN.split('.').join(',DC=');
// Auf welchen Namen das Zertifikat des DC lautet.
const AD_TLS_SERVERNAME = process.env.AD_TLS_SERVERNAME || 'DC1.ad.rosenweg4303.ch';
// PEM der Samba-CA, einzeilig mit \n statt Zeilenumbrüchen (.env kann keine).
const AD_TLS_CA = (process.env.AD_TLS_CA_PEM || '').replace(/\\n/g, '\n').trim();
const AD_TLS_INSECURE = process.env.AD_TLS_INSECURE === '1';

// CN aus einem DN ziehen: 'CN=technik,CN=Users,DC=…' -> 'technik'
function cnOf(dn) {
  const m = /^CN=([^,]+)/i.exec(dn || '');
  return m ? m[1] : null;
}

function tlsOptions() {
  if (!AD_URL.startsWith('ldaps:')) return undefined;

  if (!AD_TLS_CA) {
    if (!AD_TLS_INSECURE) {
      throw new Error(
        'AD_TLS_CA_PEM ist nicht gesetzt. Ohne gepinnte CA werden keine '
        + 'Zugangsdaten an den DC geschickt (AD_TLS_INSECURE=1 hebt das auf).',
      );
    }
    return { rejectUnauthorized: false };
  }

  return {
    ca: [AD_TLS_CA],
    // Wir verbinden über die IP; der DC weist sich unter seinem Namen aus.
    servername: AD_TLS_SERVERNAME,
    checkServerIdentity: (host, cert) => {
      const cn = cert?.subject?.CN;
      if (cn && cn.toLowerCase() === AD_TLS_SERVERNAME.toLowerCase()) return undefined;
      return new Error(`DC weist sich als '${cn}' aus, erwartet war '${AD_TLS_SERVERNAME}'.`);
    },
  };
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
  const client = new Client({
    url: AD_URL,
    timeout: 8000,
    connectTimeout: 8000,
    tlsOptions: tlsOptions(),
  });

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
