// NOC-Sicht auf die Stationen (Abschnitt „Stationen" in js/noc-cockpit.js).
//
// Die Verwaltung (/api/stations/admin/list) liefert alles: Overrides,
// Logs-Verweise, angemeldete Personen, IPs, Wer-hat-registriert. Das NOC
// braucht davon nur den Zustand — und darf Personen gar nicht zeigen (es
// hängt an der Wand). Darum hier eine eigene, schmale Auswahl: je Station
// Kennung, Rolle, Haus, Standort, Ampel und die Zeilen, die die Ampel
// begründen. Keine Personennamen, keine IPs, keine Geheimnisse.
//
// Ampel:
//   gruen  meldet sich in der erwarteten Zeit, nichts Auffälliges
//   gelb   gesperrt, länger still (wo das auffällt), Wartung steht still
//   rot    Anschluss-Abweichung, doppelte Station, eine Anzeige ist weg,
//          ein Arbeitsplatz seit Tagen still
//   grau   darf aus sein (Laptop, Kiosk, Chromecast) oder meldet sich nie
//          (Windows ohne Agent) — zählt nicht als Warnung
//   blau   Update oder SSH-Wartung läuft (Hinweis, keine Warnung)

// Wie lange ein Lebenszeichen alt sein darf, bevor die Station als „aus"
// gilt. Gemeldet wird alle 5 min (station-agent.sh), alle 2 min (Agent v2),
// jede Minute (Kiosk) bzw. alle 45 s (Cast-Wächter) — die Schwelle lässt
// zwei, drei ausgefallene Meldungen zu, damit ein kurzer Hänger nicht blinkt.
const ONLINE_MIN = { desktop: 15, display: 15, laptop: 15, windows: 15, kiosk: 5, chromecast: 5 };
// Was aus sein darf, wird nie rot.
const DARF_AUS = new Set(['laptop', 'kiosk', 'chromecast']);
// Eine Anzeige läuft 24/7: aus = rot. Ein Arbeitsplatz darf übers Wochenende
// aus sein (gelb); erst nach drei Tagen ohne Lebenszeichen ist es rot.
const ARBEITSPLATZ_ROT_STD = 72;
// Wie lange „Update läuft" nach dem Abholen der Aufforderung steht.
const UPDATE_LAEUFT_MIN = 20;
const WARTUNG_LANGE_MIN = 30;

const ROLLEN_TEXT = {
  desktop: 'Arbeitsplatz', display: 'Anzeige', laptop: 'Laptop', windows: 'Windows',
  chromecast: 'Chromecast', kiosk: 'Kiosk-TV',
};

const kurz = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));
const ms = (t) => (t ? new Date(t).getTime() : NaN);

function osText(z) {
  const inv = z.agent_inventar || {};
  const bs = inv.betriebssystem || {};
  const st = z.last_state || {};
  const v2 = [bs.name, bs.version].filter(Boolean).join(' ');
  if (v2) return kurz(v2, 60);
  if (st.os_version) return kurz('OS ' + st.os_version, 60);
  if (z.role === 'kiosk' && st.android) return kurz('Android ' + st.android, 60);
  if (z.ad_betriebssystem) return kurz(z.ad_betriebssystem, 60);
  return null;
}

function agentText(z) {
  const st = z.last_state || {};
  if (Number(z.agent_protokoll) === 2 && z.agent_version) {
    return kurz('Agent ' + z.agent_version + (z.agent_modus === 'parallel' ? ' (Probe)' : ''), 40);
  }
  if (z.role === 'kiosk' && st.app_version) return kurz('Kiosk ' + st.app_version, 40);
  return null;
}

/**
 * Eine Zeile der Tabelle stations (wie /admin/list sie liest, dazu
 * `ereignisse`: die jüngsten Ereignisse [{art, erstellt}]) -> NOC-Eintrag.
 */
function stationFuerNoc(z, jetzt = Date.now()) {
  const rolle = z.role;
  const ohneAgent = rolle === 'windows' && !(Number(z.agent_protokoll) === 2 && z.agent_modus !== 'parallel');
  const letzt = ms(z.last_seen_at);
  const alterMin = Number.isFinite(letzt) ? Math.max(0, Math.round((jetzt - letzt) / 60000)) : null;
  const schwelle = ONLINE_MIN[rolle] ?? 15;
  const online = !ohneAgent && alterMin !== null && alterMin <= schwelle;

  const hinweise = [];   // [{stufe: 'rot'|'gelb'|'info', text}]
  const h = (stufe, text) => hinweise.push({ stufe, text });

  if (z.anschluss_abweichung) h('rot', 'Anschluss-Abweichung');
  if (z.doppelt) h('rot', 'doppelt gemeldet');
  if (z.status === 'gesperrt') h('gelb', 'gesperrt');

  // Erreichbarkeit
  let zustand;  // 'online' | 'aus' | 'still' | 'ohne-agent' | 'nie'
  if (ohneAgent) zustand = 'ohne-agent';
  else if (online) zustand = 'online';
  else if (alterMin === null) zustand = 'nie';
  else zustand = 'aus';

  if (!ohneAgent && !online && !DARF_AUS.has(rolle)) {
    if (rolle === 'display') h('rot', zustand === 'nie' ? 'nie gemeldet' : 'Anzeige aus');
    else if (alterMin === null || alterMin > ARBEITSPLATZ_ROT_STD * 60) { zustand = 'still'; h('rot', 'seit Tagen still'); }
    else h('gelb', 'aus');
  }

  // Laufende Arbeiten: Hinweise, keine Warnungen.
  const ev = Array.isArray(z.ereignisse) ? z.ereignisse : [];
  const jung = (art, min) => ev.some((e) => e && e.art === art && jetzt - ms(e.erstellt) <= min * 60000);
  if (z.update_angefordert) h('info', 'Update angefordert');
  else if (jung('update-abgeholt', UPDATE_LAEUFT_MIN)) h('info', 'Update läuft');
  if (z.zuruecksetzen_angefordert) h('info', 'Zurücksetzen angefordert');
  if (z.ssh_wartung_bis && ms(z.ssh_wartung_bis) > jetzt) h('info', 'SSH-Wartung offen');
  if (jung('wartung-dauert-lange', WARTUNG_LANGE_MIN)) h('gelb', 'Wartung steht still');
  const inv = z.agent_inventar || {};
  if (inv.updates?.neustart_ausstehend) h('info', 'Neustart ausstehend');

  let ampel;
  if (hinweise.some((x) => x.stufe === 'rot')) ampel = 'rot';
  else if (hinweise.some((x) => x.stufe === 'gelb')) ampel = 'gelb';
  else if (zustand === 'online') ampel = hinweise.some((x) => x.stufe === 'info') ? 'blau' : 'gruen';
  else ampel = 'grau';

  return {
    id: kurz(z.id, 64),
    rolle,
    rolle_text: ROLLEN_TEXT[rolle] || rolle,
    haus: Number.isInteger(z.haus) ? z.haus : null,
    standort: kurz(z.standort, 40),
    zustand,
    alter_min: alterMin,
    os: osText(z),
    agent: agentText(z),
    ampel,
    hinweise,
  };
}

const RANG = { rot: 0, gelb: 1, blau: 2, gruen: 3, grau: 4 };

/** Alle Zeilen -> { zusammenfassung, stationen } (entfernte fallen weg). */
function stationenFuerNoc(zeilen, jetzt = Date.now()) {
  const liste = (zeilen || []).filter((z) => z && !z.revoked_at).map((z) => stationFuerNoc(z, jetzt));
  liste.sort((a, b) => (RANG[a.ampel] - RANG[b.ampel])
    || ((a.haus ?? 999) - (b.haus ?? 999)) || String(a.id).localeCompare(String(b.id)));
  const zs = {
    gesamt: liste.length,
    online: liste.filter((s) => s.zustand === 'online').length,
    offline: liste.filter((s) => s.zustand !== 'online' && s.zustand !== 'ohne-agent').length,
    aus_erlaubt: liste.filter((s) => s.ampel === 'grau' && s.zustand !== 'ohne-agent').length,
    ohne_agent: liste.filter((s) => s.zustand === 'ohne-agent').length,
    warnungen: liste.filter((s) => s.ampel === 'gelb').length,
    stoerungen: liste.filter((s) => s.ampel === 'rot').length,
    arbeiten: liste.filter((s) => s.hinweise.some((x) => x.stufe === 'info')).length,
  };
  zs.ampel = zs.stoerungen ? 'rot' : zs.warnungen ? 'gelb' : 'gruen';
  return { zusammenfassung: zs, stationen: liste };
}

// Anonyme Wandbild-Sicht (NOC_PUBLIC_OPEN ohne Token): wie bei den
// Anschlüssen nur Nummer, Rolle, Haus und Zustand.
function stationenOeffentlich(out) {
  return {
    ...out,
    stationen: (out.stationen || []).map((s, i) => ({
      id: 'Station ' + (i + 1), rolle: s.rolle, rolle_text: s.rolle_text, haus: s.haus,
      standort: null, zustand: s.zustand, alter_min: s.alter_min, os: null, agent: null,
      ampel: s.ampel, hinweise: s.hinweise,
    })),
  };
}

module.exports = {
  stationFuerNoc, stationenFuerNoc, stationenOeffentlich,
  ONLINE_MIN, DARF_AUS, ARBEITSPLATZ_ROT_STD,
};
