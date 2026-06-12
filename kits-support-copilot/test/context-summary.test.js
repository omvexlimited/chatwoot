import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildContextView } from '../public/context-summary.js';

test('builds context summary with tracking link and customs case', () => {
  const view = buildContextView(contextResult());
  const tracking = view.cards.find(card => card.title === 'Tracking');
  const order = view.cards.find(card => card.title === 'Order');
  const items = view.cards.find(card => card.title === 'Items');
  const supportCase = view.cards.find(card => card.title === 'Case');

  assert.equal(view.topBar.order, '#1421 | 01 Jun 2026 | FULFILLED');
  assert.equal(view.topBar.case, 'customs_pending');
  assert.equal(view.topBar.warnings, '1');
  assert.deepEqual(order.rows.map(row => row.value), ['#1421', '01 Jun 2026', 'Mign Jin (1) · 194939', '03 Jun 2026', 'FULFILLED', 'FULFILLED']);
  assert.equal(order.rows.find(row => row.label === 'Order').url, 'https://web-production-c1320.up.railway.app/kits-republic/orders?q=%231421');
  assert.deepEqual(order.rows.find(row => row.label === 'Order').links, [
    {
      label: 'Shopify',
      url: 'https://kits-republic.myshopify.com/admin/orders/1234567890'
    }
  ]);
  assert.equal(items.items.length, 1);
  assert.equal(items.items[0].title, '1x Spain 2010 Home Jersey');
  assert.equal(items.items[0].meta, 'SKU ES-2010-HOME-L | UNFULFILLED');
  assert.equal(items.items[0].personalization, 'Name: DAVID VILLA | Number: 7');
  assert.equal(tracking.action.url, 'https://tracking.example.test/');
  assert.deepEqual(tracking.rows.map(row => row.value), ['CTT Express', 'KR123', 'FULFILLED']);
  assert.equal(supportCase.emphasis, true);
  assert.match(supportCase.rows.find(row => row.label === 'Reasons').value, /tracking_present/);
});

test('builds context summary without broken tracking action', () => {
  const result = contextResult({
    trackingNumber: null,
    trackingUrl: null,
    trackingCarrier: null
  });
  const view = buildContextView(result);
  const tracking = view.cards.find(card => card.title === 'Tracking');

  assert.equal(tracking.action, null);
  assert.deepEqual(tracking.rows.map(row => row.value), ['No tracking yet', 'No tracking yet', 'FULFILLED']);
});

test('shows carrier delivery estimate in tracking card when available', () => {
  const view = buildContextView(contextResult({
    deliveryEstimate: {
      available: true,
      carrier: 'CTT Express',
      avg_transit_days: 10.7,
      delivered_pct: 82.1,
      sample_size: 299,
      fulfilled_count: 364,
      delivered_count: 299,
      fulfilled_at: '2026-06-03T10:00:00Z',
      delivered_at: null,
      days_since_fulfillment: 4.2,
      estimated_remaining_days: 6.5,
      confidence: 'high',
      reason: 'recent_average'
    }
  }));
  const tracking = view.cards.find(card => card.title === 'Tracking');

  assert.deepEqual(tracking.rows.map(row => row.label), [
    'Carrier',
    'Number',
    'Status',
    'Avg transit',
    'Elapsed since fulfillment',
    'Estimated remaining',
    'Estimate confidence'
  ]);
  assert.deepEqual(tracking.rows.map(row => row.value), [
    'CTT Express',
    'KR123',
    'FULFILLED',
    '10.7 days',
    '4.2 days',
    '~6.5 days',
    'high'
  ]);
  assert.equal(view.rawPayload.delivery_estimate_context.available, true);
});

test('shows actual transit time for delivered estimate without remaining days', () => {
  const view = buildContextView(contextResult({
    deliveryEstimate: {
      available: true,
      carrier: 'Royal Mail',
      avg_transit_days: 6.2,
      sample_size: 590,
      fulfilled_at: '2026-06-03T10:00:00Z',
      delivered_at: '2026-06-09T10:00:00Z',
      days_since_fulfillment: 6,
      estimated_remaining_days: 0,
      confidence: 'high',
      reason: 'already_delivered'
    }
  }));
  const tracking = view.cards.find(card => card.title === 'Tracking');

  assert.equal(tracking.rows.find(row => row.label === 'Transit time').value, '6 days');
  assert.equal(tracking.rows.some(row => row.label === 'Estimated remaining'), false);
});

test('keeps raw context payload for debugging', () => {
  const view = buildContextView(contextResult());

  assert.equal(view.rawPayload.context_summary.order, '#1421');
  assert.equal(view.rawPayload.support_case.type, 'customs_pending');
  assert.deepEqual(view.rawPayload.warnings, ['Multiple orders matched.']);
});

test('builds order candidate card for multiple Shopify orders', () => {
  const view = buildContextView(contextResult({
    orderCandidates: [
      {
        order: '#1111',
        date: '2026-06-01T10:00:00Z',
        shopify_status: 'FULFILLED',
        provider: 'Mign Jin (1)',
        shipment_status: 'CONFIRMED',
        country: 'Spain',
        country_code: 'ES',
        tracking_carrier: 'CTT Express',
        tracking_number: 'KR111',
        shopify_admin_url: 'https://kits-republic.myshopify.com/admin/orders/1111',
        selected: false
      },
      {
        order: '#2222',
        date: '2026-06-05T10:00:00Z',
        shopify_status: 'UNFULFILLED',
        shipment_status: null,
        country: 'France',
        country_code: 'FR',
        tracking_carrier: null,
        tracking_number: null,
        selected: true
      }
    ]
  }));
  const orders = view.cards.find(card => card.title === 'Orders');

  assert.equal(orders.orders.length, 2);
  assert.equal(orders.orders[0].date, '01 Jun 2026');
  assert.equal(orders.orders[0].provider, 'Mign Jin (1)');
  assert.equal(orders.orders[0].country, 'Spain / ES');
  assert.equal(orders.orders[0].shopify_admin_url, 'https://kits-republic.myshopify.com/admin/orders/1111');
  assert.equal(orders.orders[1].selected, true);
  assert.equal(orders.emphasis, false);
});

function contextResult({
  trackingNumber = 'KR123',
  trackingUrl = 'https://tracking.example.test',
  trackingCarrier = 'CTT Express',
  deliveryEstimate = null,
  orderCandidates = []
} = {}) {
  return {
    contact_email: 'customer@example.com',
    response_language: {
      language: 'Spanish',
      source: 'shipping_country',
      country_code: 'ES'
    },
    support_case: {
      type: 'customs_pending',
      confidence: 'medium',
      reasons: ['tracking_present', 'no_in_transit_timestamp']
    },
    warnings: ['Multiple orders matched.'],
    context_summary: {
      customer: 'customer@example.com',
      order: '#1421',
      admin_order_url: 'https://web-production-c1320.up.railway.app/kits-republic/orders?q=%231421',
      shopify_admin_url: 'https://kits-republic.myshopify.com/admin/orders/1234567890',
      order_created_at: '2026-06-01T10:00:00Z',
      provider: 'Mign Jin (1) · 194939',
      provider_source: 'kits_republic_orders',
      provider_name: 'Mign Jin (1)',
      provider_code: '194939',
      line_items: [
        {
          name: 'Spain 2010 Home Jersey',
          quantity: 1,
          sku: 'ES-2010-HOME-L',
          fulfillment_status: 'UNFULFILLED',
          custom_attributes: [
            { key: 'Name', value: 'DAVID VILLA' },
            { key: 'Number', value: '7' }
          ]
        }
      ],
      fulfillment_created_at: '2026-06-03T10:00:00Z',
      fulfillment_status: 'FULFILLED',
      shipment_status: 'FULFILLED',
      tracking_carrier: trackingCarrier,
      tracking_number: trackingNumber,
      tracking_url: trackingUrl,
      delivery_estimate_context: deliveryEstimate,
      shipping_country: 'Spain',
      shipping_country_code: 'ES',
      order_candidates: orderCandidates
    },
    shopify_context: {
      selected_order: {
        name: '#1421',
        fulfillment_status: 'FULFILLED',
        fulfillments: []
      }
    }
  };
}
