import { createHash } from 'node:crypto';
import { Client } from 'pg';

const sourceUrl = process.env.KITS_REPUBLIC_DATABASE_URL;
const targetUrl = process.env.COPILOT_DATABASE_URL;

if (!sourceUrl || !targetUrl) {
  throw new Error('KITS_REPUBLIC_DATABASE_URL and COPILOT_DATABASE_URL are required.');
}
if (sourceUrl === targetUrl) {
  throw new Error('Source and target database URLs must be different.');
}

const source = databaseClient({
  connectionString: sourceUrl,
  ssl: process.env.KITS_REPUBLIC_DATABASE_SSL !== 'false'
});
const target = databaseClient({
  connectionString: targetUrl,
  ssl: process.env.COPILOT_DATABASE_SSL !== 'false'
});

try {
  await Promise.all([source.connect(), target.connect()]);
  await ensureTargetTable(target);

  const sourceResult = await source.query('SELECT * FROM copilot_memories ORDER BY id');
  await target.query('BEGIN');
  try {
    for (const row of sourceResult.rows) {
      await target.query(
        `
        INSERT INTO copilot_memories (
          id,
          content,
          tags,
          support_case_type,
          carrier,
          language,
          created_by,
          conversation_id,
          contact_email,
          created_at,
          last_used_at,
          usage_count,
          active
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13
        )
        ON CONFLICT (id) DO UPDATE SET
          content = EXCLUDED.content,
          tags = EXCLUDED.tags,
          support_case_type = EXCLUDED.support_case_type,
          carrier = EXCLUDED.carrier,
          language = EXCLUDED.language,
          created_by = EXCLUDED.created_by,
          conversation_id = EXCLUDED.conversation_id,
          contact_email = EXCLUDED.contact_email,
          created_at = EXCLUDED.created_at,
          last_used_at = EXCLUDED.last_used_at,
          usage_count = EXCLUDED.usage_count,
          active = EXCLUDED.active
        `,
        [
          row.id,
          row.content,
          row.tags,
          row.support_case_type,
          row.carrier,
          row.language,
          row.created_by,
          row.conversation_id,
          row.contact_email,
          row.created_at,
          row.last_used_at,
          row.usage_count,
          row.active
        ]
      );
    }
    await target.query(`
      SELECT setval(
        pg_get_serial_sequence('copilot_memories', 'id'),
        COALESCE(MAX(id), 1),
        MAX(id) IS NOT NULL
      )
      FROM copilot_memories
    `);
    await target.query('COMMIT');
  } catch (error) {
    await target.query('ROLLBACK');
    throw error;
  }

  const targetResult = await target.query(
    'SELECT * FROM copilot_memories WHERE id = ANY($1::bigint[]) ORDER BY id',
    [sourceResult.rows.map(row => row.id)]
  );
  const sourceDigest = rowsDigest(sourceResult.rows);
  const targetDigest = rowsDigest(targetResult.rows);
  if (sourceResult.rowCount !== targetResult.rowCount || sourceDigest !== targetDigest) {
    throw new Error('Memory verification failed after copy.');
  }

  console.log(JSON.stringify({
    migrated: sourceResult.rowCount,
    verified: targetResult.rowCount,
    digest: sourceDigest.slice(0, 12)
  }));
} finally {
  await Promise.all([
    source.end().catch(() => {}),
    target.end().catch(() => {})
  ]);
}

function databaseClient({ connectionString, ssl }) {
  return new Client({
    connectionString,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 5000,
    query_timeout: 15000
  });
}

async function ensureTargetTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS copilot_memories (
      id BIGSERIAL PRIMARY KEY,
      content TEXT NOT NULL,
      tags TEXT[] NOT NULL DEFAULT '{}',
      support_case_type TEXT,
      carrier TEXT,
      language TEXT,
      created_by TEXT,
      conversation_id TEXT,
      contact_email TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ,
      usage_count INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS copilot_memories_active_created_idx ON copilot_memories (active, created_at DESC)');
  await client.query('CREATE INDEX IF NOT EXISTS copilot_memories_support_case_idx ON copilot_memories (support_case_type)');
  await client.query('CREATE INDEX IF NOT EXISTS copilot_memories_carrier_idx ON copilot_memories (carrier)');
}

function rowsDigest(rows) {
  const normalized = rows.map(row => ({
    id: String(row.id),
    content: row.content,
    tags: row.tags,
    support_case_type: row.support_case_type,
    carrier: row.carrier,
    language: row.language,
    created_by: row.created_by,
    conversation_id: row.conversation_id,
    contact_email: row.contact_email,
    created_at: timestamp(row.created_at),
    last_used_at: timestamp(row.last_used_at),
    usage_count: Number(row.usage_count),
    active: row.active
  }));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function timestamp(value) {
  if (!value) return null;
  return new Date(value).toISOString();
}
