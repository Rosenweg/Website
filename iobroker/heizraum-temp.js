// Heizraum-Temperatur-Wächter — eigenständig im ioBroker, OHNE Kern-API.
// Liest beide H&T (BLU + WiFi) nativ, meldet Übertemperatur direkt an den
// WhatsApp-Gateway (Technik). Anti-Spam: edge-getriggert (DB-State in 0_userdata),
// Reminder NUR im Alarm alle 6h, Entwarnung 1x. Bewertung über die FRISCHEN
// Sensoren (Redundanz BLU+WiFi); "blind"-Meldung nur wenn beide ausfallen.
const SENSORS = [
  { label: 'BLU H&T',       id: 'shelly.0.ble.0c:ef:f6:02:eb:ba.temperature' },
  { label: 'WiFi Plus H&T', id: 'shelly.0.shellyplusht#08b61fccf7a0#1.Temperature0.Celsius' },
];
const WARN_C = 40, ALARM_C = 45, HYST = 2;
const STALE_MS = 30 * 60 * 1000, REMIND_MS = 6 * 60 * 60 * 1000;
const GW_URL = 'http://100.64.2.39:8090/gateway/send';
const GW_KEY = 'mg_d07ae66b847ebb8f7d47d44fd35213393fe865fe9ef88306254ffa1c644f9443';
const TECHNIK = '120363407257445046@g.us';
const ST_LEVEL = '0_userdata.0.heizraum.alert_level';
const ST_TS    = '0_userdata.0.heizraum.alert_ts';
const ST_BLIND = '0_userdata.0.heizraum.blind';
const RANK = { ok: 0, warn: 1, alarm: 2 };

function send(text) {
  httpPost(GW_URL, JSON.stringify({ channel: 'whatsapp', to: TECHNIK, body: String(text).slice(0, 3500) }),
    { headers: { 'X-Messaging-Key': GW_KEY, 'Content-Type': 'application/json' }, timeout: 15000 },
    (err, resp) => {
      if (err) log('[Heizraum-Wächter] Sendefehler: ' + err, 'warn');
      else if (resp && resp.statusCode >= 300) log('[Heizraum-Wächter] Gateway HTTP ' + resp.statusCode, 'warn');
    });
}
function readSensor(s) {
  const o = getState(s.id);
  const val = (o && o.val != null && isFinite(Number(o.val))) ? Number(o.val) : null;
  const ts = o ? (o.lc || o.ts || 0) : 0;
  return { label: s.label, val, fresh: val != null && (Date.now() - ts <= STALE_MS) };
}
function check() {
  const reads = SENSORS.map(readSensor);
  const fresh = reads.filter(r => r.fresh);
  const detail = reads.map(r => `${r.label}: ${r.val != null ? r.val.toFixed(1) + '°C' : '—'}${r.fresh ? '' : ' (stale)'}`).join(' · ');

  const blind = getState(ST_BLIND).val === true;
  if (fresh.length === 0) {
    if (!blind) { send(`🌡️❓ *Heizraum-Temp nicht lesbar*\n${detail}. Überwachung Server/Netzwerk-Schrank aktuell blind.\n— Heizraum-Wächter`); setState(ST_BLIND, true, true); }
    return;
  } else if (blind) {
    send(`✅ *Heizraum-Temp wieder lesbar*\n${detail}. Entwarnung.\n— Heizraum-Wächter`); setState(ST_BLIND, false, true);
  }

  const maxT = Math.max.apply(null, fresh.map(r => r.val));
  const prev = String(getState(ST_LEVEL).val || 'ok');
  let level = maxT >= ALARM_C ? 'alarm' : (maxT >= WARN_C ? 'warn' : 'ok');
  if (prev === 'alarm' && maxT >= ALARM_C - HYST) level = 'alarm';
  else if ((prev === 'alarm' || prev === 'warn') && level === 'ok' && maxT >= WARN_C - HYST) level = 'warn';

  const now = Date.now();
  if (RANK[level] > RANK[prev]) {
    send(level === 'alarm'
      ? `🔥 *HEIZRAUM-ALARM — ${maxT.toFixed(1)} °C* (≥ ${ALARM_C}°C)\nÜberhitzungsgefahr Server/Netzwerk-Schrank! Lüftung/Kühlung prüfen.\n${detail}\n— Heizraum-Wächter`
      : `⚠️ *Heizraum warm — ${maxT.toFixed(1)} °C* (≥ ${WARN_C}°C)\n${detail}\n— Heizraum-Wächter`);
    setState(ST_LEVEL, level, true); setState(ST_TS, now, true);
  } else if (RANK[level] < RANK[prev]) {
    if (level === 'ok') send(`✅ *Heizraum wieder ok — ${maxT.toFixed(1)} °C*\n${detail}. Entwarnung.\n— Heizraum-Wächter`);
    setState(ST_LEVEL, level, true); setState(ST_TS, now, true);
  } else if (level === 'alarm' && (now - Number(getState(ST_TS).val || 0) >= REMIND_MS)) {
    send(`🔥 *Heizraum weiterhin heiß — ${maxT.toFixed(1)} °C*\n${detail}\n— Heizraum-Wächter`);
    setState(ST_TS, now, true);
  }
}

createState(ST_LEVEL, 'ok', { name: 'Heizraum Alarm-Level', type: 'string', read: true, write: true });
createState(ST_TS, 0, { name: 'Heizraum Alarm-Zeitstempel', type: 'number', read: true, write: true });
createState(ST_BLIND, false, { name: 'Heizraum Temp blind', type: 'boolean', read: true, write: true });
setTimeout(() => { check(); setInterval(check, 3 * 60 * 1000); }, 8000);
log('[Heizraum-Wächter] gestartet (Warn ' + WARN_C + '°C / Alarm ' + ALARM_C + '°C, Gateway direkt)');
