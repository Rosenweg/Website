const ModbusRTU = require('modbus-serial');
const { Pool } = require('pg');
const express = require('express');
const cors = require('cors');
const mqtt = require('mqtt');

// ─── Configuration ──────────────────────────────────────────────────
// METERS env var is only used for initial DB seeding (first start)
// After that, all meter config comes from the database
const SEED_METERS = process.env.METERS ? process.env.METERS.split(',').map(m => {
  const [host, port, unitId, name] = m.split(':');
  return { host, port: parseInt(port), unitId: parseInt(unitId) || 1, name: name || host };
}) : [];

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '5') * 1000;
const API_PORT = parseInt(process.env.API_PORT || '3001');

// ─── Database ───────────────────────────────────────────────────────
const pool = new Pool({
  host: process.env.DB_HOST || 'energy-db',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'energy',
  user: process.env.DB_USER || 'energy',
  password: process.env.DB_PASSWORD || '',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 30000,
});
pool.on('error', (err) => console.error('[DB] Idle client error:', err.message));

// ─── MQTT-Publish (Zaehlerdaten fuer andere Regelsysteme) ───────────
// Jeder Poll wird zusaetzlich zur DB nach MQTT publiziert (retained), damit
// Regelsysteme/Dashboards den letzten Wert sofort beim Connect bekommen.
// MQTT_URL leer => Feature aus (Collector laeuft unveraendert weiter).
const MQTT_URL = process.env.MQTT_URL || '';
const MQTT_USER = process.env.MQTT_USER || 'collector';
const MQTT_PASS = process.env.MQTT_PASS || '';
const MQTT_PREFIX = process.env.MQTT_PREFIX || 'energy';
// PV-Ueberschuss-Anteil pro Wohnung (via MQTT abonniert): wohnung -> { w, ts }
const ueberschussReadings = new Map();
let mqttClient = null;
if (MQTT_URL) {
  mqttClient = mqtt.connect(MQTT_URL, {
    username: MQTT_USER,
    password: MQTT_PASS,
    clientId: 'energy-collector',
    reconnectPeriod: 5000,
    connectTimeout: 10000,
    will: { topic: `${MQTT_PREFIX}/collector/status`, payload: 'offline', retain: true, qos: 0 },
  });
  mqttClient.on('connect', () => {
    console.log(`[MQTT] connected ${MQTT_URL} (prefix ${MQTT_PREFIX})`);
    mqttClient.publish(`${MQTT_PREFIX}/collector/status`, 'online', { retain: true });
    // PV-Ueberschuss-Anteil pro Wohnung (von einem anderen Producer publiziert)
    // abonnieren -> als 4. "Verbraucher" in solar-live + von den Wohnungen abziehen
    // (steckt in den Wohnungszaehlern mit drin, sonst doppelt gezaehlt).
    mqttClient.subscribe(`${MQTT_PREFIX}/r9/ueberschuss/+/total_w`, { qos: 0 }, (err) => {
      if (err) console.error('[MQTT] ueberschuss subscribe:', err.message);
      else console.log('[MQTT] subscribed ueberschuss/+/total_w');
    });
  });
  mqttClient.on('message', (topic, payload) => {
    // energy/r9/ueberschuss/<wohnung>/total_w  (p[2]=ueberschuss, p[3]=wohnung, p[4]=total_w)
    const p = String(topic).split('/');
    if (p[2] === 'ueberschuss' && p[4] === 'total_w') {
      const w = Number(payload.toString());
      if (Number.isFinite(w)) ueberschussReadings.set(p[3], { w, ts: Date.now() });
    }
  });
  mqttClient.on('error', (e) => console.error('[MQTT] error:', e.message));
  mqttClient.on('reconnect', () => console.log('[MQTT] reconnecting...'));
  mqttClient.on('close', () => console.log('[MQTT] disconnected'));
} else {
  console.log('[MQTT] disabled (kein MQTT_URL gesetzt)');
}

// Ein Reading publishen: Voll-JSON unter energy/<id> + flache numerische
// Schluesseltopics energy/<id>/<feld> (retained) fuer simple Subscriber.
function mqttPublishReading(meter, data, ts) {
  if (!mqttClient || !mqttClient.connected) return;
  // meter.id "r9-2og3" -> Topic energy/r9/2og3 (Hierarchie energy/<haus>/<bereich>).
  // Dieses Schema traegt die ACL: energy=alle, energy/r9=nur Rosenweg-9-Gruppen,
  // energy/r9/2og3=nur die Wohnungs-Gruppe. Bereich = Rest nach dem ersten "-".
  const idParts = String(meter.id).split('-');
  const haus = idParts.shift();
  const bereich = idParts.length ? idParts.join('-') : haus;
  const base = `${MQTT_PREFIX}/${haus}/${bereich}`;
  // Voll-JSON unter dem Basistopic + JEDES vorhandene Mess-Feld als eigenes
  // retained Subtopic (energy/<haus>/<bereich>/<feld>). Nicht alle Zaehler liefern
  // alle Felder (Shelly EM hat keine Spannung/Strom) -> nur vorhandene publiziert.
  const fields = {
    power_w: data.power_w,
    power_l1_w: data.power_l1_w,
    power_l2_w: data.power_l2_w,
    power_l3_w: data.power_l3_w,
    voltage_l1_v: data.voltage_l1_v,
    voltage_l2_v: data.voltage_l2_v,
    voltage_l3_v: data.voltage_l3_v,
    current_l1_a: data.current_l1_a,
    current_l2_a: data.current_l2_a,
    current_l3_a: data.current_l3_a,
    pf_l1: data.pf_l1,
    pf_l2: data.pf_l2,
    pf_l3: data.pf_l3,
    tariff: data.tariff,
    energy_import_kwh: data.energy_import_kwh,
    energy_export_kwh: data.energy_export_kwh,
    energy_import_t1_kwh: data.energy_import_t1_kwh,
    energy_import_t2_kwh: data.energy_import_t2_kwh,
    energy_export_t1_kwh: data.energy_export_t1_kwh,
    energy_export_t2_kwh: data.energy_export_t2_kwh,
  };
  try {
    mqttClient.publish(base, JSON.stringify({
      name: meter.name,
      location: meter.location || null,
      category: meter.category || null,
      ts: ts.toISOString(),
      ...fields,
    }), { retain: true });
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        mqttClient.publish(`${base}/${k}`, String(v), { retain: true });
      }
    }
  } catch (e) {
    console.error('[MQTT] publish error:', e.message);
  }
}

// ─── smart-me Telstar 80A Register Map ──────────────────────────────
// All registers use FC03 (Read Holding Registers), Big Endian
// IMPORTANT: smart-me Modbus addresses are "internal address - 1"
// All values are int32 (2 registers each)
// Power in mW, Voltage in mV, Current in mA, Energy kWh registers at 0x204B/0x204D (*1000)

// ─── Modbus Read Helpers ────────────────────────────────────────────
function parseRegisterValue(buffer, type) {
  switch (type) {
    case 'uint16': return buffer.readUInt16BE(0);
    case 'int32':  return buffer.readInt32BE(0);
    case 'uint32': return buffer.readUInt32BE(0);
    case 'int16':  return buffer.readInt16BE(0);
    default: return 0;
  }
}

async function readMeter(client, meter) {
  client.setID(meter.unit_id || meter.unitId || 1);

  const data = {};

  // smart-me: Modbus address = internal address - 1
  // All values are int32 (2 registers each), Big Endian

  // Group 0: Serial Number (internal 0x2000) + Date/Time UTC (internal 0x2002)
  //          → Modbus 0x1FFF, 4 registers (serial uint32, unix-time uint32).
  //          Best-effort: statische Geraete-Identitaet, darf den Live-Read nicht killen.
  try {
    const idBuf = await client.readHoldingRegisters(0x1FFF, 4);
    data.serial = parseRegisterValue(Buffer.from(idBuf.buffer), 'uint32');
    const dt = parseRegisterValue(Buffer.from(idBuf.buffer.slice(4)), 'uint32');
    data.device_time = dt ? new Date(dt * 1000).toISOString() : null;
  } catch (e) {
    data.serial = null;
    data.device_time = null;
  }

  // Group 1: Power registers (internal 0x2004-0x200B → Modbus 0x2003-0x200A, 8 registers)
  const powerBuf = await client.readHoldingRegisters(0x2003, 8);
  data.power_mw = parseRegisterValue(Buffer.from(powerBuf.buffer), 'int32');        // mW
  data.power_l1_mw = parseRegisterValue(Buffer.from(powerBuf.buffer.slice(4)), 'int32');
  data.power_l2_mw = parseRegisterValue(Buffer.from(powerBuf.buffer.slice(8)), 'int32');
  data.power_l3_mw = parseRegisterValue(Buffer.from(powerBuf.buffer.slice(12)), 'int32');

  // Group 2: Voltage + Current (internal 0x2014-0x201F → Modbus 0x2013-0x201E, 12 registers)
  const vcBuf = await client.readHoldingRegisters(0x2013, 12);
  data.voltage_l1_mv = parseRegisterValue(Buffer.from(vcBuf.buffer), 'int32');      // mV
  data.voltage_l2_mv = parseRegisterValue(Buffer.from(vcBuf.buffer.slice(4)), 'int32');
  data.voltage_l3_mv = parseRegisterValue(Buffer.from(vcBuf.buffer.slice(8)), 'int32');
  data.current_l1_ma = parseRegisterValue(Buffer.from(vcBuf.buffer.slice(12)), 'int32'); // mA
  data.current_l2_ma = parseRegisterValue(Buffer.from(vcBuf.buffer.slice(16)), 'int32');
  data.current_l3_ma = parseRegisterValue(Buffer.from(vcBuf.buffer.slice(20)), 'int32');

  // Group 3: Power factor + tariff (internal 0x2020-0x2023 → Modbus 0x201F-0x2022, 4 x uint16)
  const pfBuf = await client.readHoldingRegisters(0x201F, 4);
  data.pf_l1_raw = parseRegisterValue(Buffer.from(pfBuf.buffer.subarray(0, 2)), 'uint16');   // /1000
  data.pf_l2_raw = parseRegisterValue(Buffer.from(pfBuf.buffer.subarray(2, 4)), 'uint16');
  data.pf_l3_raw = parseRegisterValue(Buffer.from(pfBuf.buffer.subarray(4, 6)), 'uint16');
  data.tariff_raw = parseRegisterValue(Buffer.from(pfBuf.buffer.subarray(6, 8)), 'uint16');

  // Group 4: Energy in Wh, uint32. Total + Tarif-Split in EINEM Read.
  //   internal 0x204C Import-Total, 0x204E Export-Total,
  //   0x2050 Import-T1, 0x2052 Import-T2, 0x2054 Export-T1, 0x2056 Export-T2
  //   → Modbus 0x204B, 12 Register (6 x uint32). Fallback auf 4 Register
  //   (nur Total), falls ein Zaehler den Tarif-Split-Block nicht exponiert —
  //   damit ein fehlender Block nicht den ganzen Read (=> Zaehler offline) killt.
  let eb;
  try {
    const energyBuf = await client.readHoldingRegisters(0x204B, 12);
    eb = Buffer.from(energyBuf.buffer);
  } catch (e) {
    const energyBuf = await client.readHoldingRegisters(0x204B, 4);
    eb = Buffer.from(energyBuf.buffer);
  }
  data.energy_import_raw    = parseRegisterValue(eb.slice(0), 'uint32');   // Wh
  data.energy_export_raw    = parseRegisterValue(eb.slice(4), 'uint32');
  data.energy_import_t1_raw = eb.length >= 12 ? parseRegisterValue(eb.slice(8),  'uint32') : 0;
  data.energy_import_t2_raw = eb.length >= 16 ? parseRegisterValue(eb.slice(12), 'uint32') : 0;
  data.energy_export_t1_raw = eb.length >= 20 ? parseRegisterValue(eb.slice(16), 'uint32') : 0;
  data.energy_export_t2_raw = eb.length >= 24 ? parseRegisterValue(eb.slice(20), 'uint32') : 0;

  // Convert to human-readable units
  return {
    power_w: data.power_mw / 1000,           // mW → W
    power_l1_w: data.power_l1_mw / 1000,
    power_l2_w: data.power_l2_mw / 1000,
    power_l3_w: data.power_l3_mw / 1000,
    voltage_l1_v: data.voltage_l1_mv / 1000, // mV → V
    voltage_l2_v: data.voltage_l2_mv / 1000,
    voltage_l3_v: data.voltage_l3_mv / 1000,
    current_l1_a: data.current_l1_ma / 1000, // mA → A
    current_l2_a: data.current_l2_ma / 1000,
    current_l3_a: data.current_l3_ma / 1000,
    pf_l1: data.pf_l1_raw / 1000,
    pf_l2: data.pf_l2_raw / 1000,
    pf_l3: data.pf_l3_raw / 1000,
    tariff: data.tariff_raw,
    energy_import_kwh: data.energy_import_raw / 1000,
    energy_export_kwh: data.energy_export_raw / 1000,
    energy_import_t1_kwh: data.energy_import_t1_raw / 1000,
    energy_import_t2_kwh: data.energy_import_t2_raw / 1000,
    energy_export_t1_kwh: data.energy_export_t1_raw / 1000,
    energy_export_t2_kwh: data.energy_export_t2_raw / 1000,
    serial: data.serial,
    device_time: data.device_time,
  };
}

// ─── Database Init ──────────────────────────────────────────────────
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS meters (
        id VARCHAR(100) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        type VARCHAR(50) NOT NULL DEFAULT 'modbus',
        host VARCHAR(255) NOT NULL,
        port INTEGER NOT NULL DEFAULT 502,
        unit_id INTEGER NOT NULL DEFAULT 1,
        shelly_type VARCHAR(50),
        location VARCHAR(255),
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS tariffs (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        price_per_kwh DECIMAL(10,4) NOT NULL,
        description TEXT,
        valid_from DATE,
        valid_to DATE,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS meter_users (
        id SERIAL PRIMARY KEY,
        meter_id VARCHAR(100) NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
        user_email VARCHAR(255) NOT NULL,
        user_name VARCHAR(255),
        role VARCHAR(50) DEFAULT 'viewer',
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(meter_id, user_email)
      );

      CREATE TABLE IF NOT EXISTS meter_groups (
        id SERIAL PRIMARY KEY,
        meter_id VARCHAR(100) NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
        group_name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(meter_id, group_name)
      );

      CREATE TABLE IF NOT EXISTS readings (
        id BIGSERIAL PRIMARY KEY,
        meter_id VARCHAR(100) NOT NULL REFERENCES meters(id),
        ts TIMESTAMP NOT NULL DEFAULT NOW(),
        power_w REAL,
        power_l1_w REAL,
        power_l2_w REAL,
        power_l3_w REAL,
        voltage_l1_v REAL,
        voltage_l2_v REAL,
        voltage_l3_v REAL,
        current_l1_a REAL,
        current_l2_a REAL,
        current_l3_a REAL,
        pf_l1 REAL,
        pf_l2 REAL,
        pf_l3 REAL,
        tariff SMALLINT,
        energy_import_kwh DOUBLE PRECISION,
        energy_export_kwh DOUBLE PRECISION,
        energy_import_t1_kwh DOUBLE PRECISION,
        energy_import_t2_kwh DOUBLE PRECISION,
        energy_export_t1_kwh DOUBLE PRECISION,
        energy_export_t2_kwh DOUBLE PRECISION
      );

      CREATE INDEX IF NOT EXISTS idx_readings_meter_ts ON readings(meter_id, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings(ts DESC);

      -- Hourly aggregation view
      CREATE MATERIALIZED VIEW IF NOT EXISTS readings_hourly AS
        SELECT
          meter_id,
          date_trunc('hour', ts) AS hour,
          AVG(power_w) AS avg_power_w,
          MAX(power_w) AS max_power_w,
          MIN(power_w) AS min_power_w,
          AVG(voltage_l1_v) AS avg_voltage_l1,
          AVG(voltage_l2_v) AS avg_voltage_l2,
          AVG(voltage_l3_v) AS avg_voltage_l3,
          MAX(energy_import_kwh) - MIN(energy_import_kwh) AS consumption_kwh,
          MAX(energy_export_kwh) - MIN(energy_export_kwh) AS export_kwh,
          MAX(energy_import_t1_kwh) - MIN(energy_import_t1_kwh) AS consumption_t1_kwh,
          MAX(energy_import_t2_kwh) - MIN(energy_import_t2_kwh) AS consumption_t2_kwh,
          COUNT(*) AS sample_count
        FROM readings
        GROUP BY meter_id, date_trunc('hour', ts)
      WITH NO DATA;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_readings_hourly_pk
        ON readings_hourly(meter_id, hour);

      -- Migration: add location column if missing
      ALTER TABLE meters ADD COLUMN IF NOT EXISTS location VARCHAR(255);
      ALTER TABLE meters ADD COLUMN IF NOT EXISTS category VARCHAR(50) DEFAULT 'consumer';
      ALTER TABLE meters ADD COLUMN IF NOT EXISTS group_id VARCHAR(100);

      ALTER TABLE meters ADD COLUMN IF NOT EXISTS parent_id VARCHAR(100) REFERENCES meters(id);
      ALTER TABLE meters ADD COLUMN IF NOT EXISTS serial BIGINT;

      -- Auto-classify known meter types and groups
      UPDATE meters SET category = 'grid' WHERE category = 'consumer' AND (id LIKE '%-haupt' OR name ILIKE '%haupt%' OR name ILIKE '%netzübergabe%');
      UPDATE meters SET category = 'production' WHERE category = 'consumer' AND (id LIKE '%-produktion' OR name ILIKE '%produktion%' OR name ILIKE '%solar%' OR name ILIKE '%pv%');
      UPDATE meters SET group_id = split_part(id, '-', 1) WHERE group_id IS NULL;

      -- Known parent-child relationships
      UPDATE meters SET parent_id = 'r9-allgemein' WHERE id = 'r9-heizstab' AND parent_id IS NULL;
    `);

    // Seed meters from METERS env var only if DB has no meters yet
    const metersExist = await client.query('SELECT COUNT(*) FROM meters');
    if (parseInt(metersExist.rows[0].count) === 0 && SEED_METERS.length > 0) {
      console.log(`Seeding ${SEED_METERS.length} meters from METERS env var`);
      for (const meter of SEED_METERS) {
        await client.query(
          `INSERT INTO meters (id, name, type, host, port, unit_id)
           VALUES ($1, $2, 'modbus', $3, $4, $5)
           ON CONFLICT (id) DO NOTHING`,
          [meter.name, meter.name, meter.host, meter.port, meter.unitId]
        );
      }
    }

    // Add valid_from/valid_to columns if they don't exist (migration for existing DBs)
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE tariffs ADD COLUMN IF NOT EXISTS valid_from DATE;
        ALTER TABLE tariffs ADD COLUMN IF NOT EXISTS valid_to DATE;
      EXCEPTION WHEN others THEN NULL;
      END $$;
    `);

    // Insert default tariffs if none exist
    const tariffsExist = await client.query('SELECT COUNT(*) FROM tariffs');
    if (parseInt(tariffsExist.rows[0].count) === 0) {
      await client.query(
        `INSERT INTO tariffs (name, price_per_kwh, description, valid_from) VALUES
         ('Netztarif', 0.2516, 'Standardtarif Netzbezug', '2025-01-01'),
         ('Solartarif', 0.10, 'Eigenverbrauch Solarstrom', '2025-01-01')`
      );
    }

    console.log('Database initialized');
  } finally {
    client.release();
  }
}

// ─── Shelly HTTP Reader ─────────────────────────────────────────────
async function readShelly(meter) {
  const url = `http://${meter.host}/rpc/Switch.GetStatus?id=0`;
  const urlMeter = `http://${meter.host}/rpc/Shelly.GetStatus`;

  let data = {
    power_w: 0, power_l1_w: 0, power_l2_w: 0, power_l3_w: 0,
    voltage_l1_v: 0, voltage_l2_v: 0, voltage_l3_v: 0,
    current_l1_a: 0, current_l2_a: 0, current_l3_a: 0,
    pf_l1: 0, pf_l2: 0, pf_l3: 0, tariff: 0,
    energy_import_kwh: 0, energy_export_kwh: 0,
    energy_import_t1_kwh: 0, energy_import_t2_kwh: 0,
    energy_export_t1_kwh: 0, energy_export_t2_kwh: 0,
  };

  try {
    // Try Gen2+ API first (Shelly Plus/Pro)
    const res = await fetch(urlMeter, { signal: AbortSignal.timeout(3000) });
    const status = await res.json();

    if (status['em:0']) {
      // Shelly Pro 3EM
      const em = status['em:0'];
      data.power_w = em.total_act_power || 0;
      data.power_l1_w = em.a_act_power || 0;
      data.power_l2_w = em.b_act_power || 0;
      data.power_l3_w = em.c_act_power || 0;
      data.voltage_l1_v = em.a_voltage || 0;
      data.voltage_l2_v = em.b_voltage || 0;
      data.voltage_l3_v = em.c_voltage || 0;
      data.current_l1_a = em.a_current || 0;
      data.current_l2_a = em.b_current || 0;
      data.current_l3_a = em.c_current || 0;
      data.pf_l1 = em.a_pf || 0;
      data.pf_l2 = em.b_pf || 0;
      data.pf_l3 = em.c_pf || 0;
      // Energy from emdata
      if (status['emdata:0']) {
        const emd = status['emdata:0'];
        data.energy_import_kwh = (emd.total_act || 0) / 1000;
        data.energy_export_kwh = (emd.total_act_ret || 0) / 1000;
      }
    } else if (status['switch:0']) {
      // Shelly Plus Plug / Plus 1PM etc.
      const sw = status['switch:0'];
      data.power_w = sw.apower || 0;
      data.power_l1_w = sw.apower || 0;
      data.voltage_l1_v = sw.voltage || 0;
      data.current_l1_a = sw.current || 0;
      data.energy_import_kwh = (sw.aenergy?.total || 0) / 1000;
    }
  } catch (gen2Err) {
    // Try Gen1 API (Shelly 1PM, Shelly Plug S, etc.)
    try {
      const res = await fetch(`http://${meter.host}/status`, { signal: AbortSignal.timeout(3000) });
      const status = await res.json();
      if (status.meters && status.meters[0]) {
        data.power_w = status.meters[0].power || 0;
        data.power_l1_w = data.power_w;
        data.energy_import_kwh = (status.meters[0].total || 0) / 60000; // Watt-minutes to kWh
      }
    } catch (gen1Err) {
      throw new Error(`Shelly unreachable: ${gen2Err.message}`);
    }
  }

  return data;
}

// ─── SmartFox Pro2 HTTP/XML Reader (Heizstab/Boiler) ────────────────
const http = require('http');

// Aggregierte SmartFox-Solarwerte fuer /api/energy/solar-live. Wird bei jedem
// SmartFox-Poll aktualisiert. SEPARAT von der readings-Tabelle gehalten, damit
// das Meter-Schema unveraendert bleibt. null bis zum ersten erfolgreichen Poll.
let smartfoxSolar = null;

// Tages-Solarwerte aus den GEEICHTEN Zaehlern (zuverlaessiger als SmartFox-eDay,
// das Produktion/Einspeisung falsch meldete). Produktion = r9-produktion Export-
// Delta seit Mitternacht; Einspeisung = r9-haupt Export-Delta. Periodisch gecacht.
let solarTodayMeters = null; // { production_wh, feed_in_wh, ts }
async function updateSolarTodayMeters() {
  try {
    const q = await pool.query(`
      WITH ds AS (SELECT (date_trunc('day', now() AT TIME ZONE 'Europe/Zurich') AT TIME ZONE 'Europe/Zurich') AS d)
      SELECT m.meter_id,
        (SELECT energy_export_kwh FROM readings r WHERE r.meter_id = m.meter_id AND r.ts >= (SELECT d FROM ds) ORDER BY r.ts DESC LIMIT 1) AS now_v,
        (SELECT energy_export_kwh FROM readings r WHERE r.meter_id = m.meter_id AND r.ts >= (SELECT d FROM ds) ORDER BY r.ts ASC  LIMIT 1) AS start_v
      FROM (VALUES ('r9-produktion'), ('r9-haupt')) AS m(meter_id)`);
    const d = {};
    for (const row of q.rows) d[row.meter_id] = (row.now_v != null && row.start_v != null) ? Math.max(0, (Number(row.now_v) - Number(row.start_v)) * 1000) : null;
    if (d['r9-produktion'] != null && d['r9-haupt'] != null) {
      solarTodayMeters = { production_wh: d['r9-produktion'], feed_in_wh: d['r9-haupt'], ts: Date.now() };
    }
  } catch (e) { console.error('[solar-today-meters]', e.message); }
}
setInterval(updateSolarTodayMeters, 60000);
updateSolarTodayMeters();

function smartFoxFetch(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('SmartFox timeout')); });
  });
}

async function readSmartFox(meter) {
  const url = `http://${meter.host}/values.xml`;

  let data = {
    power_w: 0, power_l1_w: 0, power_l2_w: 0, power_l3_w: 0,
    voltage_l1_v: 0, voltage_l2_v: 0, voltage_l3_v: 0,
    current_l1_a: 0, current_l2_a: 0, current_l3_a: 0,
    pf_l1: 0, pf_l2: 0, pf_l3: 0, tariff: 0,
    energy_import_kwh: 0, energy_export_kwh: 0,
    energy_import_t1_kwh: 0, energy_import_t2_kwh: 0,
    energy_export_t1_kwh: 0, energy_export_t2_kwh: 0,
  };

  const xml = await smartFoxFetch(url);

  // Parse XML value by id - extract numeric value from text content
  const parseVal = (id) => {
    const match = xml.match(new RegExp(`<value id="${id}">([^<]*)</value>`));
    if (!match) return 0;
    const text = match[1].replace(/&[^;]+;/g, '').replace(/<[^>]*>/g, '');
    const num = parseFloat(text);
    return isNaN(num) ? 0 : num;
  };

  // Heizstab/Boiler power (kW -> W) - 3-phase heater, split equally
  data.power_w = parseVal('analogOutPower') * 1000;
  data.power_l1_w = data.power_w / 3;
  data.power_l2_w = data.power_w / 3;
  data.power_l3_w = data.power_w / 3;

  // Heizstab percentage stored in pf_l1 (0-1 range)
  data.pf_l1 = parseVal('hidAoutPercentage') / 100;

  // Grid voltage and current per phase from SmartFox
  data.voltage_l1_v = parseVal('voltageL1Value');
  data.voltage_l2_v = parseVal('voltageL2Value');
  data.voltage_l3_v = parseVal('voltageL3Value');
  data.current_l1_a = parseVal('ampereL1Value');
  data.current_l2_a = parseVal('ampereL2Value');
  data.current_l3_a = parseVal('ampereL3Value');

  // Daily energy counter (Wh -> kWh) - resets at midnight
  data.energy_import_kwh = parseVal('hidAoutEnergyDay') / 1000;

  // ── Solar-Live-Aggregat (fuer /api/energy/solar-live) ──
  // PV-Produktion = Summe der Wechselrichter wr1..wr5 (kW->W). Netz =
  // detailsPowerValue (W; <0 = Einspeisung/Lieferung, >0 = Bezug). Boiler aus
  // analogOut*. Tageswerte aus eDay*. Diese Felder gibt es nur am SmartFox.
  const parseText = (id) => {
    const m = xml.match(new RegExp(`<value id="${id}">([^<]*)</value>`));
    return m ? m[1].replace(/&[^;]+;/g, '').replace(/<[^>]*>/g, '').trim() : '';
  };
  let prodKw = 0;
  for (let i = 1; i <= 5; i++) prodKw += parseVal(`wr${i}PowerValue`);
  smartfoxSolar = {
    ts: Date.now(),
    production_w: prodKw * 1000,
    grid_w: parseVal('detailsPowerValue'),       // <0 = Einspeisung, >0 = Bezug
    boiler_w: parseVal('analogOutPower') * 1000,
    boiler_pct: parseVal('analogOutPercent'),
    boiler_desc: parseText('analogOutDescription') || 'Boiler',
    today_prod_wh: parseVal('eDayValue'),
    today_feedin_wh: parseVal('eDayToGridValue'),
  };

  return data;
}

// ─── Polling Loop ───────────────────────────────────────────────────
const modbusClients = new Map();

// ── Soft-Sniffer: strukturierte TCP-Events pro Zaehler (Kollisions-Timing) ──
// Greppbar via `docker logs <energy-collector> | grep MTR-EVT`. Schluessel-Signal:
// PORT_ERROR code=ECONNRESET auf haupt/allgemein = der ESP32-Single-Slot wurde
// von einem ZWEITEN Modbus-Client gekapert (Reset by peer). connect_timeout
// hingegen = Geraet/:502 haengt (Firmware). So unterscheiden wir Kollision vs Haenger.
function mtrEvt(meter, event, detail = '') {
  console.log(`[MTR-EVT] ${new Date().toISOString()} ${meter.name} ${event}${detail ? ' ' + detail : ''}`);
}

async function getModbusClient(meter) {
  let client = modbusClients.get(meter.id);
  if (client && client.isOpen) return client;

  mtrEvt(meter, 'CONNECT_TRY', `${meter.host}:${meter.port}`);
  client = new ModbusRTU();
  // Connect-Timeout begrenzen: tote Zaehler (Modbus-Port dicht) wuerden sonst
  // im OS-Default (~30-75s) haengen und die Poll-Schleife ausbremsen.
  await Promise.race([
    client.connectTCP(meter.host, { port: meter.port }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('connect timeout')), 4000)),
  ]);
  client.setTimeout(3000);
  // Handle connection errors to prevent unhandled rejections crashing the process
  client._port.on('error', (err) => {
    mtrEvt(meter, 'PORT_ERROR', `code=${err.code || '-'} ${err.message}`);
    console.error(`Modbus connection error [${meter.name}]:`, err.message);
    modbusClients.delete(meter.id);
  });
  modbusClients.set(meter.id, client);
  mtrEvt(meter, 'CONNECT_OK');
  console.log(`Modbus connected: ${meter.name} (${meter.host}:${meter.port})`);
  return client;
}

// Store latest reading per meter for live API
const latestReadings = new Map();

async function pollMeter(meter) {
  try {
    let data;
    if (meter.type === 'shelly') {
      data = await readShelly(meter);
    } else if (meter.type === 'smartfox') {
      data = await readSmartFox(meter);
    } else {
      const client = await getModbusClient(meter);
      data = await readMeter(client, meter);
    }
    const ts = new Date();

    latestReadings.set(meter.id, { ...data, ts, meter_id: meter.id });

    // Geräte-Seriennummer (smart-me, via Modbus 0x1FFF) persistieren — nur schreiben, wenn neu/geändert.
    if (data.serial != null) {
      pool.query('UPDATE meters SET serial = $2 WHERE id = $1 AND serial IS DISTINCT FROM $2', [meter.id, data.serial])
        .catch((e) => console.error('[serial-persist]', meter.id, e.message));
    }

    await pool.query(
      `INSERT INTO readings (
        meter_id, ts, power_w, power_l1_w, power_l2_w, power_l3_w,
        voltage_l1_v, voltage_l2_v, voltage_l3_v,
        current_l1_a, current_l2_a, current_l3_a,
        pf_l1, pf_l2, pf_l3, tariff,
        energy_import_kwh, energy_export_kwh,
        energy_import_t1_kwh, energy_import_t2_kwh,
        energy_export_t1_kwh, energy_export_t2_kwh
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [
        meter.id, ts,
        data.power_w, data.power_l1_w, data.power_l2_w, data.power_l3_w,
        data.voltage_l1_v, data.voltage_l2_v, data.voltage_l3_v,
        data.current_l1_a, data.current_l2_a, data.current_l3_a,
        data.pf_l1, data.pf_l2, data.pf_l3, data.tariff,
        data.energy_import_kwh, data.energy_export_kwh,
        data.energy_import_t1_kwh, data.energy_import_t2_kwh,
        data.energy_export_t1_kwh, data.energy_export_t2_kwh,
      ]
    );

    mqttPublishReading(meter, data, ts);
  } catch (err) {
    mtrEvt(meter, 'POLL_FAIL', `code=${err.code || '-'} msg=${err.message}`);
    console.error(`Poll error [${meter.name}]:`, err.message);
    if (meter.type === 'modbus') {
      const client = modbusClients.get(meter.id);
      if (client) {
        try { client.close(); } catch (_) {}
        modbusClients.delete(meter.id);
      }
    }
  }
}

// Load active meters from DB for polling
async function getActiveMeters() {
  const result = await pool.query('SELECT * FROM meters WHERE active = true');
  return result.rows;
}

let isPolling = false;
async function pollAll() {
  if (isPolling) { console.log('[Poll] Still running, skipping'); return; }
  isPolling = true;
  try {
    const meters = await getActiveMeters();
    // Parallel statt sequentiell: ein toter Zaehler (Connect-Timeout) darf die
    // lebenden nicht ausbremsen. pollMeter faengt eigene Fehler ab.
    await Promise.allSettled(meters.map(m => pollMeter(m)));
  } catch (err) {
    console.error('[Poll] pollAll error:', err.message);
  } finally {
    isPolling = false;
  }
}

// Refresh materialized view every 5 minutes
async function refreshHourlyView() {
  try {
    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY readings_hourly');
  } catch (err) {
    // First refresh must be non-concurrent
    try {
      await pool.query('REFRESH MATERIALIZED VIEW readings_hourly');
    } catch (e) {
      console.error('Hourly view refresh error:', e.message);
    }
  }
}

// Cleanup old raw data (keep 7 days, hourly aggregates stay)
async function cleanupOldData() {
  try {
    const result = await pool.query(
      "DELETE FROM readings WHERE ts < NOW() - INTERVAL '7 days'"
    );
    if (result.rowCount > 0) {
      console.log(`Cleaned up ${result.rowCount} old readings`);
    }
  } catch (err) {
    console.error('Cleanup error:', err.message);
  }
}

// ─── REST API ───────────────────────────────────────────────────────
const app = express();
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'https://www.rosenweg4303.ch';
app.use(cors({ origin: CORS_ORIGIN.split(',') }));

// Admin auth middleware for write operations (Bearer token from main API)
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
function adminAuth(req, res, next) {
  if (!ADMIN_API_KEY) return next(); // skip if not configured (backwards compat)
  const auth = req.headers.authorization;
  if (auth === `Bearer ${ADMIN_API_KEY}`) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// Health check
app.get('/health', async (req, res) => {
  try {
    const meters = await getActiveMeters();
    res.json({ status: 'ok', meters: meters.length, uptime: process.uptime() });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message });
  }
});

// List meters (includes parent_id and children info)
app.get('/api/energy/meters', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM meters ORDER BY name');
    const meters = result.rows.map(m => ({
      ...m,
      children: childrenMap[m.id] || [],
    }));
    res.json(meters);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get meters by location (e.g. ?location=waschkueche-1)
app.get('/api/energy/meters/by-location', async (req, res) => {
  const { location } = req.query;
  if (!location) return res.status(400).json({ error: 'location query parameter required' });
  try {
    const result = await pool.query(
      'SELECT * FROM meters WHERE location = $1 AND active = true ORDER BY name',
      [location]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Consumption for a meter between two timestamps
app.get('/api/energy/consumption/:meterId', async (req, res) => {
  const { meterId } = req.params;
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to query parameters required' });
  try {
    const result = await pool.query(
      `SELECT
         MIN(energy_import_kwh) AS start_kwh,
         MAX(energy_import_kwh) AS end_kwh,
         MAX(energy_import_kwh) - MIN(energy_import_kwh) AS consumption_kwh,
         AVG(power_w) AS avg_power_w,
         MAX(power_w) AS max_power_w,
         COUNT(*) AS samples
       FROM readings
       WHERE meter_id = $1 AND ts >= $2 AND ts <= $3`,
      [meterId, from, to]
    );
    res.json(result.rows[0] || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Build parent→children map from cached meter list
let childrenMap = {}; // { parentId: [childId, ...] }
async function refreshChildrenMap() {
  try {
    const result = await pool.query('SELECT id, parent_id FROM meters WHERE parent_id IS NOT NULL AND active = true');
    const map = {};
    for (const row of result.rows) {
      if (!map[row.parent_id]) map[row.parent_id] = [];
      map[row.parent_id].push(row.id);
    }
    childrenMap = map;
  } catch (e) { console.error('refreshChildrenMap error:', e.message); }
}

// Subtract child meter values from parent for live display
function getNetLiveData(meterId) {
  const raw = latestReadings.get(meterId);
  if (!raw) return null;
  const children = childrenMap[meterId];
  if (!children || children.length === 0) return raw;

  const net = { ...raw };
  for (const childId of children) {
    const child = latestReadings.get(childId);
    if (!child) continue;
    for (const key of ['power_w', 'power_l1_w', 'power_l2_w', 'power_l3_w',
                        'current_l1_a', 'current_l2_a', 'current_l3_a']) {
      if (typeof net[key] === 'number' && typeof child[key] === 'number') {
        net[key] -= child[key];
      }
    }
  }
  return net;
}

// Live data (latest reading per meter, with child subtraction)
app.get('/api/energy/live', (req, res) => {
  const live = {};
  for (const [id] of latestReadings) {
    live[id] = getNetLiveData(id);
  }
  res.json(live);
});

// Live data for specific meter
app.get('/api/energy/live/:meterId', (req, res) => {
  const data = getNetLiveData(req.params.meterId);
  if (!data) return res.status(404).json({ error: 'Meter not found' });
  res.json(data);
});

// Aggregierte Solar-Live-Ansicht Rosenweg 9 (Fluss-Diagramm-Daten).
// GEEICHT-FIRST mit SmartFox-Fallback: Produktion bevorzugt vom geeichten
// Zaehler r9-produktion; Netz bevorzugt vom geeichten Hauptzaehler r9-haupt
// (gleiche Vorzeichen-Konvention wie SmartFox: -370W r9-haupt ~ -368W SmartFox
// am 2026-06-16 verifiziert), Fallback SmartFox wenn r9-haupt stale.
// Konvention grid_w: >0 = Bezug, <0 = Einspeisung/Lieferung.
app.get('/api/energy/solar-live', (req, res) => {
  const FRESH_MS = 120000;
  const now = Date.now();
  const freshTs = (ts) => ts && (now - new Date(ts).getTime() < FRESH_MS);

  // Produktion: geeicht (power_w < 0 = Produktion) -> sonst SmartFox-WR-Summe
  const prod = latestReadings.get('r9-produktion');
  let production_w, production_source;
  if (prod && freshTs(prod.ts)) {
    production_w = Math.max(0, -(prod.power_w || 0));
    production_source = 'geeicht';
  } else if (smartfoxSolar && freshTs(smartfoxSolar.ts)) {
    production_w = Math.max(0, smartfoxSolar.production_w || 0);
    production_source = 'smartfox';
  } else { production_w = 0; production_source = 'none'; }

  // Netz: geeichter Hauptzaehler r9-haupt bevorzugt (>0 Bezug, <0 Lieferung;
  // direkt, kein Negieren) -> sonst SmartFox-Fallback -> sonst none.
  const haupt = latestReadings.get('r9-haupt');
  let grid_w, grid_source;
  if (haupt && freshTs(haupt.ts)) {
    grid_w = haupt.power_w || 0; grid_source = 'geeicht';
  } else if (smartfoxSolar && freshTs(smartfoxSolar.ts)) {
    grid_w = smartfoxSolar.grid_w || 0; grid_source = 'smartfox';
  } else { grid_w = 0; grid_source = 'none'; }

  const consumption_w = Math.max(0, production_w + grid_w);
  const self_pct = production_w > 0 ? Math.round(consumption_w / production_w * 100) : 0;
  const sf = smartfoxSolar || {};

  // Verbrauchs-Aufschluesselung (geeichte Modbus-Zaehler; Verbrauchsmesser
  // melden positiv). allgemein = Gemeinschaftsstrom; wohnungen = Summe aller
  // Wohnungszaehler. Tote Zaehler (offline) zaehlen 0 + online=false.
  const allg = latestReadings.get('r9-allgemein');
  // Der Boiler (SmartFox) haengt physisch am Allgemeinstrom-Kreis (r9-allgemein).
  // Er wird separat ausgewiesen -> hier vom Allgemein abziehen, sonst doppelt
  // gezaehlt (einmal im allgemein, einmal als boiler).
  const sfFresh = !!(smartfoxSolar && freshTs(smartfoxSolar.ts));
  const boilerW = sfFresh ? Math.max(0, sf.boiler_w || 0) : 0;
  const allgRawW = (allg && freshTs(allg.ts)) ? Math.max(0, allg.power_w || 0) : 0;
  const allgemein = {
    power_w: Math.max(0, allgRawW - boilerW),
    power_raw_w: allgRawW,            // ungekuerzt (inkl. Boiler) — fuer Debug/Anzeige
    online: !!(allg && freshTs(allg.ts)),
  };
  const APARTMENT_METERS = ['r9-eg1','r9-eg2','r9-eg3','r9-1og1','r9-1og2','r9-1og3','r9-2og1','r9-2og2','r9-2og3','r9-keller-neziri'];
  let aptW = 0, aptOn = 0;
  for (const id of APARTMENT_METERS) {
    const r = latestReadings.get(id);
    if (r && freshTs(r.ts)) { aptW += Math.max(0, r.power_w || 0); aptOn++; }
  }
  // PV-Ueberschuss-Anteil pro Wohnung (energy/r9/ueberschuss/<apt>/total_w, via MQTT
  // abonniert): als eigener "Verbraucher" ausgewiesen UND von den Wohnungen abgezogen
  // (steckt in den Wohnungszaehlern mit drin -> sonst doppelt gezaehlt).
  let ueberW = 0, ueberOn = 0;
  for (const [, r] of ueberschussReadings) { if (freshTs(r.ts)) { ueberW += Math.max(0, r.w); ueberOn++; } }
  const ueberschuss = { power_w: ueberW, online: ueberOn > 0, count: ueberOn, total_count: APARTMENT_METERS.length };
  const wohnungen = { power_w: Math.max(0, aptW - ueberW), power_raw_w: aptW, online_count: aptOn, total_count: APARTMENT_METERS.length };

  res.json({
    ts: new Date().toISOString(),
    production_w, production_source,
    grid_w, grid_source,
    feed_in_w: grid_w < 0 ? -grid_w : 0,   // Lieferung
    draw_w: grid_w > 0 ? grid_w : 0,       // Bezug
    consumption_w, self_pct,
    boiler: { power_w: sf.boiler_w || 0, percent: sf.boiler_pct || 0, label: sf.boiler_desc || 'Boiler', online: !!(smartfoxSolar && freshTs(smartfoxSolar.ts)) },
    allgemein,
    wohnungen,
    ueberschuss,
    today: (solarTodayMeters && (now - solarTodayMeters.ts < 600000))
      ? { production_wh: solarTodayMeters.production_wh, feed_in_wh: solarTodayMeters.feed_in_wh, source: 'geeicht' }
      : { production_wh: sf.today_prod_wh || 0, feed_in_wh: sf.today_feedin_wh || 0, source: 'smartfox' },
    smartfox_online: !!(smartfoxSolar && freshTs(smartfoxSolar.ts)),
  });
});

// Helper: subtract child meter values from parent rows (in-memory, after query)
async function subtractChildren(meterId, parentRows, fromDate, toDate, bucketSec) {
  const children = childrenMap[meterId];
  if (!children || children.length === 0) return parentRows;

  // For each child, fetch the same time range with the same bucketing
  for (const childId of children) {
    let childRows;
    if (bucketSec) {
      // Safe to interpolate: bucketSec is validated as positive integer by caller
      const safeBucket = parseInt(bucketSec, 10) || 30;
      const result = await pool.query(
        `SELECT to_timestamp(floor(extract(epoch from ts) / ${safeBucket}) * ${safeBucket}) AS ts,
                AVG(power_w) as power_w, AVG(power_l1_w) as power_l1_w, AVG(power_l2_w) as power_l2_w, AVG(power_l3_w) as power_l3_w,
                AVG(current_l1_a) as current_l1_a, AVG(current_l2_a) as current_l2_a, AVG(current_l3_a) as current_l3_a
         FROM readings WHERE meter_id = $1 AND ts >= $2 AND ts <= $3
         GROUP BY 1 ORDER BY 1`,
        [childId, fromDate, toDate]
      );
      childRows = result.rows;
    } else {
      const result = await pool.query(
        `SELECT ts, power_w, power_l1_w, power_l2_w, power_l3_w,
                current_l1_a, current_l2_a, current_l3_a
         FROM readings WHERE meter_id = $1 AND ts >= $2 AND ts <= $3
         ORDER BY ts`,
        [childId, fromDate, toDate]
      );
      childRows = result.rows;
    }

    // Build time-indexed map of child data
    const childMap = new Map();
    for (const r of childRows) {
      childMap.set(new Date(r.ts).getTime(), r);
    }

    // Subtract child values from parent at matching timestamps
    const tolerance = bucketSec ? bucketSec * 1000 : 10000;
    for (const row of parentRows) {
      const t = new Date(row.ts).getTime();
      let child = childMap.get(t);
      // Try nearby timestamps if exact match fails
      if (!child) {
        for (const [ct, cr] of childMap) {
          if (Math.abs(ct - t) < tolerance) { child = cr; break; }
        }
      }
      if (!child) continue;
      for (const key of ['power_w', 'power_l1_w', 'power_l2_w', 'power_l3_w',
                          'current_l1_a', 'current_l2_a', 'current_l3_a']) {
        if (typeof row[key] === 'number' && typeof child[key] === 'number') {
          row[key] = Math.max(0, row[key] - child[key]);
        }
      }
    }
  }
  return parentRows;
}

// Historical data (raw readings)
app.get('/api/energy/history/:meterId', async (req, res) => {
  const { meterId } = req.params;
  const { from, to, limit } = req.query;
  const fromDate = from || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const toDate = to || new Date().toISOString();
  const maxRows = Math.min(parseInt(limit) || 2000, 10000);

  // Calculate time span to decide on downsampling
  const spanMs = new Date(toDate) - new Date(fromDate);
  const spanHours = spanMs / 3600000;
  // At 5s intervals, 1 hour = 720 rows. For a full day (24h) we'd get 17280 rows.
  // Downsample by averaging into time buckets for spans > 2h.
  let query;
  let params;
  let bucketSec = null;
  if (spanHours > 2) {
    // Target ~1000 data points. Bucket size in seconds (min 30s).
    // Safe to interpolate: bucketSec is always a positive integer from Math.max/Math.ceil
    bucketSec = parseInt(Math.max(30, Math.ceil(spanMs / 1000 / maxRows)), 10);
    if (!Number.isFinite(bucketSec) || bucketSec < 1) bucketSec = 30;
    query = `SELECT
        to_timestamp(floor(extract(epoch from ts) / ${bucketSec}) * ${bucketSec}) AS ts,
        AVG(power_w) as power_w, AVG(power_l1_w) as power_l1_w, AVG(power_l2_w) as power_l2_w, AVG(power_l3_w) as power_l3_w,
        AVG(voltage_l1_v) as voltage_l1_v, AVG(voltage_l2_v) as voltage_l2_v, AVG(voltage_l3_v) as voltage_l3_v,
        AVG(current_l1_a) as current_l1_a, AVG(current_l2_a) as current_l2_a, AVG(current_l3_a) as current_l3_a,
        AVG(pf_l1) as pf_l1, AVG(pf_l2) as pf_l2, AVG(pf_l3) as pf_l3,
        MAX(tariff) as tariff,
        MAX(energy_import_kwh) as energy_import_kwh, MAX(energy_export_kwh) as energy_export_kwh,
        MAX(energy_import_t1_kwh) as energy_import_t1_kwh, MAX(energy_import_t2_kwh) as energy_import_t2_kwh
     FROM readings
     WHERE meter_id = $1 AND ts >= $2 AND ts <= $3
     GROUP BY 1
     ORDER BY 1`;
    params = [meterId, fromDate, toDate];
  } else {
    query = `SELECT ts, power_w, power_l1_w, power_l2_w, power_l3_w,
            voltage_l1_v, voltage_l2_v, voltage_l3_v,
            current_l1_a, current_l2_a, current_l3_a,
            pf_l1, pf_l2, pf_l3, tariff,
            energy_import_kwh, energy_export_kwh,
            energy_import_t1_kwh, energy_import_t2_kwh
     FROM readings
     WHERE meter_id = $1 AND ts >= $2 AND ts <= $3
     ORDER BY ts
     LIMIT $4`;
    params = [meterId, fromDate, toDate, maxRows];
  }

  try {
    const result = await pool.query(query, params);
    const rows = await subtractChildren(meterId, result.rows, fromDate, toDate, bucketSec);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Hourly aggregated data
app.get('/api/energy/hourly/:meterId', async (req, res) => {
  const { meterId } = req.params;
  const { from, to } = req.query;
  const fromDate = from || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const toDate = to || new Date().toISOString();

  try {
  const result = await pool.query(
    `SELECT * FROM readings_hourly
     WHERE meter_id = $1 AND hour >= $2 AND hour <= $3
     ORDER BY hour`,
    [meterId, fromDate, toDate]
  );
  res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper: subtract child consumption from daily/today aggregates
async function subtractChildrenAgg(meterId, rows, query, startDate, endDate, keyField) {
  const children = childrenMap[meterId];
  if (!children || children.length === 0) return rows;

  for (const childId of children) {
    const childResult = await pool.query(query, [childId, startDate, endDate]);
    const childMap = new Map();
    for (const cr of childResult.rows) {
      childMap.set(keyField ? new Date(cr[keyField]).getTime() : 'single', cr);
    }
    for (const row of rows) {
      const key = keyField ? new Date(row[keyField]).getTime() : 'single';
      const child = childMap.get(key);
      if (!child) continue;
      for (const k of ['consumption_kwh', 'export_kwh', 'consumption_t1_kwh', 'consumption_t2_kwh', 'avg_power_w']) {
        if (typeof row[k] === 'number' && typeof child[k] === 'number') {
          row[k] = Math.max(0, row[k] - child[k]);
        }
      }
    }
  }
  return rows;
}

// Daily summary (supports ?days=N and optional ?to=YYYY-MM-DD)
app.get('/api/energy/daily/:meterId', async (req, res) => {
  const { meterId } = req.params;
  const { days, to } = req.query;
  const numDays = parseInt(days) || 30;
  const endDate = to ? new Date(to + 'T23:59:59') : new Date();
  const startDate = new Date(endDate.getTime() - numDays * 86400000);

  const dailyQuery = `SELECT
       date_trunc('day', ts) AS day,
       AVG(power_w) AS avg_power_w,
       MAX(power_w) AS max_power_w,
       MAX(energy_import_kwh) - MIN(energy_import_kwh) AS consumption_kwh,
       MAX(energy_export_kwh) - MIN(energy_export_kwh) AS export_kwh,
       MAX(energy_import_t1_kwh) - MIN(energy_import_t1_kwh) AS consumption_t1_kwh,
       MAX(energy_import_t2_kwh) - MIN(energy_import_t2_kwh) AS consumption_t2_kwh,
       COUNT(*) AS samples
     FROM readings
     WHERE meter_id = $1 AND ts >= $2 AND ts <= $3
     GROUP BY date_trunc('day', ts)
     ORDER BY day`;

  try {
    const result = await pool.query(dailyQuery, [meterId, startDate.toISOString(), endDate.toISOString()]);
    const rows = await subtractChildrenAgg(meterId, result.rows, dailyQuery, startDate.toISOString(), endDate.toISOString(), 'day');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Day summary (today or specific date via ?date=YYYY-MM-DD)
app.get('/api/energy/today/:meterId', async (req, res) => {
  const { meterId } = req.params;
  const { date } = req.query;
  const dayStart = date ? new Date(date + 'T00:00:00') : new Date();
  if (!date) dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const todayQuery = `SELECT
       MIN(energy_import_kwh) AS start_kwh,
       MAX(energy_import_kwh) AS end_kwh,
       MAX(energy_import_kwh) - MIN(energy_import_kwh) AS consumption_kwh,
       MAX(energy_export_kwh) - MIN(energy_export_kwh) AS export_kwh,
       MAX(energy_import_t1_kwh) - MIN(energy_import_t1_kwh) AS consumption_t1_kwh,
       MAX(energy_import_t2_kwh) - MIN(energy_import_t2_kwh) AS consumption_t2_kwh,
       AVG(power_w) AS avg_power_w,
       MAX(power_w) AS max_power_w,
       MIN(power_w) AS min_power_w,
       COUNT(*) AS samples
     FROM readings
     WHERE meter_id = $1 AND ts >= $2 AND ts < $3`;

  const result = await pool.query(todayQuery, [meterId, dayStart.toISOString(), dayEnd.toISOString()]);
  const rows = result.rows[0] ? [result.rows[0]] : [];
  await subtractChildrenAgg(meterId, rows, todayQuery, dayStart.toISOString(), dayEnd.toISOString(), null);
  res.json(rows[0] || {});
});

// ═══════════════════════════════════════════════════════════════════
// CONFIG API (Meters, Users, Tariffs)
// ═══════════════════════════════════════════════════════════════════
app.use(express.json());

// --- Meter Management ---
app.post('/api/energy/meters', adminAuth, async (req, res) => {
  const { id, name, type, host, port, unit_id, shelly_type, location, category, group_id, parent_id } = req.body;
  if (!id || !name || !host) return res.status(400).json({ error: 'id, name, host required' });
  try {
    const result = await pool.query(
      `INSERT INTO meters (id, name, type, host, port, unit_id, shelly_type, location, category, group_id, parent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET name=$2, type=$3, host=$4, port=$5, unit_id=$6, shelly_type=$7, location=$8, category=$9, group_id=$10, parent_id=$11
       RETURNING *`,
      [id, name, type || 'modbus', host, port || 502, unit_id || 1, shelly_type || null, location || null, category || 'consumer', group_id || null, parent_id || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/energy/meters/:id', adminAuth, async (req, res) => {
  const { name, type, host, port, unit_id, shelly_type, location, active, category, group_id } = req.body;
  try {
    const result = await pool.query(
      `UPDATE meters SET name=COALESCE($2,name), type=COALESCE($3,type), host=COALESCE($4,host),
       port=COALESCE($5,port), unit_id=COALESCE($6,unit_id), shelly_type=$7, location=$8,
       active=COALESCE($9,active), category=COALESCE($10,category), group_id=COALESCE($11,group_id)
       WHERE id=$1 RETURNING *`,
      [req.params.id, name, type, host, port, unit_id, shelly_type || null, location !== undefined ? location : null, active, category, group_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/energy/meters/:id', adminAuth, async (req, res) => {
  try {
    // Delete readings first
    await pool.query('DELETE FROM readings WHERE meter_id = $1', [req.params.id]);
    await pool.query('DELETE FROM meters WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test meter connection
app.post('/api/energy/meters/:id/test', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM meters WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const meter = result.rows[0];

    if (meter.type === 'shelly') {
      const data = await readShelly(meter);
      res.json({ success: true, data });
    } else if (meter.type === 'smartfox') {
      const data = await readSmartFox(meter);
      res.json({ success: true, data });
    } else {
      const client = new ModbusRTU();
      await client.connectTCP(meter.host, { port: meter.port });
      client.setTimeout(3000);
      const data = await readMeter(client, meter);
      client.close();
      res.json({ success: true, data });
    }
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// --- Tariff Management ---
app.get('/api/energy/tariffs', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tariffs ORDER BY name, valid_from DESC NULLS LAST');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get active tariffs for a date (default: today). Use ?date=YYYY-MM-DD for historical.
app.get('/api/energy/tariffs/current', async (req, res) => {
  const { date } = req.query;
  const refDate = date || new Date().toISOString().slice(0, 10);
  const result = await pool.query(
    `SELECT * FROM tariffs
     WHERE active = true
       AND (valid_from IS NULL OR valid_from <= $1)
       AND (valid_to IS NULL OR valid_to >= $1)
     ORDER BY name`,
    [refDate]
  );
  res.json(result.rows);
});

app.post('/api/energy/tariffs', adminAuth, async (req, res) => {
  const { name, price_per_kwh, description, valid_from, valid_to } = req.body;
  if (!name || price_per_kwh == null) return res.status(400).json({ error: 'name, price_per_kwh required' });
  try {
    const result = await pool.query(
      'INSERT INTO tariffs (name, price_per_kwh, description, valid_from, valid_to) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, price_per_kwh, description || '', valid_from || null, valid_to || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/energy/tariffs/:id', adminAuth, async (req, res) => {
  const { name, price_per_kwh, description, valid_from, valid_to, active } = req.body;
  try {
    const result = await pool.query(
      `UPDATE tariffs SET name=COALESCE($2,name), price_per_kwh=COALESCE($3,price_per_kwh),
       description=COALESCE($4,description), valid_from=$5, valid_to=$6, active=COALESCE($7,active)
       WHERE id=$1 RETURNING *`,
      [req.params.id, name, price_per_kwh, description, valid_from || null, valid_to || null, active]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/energy/tariffs/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM tariffs WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- User-Meter Assignment ---
app.get('/api/energy/meters/:meterId/users', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM meter_users WHERE meter_id = $1 ORDER BY user_name',
      [req.params.meterId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/energy/meters/:meterId/users', adminAuth, async (req, res) => {
  const { user_email, user_name, role } = req.body;
  if (!user_email) return res.status(400).json({ error: 'user_email required' });
  try {
    const result = await pool.query(
      `INSERT INTO meter_users (meter_id, user_email, user_name, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (meter_id, user_email) DO UPDATE SET user_name=$3, role=$4
       RETURNING *`,
      [req.params.meterId, user_email.toLowerCase(), user_name || '', role || 'viewer']
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/energy/meters/:meterId/users/:email', adminAuth, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM meter_users WHERE meter_id = $1 AND user_email = $2',
      [req.params.meterId, req.params.email.toLowerCase()]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Group Assignments ───────────────────────────────────────────────
app.get('/api/energy/meters/:meterId/groups', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM meter_groups WHERE meter_id = $1 ORDER BY group_name',
      [req.params.meterId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/energy/meters/:meterId/groups', adminAuth, async (req, res) => {
  const { group_name } = req.body;
  if (!group_name) return res.status(400).json({ error: 'group_name required' });
  try {
    const result = await pool.query(
      `INSERT INTO meter_groups (meter_id, group_name)
       VALUES ($1, $2)
       ON CONFLICT (meter_id, group_name) DO NOTHING
       RETURNING *`,
      [req.params.meterId, group_name]
    );
    res.json(result.rows[0] || { meter_id: req.params.meterId, group_name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/energy/meters/:meterId/groups/:groupName', adminAuth, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM meter_groups WHERE meter_id = $1 AND group_name = $2',
      [req.params.meterId, req.params.groupName]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get meters for a specific user (by email OR group membership)
app.get('/api/energy/user/:email/meters', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT m.*, COALESCE(mu.role, 'viewer') as role FROM meters m
       LEFT JOIN meter_users mu ON m.id = mu.meter_id AND mu.user_email = $1
       LEFT JOIN meter_groups mg ON m.id = mg.meter_id
       WHERE m.active = true AND (mu.user_email IS NOT NULL OR mg.group_name = ANY($2::text[]))
       ORDER BY m.name`,
      [req.params.email.toLowerCase(), req.query.groups ? req.query.groups.split(',') : []]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Dashboard overview ─────────────────────────────────────────────
app.get('/api/energy/dashboard', async (req, res) => {
  try {
    // Get all active meters with their categories and groups
    const meters = await pool.query('SELECT * FROM meters WHERE active = true ORDER BY group_id, name');

    // Get today's consumption per meter
    const today = new Date().toISOString().slice(0, 10);
    const todayData = await pool.query(
      `SELECT meter_id,
        MAX(energy_import_kwh) - MIN(energy_import_kwh) AS consumption_kwh,
        MAX(energy_export_kwh) - MIN(energy_export_kwh) AS export_kwh
       FROM readings WHERE ts >= $1::date AND ts < ($1::date + interval '1 day')
       GROUP BY meter_id`,
      [today]
    );
    const todayMap = {};
    todayData.rows.forEach(r => { todayMap[r.meter_id] = r; });

    // Get latest reading per meter for live power
    const latest = await pool.query(
      `SELECT DISTINCT ON (meter_id) meter_id, power_w, ts
       FROM readings ORDER BY meter_id, ts DESC`
    );
    const liveMap = {};
    latest.rows.forEach(r => { liveMap[r.meter_id] = r; });

    // Build groups
    const groups = {};
    meters.rows.forEach(m => {
      const gid = m.group_id || 'default';
      if (!groups[gid]) groups[gid] = { id: gid, meters: [], grid: null, production: null };
      groups[gid].meters.push({
        ...m,
        live_power_w: liveMap[m.id]?.power_w || 0,
        live_ts: liveMap[m.id]?.ts || null,
        today_consumption_kwh: parseFloat(todayMap[m.id]?.consumption_kwh || 0),
        today_export_kwh: parseFloat(todayMap[m.id]?.export_kwh || 0),
      });
      if (m.category === 'grid') groups[gid].grid = m.id;
      if (m.category === 'production') groups[gid].production = m.id;
    });

    // Calculate solar share per group
    Object.values(groups).forEach(g => {
      const gridData = todayMap[g.grid];
      const prodData = todayMap[g.production];
      if (gridData && prodData) {
        const prodKwh = parseFloat(prodData.export_kwh || 0);
        const netExport = parseFloat(gridData.export_kwh || 0);
        const netImport = parseFloat(gridData.consumption_kwh || 0);
        const eigen = Math.max(0, prodKwh - netExport);
        const total = eigen + netImport;
        g.solar_share = total > 0 ? (eigen / total) * 100 : 0;
        g.solar_production_kwh = prodKwh;
        g.self_consumption_kwh = eigen;
        g.grid_import_kwh = netImport;
        g.grid_export_kwh = netExport;
      } else {
        g.solar_share = 0;
        g.solar_production_kwh = 0;
        g.self_consumption_kwh = 0;
        g.grid_import_kwh = 0;
        g.grid_export_kwh = 0;
      }
      // Total consumer consumption
      g.total_consumption_kwh = g.meters
        .filter(m => m.category === 'consumer')
        .reduce((s, m) => s + m.today_consumption_kwh, 0);
    });

    res.json(Object.values(groups));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Surplus endpoints (open, no auth — for Shelly/IoT devices) ─────

// Helper: collect all live values for a group
async function getGroupLiveData(group) {
  const meters = await pool.query(
    "SELECT id, name, category FROM meters WHERE group_id = $1 AND active = true", [group]);

  let grid_w = null, production_w = null, heizstab_w = null, grid_ts = null;
  const consumers = [];

  for (const m of meters.rows) {
    const live = latestReadings.get(m.id);
    const power = live ? Math.round(live.power_w || 0) : 0;
    const fresh = !!(live && freshTs(live.ts));
    // Grid/Produktion NUR mit frischen geeichten Werten uebernehmen; sonst greift unten
    // der SmartFox-Fallback. Sonst regelt die Ueberschuss-Steuerung auf einen VERALTETEN
    // r9-haupt-Wert (z.B. bei totem Hauptzaehler -> falscher/0-Ueberschuss trotz PV).
    if (m.category === 'grid') { if (fresh) { grid_w = power; grid_ts = live.ts; } }
    else if (m.category === 'production') { if (fresh) production_w = Math.abs(power); }
    else if (m.id.includes('heizstab')) { heizstab_w = power; }
    else if (m.category === 'consumer') { consumers.push({ id: m.id, name: m.name, power_w: power }); }
  }

  // Fallback SmartFox, wenn kein FRISCHER geeichter Grid-/Produktionswert vorliegt
  // (z.B. r9-haupt/produktion tot). Gleiche Vorzeichen-Konvention wie geeicht
  // (grid_w: <0 Einspeisung, >0 Bezug; 2026-06-16 verifiziert). Nur Gruppe r9.
  if (group === 'r9' && smartfoxSolar && freshTs(smartfoxSolar.ts)) {
    if (grid_w === null) { grid_w = Math.round(smartfoxSolar.grid_w || 0); grid_ts = smartfoxSolar.ts; }
    if (production_w === null) production_w = Math.round(smartfoxSolar.production_w || 0);
  }

  return { grid_w, production_w, heizstab_w, consumers, timestamp: grid_ts };
}

// ─── Open CORS for IoT endpoints (Shelly, LaMetric, etc.) ──────────
const openCors = cors({ origin: '*' });
app.options('/api/energy/surplus', openCors);
app.options('/api/energy/surplus-available', openCors);
app.options('/api/energy/lametric', openCors);

// Surplus without Heizstab: actual grid export (what's going to the grid right now)
app.get('/api/energy/surplus', openCors, async (req, res) => {
  try {
    const group = req.query.group || 'r9';
    const data = await getGroupLiveData(group);
    if (data.grid_w === null) return res.status(503).json({ error: 'No live data' });

    const surplus_w = Math.max(0, -data.grid_w);
    const result = {
      surplus_w, grid_power_w: data.grid_w, production_w: data.production_w,
      heizstab_w: data.heizstab_w, consumers: data.consumers,
      timestamp: data.timestamp, group,
    };

    // ?field=grid_power_w → returns just the number as plain text (for Shelly/IoT)
    // ?field=grid_power_w&format={val} W → returns "1234 W"
    if (req.query.field && result[req.query.field] !== undefined) {
      const val = String(result[req.query.field]);
      const out = req.query.format ? req.query.format.replace('{val}', val) : val;
      return res.type('text/plain').send(out);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Surplus with Heizstab: available surplus if Heizstab were off
app.get('/api/energy/surplus-available', openCors, async (req, res) => {
  try {
    const group = req.query.group || 'r9';
    const data = await getGroupLiveData(group);
    if (data.grid_w === null) return res.status(503).json({ error: 'No live data' });

    const heizstab = data.heizstab_w || 0;
    const surplus_w = Math.max(0, -data.grid_w) + heizstab;
    const result = {
      surplus_w, grid_power_w: data.grid_w, heizstab_w: heizstab,
      production_w: data.production_w, consumers: data.consumers,
      timestamp: data.timestamp, group,
    };

    if (req.query.field && result[req.query.field] !== undefined) {
      return res.type('text/plain').send(String(result[req.query.field]));
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── LaMetric My Data DIY endpoint ──────────────────────────────────
// Returns frames in LaMetric JSON format for the "My Data DIY" app
// Usage: /api/energy/lametric?fields=surplus_w,production_w,grid_power_w
app.get('/api/energy/lametric', openCors, async (req, res) => {
  try {
    const group = req.query.group || 'r9';
    const data = await getGroupLiveData(group);
    if (data.grid_w === null) return res.status(503).json({ error: 'No live data' });

    const surplus_w = Math.max(0, -data.grid_w);
    const heizstab = data.heizstab_w || 0;
    const surplus_available = surplus_w + heizstab;

    const values = {
      surplus_w: { val: surplus_w, icon: 'i67405', label: 'Ueberschuss' },
      surplus_available_w: { val: surplus_available, icon: 'i67405', label: 'Verfuegbar' },
      production_w: { val: data.production_w || 0, icon: 'i37515', label: 'Solar' },
      grid_power_w: { val: data.grid_w, icon: data.grid_w < 0 ? 'i64129' : 'i59257', label: 'Netz' },
      heizstab_w: { val: heizstab, icon: 'i52509', label: 'Heizstab' },
    };

    // Which fields to show (default: all main values)
    const fields = (req.query.fields || 'surplus_w,production_w,grid_power_w,heizstab_w').split(',').filter(f => values[f]);

    const frames = fields.map(f => {
      const v = values[f];
      const display = Math.abs(v.val) >= 1000
        ? (v.val / 1000).toFixed(1) + ' kW'
        : v.val + ' W';
      return { text: v.label + ' ' + display, icon: v.icon };
    });

    res.json({ frames });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Shelly virtual device endpoint ─────────────────────────────────
// Liefert die zwei PV-Ueberschuss-Werte (mit + ohne Boiler) in einem
// kompakten JSON, optimiert fuer:
//   - Variante A: mJS-Script auf einem Shelly Plus/Pro, das das alle 30s
//     pollt und Virtual-Number-Components updated
//   - Variante B: standalone Shelly-Emulator-Service der das als virtuelles
//     Energiemessgeraet ausspielt
// CORS offen damit der Shelly direkt zugreifen kann.
app.options('/api/energy/shelly', openCors);
app.get('/api/energy/shelly', openCors, async (req, res) => {
  try {
    const group = req.query.group || 'r9';
    const variant = (req.query.variant || 'surplus').toLowerCase();
    const data = await getGroupLiveData(group);
    if (data.grid_w === null) return res.status(503).json({ error: 'No live data' });
    const surplus_w = Math.max(0, -data.grid_w);
    const heizstab_w = data.heizstab_w || 0;
    const surplus_available_w = surplus_w + heizstab_w;
    const production_w = data.production_w || 0;
    const consumption_w = data.consumption_w || 0;

    // Variant-spezifisches Mapping fuer Phasen A/B/C des virtuellen Shelly:
    // surplus  (default) — A=Ueberschuss ohne Boiler, B=Ueberschuss mit Boiler, C=Heizstab
    // production         — A=Solar-Produktion,        B=Verbrauch,              C=Netz-Bezug (>0 vom Netz)
    // grid               — A=Netz-Einspeisung (>0),   B=Netz-Bezug (>0),        C=Netto-Bilanz
    const variants = {
      surplus: {
        a: { label: 'Ueberschuss ohne Boiler', w: surplus_w },
        b: { label: 'Ueberschuss mit Boiler',  w: surplus_available_w },
        c: { label: 'Heizstab',                w: heizstab_w },
      },
      production: {
        a: { label: 'Solar-Produktion', w: production_w },
        b: { label: 'Verbrauch',        w: consumption_w },
        c: { label: 'Netz-Bezug',       w: Math.max(0, data.grid_w) },
      },
      grid: {
        a: { label: 'Einspeisung',  w: Math.max(0, -data.grid_w) },
        b: { label: 'Netz-Bezug',   w: Math.max(0, data.grid_w) },
        c: { label: 'Netto-Bilanz', w: data.grid_w },
      },
      // Single-Wert Varianten fuer Shelly Plus 1PM Emulation
      // (jeweils nur Phase A populiert, B+C = 0)
      'ohne-boiler': {
        a: { label: 'Ueberschuss ohne Boiler', w: surplus_w },
        b: { label: '', w: 0 },
        c: { label: '', w: 0 },
        single: true,
      },
      'mit-boiler': {
        a: { label: 'Ueberschuss mit Boiler', w: surplus_available_w },
        b: { label: '', w: 0 },
        c: { label: '', w: 0 },
        single: true,
      },
    };
    const v = variants[variant] || variants.surplus;

    res.json({
      group,
      variant: variants[variant] ? variant : 'surplus',
      timestamp: new Date().toISOString(),
      // Variant-Mapping fuer Shelly Pro 3EM (Phasen)
      phase_a_label: v.a.label,
      phase_a_w: v.a.w,
      phase_b_label: v.b.label,
      phase_b_w: v.b.w,
      phase_c_label: v.c.label,
      phase_c_w: v.c.w,
      // Backward-Compat: alte Felder behalten (variant=surplus default)
      surplus_without_boiler_w: surplus_w,
      surplus_with_boiler_w: surplus_available_w,
      // Rohwerte fuer eigene Mappings
      production_w,
      consumption_w,
      grid_w: data.grid_w,
      heizstab_w,
      battery_soc: data.battery_soc != null ? data.battery_soc : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Comparison endpoint ────────────────────────────────────────────
app.get('/api/energy/compare', async (req, res) => {
  try {
    const meterIds = (req.query.meters || '').split(',').filter(Boolean);
    const days = parseInt(req.query.days) || 7;
    if (meterIds.length === 0) return res.status(400).json({ error: 'meters parameter required' });
    if (meterIds.length > 10) return res.status(400).json({ error: 'max 10 meters' });

    const result = await pool.query(
      `SELECT meter_id, date_trunc('day', ts)::date AS day,
        MAX(energy_import_kwh) - MIN(energy_import_kwh) AS consumption_kwh
       FROM readings
       WHERE meter_id = ANY($1) AND ts >= NOW() - ($2 || ' days')::interval
       GROUP BY meter_id, day
       ORDER BY day, meter_id`,
      [meterIds, String(days)]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Cost projection ────────────────────────────────────────────────
app.get('/api/energy/projection/:meterId', async (req, res) => {
  try {
    const { meterId } = req.params;
    // Get last 30 days daily consumption
    const result = await pool.query(
      `SELECT date_trunc('day', ts)::date AS day,
        MAX(energy_import_kwh) - MIN(energy_import_kwh) AS consumption_kwh
       FROM readings
       WHERE meter_id = $1 AND ts >= NOW() - interval '30 days'
       GROUP BY day ORDER BY day`,
      [meterId]
    );
    const days = result.rows;
    if (days.length === 0) return res.json({ avg_daily: 0, projected_monthly: 0, projected_yearly: 0 });

    const totalKwh = days.reduce((s, d) => s + parseFloat(d.consumption_kwh || 0), 0);
    const avgDaily = totalKwh / days.length;

    // Get current tariffs
    const tariffs = await pool.query("SELECT * FROM tariffs WHERE active = true AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)");
    const netzTarif = tariffs.rows.find(t => t.name === 'Netztarif');
    const solarTarif = tariffs.rows.find(t => t.name === 'Solartarif');
    const netzPrice = netzTarif ? parseFloat(netzTarif.price_per_kwh) : 0;
    const solarPrice = solarTarif ? parseFloat(solarTarif.price_per_kwh) : 0;

    // Get meter's group solar share
    const meter = await pool.query('SELECT * FROM meters WHERE id = $1', [meterId]);
    let solarShare = 0;
    if (meter.rows.length > 0 && meter.rows[0].group_id) {
      const gid = meter.rows[0].group_id;
      const grid = await pool.query("SELECT id FROM meters WHERE group_id = $1 AND category = 'grid'", [gid]);
      const prod = await pool.query("SELECT id FROM meters WHERE group_id = $1 AND category = 'production'", [gid]);
      if (grid.rows.length > 0 && prod.rows.length > 0) {
        const gridDaily = await pool.query(
          `SELECT MAX(energy_import_kwh) - MIN(energy_import_kwh) AS import, MAX(energy_export_kwh) - MIN(energy_export_kwh) AS export
           FROM readings WHERE meter_id = $1 AND ts >= NOW() - interval '30 days'`,
          [grid.rows[0].id]
        );
        const prodDaily = await pool.query(
          `SELECT MAX(energy_export_kwh) - MIN(energy_export_kwh) AS production
           FROM readings WHERE meter_id = $1 AND ts >= NOW() - interval '30 days'`,
          [prod.rows[0].id]
        );
        const gridImport = parseFloat(gridDaily.rows[0]?.import || 0);
        const gridExport = parseFloat(gridDaily.rows[0]?.export || 0);
        const production = parseFloat(prodDaily.rows[0]?.production || 0);
        const eigen = Math.max(0, production - gridExport);
        const total = eigen + gridImport;
        solarShare = total > 0 ? eigen / total : 0;
      }
    }

    const projectedMonthly = avgDaily * 30.44;
    const projectedYearly = avgDaily * 365;
    const monthlySolar = projectedMonthly * solarShare;
    const monthlyNetz = projectedMonthly - monthlySolar;
    const monthlyCost = (monthlyNetz * netzPrice) + (monthlySolar * solarPrice);
    const yearlyCost = monthlyCost * 12;

    res.json({
      days_analyzed: days.length,
      avg_daily_kwh: Math.round(avgDaily * 100) / 100,
      solar_share_percent: Math.round(solarShare * 10000) / 100,
      projected_monthly_kwh: Math.round(projectedMonthly * 100) / 100,
      projected_yearly_kwh: Math.round(projectedYearly * 100) / 100,
      projected_monthly_cost: Math.round(monthlyCost * 100) / 100,
      projected_yearly_cost: Math.round(yearlyCost * 100) / 100,
      netz_price: netzPrice,
      solar_price: solarPrice,
      daily_data: days,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Alerts endpoint ────────────────────────────────────────────────
app.get('/api/energy/alerts', async (req, res) => {
  try {
    // Check all active meters for issues
    const alerts = [];
    const meters = await pool.query('SELECT * FROM meters WHERE active = true');

    for (const meter of meters.rows) {
      // Check if meter has recent readings (last 10 minutes)
      const latest = await pool.query(
        'SELECT ts, power_w FROM readings WHERE meter_id = $1 ORDER BY ts DESC LIMIT 1',
        [meter.id]
      );
      if (latest.rows.length === 0 || (Date.now() - new Date(latest.rows[0].ts).getTime() > 10 * 60 * 1000)) {
        alerts.push({ type: 'offline', severity: 'warning', meter_id: meter.id, meter_name: meter.name, message: `Keine Daten seit >10 Min.` });
      }

      // Check for unusually high consumption (> 2x daily average)
      if (meter.category === 'consumer' && latest.rows.length > 0) {
        const avgResult = await pool.query(
          `SELECT AVG(avg_power) AS avg_power FROM (
            SELECT AVG(power_w) AS avg_power FROM readings
            WHERE meter_id = $1 AND ts >= NOW() - interval '7 days'
            GROUP BY date_trunc('hour', ts)
          ) sub`,
          [meter.id]
        );
        const avgPower = parseFloat(avgResult.rows[0]?.avg_power || 0);
        const currentPower = Math.abs(latest.rows[0].power_w);
        if (avgPower > 0 && currentPower > avgPower * 3) {
          alerts.push({ type: 'high_consumption', severity: 'info', meter_id: meter.id, meter_name: meter.name,
            message: `Aktuell ${Math.round(currentPower)} W (Durchschnitt: ${Math.round(avgPower)} W)` });
        }
      }
    }
    res.json(alerts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CSV Export ─────────────────────────────────────────────────────
app.get('/api/energy/export/:meterId', async (req, res) => {
  try {
    const { meterId } = req.params;
    const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to = req.query.to || new Date().toISOString().slice(0, 10);

    const meter = await pool.query('SELECT name FROM meters WHERE id = $1', [meterId]);
    const meterName = meter.rows[0]?.name || meterId;

    const result = await pool.query(
      `SELECT date_trunc('day', ts)::date AS datum,
        MAX(energy_import_kwh) - MIN(energy_import_kwh) AS verbrauch_kwh,
        MAX(energy_export_kwh) - MIN(energy_export_kwh) AS einspeisung_kwh,
        AVG(power_w) AS durchschnitt_w,
        MAX(power_w) AS max_w
       FROM readings
       WHERE meter_id = $1 AND ts >= $2::date AND ts <= ($3::date + interval '1 day')
       GROUP BY datum ORDER BY datum`,
      [meterId, from, to]
    );

    // Build CSV
    const header = 'Datum;Verbrauch (kWh);Einspeisung (kWh);Durchschnitt (W);Maximum (W)';
    const rows = result.rows.map(r =>
      `${r.datum};${parseFloat(r.verbrauch_kwh || 0).toFixed(2)};${parseFloat(r.einspeisung_kwh || 0).toFixed(2)};${Math.round(r.durchschnitt_w || 0)};${Math.round(r.max_w || 0)}`
    );
    const csv = [header, ...rows].join('\n');

    const safeName = meterName.replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}_${from}_${to}.csv"`);
    res.send('\uFEFF' + csv); // BOM for Excel
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Startup ────────────────────────────────────────────────────────
async function start() {
  await initDB();

  // Load parent-child meter relationships
  await refreshChildrenMap();
  setInterval(refreshChildrenMap, 5 * 60 * 1000); // refresh every 5 min

  // Start polling (meters loaded from DB)
  const activeMeters = await getActiveMeters();
  console.log(`Polling ${activeMeters.length} meter(s) every ${POLL_INTERVAL / 1000}s`);
  pollAll(); // immediate first poll
  setInterval(pollAll, POLL_INTERVAL);

  // Refresh hourly view every 5 minutes
  setInterval(refreshHourlyView, 5 * 60 * 1000);
  setTimeout(refreshHourlyView, 30 * 1000); // first refresh after 30s

  // Cleanup old data daily at 3am
  setInterval(cleanupOldData, 24 * 60 * 60 * 1000);

  // Start API
  app.listen(API_PORT, () => {
    console.log(`Energy API running on port ${API_PORT}`);
  });
}

// ─── Graceful Shutdown ───────────────────────────────────────────────
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received. Shutting down gracefully...`);

  // Close Modbus connections
  for (const [id, client] of modbusClients) {
    try { client.close(); } catch (_) {}
    modbusClients.delete(id);
  }

  // Close MQTT (will-Message faengt harte Abbrueche ab)
  if (mqttClient) {
    try { mqttClient.publish(`${MQTT_PREFIX}/collector/status`, 'offline', { retain: true }); mqttClient.end(true); } catch (_) {}
  }

  // Close DB pool
  try {
    await pool.end();
    console.log('Database pool closed');
  } catch (err) {
    console.error('Error closing database pool:', err.message);
  }

  setTimeout(() => { console.error('Forced shutdown after timeout'); process.exit(1); }, 10000).unref();
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason?.message || reason);
});

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
