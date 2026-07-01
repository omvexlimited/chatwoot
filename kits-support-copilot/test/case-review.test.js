import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCaseReview, withCaseReviewDraft } from '../src/case-review.js';

test('builds case review with verified facts and after-send action', () => {
  const review = buildCaseReview({
    supportCase: {
      type: 'failed_delivery_attempt',
      confidence: 'high',
      reasons: ['carrier_delivery_attempt_failed']
    },
    latestMessage: 'Royal Mail says delivery failed.',
    shopifyContext: {
      selected_order: {
        name: '#3227',
        fulfillment_status: 'FULFILLED',
        fulfillments: [
          {
            display_status: 'OUT_FOR_DELIVERY',
            tracking_numbers: ['GV548675650GB'],
            tracking: [{ company: 'Royal Mail', number: 'GV548675650GB' }]
          }
        ]
      },
      selection_reason: 'Matched explicit order #3227.'
    },
    providerTrackingContext: {
      available: true,
      last_update_at: '2026-06-27 13:59:59',
      last_record: 'Delivery Attempt Failed'
    }
  });

  assert.equal(review.detected_case, 'failed_delivery_attempt');
  assert.equal(review.after_send_action, 'leave_open');
  assert.match(review.recommended_decision, /carrier attempted delivery/i);
  assert.ok(review.verified_facts.some(fact => fact.includes('GV548675650GB')));

  const withDraft = withCaseReviewDraft(review, 'Hi, please contact Royal Mail.');
  assert.equal(withDraft.proposed_reply, 'Hi, please contact Royal Mail.');
});
