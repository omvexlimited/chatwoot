export async function getAssignedProvider({ config, order }) {
  if (!order) return emptyResult('no_order');
  if (!config.krProviderDatabaseUrl) return emptyResult('not_configured');

  const { Client } = await import('pg');
  const client = new Client({
    connectionString: config.krProviderDatabaseUrl,
    ssl: config.krProviderDatabaseSsl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 3000,
    query_timeout: 5000
  });

  try {
    await client.connect();
    const result = await client.query(
      `
      SELECT
        o.id AS order_id,
        o.order_number,
        o.shopify_order_id,
        o.provider_id,
        o.provider_assigned_at,
        o.provider_assignment_source,
        o.provider_assignment_note,
        p.code AS provider_code,
        p.name AS provider_name,
        p.is_active AS provider_is_active,
        p.is_default AS provider_is_default,
        p.assignment_priority AS provider_priority
      FROM kits_republic_orders o
      LEFT JOIN kits_republic_providers p ON p.id = o.provider_id
      WHERE o.store_id = $1
        AND (
          o.shopify_order_id = $2
          OR o.order_number = ANY($3::text[])
        )
      ORDER BY o.shopify_created_at DESC NULLS LAST, o.id DESC
      LIMIT 1
      `,
      [
        config.krProviderStoreId || 'kits_republic',
        String(order.id || ''),
        orderNumberCandidates(order.name)
      ]
    );

    const row = result.rows[0];
    if (!row) return emptyResult('order_not_found');

    return {
      available: true,
      source: 'kits_republic_orders',
      order_id: row.order_id,
      order_number: row.order_number || null,
      shopify_order_id: row.shopify_order_id || null,
      provider: formatProvider(row),
      warnings: []
    };
  } finally {
    await client.end().catch(() => {});
  }
}

export function formatProvider(row = {}) {
  const name = clean(row.provider_name);
  const code = clean(row.provider_code);
  const label = providerLabel({ name, code });

  if (!row.provider_id && !label) return null;

  return {
    id: row.provider_id ? Number(row.provider_id) : null,
    name,
    code,
    label,
    is_active: Boolean(row.provider_is_active),
    is_default: Boolean(row.provider_is_default),
    priority: row.provider_priority ?? null,
    assigned_at: row.provider_assigned_at || null,
    assignment_source: clean(row.provider_assignment_source),
    assignment_note: clean(row.provider_assignment_note)
  };
}

function providerLabel({ name, code }) {
  if (name && code && name !== code) return `${name} · ${code}`;
  return name || code || null;
}

function orderNumberCandidates(value = '') {
  const normalized = String(value || '').trim();
  if (!normalized) return [];
  const candidates = [normalized];
  const digits = normalized.startsWith('#') ? normalized.slice(1) : normalized;
  if (/^\d+$/.test(digits)) {
    candidates.push(digits, `#${digits}`);
  }
  return [...new Set(candidates)];
}

function emptyResult(reason) {
  return {
    available: false,
    source: null,
    reason,
    provider: null,
    warnings: []
  };
}

function clean(value) {
  return String(value || '').trim() || null;
}
