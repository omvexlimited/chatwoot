import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDeliveryTimingGuidance } from '../src/delivery-guidance.js';

test('classifies reliable carrier estimate near recent average', () => {
  const guidance = buildDeliveryTimingGuidance({
    available: true,
    carrier: 'Royal Mail',
    avg_transit_days: 6.2,
    days_since_fulfillment: 5.4,
    estimated_remaining_days: 0.8,
    confidence: 'medium'
  });

  assert.equal(guidance.usable, true);
  assert.equal(guidance.tone, 'near_average');
  assert.match(guidance.customer_guidance, /updates around this point after dispatch/);
  assert.match(guidance.customer_guidance, /tracking should update soon/);
  assert.equal(guidance.internal_only_exact_values, true);
});

test('classifies reliable carrier estimate over recent average', () => {
  const guidance = buildDeliveryTimingGuidance({
    available: true,
    carrier: 'Royal Mail',
    avg_transit_days: 6.2,
    days_since_fulfillment: 7.1,
    estimated_remaining_days: 0,
    confidence: 'high'
  });

  assert.equal(guidance.usable, true);
  assert.equal(guidance.tone, 'over_average');
  assert.match(guidance.customer_guidance, /taking a little longer than our recent Royal Mail average/);
});

test('classifies reliable carrier estimate as early when there is still margin', () => {
  const guidance = buildDeliveryTimingGuidance({
    available: true,
    carrier: 'CTT Express',
    avg_transit_days: 10.7,
    days_since_fulfillment: 4.1,
    estimated_remaining_days: 6.6,
    confidence: 'medium'
  });

  assert.equal(guidance.usable, true);
  assert.equal(guidance.tone, 'early');
  assert.match(guidance.customer_guidance, /usual recent timing we see for CTT Express/);
});

test('does not expose delivery guidance for low confidence estimates', () => {
  const guidance = buildDeliveryTimingGuidance({
    available: true,
    carrier: 'Royal Mail',
    avg_transit_days: 6.2,
    days_since_fulfillment: 5.4,
    estimated_remaining_days: 0.8,
    confidence: 'low'
  });

  assert.equal(guidance.usable, false);
  assert.equal(guidance.tone, 'unusable');
});
