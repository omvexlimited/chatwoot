import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildDeliveryEstimateContext,
  normalizeCarrierName
} from '../src/delivery-estimates.js';

test('normalizes frequent carrier names', () => {
  assert.equal(normalizeCarrierName('Royal Mail Tracked'), 'royal mail');
  assert.equal(normalizeCarrierName('CTT Express'), 'ctt express');
  assert.equal(normalizeCarrierName('DHL eCommerce'), 'dhl');
  assert.equal(normalizeCarrierName('Colissimo FR'), 'colissimo');
});

test('builds delivery estimate with remaining days from carrier average', () => {
  const estimate = buildDeliveryEstimateContext({
    carrier: 'Royal Mail',
    fulfilledAt: '2026-06-10T12:00:00Z',
    now: new Date('2026-06-14T00:00:00Z'),
    stats: {
      carrier: 'Royal Mail',
      fulfilled: 681,
      delivered: 590,
      avg_transit_days: 6.2,
      delivered_pct: 86.6
    }
  });

  assert.equal(estimate.available, true);
  assert.equal(estimate.carrier, 'Royal Mail');
  assert.equal(estimate.avg_transit_days, 6.2);
  assert.equal(estimate.sample_size, 590);
  assert.equal(estimate.days_since_fulfillment, 3.5);
  assert.equal(estimate.estimated_remaining_days, 2.7);
  assert.equal(estimate.confidence, 'high');
  assert.equal(estimate.reason, 'recent_average');
});

test('marks shipment over recent average without promising same-day delivery', () => {
  const estimate = buildDeliveryEstimateContext({
    carrier: 'CTT Express',
    fulfilledAt: '2026-06-01T00:00:00Z',
    now: new Date('2026-06-14T00:00:00Z'),
    stats: {
      carrier: 'CTT Express',
      fulfilled: 364,
      delivered: 250,
      avg_transit_days: 10.7,
      delivered_pct: 68.7
    }
  });

  assert.equal(estimate.available, true);
  assert.equal(estimate.estimated_remaining_days, 0);
  assert.equal(estimate.reason, 'over_recent_average');
  assert.equal(estimate.confidence, 'medium');
});

test('does not expose estimate when carrier sample is too small', () => {
  const estimate = buildDeliveryEstimateContext({
    carrier: 'UniUni',
    fulfilledAt: '2026-06-10T12:00:00Z',
    now: new Date('2026-06-14T00:00:00Z'),
    stats: {
      carrier: 'UniUni',
      fulfilled: 10,
      delivered: 4,
      avg_transit_days: 8.3,
      delivered_pct: 40
    }
  });

  assert.equal(estimate.available, false);
  assert.equal(estimate.reason, 'insufficient_sample');
  assert.equal(estimate.avg_transit_days, 8.3);
  assert.equal(estimate.estimated_remaining_days, null);
});

test('uses actual transit time for delivered orders', () => {
  const estimate = buildDeliveryEstimateContext({
    carrier: 'Colissimo',
    fulfilledAt: '2026-06-01T00:00:00Z',
    deliveredAt: '2026-06-10T12:00:00Z',
    now: new Date('2026-06-14T00:00:00Z'),
    stats: {
      carrier: 'Colissimo',
      fulfilled: 112,
      delivered: 80,
      avg_transit_days: 11.6,
      delivered_pct: 71.4
    }
  });

  assert.equal(estimate.available, true);
  assert.equal(estimate.days_since_fulfillment, 9.5);
  assert.equal(estimate.estimated_remaining_days, 0);
  assert.equal(estimate.reason, 'already_delivered');
});
