// Datenbank-Pools + Audit-Kontext — aus server.js ausgelagert (Router-Split).
// MUSS frueh require't werden (vor jeder Query), da pool.query gewrappt wird.
// Hinweis: initDB() bleibt bewusst im Bootstrap (server.js) — reine Startup-
// Logik, nutzt den hier exportierten pool.
const { Pool } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');

const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'rosenweg',
  user: process.env.DB_USER || 'rosenweg',
  password: process.env.DB_PASSWORD || 'changeme',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 30000,
});
pool.on('error', (err) => console.error('[DB] Idle client error:', err.message));

// ─── Audit-Kontext: AsyncLocalStorage haelt die User-Email pro Request ──
// Trigger audit_trigger_fn() liest current_setting('app.user_email').
// Wir wrappen pool.query: bei MUTATIONEN (INSERT/UPDATE/DELETE) wird ein
// Client gecheckt, in einer Transaction "SET LOCAL app.user_email" gesetzt
// und die Query darin ausgefuehrt. Reads bleiben unveraendert (Performance).
const auditCtx = new AsyncLocalStorage();
const _origPoolQuery = pool.query.bind(pool);
const isMutation = (sql) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(typeof sql === 'string' ? sql : sql?.text || '');
pool.query = async function (sqlOrCfg, params) {
  const userEmail = auditCtx.getStore()?.userEmail;
  const sqlStr = typeof sqlOrCfg === 'string' ? sqlOrCfg : sqlOrCfg?.text || '';
  if (!userEmail || !isMutation(sqlStr)) return _origPoolQuery(sqlOrCfg, params);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_email', $1, true)`, [userEmail]);
    const r = await client.query(sqlOrCfg, params);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
};

// ─── Energy Database (for Waschküche billing) ──────────────────────
const energyPool = new Pool({
  host: process.env.ENERGY_DB_HOST || 'energy-db',
  port: process.env.ENERGY_DB_PORT || 5432,
  database: process.env.ENERGY_DB_NAME || 'energy',
  user: process.env.ENERGY_DB_USER || 'energy',
  password: process.env.ENERGY_DB_PASSWORD || 'energy2026',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 30000,
});
energyPool.on('error', (err) => console.error('[EnergyDB] Idle client error:', err.message));

module.exports = { pool, energyPool, auditCtx };
