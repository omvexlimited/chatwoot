import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enforceDraftRequirements } from '../src/draft-rules.js';

test('adds public tracking link after greeting for customs pending drafts', () => {
  const draft = [
    'Hi,',
    '',
    'The parcel is going through customs clearance.',
    '',
    'Kind regards,',
    'www.kitsrepublic.com'
  ].join('\n');

  const result = enforceDraftRequirements({
    draft,
    supportCase: { type: 'customs_pending', confidence: 'medium', reasons: [] },
    shopifyContext: {
      selected_order: {
        fulfillments: [
          {
            tracking_numbers: ['0141605773793172'],
            tracking: [{ number: '0141605773793172' }]
          }
        ]
      }
    }
  });

  assert.match(result, /The tracking number is correct\./);
  assert.match(result, /https:\/\/kitsrepublic\.com\/apps\/17TRACK\?nums=0141605773793172/);
  assert.ok(result.indexOf('You can follow the shipment here:') < result.indexOf('The parcel is going through customs clearance.'));
  assert.doesNotMatch(result, /shipping-policy/);
  assert.match(result, /www\.kitsrepublic\.com$/);
});

test('does not alter non-customs drafts', () => {
  const draft = 'Hi,\n\nThanks.\n\nwww.kitsrepublic.com';

  assert.equal(enforceDraftRequirements({ draft, supportCase: null }), draft);
});

test('adds public tracking link when a non-customs draft only includes the tracking number', () => {
  const draft = [
    'Hi,',
    '',
    'Your tracking number is 0141605773793172.',
    '',
    'Kind regards,',
    'www.kitsrepublic.com'
  ].join('\n');

  const result = enforceDraftRequirements({
    draft,
    supportCase: null,
    shopifyContext: {
      selected_order: {
        fulfillments: [
          {
            tracking_numbers: ['0141605773793172'],
            tracking: [{ number: '0141605773793172' }]
          }
        ]
      }
    }
  });

  assert.match(result, /You can follow the shipment here:/);
  assert.match(result, /https:\/\/kitsrepublic\.com\/apps\/17TRACK\?nums=0141605773793172/);
});

test('adds shipping policy link when delivery times are mentioned', () => {
  const draft = [
    'Hola,',
    '',
    'El plazo de entrega es de 7-15 días desde la compra.',
    '',
    'Un saludo,',
    'www.kitsrepublic.com'
  ].join('\n');

  const result = enforceDraftRequirements({
    draft,
    responseLanguage: { language: 'Spanish' }
  });

  assert.match(result, /Política de envíos:/);
  assert.match(result, /https:\/\/kitsrepublic\.com\/policies\/shipping-policy/);
  assert.ok(result.indexOf('https://kitsrepublic.com/policies/shipping-policy') < result.indexOf('www.kitsrepublic.com'));
});

test('adds refund policy link when returns or exchanges are mentioned', () => {
  const draft = [
    'Hi,',
    '',
    'For a size exchange, return shipping is paid by the customer.',
    '',
    'Kind regards,',
    'www.kitsrepublic.com'
  ].join('\n');

  const result = enforceDraftRequirements({ draft });

  assert.match(result, /Refund policy:/);
  assert.match(result, /https:\/\/kitsrepublic\.com\/policies\/refund-policy/);
});

test('replaces Shopify 17track proxy URL in customs drafts', () => {
  const draft = [
    'Hi,',
    '',
    'You can follow the shipment here:',
    '',
    'https://shopify.17track.net/app-api/tracking-page/proxy?data=abc123',
    '',
    'Kind regards,',
    'www.kitsrepublic.com'
  ].join('\n');

  const result = enforceDraftRequirements({
    draft,
    supportCase: { type: 'customs_pending', confidence: 'high', reasons: [] },
    shopifyContext: {
      selected_order: {
        fulfillments: [
          {
            tracking_numbers: ['0141605773793172'],
            tracking: [{ number: '0141605773793172' }]
          }
        ]
      }
    }
  });

  assert.doesNotMatch(result, /shopify\.17track\.net/);
  assert.match(result, /https:\/\/kitsrepublic\.com\/apps\/17TRACK\?nums=0141605773793172/);
});

test('adds correct tracking sentence in Spanish when public link already exists', () => {
  const draft = [
    'Hola Francisco,',
    '',
    'Puedes consultar el envio aqui: https://kitsrepublic.com/apps/17TRACK?nums=0141605773793172',
    '',
    'El paquete esta en aduanas.',
    '',
    'Un saludo,',
    'www.kitsrepublic.com'
  ].join('\n');

  const result = enforceDraftRequirements({
    draft,
    responseLanguage: { language: 'Spanish' },
    supportCase: { type: 'customs_pending', confidence: 'medium', reasons: [] },
    shopifyContext: {
      selected_order: {
        fulfillments: [
          {
            tracking_numbers: ['0141605773793172'],
            tracking: [{ number: '0141605773793172' }]
          }
        ]
      }
    }
  });

  assert.match(result, /El número de seguimiento es correcto\./);
  assert.equal((result.match(/kitsrepublic\.com\/apps\/17TRACK/g) || []).length, 1);
});

test('cleans duplicate tracking links, misplaced shipping policy, and cramped signature', () => {
  const draft = [
    'Hi Hugo,',
    '',
    'You can follow the shipment here:',
    '',
    'https://kitsrepublic.com/apps/17TRACK?nums=6A06464537496',
    '',
    'Your order #1404 has already been shipped and is currently going through customs/pre-entry processing before being handed over to Colissimo.',
    '',
    'At this stage, tracking can stay unchanged for a few days because the local carrier may have the shipment details before physically receiving the parcel. Customs are also experiencing higher volume than usual due to the World Cup, so some shipments are taking a little longer, but your order is still within our usual delivery timeframe of 7–15 days from purchase.',
    '',
    'You can follow the shipment here:https://www.17track.net/en/track?nums=6A06464537496',
    '',
    'Shipping policy:https://kitsrepublic.com/policies/shipping-policy',
    '',
    'Once customs/pre-entry processing is complete and the parcel is handed to Colissimo, tracking will update automatically and delivery usually follows soon after.',
    '',
    'Best regards,www.kitsrepublic.com'
  ].join('\n');

  const result = enforceDraftRequirements({
    draft,
    responseLanguage: { language: 'English' },
    supportCase: { type: 'customs_pending', confidence: 'medium', reasons: [] },
    shopifyContext: {
      selected_order: {
        fulfillments: [
          {
            tracking_numbers: ['6A06464537496'],
            tracking: [{ number: '6A06464537496' }]
          }
        ]
      }
    }
  });

  assert.equal((result.match(/kitsrepublic\.com\/apps\/17TRACK/g) || []).length, 1);
  assert.doesNotMatch(result, /www\.17track\.net/);
  assert.match(result, /Shipping policy:\n\nhttps:\/\/kitsrepublic\.com\/policies\/shipping-policy/);
  assert.equal((result.match(/kitsrepublic\.com\/policies\/shipping-policy/g) || []).length, 1);
  assert.ok(
    result.indexOf('usual delivery timeframe of 7–15 days from purchase.') <
      result.indexOf('Shipping policy:')
  );
  assert.ok(
    result.indexOf('Shipping policy:') <
      result.indexOf('Once customs/pre-entry processing is complete')
  );
  assert.match(result, /Best regards,\n\nwww\.kitsrepublic\.com$/);
});

test('removes Royal Mail tracking links and redundant tracking number lines', () => {
  const draft = [
    'Hi Chris,',
    '',
    'You can follow the shipment here:',
    '',
    'https://kitsrepublic.com/apps/17TRACK?nums=GV501788296GB',
    '',
    'We’ve checked your delivery and the latest tracking status is: Shipment Announced.',
    '',
    'Tracking number: GV501788296GB',
    '',
    'Track your parcel here:',
    '',
    'https://www.royalmail.com/track-your-item#/tracking-results/GV501788296GB',
    '',
    'This means the shipping label and parcel details have been created, but Royal Mail may not yet have fully received the parcel into their network.',
    '',
    'Best regards,',
    '',
    'www.kitsrepublic.com'
  ].join('\n');

  const result = enforceDraftRequirements({
    draft,
    responseLanguage: { language: 'English' },
    shopifyContext: {
      selected_order: {
        fulfillments: [
          {
            tracking_numbers: ['GV501788296GB'],
            tracking: [{ number: 'GV501788296GB' }]
          }
        ]
      }
    }
  });

  assert.equal((result.match(/kitsrepublic\.com\/apps\/17TRACK/g) || []).length, 1);
  assert.doesNotMatch(result, /royalmail\.com/);
  assert.doesNotMatch(result, /^Tracking number:/m);
  assert.doesNotMatch(result, /Track your parcel here:/);
  assert.match(result, /Best regards,\n\nwww\.kitsrepublic\.com$/);
});

test('replaces carrier-only tracking links with the Kits Republic tracking link', () => {
  const draft = [
    'Hi,',
    '',
    'Track your parcel here:',
    '',
    'https://www.royalmail.com/track-your-item#/tracking-results/GV501788296GB',
    '',
    'Best regards,',
    'www.kitsrepublic.com'
  ].join('\n');

  const result = enforceDraftRequirements({
    draft,
    responseLanguage: { language: 'English' },
    shopifyContext: {
      selected_order: {
        fulfillments: [
          {
            tracking_numbers: ['GV501788296GB'],
            tracking: [{ number: 'GV501788296GB' }]
          }
        ]
      }
    }
  });

  assert.match(result, /https:\/\/kitsrepublic\.com\/apps\/17TRACK\?nums=GV501788296GB/);
  assert.equal((result.match(/kitsrepublic\.com\/apps\/17TRACK/g) || []).length, 1);
  assert.doesNotMatch(result, /royalmail\.com/);
});

test('removes duplicate Kits Republic tracking route links', () => {
  const draft = [
    'Hi Jack,',
    '',
    'You can follow the shipment here:',
    '',
    'https://kitsrepublic.com/apps/17TRACK?nums=GV129857971GB',
    '',
    'The tracking has not updated yet because the parcel is in customs clearance.',
    '',
    'You can follow it here:',
    '',
    'https://kitsrepublic.com/tracking/GV129857971GB',
    '',
    'Best,',
    'www.kitsrepublic.com'
  ].join('\n');

  const result = enforceDraftRequirements({
    draft,
    responseLanguage: { language: 'English' },
    supportCase: { type: 'customs_pending', confidence: 'medium', reasons: [] },
    shopifyContext: {
      selected_order: {
        fulfillments: [
          {
            tracking_numbers: ['GV129857971GB'],
            tracking: [{ company: 'Royal Mail', number: 'GV129857971GB' }]
          }
        ]
      }
    }
  });

  assert.equal((result.match(/kitsrepublic\.com\/apps\/17TRACK/g) || []).length, 1);
  assert.doesNotMatch(result, /kitsrepublic\.com\/tracking/);
  assert.doesNotMatch(result, /You can follow it here:/);
});
