/**
 * Zwei Wächter für die Stationen (Rosenweg/os-stationen), ohne Datenbank —
 * damit sich die Entscheidungen ohne Postgres und ohne UniFi prüfen lassen
 * (api/test/stationwaechter.test.js). Was daraus folgt (sperren, melden,
 * speichern), macht routes/stations.js.
 *
 * 1. Anschluss: Jede Station merkt sich, an welchem Switch-Port (bzw. bei
 *    WLAN: an welchem Access Point) ihre MAC zuletzt hing. Taucht sie an
 *    einem anderen auf, wird sie gesperrt, bis Technik den neuen Anschluss
 *    übernimmt. Wer eine Station heimlich ab- und anderswo wieder ansteckt
 *    — oder ein fremdes Gerät mit ihrer MAC —, fällt so auf.
 *
 * 2. Doppelte Station: Melden sich zwei Geräte mit demselben Token, sieht
 *    man das an den Lebenszeichen: zwei Absender (Adresse oder Startzeit),
 *    die sich zeitlich abwechseln. Ein Gerät, das neu startet oder eine
 *    neue Adresse bekommt, wechselt einmal und bleibt dann — das ist kein
 *    Abwechseln. Hier wird nur gemeldet, nicht gesperrt: welches der beiden
 *    das echte ist, weiss die API nicht.
 */

// ─── Anschluss ───────────────────────────────────────────────────────

const normMac = (m) => String(m || '').trim().toLowerCase();

/** Die MAC-Adressen einer Station, aus dem Inventar der Einrichtung. */
function stationsMacs(hardware) {
  const macs = Object.values((hardware && hardware.macs) || {})
    .map(normMac)
    .filter((m) => /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(m) && m !== '00:00:00:00:00:00');
  return [...new Set(macs)];
}

/**
 * Der UniFi-Client (aus stat/sta) zu diesen MACs. Hängt eine Station mit
 * Kabel und WLAN zugleich im Netz, zählt das Kabel — das ist der Anschluss,
 * an dem sie steht; das WLAN wandert mit jedem Roaming.
 */
function clientFinden(clients, macs) {
  const set = new Set(macs.map(normMac));
  const treffer = (clients || []).filter((c) => set.has(normMac(c.mac)));
  if (!treffer.length) return null;
  treffer.sort((a, b) => (Number(!!b.is_wired) - Number(!!a.is_wired))
    || ((b.last_seen || 0) - (a.last_seen || 0)));
  return treffer[0];
}

function geraetName(devices, mac) {
  const d = (devices || []).find((x) => normMac(x.mac) === normMac(mac));
  return { geraet: d, name: (d && (d.name || d.model)) || normMac(mac) };
}

/**
 * Wo der Client hängt, als {art, geraet_mac, geraet_name, port, port_name, mac}.
 * null, wenn UniFi es nicht sagt (etwa ein Kabelclient ohne sw_mac).
 */
function anschlussAus(client, devices) {
  if (!client) return null;
  if (client.is_wired) {
    if (!client.sw_mac || client.sw_port == null) return null;
    const { geraet, name } = geraetName(devices, client.sw_mac);
    const port = Number(client.sw_port);
    const p = (geraet?.port_table || []).find((x) => Number(x.port_idx) === port);
    // UniFi nennt einen unbenannten Port "Port 7"; das wäre doppelt.
    const portName = p?.name && !/^port \d+$/i.test(p.name.trim()) ? p.name.trim() : null;
    return {
      art: 'kabel', geraet_mac: normMac(client.sw_mac), geraet_name: name,
      port, port_name: portName, mac: normMac(client.mac),
    };
  }
  if (!client.ap_mac) return null;
  const { name } = geraetName(devices, client.ap_mac);
  return {
    art: 'wlan', geraet_mac: normMac(client.ap_mac), geraet_name: client.ap_name || name,
    port: null, port_name: null, mac: normMac(client.mac),
  };
}

const anschlussSchluessel = (a) => (a ? `${a.art}|${normMac(a.geraet_mac)}|${a.port ?? ''}` : '');

function anschlussText(a) {
  if (!a) return '?';
  if (a.art === 'wlan') return `WLAN über ${a.geraet_name || a.geraet_mac}`;
  return `${a.geraet_name || a.geraet_mac} Port ${a.port}${a.port_name ? ` (${a.port_name})` : ''}`;
}

const listeText = (liste) => (liste || []).map(anschlussText).join(' / ') || '?';

// Erst beim zweiten Abgleich in Folge am selben fremden Anschluss wird
// gesperrt. UniFi meldet einen Client nach dem Umstecken oder hinter einem
// zweiten Switch kurz am falschen Port; einmal ist kein Umzug.
const BESTAETIGUNGEN = 2;

/**
 * Was der Abgleich mit einer Station tun soll.
 *   gelernt:    Liste der gelernten Anschlüsse (Kabel: einer; WLAN: die APs,
 *               an denen sie schon freigegeben war — sie roamt)
 *   kandidat:   {anschluss, mal} — fremder Anschluss, noch nicht bestätigt
 *   abweichung: fremder Anschluss, für den schon gesperrt wurde
 *   aktuell:    wo sie jetzt hängt (anschlussAus), oder null
 *
 * aktion: 'unbekannt' | 'lernen' | 'gleich' | 'vormerken' | 'sperren' | 'bleibt'
 */
function anschlussPruefen({ gelernt, kandidat, abweichung, aktuell }) {
  if (!aktuell) return { aktion: 'unbekannt' };
  const k = anschlussSchluessel(aktuell);
  const liste = Array.isArray(gelernt) ? gelernt : [];
  if (!liste.length) return { aktion: 'lernen' };
  if (liste.some((g) => anschlussSchluessel(g) === k)) return { aktion: 'gleich' };
  if (abweichung && anschlussSchluessel(abweichung) === k) return { aktion: 'bleibt' };
  const mal = kandidat && anschlussSchluessel(kandidat.anschluss) === k ? (kandidat.mal || 0) + 1 : 1;
  if (mal >= BESTAETIGUNGEN) {
    return { aktion: 'sperren', grund: `an anderem Anschluss aufgetaucht: ${anschlussText(aktuell)} statt ${listeText(liste)}` };
  }
  return { aktion: 'vormerken', kandidat: { anschluss: aktuell, mal } };
}

const WLAN_MAX_APS = 12;

/**
 * Den neuen Anschluss übernehmen. Kabel: er ersetzt den alten — das ist der
 * Umzug. WLAN: der AP kommt dazu, die alten bleiben — eine WLAN-Station
 * roamt zwischen den APs im Haus, und jeder davon soll nur einmal
 * freigegeben werden müssen. Wechselt die Art (Kabel ↔ WLAN), beginnt die
 * Liste neu.
 */
function uebernehmen(gelernt, neu) {
  if (!neu) return Array.isArray(gelernt) ? gelernt : [];
  const liste = Array.isArray(gelernt) ? gelernt : [];
  if (neu.art !== 'wlan' || liste.some((g) => g.art !== 'wlan')) return [neu];
  const k = anschlussSchluessel(neu);
  return [...liste.filter((g) => anschlussSchluessel(g) !== k), neu].slice(-WLAN_MAX_APS);
}

// ─── Doppelte Station ───────────────────────────────────────────────

// Wie weit die aus der Laufzeit errechnete Startzeit eines Geräts von
// Lebenszeichen zu Lebenszeichen schwanken darf (Laufzeit der Anfrage,
// ganze Sekunden). Zwei Geräte, die nach einem Stromausfall gleichzeitig
// hochkommen, unterscheiden sich meist trotzdem in der Adresse.
const BOOT_TOLERANZ_MS = 30 * 1000;

const ms = (t) => (t instanceof Date ? t.getTime() : (typeof t === 'number' ? t : new Date(t).getTime()));

/**
 * Lebenszeichen nach Absender gruppieren. Ein Absender ist: dieselbe
 * Quelladresse, dieselbe lokale Adresse und dieselbe Startzeit (±30 s).
 * Eintrag: {zeit, quelle_ip, lokal_ip, boot} — boot darf fehlen.
 */
function absenderGruppen(lebenszeichen) {
  const gruppen = [];
  const sortiert = [...(lebenszeichen || [])].sort((a, b) => ms(a.zeit) - ms(b.zeit));
  for (const z of sortiert) {
    const t = ms(z.zeit);
    const boot = z.boot == null ? null : ms(z.boot);
    const g = gruppen.find((x) => x.quelle_ip === (z.quelle_ip || null)
      && x.lokal_ip === (z.lokal_ip || null)
      && (x.boot == null || boot == null || Math.abs(x.boot - boot) <= BOOT_TOLERANZ_MS));
    if (g) {
      g.bis = t; g.anzahl += 1;
      if (g.boot == null) g.boot = boot;
    } else {
      gruppen.push({ quelle_ip: z.quelle_ip || null, lokal_ip: z.lokal_ip || null, boot, von: t, bis: t, anzahl: 1 });
    }
  }
  return gruppen;
}

/**
 * Melden sich gerade zwei Geräte als dieselbe Station? Ja, wenn sich zwei
 * Absender zeitlich überlappen: der eine meldet sich, dann der andere, dann
 * wieder der erste. Ein Neustart oder eine neue Adresse ergibt zwei
 * Absender nacheinander, ohne Überlappung.
 *
 * Rückgabe: null oder {quellen: [Gruppen, die sich überlappen]}.
 */
function doppelteErkennen(lebenszeichen) {
  const gruppen = absenderGruppen(lebenszeichen);
  const beteiligt = new Set();
  for (let i = 0; i < gruppen.length; i += 1) {
    for (let j = i + 1; j < gruppen.length; j += 1) {
      const a = gruppen[i]; const b = gruppen[j];
      if (a.von < b.bis && b.von < a.bis) { beteiligt.add(a); beteiligt.add(b); }
    }
  }
  if (!beteiligt.size) return null;
  return {
    quellen: [...beteiligt].map((g) => ({
      quelle_ip: g.quelle_ip, lokal_ip: g.lokal_ip,
      gestartet: g.boot == null ? null : new Date(g.boot).toISOString(),
      zuerst: new Date(g.von).toISOString(), zuletzt: new Date(g.bis).toISOString(), anzahl: g.anzahl,
    })),
  };
}

function quelleText(q) {
  const teile = [q.lokal_ip, q.quelle_ip && q.quelle_ip !== q.lokal_ip ? `über ${q.quelle_ip}` : null].filter(Boolean);
  return teile.join(' ') || 'unbekannte Adresse';
}

module.exports = {
  stationsMacs, clientFinden, anschlussAus, anschlussSchluessel, anschlussText, listeText,
  anschlussPruefen, uebernehmen, BESTAETIGUNGEN,
  absenderGruppen, doppelteErkennen, quelleText, BOOT_TOLERANZ_MS,
};
