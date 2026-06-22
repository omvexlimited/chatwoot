import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectSupportCase } from '../src/support-case.js';

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

test('does not detect customs when there is no tracking', () => {
  const context = shopifyContext({ carrier: null, trackingNumber: null });
  const supportCase = detectSupportCase({
    latestMessage: 'Hola, aun no ha llegado el pedido.',
    conversationText: 'Pending receipt at CTT Express.',
    shopifyContext: context
  });

  assert.equal(supportCase, null);
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
