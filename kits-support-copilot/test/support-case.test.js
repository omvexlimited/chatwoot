import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyForcedSupportCase, detectSupportCase, normalizeSupportCaseType, SUPPORT_CASE_TYPES } from '../src/support-case.js';

test('detects Spain CTT pending receipt as customs pending', () => {
  const supportCase = detectSupportCase({
    latestMessage: 'Hola, mi pedido no ha llegado.',
    conversationText: 'Pending receipt at CTT Express. We already have all the details of your shipment.',
    shopifyContext: shopifyContext({
      countryCode: 'ES',
      carrier: 'CTT Express',
      inTransitAt: null
    })
  });

  assert.equal(supportCase.type, 'customs_pending');
  assert.equal(supportCase.confidence, 'high');
  assert.ok(supportCase.reasons.includes('customs_tracking_phrase'));
});

test('detects CTT network-entry wording as customs pending', () => {
  const supportCase = detectSupportCase({
    latestMessage: 'Hola, mi tracking sigue igual.',
    conversationText: 'Pendiente de entrada en red.',
    shopifyContext: shopifyContext({
      countryCode: 'ES',
      carrier: 'CTT Express',
      inTransitAt: null
    })
  });

  assert.equal(supportCase.type, 'customs_pending');
  assert.equal(supportCase.confidence, 'high');
  assert.ok(supportCase.reasons.includes('customs_tracking_phrase'));
});

test('detects UK Royal Mail expecting parcel as customs pending', () => {
  const supportCase = detectSupportCase({
    latestMessage: 'Where is my order? It has not arrived.',
    conversationText: 'Royal Mail expecting parcel.',
    shopifyContext: shopifyContext({
      countryCode: 'GB',
      carrier: 'Royal Mail',
      inTransitAt: null
    })
  });

  assert.equal(supportCase.type, 'customs_pending');
  assert.equal(supportCase.confidence, 'high');
});

test('detects no tracking updates with Royal Mail as customs pending', () => {
  const supportCase = detectSupportCase({
    latestMessage: 'Hi, there have been no updates on my tracking for days.',
    conversationText: '',
    shopifyContext: shopifyContext({
      countryCode: 'GB',
      carrier: 'Royal Mail',
      trackingNumber: 'GV129857971GB',
      inTransitAt: null,
      displayStatus: 'CONFIRMED'
    })
  });

  assert.equal(supportCase.type, 'customs_pending');
  assert.equal(supportCase.confidence, 'medium');
  assert.ok(supportCase.reasons.includes('customer_waiting_or_delay_question'));
  assert.ok(supportCase.reasons.includes('local_handoff_carrier:Royal Mail'));
});

test('does not detect customs when fulfillment is delivered', () => {
  const supportCase = detectSupportCase({
    latestMessage: 'Where is my order?',
    conversationText: 'Pending receipt at CTT Express.',
    shopifyContext: shopifyContext({
      carrier: 'CTT Express',
      deliveredAt: '2026-06-10T12:00:00Z',
      displayStatus: 'DELIVERED'
    })
  });

  assert.equal(supportCase, null);
});

test('uses order update case instead of customs when there is no tracking', () => {
  const context = shopifyContext({ carrier: null, trackingNumber: null });
  const supportCase = detectSupportCase({
    latestMessage: 'Hola, aun no ha llegado el pedido.',
    conversationText: 'Pending receipt at CTT Express.',
    shopifyContext: context
  });

  assert.equal(supportCase.type, 'order_update');
  assert.ok(supportCase.reasons.includes('selected_order_without_tracking'));
});

test('detects missing and ambiguous order lookups', () => {
  const noOrder = detectSupportCase({
    latestMessage: 'Where is my order?',
    shopifyContext: { selected_order: null, orders: [] }
  });
  assert.equal(noOrder.type, 'no_order_found');

  const multipleOrders = detectSupportCase({
    latestMessage: 'Where is my order?',
    shopifyContext: { selected_order: null, orders: [{ name: '#1' }, { name: '#2' }] }
  });
  assert.equal(multipleOrders.type, 'multiple_orders');
});

test('detects delay question with fulfilled local-carrier tracking as medium confidence', () => {
  const supportCase = detectSupportCase({
    latestMessage: 'Hola, hice un pedido el 1 de junio y aun no ha llegado, pedido #1421.',
    conversationText: '',
    shopifyContext: shopifyContext({
      name: '#1421',
      countryCode: 'ES',
      carrier: 'CTT Express',
      inTransitAt: null
    })
  });

  assert.equal(supportCase.type, 'customs_pending');
  assert.equal(supportCase.confidence, 'medium');
  assert.ok(supportCase.reasons.includes('customer_waiting_or_delay_question'));
});

test('detects failed delivery attempt from provider tracking', () => {
  const supportCase = detectSupportCase({
    latestMessage: 'Royal Mail says there was a delivery attempt.',
    conversationText: '',
    providerTrackingContext: {
      available: true,
      last_record: 'Delivery Attempt Failed',
      normalized_status: 'delivery_attempt_failed'
    },
    shopifyContext: shopifyContext({
      carrier: 'Royal Mail',
      trackingNumber: 'GV548675650GB',
      displayStatus: 'OUT_FOR_DELIVERY',
      inTransitAt: '2026-06-27T08:26:10Z'
    })
  });

  assert.equal(supportCase.type, 'failed_delivery_attempt');
  assert.equal(supportCase.confidence, 'high');
});

test('detects delivered not found when customer disputes delivered status', () => {
  const supportCase = detectSupportCase({
    latestMessage: 'It says delivered but I have not received the parcel.',
    conversationText: '',
    shopifyContext: shopifyContext({
      carrier: 'Royal Mail',
      trackingNumber: 'GV499951597GB',
      deliveredAt: '2026-06-09T12:00:00Z',
      displayStatus: 'DELIVERED'
    })
  });

  assert.equal(supportCase.type, 'delivered_not_found');
  assert.equal(supportCase.confidence, 'high');
});

test('detects return request without requiring selected logistics state', () => {
  const supportCase = detectSupportCase({
    latestMessage: 'I want to return my jersey.',
    conversationText: '',
    shopifyContext: shopifyContext()
  });

  assert.equal(supportCase.type, 'return_request');
});

test('detects wrong item report', () => {
  const supportCase = detectSupportCase({
    latestMessage: 'I received the wrong jersey.',
    conversationText: '',
    shopifyContext: shopifyContext()
  });

  assert.equal(supportCase.type, 'wrong_item');
});

test('detects product mismatch report', () => {
  const supportCase = detectSupportCase({
    latestMessage: 'The front is different from the photo on the website.',
    conversationText: '',
    shopifyContext: shopifyContext()
  });

  assert.equal(supportCase.type, 'product_mismatch');
});

test('detects invoice request', () => {
  const supportCase = detectSupportCase({
    latestMessage: 'Can you send me an invoice for my order?',
    conversationText: '',
    shopifyContext: shopifyContext()
  });

  assert.equal(supportCase.type, 'invoice_request');
});

test('detects duplicate thread signal', () => {
  const supportCase = detectSupportCase({
    latestMessage: 'This is a duplicate, we already answered in the other thread.',
    conversationText: '',
    shopifyContext: shopifyContext()
  });

  assert.equal(supportCase.type, 'duplicate_thread');
});

test('detects open supplier issue when no stronger customer case is present', () => {
  const supportCase = detectSupportCase({
    latestMessage: 'Any update?',
    conversationText: '',
    shopifyContext: shopifyContext(),
    issueContext: {
      available: true,
      total: 1,
      issues: [{ issue_id: 22, status: 'open', issue_type: 'stock' }]
    }
  });

  assert.equal(supportCase.type, 'supplier_issue_open');
});

test('normalizes known support case types for forced overrides', () => {
  assert.ok(SUPPORT_CASE_TYPES.includes('return_request'));
  assert.equal(normalizeSupportCaseType('return_request'), 'return_request');
  assert.equal(normalizeSupportCaseType('return request'), '');
  assert.equal(normalizeSupportCaseType('nonsense'), '');
});

test('applies forced support case while preserving detected case metadata', () => {
  const detectedSupportCase = {
    type: 'refund_request',
    confidence: 'high',
    reasons: ['customer_requests_refund']
  };
  const supportCase = applyForcedSupportCase({
    detectedSupportCase,
    forcedSupportCaseType: 'return_request'
  });

  assert.equal(supportCase.type, 'return_request');
  assert.equal(supportCase.confidence, 'high');
  assert.equal(supportCase.forced, true);
  assert.equal(supportCase.detected_type, 'refund_request');
  assert.deepEqual(supportCase.reasons, ['agent_forced_case', 'detected_case:refund_request']);
});

test('ignores invalid forced support case types', () => {
  const detectedSupportCase = {
    type: 'refund_request',
    confidence: 'high',
    reasons: ['customer_requests_refund']
  };

  assert.equal(applyForcedSupportCase({ detectedSupportCase, forcedSupportCaseType: 'nonsense' }), detectedSupportCase);
});

function shopifyContext({
  name = '#1421',
  countryCode = 'ES',
  carrier = 'CTT Express',
  trackingNumber = 'KR123456789',
  deliveredAt = null,
  displayStatus = 'FULFILLED',
  inTransitAt = null
} = {}) {
  return {
    selected_order: {
      name,
      fulfillment_status: 'FULFILLED',
      shipping_address: {
        country_code: countryCode
      },
      fulfillments: [
        {
          created_at: '2026-06-03T07:46:00Z',
          delivered_at: deliveredAt,
          display_status: displayStatus,
          in_transit_at: inTransitAt,
          tracking_numbers: trackingNumber ? [trackingNumber] : [],
          tracking: trackingNumber
            ? [{ company: carrier, number: trackingNumber, url: 'https://tracking.example.test' }]
            : []
        }
      ]
    }
  };
}
