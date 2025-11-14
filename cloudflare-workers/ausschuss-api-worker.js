/**
 * Cloudflare Worker für IP-basierte Zugriffskontrolle auf Ausschuss-Kontakte
 *
 * Deployment:
 * - URL: https://api.rosenweg4303.ch/ausschuss-kontakte
 * - oder als Route auf rosenweg4303.ch/api/ausschuss-kontakte
 *
 * Funktionalität:
 * - Prüft ob anfragende IP = IP von kooperation.rosenweg4303.ch
 * - Bei Match: Vollständige Daten (inkl. Telefonnummern)
 * - Sonst: Gefilterte Daten (ohne Telefonnummern)
 */

// Konfiguration
const CONFIG = {
  AUTHORIZED_HOSTNAME: 'kooperation.rosenweg4303.ch',
  GITHUB_RAW_JSON_URL: 'https://raw.githubusercontent.com/Rosenweg/Website/main/ausschuss-kontakte.json',
  CACHE_TTL: 300 // 5 Minuten Cache für DNS-Lookups
};

/**
 * Löst einen Hostnamen zu IPv4-Adresse(n) auf via Cloudflare DNS-over-HTTPS
 */
async function resolveHostname(hostname) {
  try {
    const response = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${hostname}&type=A`,
      {
        headers: {
          'Accept': 'application/dns-json'
        },
        cf: {
          cacheTtl: CONFIG.CACHE_TTL,
          cacheEverything: true
        }
      }
    );

    if (!response.ok) {
      console.error(`DNS-Lookup fehlgeschlagen für ${hostname}:`, response.status);
      return [];
    }

    const data = await response.json();

    // Extrahiere IPv4-Adressen aus den Antworten
    if (data.Answer && Array.isArray(data.Answer)) {
      return data.Answer
        .filter(answer => answer.type === 1) // Typ 1 = A Record (IPv4)
        .map(answer => answer.data);
    }

    return [];
  } catch (error) {
    console.error(`Fehler beim DNS-Lookup für ${hostname}:`, error);
    return [];
  }
}

/**
 * Prüft, ob die Besucher-IP autorisiert ist
 */
async function isAuthorizedIP(visitorIP, cache) {
  // Versuche aus Cache zu lesen
  const cacheKey = `authorized-ips-${CONFIG.AUTHORIZED_HOSTNAME}`;
  let authorizedIPs = cache ? await cache.get(cacheKey, 'json') : null;

  if (!authorizedIPs) {
    // Cache-Miss: Löse Hostname auf
    authorizedIPs = await resolveHostname(CONFIG.AUTHORIZED_HOSTNAME);

    // Speichere in Cache
    if (cache && authorizedIPs.length > 0) {
      await cache.put(
        cacheKey,
        JSON.stringify(authorizedIPs),
        { expirationTtl: CONFIG.CACHE_TTL }
      );
    }
  }

  console.log(`Besucher-IP: ${visitorIP}`);
  console.log(`Autorisierte IPs für ${CONFIG.AUTHORIZED_HOSTNAME}:`, authorizedIPs);

  // Prüfe, ob die Besucher-IP in der Liste ist
  return authorizedIPs.includes(visitorIP);
}

/**
 * Filtert sensible Daten aus den Ausschuss-Kontakten
 */
function filterSensitiveData(data) {
  const filtered = JSON.parse(JSON.stringify(data)); // Deep copy

  // Filtere Präsident: Entferne Telefonnummer und original E-Mail
  if (filtered.ausschuss?.präsident) {
    delete filtered.ausschuss.präsident.telefon;
    delete filtered.ausschuss.präsident.email_original;
  }

  // Filtere STWEG-Vertreter: Entferne Telefonnummern und original E-Mails
  if (filtered.ausschuss?.vertreter) {
    filtered.ausschuss.vertreter.forEach(stweg => {
      // Entferne email_forwards_to (enthält originale E-Mails)
      delete stweg.email_forwards_to;

      // Entferne Telefonnummern und E-Mails der einzelnen Vertreter
      if (stweg.vertreter) {
        stweg.vertreter.forEach(vertreter => {
          delete vertreter.telefon;
          delete vertreter.email;
        });
      }
    });
  }

  return filtered;
}

/**
 * Lädt die ausschuss-kontakte.json von GitHub
 */
async function loadAusschussKontakte() {
  try {
    const response = await fetch(CONFIG.GITHUB_RAW_JSON_URL, {
      cf: {
        cacheTtl: 60, // Cache für 1 Minute
        cacheEverything: true
      }
    });

    if (!response.ok) {
      throw new Error(`GitHub fetch fehlgeschlagen: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Fehler beim Laden der ausschuss-kontakte.json:', error);
    throw error;
  }
}

/**
 * Hauptfunktion - Cloudflare Worker Handler
 */
export default {
  async fetch(request, env, ctx) {
    // CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      });
    }

    // Nur GET erlauben
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: {
          'Allow': 'GET, OPTIONS'
        }
      });
    }

    try {
      // 1. Hole die IP-Adresse des Besuchers
      // Cloudflare stellt die echte IP im CF-Connecting-IP Header bereit
      const visitorIP = request.headers.get('CF-Connecting-IP') ||
                        request.headers.get('X-Forwarded-For')?.split(',')[0] ||
                        'unknown';

      console.log(`API-Anfrage von IP: ${visitorIP}`);

      // 2. Lade die vollständigen Kontaktdaten von GitHub
      const fullData = await loadAusschussKontakte();

      // 3. Prüfe, ob die IP autorisiert ist
      const cache = env.CACHE || caches.default;
      const isAuthorized = await isAuthorizedIP(visitorIP, cache);

      // 4. Entscheide, welche Daten zurückgegeben werden
      let responseData;
      let accessLevel;

      if (isAuthorized) {
        // Autorisiert: Gebe vollständige Daten zurück
        responseData = fullData;
        accessLevel = 'full';
        console.log(`✅ Zugriff gewährt für IP ${visitorIP}`);
      } else {
        // Nicht autorisiert: Gebe gefilterte Daten zurück
        responseData = filterSensitiveData(fullData);
        accessLevel = 'public';
        console.log(`🔒 Zugriff eingeschränkt für IP ${visitorIP}`);
      }

      // 5. Füge Metadaten hinzu
      const response = {
        ...responseData,
        _meta: {
          access_level: accessLevel,
          timestamp: new Date().toISOString(),
          visitor_ip: visitorIP,
          authorized_hostname: CONFIG.AUTHORIZED_HOSTNAME
        }
      };

      // 6. Rückgabe mit CORS-Headern
      return new Response(JSON.stringify(response, null, 2), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
          'X-Access-Level': accessLevel,
          'X-Visitor-IP': visitorIP
        }
      });

    } catch (error) {
      console.error('Fehler in ausschuss-kontakte API:', error);

      return new Response(JSON.stringify({
        error: 'Interner Serverfehler',
        message: error.message,
        stack: error.stack
      }, null, 2), {
        status: 500,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
  }
};
