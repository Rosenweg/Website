/**
 * Das WLAN einer Station aus UniFi auflösen.
 *
 * Im Haus gibt es genau ein Funknetz — `Rosenweg` — mit privaten
 * Schlüsseln (PPSK). Welchen Schlüssel ein Gerät benutzt, entscheidet, in
 * welchem VLAN es landet: `RK-Clients` (VLAN 9) ist der allgemeine
 * Client-Bereich, `RW9-Clients`, `RW13-Clients` und so weiter gehören den
 * einzelnen Häusern.
 *
 * Deshalb steht in der Stationsconfig ein NETZNAME und kein Passwort. Der
 * Schlüssel kommt von hier, frisch aus UniFi. Wird er dort gewechselt, ziehen
 * die Stationen beim nächsten Update von selbst nach — niemand muss ihn an
 * zwei Stellen pflegen, und in der Verwaltung tippt ihn niemand ab.
 *
 * Ausnahme ist eine Station, die gar nicht im Haus steht, etwa bei jemandem
 * zu Hause. Dort hilft kein Hausnetz; dafür gibt es weiterhin SSID und
 * Passwort von Hand (siehe stationconfig.js).
 */

const UNIFI_HOST = process.env.UNIFI_HOST || 'https://100.64.2.1';
const UNIFI_API_KEY = process.env.UNIFI_API_KEY || '';

// UniFi antwortet mit einem selbst ausgestellten Zertifikat. Die Station holt
// ihre Config bei jedem Lauf; ohne Zwischenspeicher wären das bei zwanzig
// Geräten zwanzig Abfragen alle paar Minuten, und bei jeder Störung dort
// stünde die Einrichtung still.
const CACHE_MS = 5 * 60 * 1000;
let cache = { zeit: 0, netze: null };

async function unifiHolen(pfad) {
  const antwort = await fetch(`${UNIFI_HOST}/proxy/network/api/s/default/${pfad}`, {
    headers: { 'X-API-Key': UNIFI_API_KEY },
    signal: AbortSignal.timeout(6000),
  });
  if (!antwort.ok) throw new Error(`unifi ${pfad} -> ${antwort.status}`);
  return (await antwort.json()).data || [];
}

/**
 * Alle Netze mit privatem Schlüssel, als {netz: {ssid, password, vlan}}.
 * Bei einer Störung kommt der letzte bekannte Stand zurück, notfalls null.
 */
async function netzeLesen() {
  if (cache.netze && Date.now() - cache.zeit < CACHE_MS) return cache.netze;
  if (!UNIFI_API_KEY) return cache.netze;

  try {
    const [netzconf, wlanconf] = await Promise.all([
      unifiHolen('rest/networkconf'),
      unifiHolen('rest/wlanconf'),
    ]);
    const nachId = Object.fromEntries(netzconf.map((n) => [n._id, n]));
    const funknetz = wlanconf.find((w) => w.name === 'Rosenweg' && w.enabled);
    if (!funknetz?.private_preshared_keys_enabled) return cache.netze;

    const netze = {};
    for (const ppsk of funknetz.private_preshared_keys || []) {
      const netz = nachId[ppsk.networkconf_id];
      if (!netz?.name || !ppsk.password) continue;
      // Mehrere Schlüssel je Netz kommen vor; der erste gilt.
      if (netze[netz.name]) continue;
      netze[netz.name] = { ssid: funknetz.name, password: ppsk.password, vlan: netz.vlan };
    }
    cache = { zeit: Date.now(), netze };
    return netze;
  } catch (e) {
    console.error('[stationwlan] UniFi nicht lesbar:', e.message);
    // Lieber der letzte bekannte Stand als gar keiner — eine Station ohne
    // WLAN-Profil käme sonst nicht mehr ins Netz zurück.
    return cache.netze;
  }
}

/** Nur die Namen, für die Auswahl in der Verwaltung. Ohne Schlüssel. */
async function netznamen() {
  const netze = await netzeLesen();
  if (!netze) return [];
  return Object.entries(netze)
    .map(([name, n]) => ({ name, vlan: n.vlan }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

/**
 * Das `network.wifi` einer Station fertig machen.
 * Ein von Hand gesetztes `ssid` gewinnt — das ist der Fall „Station steht
 * nicht im Haus". Sonst wird `netz` in UniFi nachgeschlagen.
 */
async function wlanAufloesen(wifi) {
  const w = { ...(wifi || {}) };
  if (w.ssid) return w;                     // eigenes Netz, von Hand
  if (!w.netz) return w;

  const netze = await netzeLesen();
  const treffer = netze?.[w.netz];
  if (treffer) return { ...w, ssid: treffer.ssid, password: treffer.password };

  // UniFi antwortet nicht, oder das Netz heisst dort anders. Dann die
  // Rückfallebene aus der Umgebung — besser ein Profil, das vielleicht
  // veraltet ist, als eine Station ohne Netz. Wenn auch die leer ist, bleibt
  // das WLAN weg und die Station behält ihr vorhandenes Profil.
  console.error(`[stationwlan] Netz '${w.netz}' nicht aufloesbar.`);
  const ersatzSsid = process.env.STATION_WIFI_SSID || '';
  const ersatzPsk = process.env.STATION_WIFI_PASSWORD || '';
  if (ersatzSsid && ersatzPsk) {
    console.error('[stationwlan] benutze die Rueckfallebene aus der Umgebung.');
    return { ...w, ssid: ersatzSsid, password: ersatzPsk };
  }
  return w;
}

module.exports = { wlanAufloesen, netznamen };
