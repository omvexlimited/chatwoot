import { withDatabaseClient } from './database.js';

export async function getAssignedProvider({ config, order }) {
  const result = await getAssignedProviders({ config, orders: order ? [order] : [] });
  return providerResultForOrder({ result, order });
}

export async function getAssignedProviders({ config, orders = [] }) {
  const normalizedOrders = Array.isArray(orders) ? orders.filter(Boolean) : [];
  if (!normalizedOrders.length) return batchResult('no_order');
  if (!config.krProviderDatabaseUrl) {
    return batchResult(
      'not_configured',
      'Provider lookup is not configured. Set KITS_REPUBLIC_DATABASE_URL to the Kits Republic admin database.'
    );
  }

  return withDatabaseClient({
    role: 'kits-republic',
    connectionString: config.krProviderDatabaseUrl,
    ssl: config.krProviderDatabaseSsl,
    max: config.krDatabasePoolSize,
    connectionTimeoutMs: 3000,
    queryTimeoutMs: 5000
  }, async client => {
    const shopifyIds = normalizedOrders.flatMap(shopifyOrderIdCandidates);
    const orderNumbers = normalizedOrders.flatMap(order => orderNumberCandidates(order.name));
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
          o.shopify_order_id = ANY($2::text[])
          OR o.order_number = ANY($3::text[])
        )
      ORDER BY o.shopify_created_at DESC NULLS LAST, o.id DESC
      `,
      [
        config.krProviderStoreId || 'kits_republic',
        [...new Set(shopifyIds)],
        [...new Set(orderNumbers)]
      ]
    );

    return {
      available: true,
      source: 'kits_republic_orders',
      reason: null,
      providers_by_order_ref: providersByOrderRef({ rows: result.rows, orders: normalizedOrders }),
      warnings: []
    };
  });
}

function providerResultForOrder({ result, order }) {
  if (!order) return emptyResult('no_order');
  if (!result.available) return emptyResult(result.reason, result.warnings?.[0] || null);

  const providerResult = result.providers_by_order_ref?.[order.name];
  if (providerResult) return providerResult;

  return emptyResult(
    'order_not_found',
    `Provider lookup could not find ${order.name || 'the selected order'} in the Kits Republic orders database.`
  );
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

function providersByOrderRef({ rows = [], orders = [] }) {
  const indexes = rowIndexes(rows);
  return orders.reduce((acc, order) => {
    const row = rowForOrder(order, indexes);
    if (!row) return acc;

    const provider = formatProvider(row);
    acc[order.name] = {
      available: Boolean(provider),
      source: 'kits_republic_orders',
      reason: provider ? null : 'provider_not_assigned',
      order_id: row.order_id,
      order_number: row.order_number || null,
      shopify_order_id: row.shopify_order_id || null,
      provider,
      warnings: provider ? [] : [`Kits Republic order ${row.order_number || order.name} was found but has no provider assigned.`]
    };
    return acc;
  }, {});
}

function rowIndexes(rows = []) {
  const byShopifyId = new Map();
  const byOrderNumber = new Map();

  for (const row of rows) {
    for (const id of shopifyOrderIdCandidates({ id: row.shopify_order_id })) {
      if (!byShopifyId.has(id)) byShopifyId.set(id, row);
    }
    for (const orderNumber of orderNumberCandidates(row.order_number)) {
      if (!byOrderNumber.has(orderNumber)) byOrderNumber.set(orderNumber, row);
    }
  }

  return { byShopifyId, byOrderNumber };
}

function rowForOrder(order, indexes) {
  for (const id of shopifyOrderIdCandidates(order)) {
    const row = indexes.byShopifyId.get(id);
    if (row) return row;
  }

  for (const orderNumber of orderNumberCandidates(order.name)) {
    const row = indexes.byOrderNumber.get(orderNumber);
    if (row) return row;
  }

  return null;
}

function shopifyOrderIdCandidates(order = {}) {
  const value = String(order.id || '').trim();
  if (!value) return [];
  const numeric = value.match(/(\d+)$/)?.[1];
  return [...new Set([value, numeric].filter(Boolean))];
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

function batchResult(reason, warning = null) {
  return {
    available: false,
    source: null,
    reason,
    providers_by_order_ref: {},
    warnings: warning ? [warning] : []
  };
}

function emptyResult(reason, warning = null) {
  return {
    available: false,
    source: null,
    reason,
    provider: null,
    warnings: warning ? [warning] : []
  };
}

function clean(value) {
  return String(value || '').trim() || null;
}
