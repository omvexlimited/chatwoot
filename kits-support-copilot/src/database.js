const pools = new Map();

export async function withDatabaseClient({
  role,
  connectionString,
  ssl = true,
  max = 4,
  connectionTimeoutMs = 3000,
  queryTimeoutMs = 5000
}, callback) {
  if (!connectionString) throw new Error(`Database URL is not configured for ${role}.`);

  const pool = await getDatabasePool({
    role,
    connectionString,
    ssl,
    max,
    connectionTimeoutMs,
    queryTimeoutMs
  });
  const client = await pool.connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

export async function closeDatabasePools() {
  const activePools = [...pools.values()];
  pools.clear();
  await Promise.all(activePools.map(pool => pool.end().catch(() => {})));
}

export function databasePoolCount() {
  return pools.size;
}

async function getDatabasePool(options) {
  const key = poolKey(options);
  if (pools.has(key)) return pools.get(key);

  const { Pool } = await import('pg');
  const pool = new Pool({
    connectionString: options.connectionString,
    ssl: options.ssl ? { rejectUnauthorized: false } : undefined,
    max: positiveInteger(options.max, 4),
    connectionTimeoutMillis: positiveInteger(options.connectionTimeoutMs, 3000),
    query_timeout: positiveInteger(options.queryTimeoutMs, 5000),
    idleTimeoutMillis: 30_000,
    keepAlive: true,
    allowExitOnIdle: true
  });
  pool.on('error', error => {
    console.warn(`KR Copilot ${options.role} database pool error: ${error.message}`);
  });
  pools.set(key, pool);
  return pool;
}

function poolKey({ role, connectionString }) {
  return `${String(role || 'default')}:${connectionString}`;
}

function positiveInteger(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
