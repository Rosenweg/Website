const ModbusRTU = require('modbus-serial');
const { Pool } = require('pg');
const express = require('express');
const cors = require('cors');

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
  password: process.env.DB_PASSWORD || 'changeme',
});

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

  // Group 4: Energy import/export in kWh (internal 0x204C/0x204E → Modbus 0x204B/0x204D)
  const energyBuf = await client.readHoldingRegisters(0x204B, 4);
  data.energy_import_raw = parseRegisterValue(Buffer.from(energyBuf.buffer), 'int32');      // kWh * 1000
  data.energy_export_raw = parseRegisterValue(Buffer.from(energyBuf.buffer.slice(4)), 'int32');

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
    energy_import_t1_kwh: 0,
    energy_import_t2_kwh: 0,
    energy_export_t1_kwh: 0,
    energy_export_t2_kwh: 0,
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

  return data;
}

// ─── Polling Loop ───────────────────────────────────────────────────
const modbusClients = new Map();

async function getModbusClient(meter) {
  let client = modbusClients.get(meter.id);
  if (client && client.isOpen) return client;

  client = new ModbusRTU();
  await client.connectTCP(meter.host, { port: meter.port });
  client.setTimeout(3000);
  // Handle connection errors to prevent unhandled rejections crashing the process
  client._port.on('error', (err) => {
    console.error(`Modbus connection error [${meter.name}]:`, err.message);
    modbusClients.delete(meter.id);
  });
  modbusClients.set(meter.id, client);
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
  } catch (err) {
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

async function pollAll() {
  const meters = await getActiveMeters();
  for (const meter of meters) {
    await pollMeter(meter);
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
app.use(cors({ origin: true }));

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
  const result = await pool.query(
    'SELECT * FROM meters WHERE location = $1 AND active = true ORDER BY name',
    [location]
  );
  res.json(result.rows);
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

  const result = await pool.query(dailyQuery, [meterId, startDate.toISOString(), endDate.toISOString()]);
  const rows = await subtractChildrenAgg(meterId, result.rows, dailyQuery, startDate.toISOString(), endDate.toISOString(), 'day');
  res.json(rows);
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
app.post('/api/energy/meters', async (req, res) => {
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

app.put('/api/energy/meters/:id', async (req, res) => {
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

app.delete('/api/energy/meters/:id', async (req, res) => {
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
app.post('/api/energy/meters/:id/test', async (req, res) => {
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
  const result = await pool.query('SELECT * FROM tariffs ORDER BY name, valid_from DESC NULLS LAST');
  res.json(result.rows);
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

app.post('/api/energy/tariffs', async (req, res) => {
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

app.put('/api/energy/tariffs/:id', async (req, res) => {
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

app.delete('/api/energy/tariffs/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM tariffs WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- User-Meter Assignment ---
app.get('/api/energy/meters/:meterId/users', async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM meter_users WHERE meter_id = $1 ORDER BY user_name',
    [req.params.meterId]
  );
  res.json(result.rows);
});

app.post('/api/energy/meters/:meterId/users', async (req, res) => {
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

app.delete('/api/energy/meters/:meterId/users/:email', async (req, res) => {
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
  const result = await pool.query(
    'SELECT * FROM meter_groups WHERE meter_id = $1 ORDER BY group_name',
    [req.params.meterId]
  );
  res.json(result.rows);
});

app.post('/api/energy/meters/:meterId/groups', async (req, res) => {
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

app.delete('/api/energy/meters/:meterId/groups/:groupName', async (req, res) => {
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
  const result = await pool.query(
    `SELECT DISTINCT m.*, COALESCE(mu.role, 'viewer') as role FROM meters m
     LEFT JOIN meter_users mu ON m.id = mu.meter_id AND mu.user_email = $1
     LEFT JOIN meter_groups mg ON m.id = mg.meter_id
     WHERE m.active = true AND (mu.user_email IS NOT NULL OR mg.group_name = ANY($2::text[]))
     ORDER BY m.name`,
    [req.params.email.toLowerCase(), req.query.groups ? req.query.groups.split(',') : []]
  );
  res.json(result.rows);
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
// Alert check: runs as part of polling, stores alerts in memory (no DB table needed yet)
const activeAlerts = [];

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

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${meterName}_${from}_${to}.csv"`);
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

// Prevent unhandled errors from crashing the process
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err.message);
});

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
