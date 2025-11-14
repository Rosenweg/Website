/**
 * Cloudflare Pages Function für IP-basierte Zugriffskontrolle
 * Gibt vollständige Ausschussdaten nur an autorisierte IPs zurück
 */

// Hostname für IP-Prüfung
const AUTHORIZED_HOSTNAME = 'kooperation.rosenweg4303.ch';

/**
 * Löst einen Hostnamen zu IP-Adresse(n) auf via Cloudflare DNS-over-HTTPS
 */
async function resolveHostname(hostname) {
  try {
    const response = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${hostname}&type=A`,
      {
        headers: {
          'Accept': 'application/dns-json'
        }
      }
    );

    if (!response.ok) {
      console.error(`DNS-Lookup fehlgeschlagen für ${hostname}`);
      return [];
    }

    const data = await response.json();

    // Extrahiere IP-Adressen aus den Antworten
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
async function isAuthorizedIP(visitorIP) {
  // Löse den autorisierten Hostnamen auf
  const authorizedIPs = await resolveHostname(AUTHORIZED_HOSTNAME);

  console.log(`Besucher-IP: ${visitorIP}`);
  console.log(`Autorisierte IPs für ${AUTHORIZED_HOSTNAME}:`, authorizedIPs);

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
 * Lädt die ausschuss-kontakte.json Datei
 */
async function loadAusschussKontakte(env) {
  try {
    // Für Cloudflare Pages: Lade die Datei aus dem Asset-Namespace
    // Die Datei muss im Build-Output sein
    const response = await env.ASSETS.fetch(new Request('https://dummy.host/ausschuss-kontakte.json'));

    if (!response.ok) {
      throw new Error('Datei nicht gefunden');
    }

    return await response.json();
  } catch (error) {
    console.error('Fehler beim Laden der ausschuss-kontakte.json:', error);
    throw error;
  }
}

/**
 * Hauptfunktion - Cloudflare Pages Function Handler
 */
export async function onRequest(context) {
  const { request, env } = context;

  try {
    // 1. Hole die IP-Adresse des Besuchers
    // Cloudflare stellt die echte IP im CF-Connecting-IP Header bereit
    const visitorIP = request.headers.get('CF-Connecting-IP') ||
                      request.headers.get('X-Forwarded-For')?.split(',')[0] ||
                      'unknown';

    console.log(`API-Anfrage von IP: ${visitorIP}`);

    // 2. Lade die vollständigen Kontaktdaten
    const fullData = await loadAusschussKontakte(env);

    // 3. Prüfe, ob die IP autorisiert ist
    const isAuthorized = await isAuthorizedIP(visitorIP);

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
        authorized_hostname: AUTHORIZED_HOSTNAME
      }
    };

    // 6. Rückgabe mit CORS-Headern
    return new Response(JSON.stringify(response, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'X-Access-Level': accessLevel
      }
    });

  } catch (error) {
    console.error('Fehler in ausschuss-kontakte API:', error);

    return new Response(JSON.stringify({
      error: 'Interner Serverfehler',
      message: error.message
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }
}

// OPTIONS-Handler für CORS Preflight
export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
