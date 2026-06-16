// ─────────────────────────────────────────────────────────────────────────
// Alarmpanel (STWEG 3): Shelly Gaswarner + Rauchmelder "aufschalten", Status
// pollen, bei Alarm-FLANKE eskalieren:
//   - Rauchmelder (smoke)  -> Technik-WhatsApp + alle STWEG3-Bewohner + Mail
//   - Gaswarner    (gas)   -> Technik-WhatsApp + Mail
// Lesen rein lokal per HTTP (wie der energy-collector): Smoke = Gen2
// (/rpc/Shelly.GetStatus, Komponente smoke:0), Gas = Shelly Gas Gen1 (/status,
// gas_sensor + concentration.ppm). Kein Cloud, kein MQTT.
// ─────────────────────────────────────────────────────────────────────────
const { pool } = require('./db');
const { queueWhatsappMessage, resolveTechnikWhatsappGroupId } = require('./whatsapp');
const { loggedSendMail } = require('./mail');

const POLL_MS       = parseInt(process.env.ALARM_POLL_MS, 10) || 30000; // 30s
const OFFLINE_AFTER = 3;    // aufeinanderfolgende Fehlversuche -> offline
const BATTERY_WARN  = 15;   // % -> Warnung (einmalig pro Flanke)
const TECHNIK_MAIL  = process.env.ALARM_MAIL_TO || 'technik@rosenweg4303.ch';
const tz = (d) => { try { return new Date(d).toLocaleString('de-CH', { timeZone: 'Europe/Zurich' }); } catch { return String(d); } };

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alarm_sensors (
      id SERIAL PRIMARY KEY,
      stweg INTEGER NOT NULL DEFAULT 3,
      name TEXT NOT NULL,
      location TEXT,
      device_type TEXT NOT NULL,            -- 'smoke' | 'gas'
      host TEXT NOT NULL,                   -- Shelly IP/Hostname (lokal)
      gas_threshold_ppm INTEGER,            -- nur gas; Alarm ab >= ppm (zusaetzl. zum Geraete-Alarm)
      active BOOLEAN NOT NULL DEFAULT true,
      status TEXT DEFAULT 'unknown',        -- 'ok' | 'alarm' | 'offline' | 'unknown'
      in_alarm BOOLEAN DEFAULT false,
      battery_low BOOLEAN DEFAULT false,
      battery_percent NUMERIC,
      last_value TEXT,
      fail_count INTEGER DEFAULT 0,
      last_ok_at TIMESTAMPTZ,
      last_alarm_at TIMESTAMPTZ,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS alarm_events (
      id SERIAL PRIMARY KEY,
      sensor_id INTEGER,
      sensor_name TEXT,
      device_type TEXT,
      event TEXT NOT NULL,                  -- alarm|clear|offline|online|battery_low|test
      detail TEXT,
      notified TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_alarm_events ON alarm_events(id DESC);
  `);
}

async function logEvent(s, event, detail, notified) {
  try {
    await pool.query(
      `INSERT INTO alarm_events (sensor_id,sensor_name,device_type,event,detail,notified) VALUES ($1,$2,$3,$4,$5,$6)`,
      [s.id || null, s.name || null, s.device_type || null, event, detail || null, notified || null]);
  } catch (e) { console.warn('[alarm] logEvent:', e.message); }
}

// ── Shelly lokal lesen ────────────────────────────────────────────────────
async function readSensor(s) {
  if (s.device_type === 'smoke') {
    const r = await fetch(`http://${s.host}/rpc/Shelly.GetStatus`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const st = await r.json();
    const sm = st['smoke:0'] || {};
    const dp = st['devicepower:0'] || st['devicepower:1'] || {};
    const bat = dp.battery && typeof dp.battery.percent === 'number' ? dp.battery.percent : null;
    return { alarm: sm.alarm === true, battery: bat, value: sm.alarm ? 'Rauch erkannt' : 'klar' };
  }
  // gas: Shelly Gas (Gen1)
  const r = await fetch(`http://${s.host}/status`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const st = await r.json();
  const gs = st.gas_sensor || {};
  const ppm = st.concentration && typeof st.concentration.ppm === 'number' ? st.concentration.ppm : null;
  const deviceAlarm = gs.alarm_state && gs.alarm_state !== 'none';
  const overThresh  = s.gas_threshold_ppm != null && ppm != null && ppm >= s.gas_threshold_ppm;
  return { alarm: !!(deviceAlarm || overThresh), battery: null, value: ppm != null ? `${ppm} ppm` : (gs.sensor_state || 'unbekannt') };
}

// ── Eskalation ────────────────────────────────────────────────────────────
async function notifyTechnik(body) {
  try {
    const gid = await resolveTechnikWhatsappGroupId();
    if (gid) await queueWhatsappMessage({ chatId: gid, body, sourceType: 'alarmpanel' });
  } catch (e) { console.warn('[alarm] technik-notify:', e.message); }
}

function escalator(resolveBroadcastRecipients) {
  return async function escalate(s, r, isTest) {
    const label = s.device_type === 'smoke' ? '🔥 RAUCHALARM' : '🚨 GASALARM';
    const pfx = isTest ? '🧪 TEST — ' : '';
    const msg = `${pfx}${label}\n${s.name}${s.location ? ' — ' + s.location : ''}\nWert: ${r.value}\nZeit: ${tz(Date.now())}\n— Rosenweg Alarmpanel STWEG 3`;
    let notified = 'technik';
    await notifyTechnik(msg);
    loggedSendMail({ to: TECHNIK_MAIL, subject: `${pfx}${label}: ${s.name}`, text: msg }, 'alarmpanel').catch(e => console.warn('[alarm] mail:', e.message));
    // Rauchmelder: zusaetzlich ALLE STWEG3-Bewohner (Test NICHT an Bewohner!)
    if (s.device_type === 'smoke' && !isTest) {
      try {
        const residents = await resolveBroadcastRecipients('stweg:3');
        let n = 0;
        for (const p of residents) {
          try { await queueWhatsappMessage({ phone: p.phone, body: msg, personId: p.id, sourceType: 'alarmpanel', sourceId: String(s.id) }); n++; } catch {}
        }
        notified = `technik + ${n} bewohner`;
      } catch (e) { console.warn('[alarm] bewohner-broadcast:', e.message); }
    }
    await logEvent(s, isTest ? 'test' : 'alarm', r.value, notified);
    return notified;
  };
}

// ── Poll-Schleife ─────────────────────────────────────────────────────────
function startPolling(escalate) {
  async function pollOnce() {
    let rows = [];
    try { ({ rows } = await pool.query(`SELECT * FROM alarm_sensors WHERE active = true`)); }
    catch (e) { console.warn('[alarm] poll select:', e.message); return; }
    for (const s of rows) {
      try {
        const r = await readSensor(s);
        const wasOffline = s.status === 'offline';
        const wasAlarm = s.in_alarm === true;
        const newStatus = r.alarm ? 'alarm' : 'ok';
        await pool.query(
          `UPDATE alarm_sensors SET status=$1, in_alarm=$2, battery_percent=$3, last_value=$4,
             fail_count=0, last_ok_at=NOW()${r.alarm ? ', last_alarm_at=NOW()' : ''} WHERE id=$5`,
          [newStatus, r.alarm, r.battery, r.value, s.id]);
        if (wasOffline) { await logEvent(s, 'online', 'wieder erreichbar'); }
        if (r.alarm && !wasAlarm) { await escalate(s, r, false); }
        else if (!r.alarm && wasAlarm) { await logEvent(s, 'clear', 'Alarm beendet'); await notifyTechnik(`✅ Entwarnung: ${s.name}${s.location ? ' — ' + s.location : ''} (${tz(Date.now())})`); }
        // Batterie-Flanke
        if (r.battery != null) {
          const low = r.battery < BATTERY_WARN;
          if (low && !s.battery_low) { await pool.query(`UPDATE alarm_sensors SET battery_low=true WHERE id=$1`, [s.id]); await logEvent(s, 'battery_low', `${r.battery}%`); await notifyTechnik(`🔋 Batterie schwach: ${s.name} (${r.battery}%)`); }
          else if (!low && s.battery_low) { await pool.query(`UPDATE alarm_sensors SET battery_low=false WHERE id=$1`, [s.id]); }
        }
      } catch (e) {
        const fc = (s.fail_count || 0) + 1;
        const goOffline = fc >= OFFLINE_AFTER && s.status !== 'offline';
        await pool.query(`UPDATE alarm_sensors SET fail_count=$1${goOffline ? ", status='offline'" : ''} WHERE id=$2`, [fc, s.id]).catch(() => {});
        if (goOffline) { await logEvent(s, 'offline', String(e.message).slice(0, 200)); await notifyTechnik(`⚠️ Sensor nicht erreichbar: ${s.name}${s.location ? ' — ' + s.location : ''}`); }
      }
    }
  }
  setTimeout(function loop() { pollOnce().finally(() => setTimeout(loop, POLL_MS)); }, 5000);
}

// ── Mount: Schema + Endpoints + Polling ────────────────────────────────────
function mountAlarmpanel({ app, authMiddleware, requireManage, resolveBroadcastRecipients }) {
  const escalate = escalator(resolveBroadcastRecipients);
  initSchema()
    .then(() => { startPolling(escalate); console.log('[alarm] Alarmpanel aktiv (poll', POLL_MS + 'ms)'); })
    .catch(e => console.error('[alarm] initSchema:', e.message));

  const VIEW = ['id', 'stweg', 'name', 'location', 'device_type', 'host', 'gas_threshold_ppm', 'active',
    'status', 'in_alarm', 'battery_low', 'battery_percent', 'last_value', 'last_ok_at', 'last_alarm_at'].join(',');

  // Liste + Live-Status
  app.get('/api/alarmpanel/sensors', authMiddleware, async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT ${VIEW} FROM alarm_sensors ORDER BY device_type, name`);
      const agg = rows.reduce((a, s) => { if (s.in_alarm) a.alarm++; else if (s.status === 'offline') a.offline++; else if (s.active) a.ok++; return a; }, { ok: 0, alarm: 0, offline: 0 });
      res.json({ sensors: rows, summary: agg, poll_ms: POLL_MS });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Aufschalten
  app.post('/api/alarmpanel/sensors', authMiddleware, requireManage, async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const device_type = String(b.device_type || '').trim();
    const host = String(b.host || '').trim();
    if (!name || !['smoke', 'gas'].includes(device_type) || !host) {
      return res.status(400).json({ error: 'name, device_type (smoke|gas) und host erforderlich' });
    }
    try {
      const { rows } = await pool.query(
        `INSERT INTO alarm_sensors (name, location, device_type, host, gas_threshold_ppm, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [name, b.location || null, device_type, host, device_type === 'gas' ? (parseInt(b.gas_threshold_ppm, 10) || null) : null, req.user?.email || null]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/alarmpanel/sensors/:id', authMiddleware, requireManage, async (req, res) => {
    const b = req.body || {};
    try {
      await pool.query(
        `UPDATE alarm_sensors SET name=COALESCE($1,name), location=$2, host=COALESCE($3,host),
           gas_threshold_ppm=$4, active=COALESCE($5,active) WHERE id=$6`,
        [b.name ?? null, b.location ?? null, b.host ?? null,
         b.gas_threshold_ppm != null ? parseInt(b.gas_threshold_ppm, 10) : null,
         typeof b.active === 'boolean' ? b.active : null, parseInt(req.params.id, 10)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/alarmpanel/sensors/:id', authMiddleware, requireManage, async (req, res) => {
    try { await pool.query(`DELETE FROM alarm_sensors WHERE id=$1`, [parseInt(req.params.id, 10)]); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Alarm-Historie
  app.get('/api/alarmpanel/events', authMiddleware, async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT id,sensor_name,device_type,event,detail,notified,created_at FROM alarm_events ORDER BY id DESC LIMIT 100`);
      res.json({ events: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Test-Alarm (nur Technik-Benachrichtigung, NICHT an Bewohner)
  app.post('/api/alarmpanel/sensors/:id/test', authMiddleware, requireManage, async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM alarm_sensors WHERE id=$1`, [parseInt(req.params.id, 10)]);
      if (!rows[0]) return res.status(404).json({ error: 'Sensor nicht gefunden' });
      const notified = await escalate(rows[0], { value: 'TEST-Auslösung' }, true);
      res.json({ ok: true, notified });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { mountAlarmpanel };
