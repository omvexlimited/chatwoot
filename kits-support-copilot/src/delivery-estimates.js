import { withDatabaseClient } from './database.js';

export async function getDeliveryEstimateContext({ config, order }) {
  if (!order) return null;

  const carrier = carrierFromOrder(order);
  if (!carrier) return null;

  const fulfillment = summaryFulfillment(order);
  const orderCreatedAt = order.created_at || null;
  const fulfilledAt = fulfillment?.created_at || null;
  const deliveredAt = fulfillment?.delivered_at || null;

  if (!config.krAnalyticsDatabaseUrl) {
    return null;
  }

  const stats = await fetchCarrierStats({ config, carrier });
  return buildDeliveryEstimateContext({
    carrier,
    orderCreatedAt,
    fulfilledAt,
    deliveredAt,
    stats,
    minFulfilled: config.krAnalyticsMinFulfilled,
    minDelivered: config.krAnalyticsMinDelivered
  });
}

export function buildDeliveryEstimateContext({
  carrier,
  orderCreatedAt,
  fulfilledAt,
  deliveredAt,
  stats,
  minFulfilled = 20,
  minDelivered = 10,
  now = new Date()
}) {
  const fulfilledThreshold = positiveNumber(minFulfilled, 20);
  const deliveredThreshold = positiveNumber(minDelivered, 10);
  const normalizedCarrier = normalizeCarrierName(carrier);
  const orderDate = parseDate(orderCreatedAt);
  const fulfilledDate = parseDate(fulfilledAt);
  const deliveredDate = parseDate(deliveredAt);
  const fulfilledCount = Number(stats?.fulfilled || 0);
  const deliveredCount = Number(stats?.delivered || 0);
  const avgTransitDays = numberOrNull(stats?.avg_transit_days);
  const deliveredPct = numberOrNull(stats?.delivered_pct);

  if (!normalizedCarrier || !fulfilledDate) {
    return null;
  }

  const base = {
    available: false,
    source: 'kits_republic_orders',
    carrier: stats?.carrier || carrier,
    avg_transit_days: avgTransitDays,
    delivered_pct: deliveredPct,
    sample_size: deliveredCount,
    fulfilled_count: fulfilledCount,
    delivered_count: deliveredCount,
    order_created_at: orderDate?.toISOString() || null,
    fulfilled_at: fulfilledDate.toISOString(),
    delivered_at: deliveredDate?.toISOString() || null,
    days_since_order: orderDate ? roundDays(daysBetween(orderDate, deliveredDate || now)) : null,
    days_since_fulfillment: roundDays(daysBetween(fulfilledDate, deliveredDate || now)),
    estimated_remaining_days: null,
    confidence: 'low',
    reason: null
  };

  if (!stats || avgTransitDays === null) {
    return { ...base, reason: 'no_carrier_analytics' };
  }

  if (fulfilledCount < fulfilledThreshold || deliveredCount < deliveredThreshold) {
    return { ...base, reason: 'insufficient_sample' };
  }

  if (deliveredDate) {
    return {
      ...base,
      available: true,
      estimated_remaining_days: 0,
      confidence: estimateConfidence({ deliveredCount, deliveredPct }),
      reason: 'already_delivered'
    };
  }

  const elapsed = daysBetween(fulfilledDate, now);
  return {
    ...base,
    available: true,
    estimated_remaining_days: Math.max(0, roundDays(avgTransitDays - elapsed)),
    confidence: estimateConfidence({ deliveredCount, deliveredPct }),
    reason: elapsed > avgTransitDays ? 'over_recent_average' : 'recent_average'
  };
}

export function normalizeCarrierName(value = '') {
  const normalized = String(value || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  if (!normalized) return '';
  if (normalized.includes('royal mail')) return 'royal mail';
  if (normalized.includes('ctt')) return 'ctt express';
  if (normalized.includes('colissimo')) return 'colissimo';
  if (normalized.includes('china post')) return 'china post';
  if (normalized.includes('deutsche post')) return 'deutsche post';
  if (normalized.includes('usps')) return 'usps';
  if (normalized.includes('dhl')) return 'dhl';
  return normalized;
}

async function fetchCarrierStats({ config, carrier }) {
  const normalizedTarget = normalizeCarrierName(carrier);
  if (!normalizedTarget) return null;

  return withDatabaseClient({
    role: 'kits-republic',
    connectionString: config.krAnalyticsDatabaseUrl,
    ssl: config.krAnalyticsDatabaseSsl,
    max: config.krDatabasePoolSize,
    connectionTimeoutMs: 3000,
    queryTimeoutMs: 5000
  }, async client => {
    const result = await client.query(
      `
      WITH carrier_rows AS (
        SELECT
          TRIM(carrier_name) AS carrier,
          o.fulfilled_at,
          o.delivered_at,
          o.delivery_status
        FROM kits_republic_orders o
        CROSS JOIN LATERAL unnest(string_to_array(COALESCE(o.shipping_carrier, ''), ',')) AS carrier_names(carrier_name)
        WHERE o.store_id = $1
          AND o.fulfilled_at IS NOT NULL
          AND TRIM(carrier_name) <> ''
          AND COALESCE(LOWER(o.raw_json->>'test'), 'false') <> 'true'
          AND LOWER(COALESCE(o.customer_name, '')) <> 'test test'
          AND COALESCE(o.financial_status, '') NOT IN ('REFUNDED', 'VOIDED')
      )
      SELECT
        carrier,
        COUNT(*)::int AS fulfilled,
        COUNT(*) FILTER (WHERE delivery_status = 'DELIVERED' OR delivered_at IS NOT NULL)::int AS delivered,
        ROUND(
          (AVG(EXTRACT(EPOCH FROM (delivered_at - fulfilled_at)) / 86400)
          FILTER (WHERE delivered_at IS NOT NULL AND delivered_at >= fulfilled_at))::numeric,
          1
        )::float AS avg_transit_days,
        ROUND(
          (
            COUNT(*) FILTER (WHERE delivery_status = 'DELIVERED' OR delivered_at IS NOT NULL)::numeric
            / NULLIF(COUNT(*), 0)
            * 100
          ),
          1
        )::float AS delivered_pct
      FROM carrier_rows
      GROUP BY carrier
      `,
      [config.krAnalyticsStoreId || 'kits_republic']
    );

    return result.rows.find(row => normalizeCarrierName(row.carrier) === normalizedTarget) || null;
  });
}

function carrierFromOrder(order = {}) {
  const fulfillment = summaryFulfillment(order);
  const tracking = Array.isArray(fulfillment?.tracking) ? fulfillment.tracking : [];
  return tracking.find(item => item?.company)?.company || '';
}

function summaryFulfillment(order = {}) {
  const fulfillments = Array.isArray(order.fulfillments) ? order.fulfillments : [];
  return fulfillments.find(fulfillment => {
    return Array.isArray(fulfillment.tracking) && fulfillment.tracking.some(item => item?.number || item?.url);
  }) || fulfillments[0] || null;
}

function estimateConfidence({ deliveredCount, deliveredPct }) {
  if (deliveredCount >= 50 && deliveredPct >= 70) return 'high';
  return 'medium';
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function daysBetween(start, end) {
  return Math.max(0, (end.getTime() - start.getTime()) / 86400000);
}

function roundDays(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round(number * 10) / 10;
}
