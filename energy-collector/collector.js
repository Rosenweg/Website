const ModbusRTU = require('modbus-serial');
const { Pool } = require('pg');
const express = require('express');
const cors = require('cors');

// ─── Configuration ──────────────────────────────────────────────────
const METERS = (process.env.METERS || '100.64.90.72:502:1:test-meter').split(',').map(m => {
  const [host, port, unitId, name] = m.split(':');
  return { host, port: parseInt(port), unitId: parseInt(unitId) || 1, name: name || host };
});

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
const REGISTERS = {
  serial:           { addr: 0x2000, len: 2, type: 'uint32', unit: null },
  timestamp:        { addr: 0x2002, len: 2, type: 'uint32', unit: null },
  power_total:      { addr: 0x2004, len: 2, type: 'int32',  unit: 'mW' },
  power_l1:         { addr: 0x2006, len: 2, type: 'int32',  unit: 'mW' },
  power_l2:         { addr: 0x2008, len: 2, type: 'int32',  unit: 'mW' },
  power_l3:         { addr: 0x200A, len: 2, type: 'int32',  unit: 'mW' },
  voltage_l1:       { addr: 0x2014, len: 2, type: 'uint32', unit: 'mV' },
  voltage_l2:       { addr: 0x2016, len: 2, type: 'uint32', unit: 'mV' },
  voltage_l3:       { addr: 0x2018, len: 2, type: 'uint32', unit: 'mV' },
  current_l1:       { addr: 0x201A, len: 2, type: 'int32',  unit: 'mA' },
  current_l2:       { addr: 0x201C, len: 2, type: 'int32',  unit: 'mA' },
  current_l3:       { addr: 0x201E, len: 2, type: 'int32',  unit: 'mA' },
  pf_l1:            { addr: 0x2020, len: 1, type: 'uint16', unit: '1/1000' },
  pf_l2:            { addr: 0x2021, len: 1, type: 'uint16', unit: '1/1000' },
  pf_l3:            { addr: 0x2022, len: 1, type: 'uint16', unit: '1/1000' },
  tariff:           { addr: 0x2023, len: 1, type: 'uint16', unit: null },
  energy_import:    { addr: 0x2024, len: 4, type: 'uint64', unit: 'mWh' },
  energy_export:    { addr: 0x2028, len: 4, type: 'uint64', unit: 'mWh' },
  energy_import_t1: { addr: 0x202C, len: 4, type: 'uint64', unit: 'mWh' },
  energy_import_t2: { addr: 0x2030, len: 4, type: 'uint64', unit: 'mWh' },
  energy_export_t1: { addr: 0x2034, len: 4, type: 'uint64', unit: 'mWh' },
  energy_export_t2: { addr: 0x2038, len: 4, type: 'uint64', unit: 'mWh' },
};

// ─── Modbus Read Helpers ────────────────────────────────────────────
function parseRegisterValue(buffer, type) {
  switch (type) {
    case 'uint16': return buffer.readUInt16BE(0);
    case 'int32':  return buffer.readInt32BE(0);
    case 'uint32': return buffer.readUInt32BE(0);
    case 'uint64': {
      const high = buffer.readUInt32BE(0);
      const low = buffer.readUInt32BE(4);
      return high * 0x100000000 + low;
    }
    default: return 0;
  }
}

async function readMeter(client, meter) {
  client.setID(meter.unitId);

  const data = {};

  // Read all registers in logical groups to minimize requests
  // Group 1: Power registers (0x2004 - 0x200B, 8 registers)
  const powerBuf = await client.readHoldingRegisters(0x2004, 8);
  data.power_total_mw = parseRegisterValue(Buffer.from(powerBuf.buffer), 'int32');
  data.power_l1_mw = parseRegisterValue(Buffer.from(powerBuf.buffer.slice(4)), 'int32');
  data.power_l2_mw = parseRegisterValue(Buffer.from(powerBuf.buffer.slice(8)), 'int32');
  data.power_l3_mw = parseRegisterValue(Buffer.from(powerBuf.buffer.slice(12)), 'int32');

  // Group 2: Voltage + Current (0x2014 - 0x201F, 12 registers)
  const vcBuf = await client.readHoldingRegisters(0x2014, 12);
  data.voltage_l1_mv = parseRegisterValue(Buffer.from(vcBuf.buffer), 'uint32');
  data.voltage_l2_mv = parseRegisterValue(Buffer.from(vcBuf.buffer.slice(4)), 'uint32');
  data.voltage_l3_mv = parseRegisterValue(Buffer.from(vcBuf.buffer.slice(8)), 'uint32');
  data.current_l1_ma = parseRegisterValue(Buffer.from(vcBuf.buffer.slice(12)), 'int32');
  data.current_l2_ma = parseRegisterValue(Buffer.from(vcBuf.buffer.slice(16)), 'int32');
  data.current_l3_ma = parseRegisterValue(Buffer.from(vcBuf.buffer.slice(20)), 'int32');

  // Group 3: Power factor + tariff (0x2020 - 0x2023, 4 registers)
  const pfBuf = await client.readHoldingRegisters(0x2020, 4);
  data.pf_l1 = parseRegisterValue(Buffer.from(pfBuf.buffer), 'uint16') / 1000;
  data.pf_l2 = parseRegisterValue(Buffer.from(pfBuf.buffer.slice(2)), 'uint16') / 1000;
  data.pf_l3 = parseRegisterValue(Buffer.from(pfBuf.buffer.slice(4)), 'uint16') / 1000;
  data.tariff = parseRegisterValue(Buffer.from(pfBuf.buffer.slice(6)), 'uint16');

  // Group 4: Energy counters (0x2024 - 0x203B, 24 registers)
  const energyBuf = await client.readHoldingRegisters(0x2024, 24);
  data.energy_import_mwh = parseRegisterValue(Buffer.from(energyBuf.buffer), 'uint64');
  data.energy_export_mwh = parseRegisterValue(Buffer.from(energyBuf.buffer.slice(8)), 'uint64');
  data.energy_import_t1_mwh = parseRegisterValue(Buffer.from(energyBuf.buffer.slice(16)), 'uint64');
  data.energy_import_t2_mwh = parseRegisterValue(Buffer.from(energyBuf.buffer.slice(24)), 'uint64');
  data.energy_export_t1_mwh = parseRegisterValue(Buffer.from(energyBuf.buffer.slice(32)), 'uint64');
  data.energy_export_t2_mwh = parseRegisterValue(Buffer.from(energyBuf.buffer.slice(40)), 'uint64');

  // Convert to human-readable units
  return {
    power_w: data.power_total_mw / 1000,
    power_l1_w: data.power_l1_mw / 1000,
    power_l2_w: data.power_l2_mw / 1000,
    power_l3_w: data.power_l3_mw / 1000,
    voltage_l1_v: data.voltage_l1_mv / 1000,
    voltage_l2_v: data.voltage_l2_mv / 1000,
    voltage_l3_v: data.voltage_l3_mv / 1000,
    current_l1_a: data.current_l1_ma / 1000,
    current_l2_a: data.current_l2_ma / 1000,
    current_l3_a: data.current_l3_ma / 1000,
    pf_l1: data.pf_l1,
    pf_l2: data.pf_l2,
    pf_l3: data.pf_l3,
    tariff: data.tariff,
    energy_import_kwh: data.energy_import_mwh / 1000000,
    energy_export_kwh: data.energy_export_mwh / 1000000,
    energy_import_t1_kwh: data.energy_import_t1_mwh / 1000000,
    energy_import_t2_kwh: data.energy_import_t2_mwh / 1000000,
    energy_export_t1_kwh: data.energy_export_t1_mwh / 1000000,
    energy_export_t2_kwh: data.energy_export_t2_mwh / 1000000,
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
    `);

    // Register configured meters (from env)
    for (const meter of METERS) {
      await client.query(
        `INSERT INTO meters (id, name, type, host, port, unit_id)
         VALUES ($1, $2, 'modbus', $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET name=$2, host=$3, port=$4, unit_id=$5`,
        [meter.name, meter.name, meter.host, meter.port, meter.unitId]
      );
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

// ─── Polling Loop ───────────────────────────────────────────────────
const modbusClients = new Map();

async function getModbusClient(meter) {
  let client = modbusClients.get(meter.id);
  if (client && client.isOpen) return client;

  client = new ModbusRTU();
  await client.connectTCP(meter.host, { port: meter.port });
  client.setTimeout(3000);
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
app.get('/health', (req, res) => {
  res.json({ status: 'ok', meters: METERS.length, uptime: process.uptime() });
});

// List meters
app.get('/api/energy/meters', async (req, res) => {
  const result = await pool.query('SELECT * FROM meters ORDER BY name');
  res.json(result.rows);
});

// Live data (latest reading per meter)
app.get('/api/energy/live', (req, res) => {
  const live = {};
  for (const [id, data] of latestReadings) {
    live[id] = data;
  }
  res.json(live);
});

// Live data for specific meter
app.get('/api/energy/live/:meterId', (req, res) => {
  const data = latestReadings.get(req.params.meterId);
  if (!data) return res.status(404).json({ error: 'Meter not found' });
  res.json(data);
});

// Historical data (raw readings)
app.get('/api/energy/history/:meterId', async (req, res) => {
  const { meterId } = req.params;
  const { from, to, limit } = req.query;
  const fromDate = from || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const toDate = to || new Date().toISOString();
  const maxRows = Math.min(parseInt(limit) || 2000, 10000);

  const result = await pool.query(
    `SELECT ts, power_w, power_l1_w, power_l2_w, power_l3_w,
            voltage_l1_v, voltage_l2_v, voltage_l3_v,
            current_l1_a, current_l2_a, current_l3_a,
            pf_l1, pf_l2, pf_l3, tariff,
            energy_import_kwh, energy_export_kwh,
            energy_import_t1_kwh, energy_import_t2_kwh
     FROM readings
     WHERE meter_id = $1 AND ts >= $2 AND ts <= $3
     ORDER BY ts
     LIMIT $4`,
    [meterId, fromDate, toDate, maxRows]
  );
  res.json(result.rows);
});

// Hourly aggregated data
app.get('/api/energy/hourly/:meterId', async (req, res) => {
  const { meterId } = req.params;
  const { from, to } = req.query;
  const fromDate = from || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const toDate = to || new Date().toISOString();

  const result = await pool.query(
    `SELECT * FROM readings_hourly
     WHERE meter_id = $1 AND hour >= $2 AND hour <= $3
     ORDER BY hour`,
    [meterId, fromDate, toDate]
  );
  res.json(result.rows);
});

// Daily summary
app.get('/api/energy/daily/:meterId', async (req, res) => {
  const { meterId } = req.params;
  const { days } = req.query;
  const numDays = parseInt(days) || 30;

  const result = await pool.query(
    `SELECT
       date_trunc('day', ts) AS day,
       AVG(power_w) AS avg_power_w,
       MAX(power_w) AS max_power_w,
       MAX(energy_import_kwh) - MIN(energy_import_kwh) AS consumption_kwh,
       MAX(energy_export_kwh) - MIN(energy_export_kwh) AS export_kwh,
       MAX(energy_import_t1_kwh) - MIN(energy_import_t1_kwh) AS consumption_t1_kwh,
       MAX(energy_import_t2_kwh) - MIN(energy_import_t2_kwh) AS consumption_t2_kwh,
       COUNT(*) AS samples
     FROM readings
     WHERE meter_id = $1 AND ts >= NOW() - ($2 || ' days')::INTERVAL
     GROUP BY date_trunc('day', ts)
     ORDER BY day`,
    [meterId, numDays.toString()]
  );
  res.json(result.rows);
});

// Today's summary
app.get('/api/energy/today/:meterId', async (req, res) => {
  const { meterId } = req.params;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const result = await pool.query(
    `SELECT
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
     WHERE meter_id = $1 AND ts >= $2`,
    [meterId, today.toISOString()]
  );
  res.json(result.rows[0] || {});
});

// ═══════════════════════════════════════════════════════════════════
// CONFIG API (Meters, Users, Tariffs)
// ═══════════════════════════════════════════════════════════════════
app.use(express.json());

// --- Meter Management ---
app.post('/api/energy/meters', async (req, res) => {
  const { id, name, type, host, port, unit_id, shelly_type } = req.body;
  if (!id || !name || !host) return res.status(400).json({ error: 'id, name, host required' });
  try {
    const result = await pool.query(
      `INSERT INTO meters (id, name, type, host, port, unit_id, shelly_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET name=$2, type=$3, host=$4, port=$5, unit_id=$6, shelly_type=$7
       RETURNING *`,
      [id, name, type || 'modbus', host, port || 502, unit_id || 1, shelly_type || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/energy/meters/:id', async (req, res) => {
  const { name, type, host, port, unit_id, shelly_type, active } = req.body;
  try {
    const result = await pool.query(
      `UPDATE meters SET name=COALESCE($2,name), type=COALESCE($3,type), host=COALESCE($4,host),
       port=COALESCE($5,port), unit_id=COALESCE($6,unit_id), shelly_type=$7, active=COALESCE($8,active)
       WHERE id=$1 RETURNING *`,
      [req.params.id, name, type, host, port, unit_id, shelly_type || null, active]
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

// Get currently active tariffs (valid_from <= today AND (valid_to IS NULL OR valid_to >= today))
app.get('/api/energy/tariffs/current', async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM tariffs
     WHERE active = true
       AND (valid_from IS NULL OR valid_from <= CURRENT_DATE)
       AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)
     ORDER BY name`
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

// Get meters for a specific user
app.get('/api/energy/user/:email/meters', async (req, res) => {
  const result = await pool.query(
    `SELECT m.*, mu.role FROM meters m
     JOIN meter_users mu ON m.id = mu.meter_id
     WHERE mu.user_email = $1 AND m.active = true
     ORDER BY m.name`,
    [req.params.email.toLowerCase()]
  );
  res.json(result.rows);
});

// ─── Startup ────────────────────────────────────────────────────────
async function start() {
  await initDB();

  // Start polling
  console.log(`Polling ${METERS.length} meter(s) every ${POLL_INTERVAL / 1000}s`);
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

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
