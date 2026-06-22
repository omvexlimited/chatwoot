import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enforceDraftRequirements } from '../src/draft-rules.js';

test('adds public tracking link near sign-off for customs pending drafts', () => {
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
  assert.match(result, /Thank you for your email\./);
  assert.match(result, /https:\/\/kitsrepublic\.com\/apps\/17TRACK\?nums=0141605773793172/);
  assert.ok(result.indexOf('The parcel is going through customs clearance.') < result.indexOf('You can follow the shipment here:'));
  assert.ok(result.indexOf('You can follow the shipment here:') < result.indexOf('Kind regards,'));
  assert.doesNotMatch(result, /shipping-policy/);
  assert.match(result, /www\.kitsrepublic\.com$/);
});

test('does not alter non-customs drafts', () => {
  const draft = 'Hi,\n\nThanks.\n\nwww.kitsrepublic.com';

  assert.equal(enforceDraftRequirements({ draft, supportCase: null }), draft);
});

test('removes em dash punctuation from drafts', () => {
  const draft = [
    'Hi,',
    '',
    'Thank you — we will do that.',
    '',
    'Best,',
    'www.kitsrepublic.com'
  ].join('\n');

  const result = enforceDraftRequirements({ draft, responseLanguage: { language: 'English' } });

  assert.doesNotMatch(result, /—/);
  assert.match(result, /Thank you, we will do that\./);
});

test('adds warm opening when the draft does not thank the customer', () => {
  const draft = [
    'Hola,',
    '',
    'Hemos revisado tu pedido.',
    '',
    'Un saludo,',
    'www.kitsrepublic.com'
  ].join('\n');

  const result = enforceDraftRequirements({ draft, responseLanguage: { language: 'Spanish' } });

  assert.match(result, /Hola,\n\nMuchas gracias por tu correo\.\n\nHemos revisado tu pedido\./);
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

test('adds official timeframes and shipping policy for order update questions', () => {
  const draft = [
    'Hi Andrew,',
    '',
    'Thank you for your email. I’ve checked your order #2889, and it is currently being processed.',
    '',
    'Once it ships, you’ll receive an update with the tracking details automatically.',
    '',
    'Best regards,',
    '',
    'www.kitsrepublic.com'
  ].join('\n');

  const result = enforceDraftRequirements({
    draft,
    latestMessage: 'Hi, Looking for an update on where my order is? Regards Andrew',
    responseLanguage: { language: 'English' },
    shopifyContext: {
      selected_order: {
        name: '#2889',
        fulfillment_status: 'UNFULFILLED',
        fulfillments: []
      }
    }
  });

  assert.match(result, /processing time is 1-3 days/i);
  assert.match(result, /delivery normally takes 7-15 days from purchase/i);
  assert.match(result, /Shipping policy:\nhttps:\/\/kitsrepublic\.com\/policies\/shipping-policy/);
  assert.ok(result.indexOf('Shipping policy:') < result.indexOf('Best regards,'));
});

test('removes processing time from fulfilled tracking update questions', () => {
  const draft = [
    'Hi Mark,',
    '',
    'Thank you for your email. We have checked your shipment and it is currently going through customs clearance. This is why the tracking may not show many updates yet.',
    '',
    'Our processing time is 1-3 days, and delivery normally takes 7-15 days from purchase.',
    '',
    'Shipping policy:',
    '',
    'https://kitsrepublic.com/policies/shipping-policy',
    '',
    'You can follow the shipment here:',
    '',
    'https://kitsrepublic.com/apps/17TRACK?nums=GV501324085GB',
    '',
    'Best regards,',
    '',
    'www.kitsrepublic.com'
  ].join('\n');

  const result = enforceDraftRequirements({
    draft,
    latestMessage: 'Hi, any update on where my order is?',
    responseLanguage: { language: 'English' },
    supportCase: { type: 'customs_pending', confidence: 'medium', reasons: ['local_handoff_carrier:Royal Mail'] },
    shopifyContext: {
      selected_order: {
        name: '#1234',
        fulfillment_status: 'FULFILLED',
        fulfillments: [
          {
            display_status: 'FULFILLED',
            tracking_numbers: ['GV501324085GB'],
            tracking: [{ company: 'Royal Mail', number: 'GV501324085GB' }]
          }
        ]
      }
    }
  });

  assert.doesNotMatch(result, /processing time/i);
  assert.match(result, /Delivery normally takes 7-15 days from purchase\./);
  assert.match(result, /Shipping policy:\nhttps:\/\/kitsrepublic\.com\/policies\/shipping-policy/);
  assert.ok(result.indexOf('This is why the tracking may not show many updates yet.') < result.indexOf('Delivery normally takes 7-15 days from purchase.'));
  assert.ok(result.indexOf('You can follow the shipment here:') < result.indexOf('Best regards,'));
});

test('adds delivery-only timeframe for fulfilled order update questions', () => {
  const draft = [
    'Hi Mark,',
    '',
    'Thank you for your email. We have checked your shipment and it is currently going through customs clearance.',
    '',
    'Best regards,',
    '',
    'www.kitsrepublic.com'
  ].join('\n');

  const result = enforceDraftRequirements({
    draft,
    latestMessage: 'Hi, any update on where my order is?',
    responseLanguage: { language: 'English' },
    supportCase: { type: 'customs_pending', confidence: 'medium', reasons: ['local_handoff_carrier:Royal Mail'] },
    shopifyContext: {
      selected_order: {
        name: '#1234',
        fulfillment_status: 'FULFILLED',
        fulfillments: [
          {
            tracking_numbers: ['GV501324085GB'],
            tracking: [{ company: 'Royal Mail', number: 'GV501324085GB' }]
          }
        ]
      }
    }
  });

  assert.doesNotMatch(result, /processing time/i);
  assert.match(result, /Delivery normally takes 7-15 days from purchase\./);
  assert.match(result, /Shipping policy:\nhttps:\/\/kitsrepublic\.com\/policies\/shipping-policy/);
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

test('adds terms privacy and FAQ links when those topics are mentioned', () => {
  const draft = [
    'Hi,',
    '',
    'You can review our terms and conditions before checkout.',
    '',
    'Our privacy policy explains how we handle personal data.',
    '',
    'You can also check the FAQ Help Center for general questions.',
    '',
    'Best regards,',
    'www.kitsrepublic.com'
  ].join('\n');

  const result = enforceDraftRequirements({ draft, responseLanguage: { language: 'English' } });

  assert.match(result, /Terms of service:\nhttps:\/\/kitsrepublic\.com\/policies\/terms-of-service/);
  assert.match(result, /Privacy policy:\nhttps:\/\/kitsrepublic\.com\/policies\/privacy-policy/);
  assert.match(result, /FAQ \/ Help Center:\nhttps:\/\/kitsrepublic\.com\/pages\/faq-help-center/);
});

test('deduplicates manually included terms privacy and FAQ links', () => {
  const draft = [
    'Hi,',
    '',
    'You can review our terms and conditions before checkout.',
    '',
    'Terms of service:https://kitsrepublic.com/policies/terms-of-service',
    '',
    'Our privacy policy explains how we handle personal data.',
    '',
    'Privacy policy:https://kitsrepublic.com/policies/privacy-policy',
    '',
    'Please check our FAQ Help Center too.',
    '',
    'FAQ / Help Center:https://kitsrepublic.com/pages/faq-help-center',
    '',
    'Best regards,',
    'www.kitsrepublic.com'
  ].join('\n');

  const result = enforceDraftRequirements({ draft, responseLanguage: { language: 'English' } });

  assert.equal((result.match(/terms-of-service/g) || []).length, 1);
  assert.equal((result.match(/privacy-policy/g) || []).length, 1);
  assert.equal((result.match(/faq-help-center/g) || []).length, 1);
  assert.doesNotMatch(result, /service:https/);
  assert.doesNotMatch(result, /policy:https/);
  assert.doesNotMatch(result, /Center:https/);
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
  assert.match(result, /Shipping policy:\nhttps:\/\/kitsrepublic\.com\/policies\/shipping-policy/);
  assert.equal((result.match(/kitsrepublic\.com\/policies\/shipping-policy/g) || []).length, 1);
  assert.ok(
    result.indexOf('usual delivery timeframe of 7–15 days from purchase.') <
      result.indexOf('Shipping policy:')
  );
  assert.ok(
    result.indexOf('Shipping policy:') <
      result.indexOf('Once customs/pre-entry processing is complete')
  );
  assert.ok(
    result.indexOf('Once customs/pre-entry processing is complete') <
      result.indexOf('You can follow the shipment here:')
  );
  assert.ok(result.indexOf('You can follow the shipment here:') < result.indexOf('Best regards,'));
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
  assert.ok(result.indexOf('This means the shipping label') < result.indexOf('You can follow the shipment here:'));
  assert.ok(result.indexOf('You can follow the shipment here:') < result.indexOf('Best regards,'));
  assert.match(result, /Best regards,\n\nwww\.kitsrepublic\.com$/);
});

test('removes internal provider tracking portal links from customer drafts', () => {
  const draft = [
    'Hi,',
    '',
    'Thank you for your email.',
    '',
    'Your shipment has cleared customs and is moving to the final delivery provider.',
    '',
    'You can check it here:',
    'http://193.112.141.69:8082/en/trackIndex.htm',
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
            tracking_numbers: ['0082800082809769818715'],
            tracking: [{ number: '0082800082809769818715' }]
          }
        ]
      }
    }
  });

  assert.doesNotMatch(result, /193\.112\.141\.69|119\.91\.41\.88/);
  assert.equal((result.match(/kitsrepublic\.com\/apps\/17TRACK/g) || []).length, 1);
  assert.match(result, /https:\/\/kitsrepublic\.com\/apps\/17TRACK\?nums=0082800082809769818715/);
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

test('removes orphan tracking label after a valid tracking block', () => {
  const draft = [
    'Hi,',
    '',
    'You can follow the shipment here:',
    '',
    'https://kitsrepublic.com/apps/17TRACK?nums=GV501871585GB',
    '',
    'Delivery normally takes around 7-15 days from purchase, and this order is still within the usual recent timing we see for Royal Mail shipments.',
    '',
    'Shipping policy:',
    '',
    'https://kitsrepublic.com/policies/shipping-policy',
    '',
    'You can follow the shipment here:',
    '',
    'Best,',
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
            tracking_numbers: ['GV501871585GB'],
            tracking: [{ company: 'Royal Mail', number: 'GV501871585GB' }]
          }
        ]
      }
    },
    deliveryEstimateContext: {
      available: true,
      confidence: 'medium',
      carrier: 'Royal Mail',
      avg_transit_days: 6.2,
      days_since_fulfillment: 5.4,
      estimated_remaining_days: 0.8
    }
  });

  assert.equal((result.match(/You can follow the shipment here:/g) || []).length, 1);
  assert.equal((result.match(/kitsrepublic\.com\/apps\/17TRACK/g) || []).length, 1);
  assert.match(result, /Delivery normally takes around 7-15 days from purchase/);
  assert.match(result, /Shipping policy:\nhttps:\/\/kitsrepublic\.com\/policies\/shipping-policy/);
  assert.match(result, /Best,\n\nwww\.kitsrepublic\.com$/);
});

test('removes French duplicate timeframe and orphan tracking label', () => {
  const draft = [
    'Bonjour Samuel,',
    '',
    'Merci beaucoup pour votre message.',
    '',
    'Votre commande a bien été expédiée. Le délai de livraison est généralement de 7 à 15 jours à compter de la date d’achat.',
    '',
    'Vous pouvez suivre votre colis ici :',
    '',
    'La livraison prend normalement 7 à 15 jours à partir de l achat.',
    '',
    'Vous pouvez suivre l envoi ici:',
    '',
    'https://kitsrepublic.com/apps/17TRACK?nums=6A06542422997',
    '',
    'Cordialement,',
    '',
    'www.kitsrepublic.com'
  ].join('\n');

  const result = enforceDraftRequirements({
    draft,
    responseLanguage: { language: 'French' },
    shopifyContext: {
      selected_order: {
        fulfillments: [
          {
            tracking_numbers: ['6A06542422997'],
            tracking: [{ company: 'Colissimo', number: '6A06542422997' }]
          }
        ]
      }
    }
  });

  assert.equal((result.match(/7 à 15 jours/g) || []).length, 1);
  assert.doesNotMatch(result, /Vous pouvez suivre votre colis ici/);
  assert.equal((result.match(/Vous pouvez suivre l envoi ici:/g) || []).length, 1);
  assert.equal((result.match(/kitsrepublic\.com\/apps\/17TRACK/g) || []).length, 1);
  assert.match(result, /Politique de livraison:\nhttps:\/\/kitsrepublic\.com\/policies\/shipping-policy/);
  assert.match(result, /Cordialement,\n\nwww\.kitsrepublic\.com$/);
});

test('removes German orphan shipping policy label and keeps tracking before sign-off', () => {
  const draft = [
    'Hallo Luis,',
    '',
    'vielen Dank für Ihre Nachricht.',
    '',
    'Ihre Bestellung #1300 wurde versendet und befindet sich aktuell auf dem Weg. Die Lieferung dauert normalerweise 7-15 Tage ab Kaufdatum. Da es in Ihrem Fall bereits etwas länger dauert als üblich, entschuldigen wir uns für die Wartezeit. Das Tracking sollte automatisch aktualisiert werden, sobald das Paket an den lokalen Zustelldienst übergeben wurde.',
    '',
    'Versandrichtlinie:',
    '',
    'https://kitsrepublic.com/policies/shipping-policy',
    '',
    'Versandrichtlinie',
    '',
    'Mit freundlichen Grüßen',
    '',
    'Sie können die Sendung hier verfolgen:',
    '',
    'https://kitsrepublic.com/apps/17TRACK?nums=2764907499000900085000',
    '',
    'www.kitsrepublic.com'
  ].join('\n');

  const result = enforceDraftRequirements({
    draft,
    responseLanguage: { language: 'German' },
    shopifyContext: {
      selected_order: {
        fulfillments: [
          {
            tracking_numbers: ['2764907499000900085000'],
            tracking: [{ number: '2764907499000900085000' }]
          }
        ]
      }
    }
  });

  assert.equal((result.match(/Versandrichtlinie/g) || []).length, 1);
  assert.match(result, /Versandrichtlinie:\nhttps:\/\/kitsrepublic\.com\/policies\/shipping-policy/);
  assert.equal((result.match(/Sie können die Sendung hier verfolgen:/g) || []).length, 1);
  assert.match(result, /Sie können die Sendung hier verfolgen:\nhttps:\/\/kitsrepublic\.com\/apps\/17TRACK\?nums=2764907499000900085000/);
  assert.ok(result.indexOf('Sie können die Sendung hier verfolgen:') < result.indexOf('Mit freundlichen Grüßen'));
  assert.match(result, /Mit freundlichen Grüßen\nwww\.kitsrepublic\.com$/);
});

test('removes Dutch orphan shipping policy label and keeps tracking before sign-off', () => {
  const draft = [
    'Hallo Luis,',
    '',
    'Bedankt voor je bericht.',
    '',
    'Je bestelling #1300 is verzonden. Levering duurt normaal 7-15 dagen vanaf aankoop.',
    '',
    'Verzendbeleid:',
    '',
    'https://kitsrepublic.com/policies/shipping-policy',
    '',
    'Verzendbeleid',
    '',
    'Met vriendelijke groet',
    '',
    'Je kunt de zending hier volgen:',
    '',
    'https://kitsrepublic.com/apps/17TRACK?nums=2764907499000900085000',
    '',
    'www.kitsrepublic.com'
  ].join('\n');

  const result = enforceDraftRequirements({
    draft,
    responseLanguage: { language: 'Dutch' },
    shopifyContext: {
      selected_order: {
        fulfillments: [
          {
            tracking_numbers: ['2764907499000900085000'],
            tracking: [{ number: '2764907499000900085000' }]
          }
        ]
      }
    }
  });

  assert.equal((result.match(/Verzendbeleid/g) || []).length, 1);
  assert.match(result, /Verzendbeleid:\nhttps:\/\/kitsrepublic\.com\/policies\/shipping-policy/);
  assert.equal((result.match(/Je kunt de zending hier volgen:/g) || []).length, 1);
  assert.match(result, /Je kunt de zending hier volgen:\nhttps:\/\/kitsrepublic\.com\/apps\/17TRACK\?nums=2764907499000900085000/);
  assert.ok(result.indexOf('Je kunt de zending hier volgen:') < result.indexOf('Met vriendelijke groet'));
  assert.match(result, /Met vriendelijke groet\nwww\.kitsrepublic\.com$/);
});

test('keeps the tracking label immediately associated with the canonical link', () => {
  const draft = [
    'Hi,',
    '',
    'You can follow the shipment here:',
    '',
    'Track your parcel here:',
    '',
    'https://kitsrepublic.com/apps/17TRACK?nums=GV501871585GB',
    '',
    'Best,',
    'www.kitsrepublic.com'
  ].join('\n');

  const result = enforceDraftRequirements({
    draft,
    responseLanguage: { language: 'English' },
    shopifyContext: {
      selected_order: {
        fulfillments: [
          {
            tracking_numbers: ['GV501871585GB'],
            tracking: [{ company: 'Royal Mail', number: 'GV501871585GB' }]
          }
        ]
      }
    }
  });

  assert.doesNotMatch(result, /You can follow the shipment here:/);
  assert.match(result, /Track your parcel here:\nhttps:\/\/kitsrepublic\.com\/apps\/17TRACK\?nums=GV501871585GB/);
  assert.equal((result.match(/kitsrepublic\.com\/apps\/17TRACK/g) || []).length, 1);
});

test('removes false recent-shipment estimate wording when delivery analytics are unavailable', () => {
  const draft = [
    'Hi,',
    '',
    'Based on recent shipments with Royal Mail, this stage usually takes around 7-15 days after dispatch, but it can vary.',
    '',
    'Best regards,',
    'www.kitsrepublic.com'
  ].join('\n');

  const result = enforceDraftRequirements({
    draft,
    responseLanguage: { language: 'English' },
    deliveryEstimateContext: { available: false, reason: 'missing_database_url' }
  });

  assert.doesNotMatch(result, /Based on recent shipments/i);
  assert.doesNotMatch(result, /Royal Mail, this stage usually takes around 7-15 days after dispatch/i);
  assert.match(result, /Our usual delivery timeframe is 7-15 days from purchase, but it can vary\./);
  assert.match(result, /Shipping policy:\nhttps:\/\/kitsrepublic\.com\/policies\/shipping-policy/);
});

test('replaces exact recent-shipment decimal wording when delivery analytics are reliable', () => {
  const draft = [
    'Hi,',
    '',
    'Based on recent shipments with Royal Mail, delivery usually takes around 6.2 days after dispatch.',
    'Estimated remaining: ~0.8 days.',
    '',
    'Best,www.kitsrepublic.com'
  ].join('\n');

  const result = enforceDraftRequirements({
    draft,
    responseLanguage: { language: 'English' },
    deliveryEstimateContext: {
      available: true,
      confidence: 'high',
      carrier: 'Royal Mail',
      avg_transit_days: 6.2,
      days_since_fulfillment: 5.4,
      estimated_remaining_days: 0.8
    }
  });

  assert.match(result, /Based on our recent Royal Mail shipments, this stage usually updates around this point after dispatch/);
  assert.doesNotMatch(result, /6\.2 days/);
  assert.doesNotMatch(result, /0\.8 days/);
  assert.match(result, /Best,\n\nwww\.kitsrepublic\.com$/);
});

test('cleans exact arrival promises from delivery estimate wording', () => {
  const draft = [
    'Hi,',
    '',
    'The shipment should arrive tomorrow.',
    'It should update today.',
    '0.8 days remaining.',
    '',
    'Best regards,',
    'www.kitsrepublic.com'
  ].join('\n');

  const result = enforceDraftRequirements({
    draft,
    responseLanguage: { language: 'English' },
    deliveryEstimateContext: {
      available: true,
      confidence: 'medium',
      carrier: 'Royal Mail',
      avg_transit_days: 6.2,
      days_since_fulfillment: 5.4,
      estimated_remaining_days: 0.8
    }
  });

  assert.doesNotMatch(result, /tomorrow/i);
  assert.doesNotMatch(result, /today/i);
  assert.doesNotMatch(result, /0\.8 days/i);
  assert.match(result, /Best regards,\n\nwww\.kitsrepublic\.com$/);
});

test('uses Catalan labels when the draft language is explicitly Catalan', () => {
  const draft = [
    'Hola,',
    '',
    'El paquet es troba en aduanes.',
    '',
    'Salutacions,www.kitsrepublic.com'
  ].join('\n');

  const result = enforceDraftRequirements({
    draft,
    responseLanguage: { language: 'Catalan', source: 'agent_explicit_language_request' },
    supportCase: { type: 'customs_pending', confidence: 'high', reasons: [] },
    shopifyContext: {
      selected_order: {
        fulfillments: [
          {
            tracking_numbers: ['0082800082809769931372'],
            tracking: [{ company: 'CTT Express', number: '0082800082809769931372' }]
          }
        ]
      }
    }
  });

  assert.match(result, /El número de seguiment és correcte\./);
  assert.match(result, /Pots seguir l enviament aquí:/);
  assert.match(result, /https:\/\/kitsrepublic\.com\/apps\/17TRACK\?nums=0082800082809769931372/);
  assert.match(result, /Salutacions,\n\nwww\.kitsrepublic\.com$/);
});
