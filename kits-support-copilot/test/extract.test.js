import test from 'node:test';
import assert from 'node:assert/strict';
import { extractIdentifiers, normalizeOrderRef, normalizePhoneCandidates } from '../src/extract.js';
import { buildShopifyQueries, getShopifyContext, selectOrder } from '../src/shopify.js';

test('extracts emails and explicit order refs', () => {
  const result = extractIdentifiers('My email is Test@Example.com and order #12345 has no tracking.');
  assert.deepEqual(result.emails, ['test@example.com']);
  assert.equal(result.orderRefs.includes('#12345'), true);
});

test('does not treat bare years as order refs', () => {
  const result = extractIdentifiers('Oyeeee, llevo varias semanas y sigo sin recibir las camisetas.');
  assert.deepEqual(result.orderRefs, []);
});

test('extracts localized order refs without requiring hash', () => {
  const result = extractIdentifiers('Hola, mi pedido 1421 no ha llegado. Commande n°1558 aussi.');
  assert.equal(result.orderRefs.includes('#1421'), true);
  assert.equal(result.orderRefs.includes('#1558'), true);
});

test('does not treat normal words after tracking as tracking numbers', () => {
  const result = extractIdentifiers('El tracking indicado no se actualiza.');
  assert.deepEqual(result.trackingNumbers, []);
});

test('does not treat email local parts near tracking hints as tracking numbers', () => {
  const result = extractIdentifiers([
    "You received a new message from your online store's contact form.",
    'Email: jlally1997@hotmail.com',
    'Body: Hi, I placed an order Saturday but haven’t received a confirmation email with any tracking information?'
  ].join(' '));

  assert.deepEqual(result.emails, ['jlally1997@hotmail.com']);
  assert.deepEqual(result.trackingNumbers, []);
});

test('extracts real tracking numbers after tracking hints', () => {
  const result = extractIdentifiers('Tracking indicado: 006239005280976987333001.');
  assert.deepEqual(result.trackingNumbers, ['006239005280976987333001']);
});

test('extracts phone numbers from explicit phone fields with country code variants', () => {
  const result = extractIdentifiers('Country Code: GB Name: Nasir Email: test@example.com Phone: 07950527911 Body: Hello');

  assert.deepEqual(result.countryCodes, ['GB']);
  assert.equal(result.phoneNumbers.includes('07950527911'), true);
  assert.equal(result.phoneNumbers.includes('+447950527911'), true);
  assert.equal(result.phoneNumbers.includes('447950527911'), true);
  assert.equal(result.phoneNumbers.includes('7950527911'), true);
});

test('normalizes Spanish local phone variants', () => {
  const result = normalizePhoneCandidates('654 91 18 76', 'ES');

  assert.equal(result.includes('654911876'), true);
  assert.equal(result.includes('+34654911876'), true);
  assert.equal(result.includes('34654911876'), true);
});

test('normalizes order refs', () => {
  assert.equal(normalizeOrderRef('1234'), '#1234');
  assert.equal(normalizeOrderRef('#1234'), '#1234');
});

test('builds Shopify lookup queries that include closed archived orders', () => {
  const queries = buildShopifyQueries({
    contactEmail: 'alvarezlozano.sonia@gmail.com',
    identifiers: { orderRefs: [], trackingNumbers: [], emails: [] }
  });

  assert.deepEqual(queries, [
    'email:alvarezlozano.sonia@gmail.com',
    'email:alvarezlozano.sonia@gmail.com status:open',
    'email:alvarezlozano.sonia@gmail.com status:closed',
    'email:alvarezlozano.sonia@gmail.com status:cancelled'
  ]);
});

test('builds explicit order lookups that include closed archived orders', () => {
  const queries = buildShopifyQueries({
    contactEmail: '',
    identifiers: { orderRefs: ['#1329'], trackingNumbers: [], emails: [] }
  });

  assert.deepEqual(queries, [
    'name:#1329',
    'name:#1329 status:open',
    'name:#1329 status:closed',
    'name:#1329 status:cancelled'
  ]);
});

test('builds selected order lookups even without email identifiers', () => {
  const queries = buildShopifyQueries({
    contactEmail: '',
    selectedOrderRef: '2280',
    identifiers: { orderRefs: [], trackingNumbers: [], emails: [] }
  });

  assert.deepEqual(queries, [
    'name:#2280',
    'name:#2280 status:open',
    'name:#2280 status:closed',
    'name:#2280 status:cancelled'
  ]);
});

test('puts selected order lookup before active contact email lookup', () => {
  const queries = buildShopifyQueries({
    contactEmail: 'other@example.com',
    selectedOrderRef: '#2280',
    identifiers: { orderRefs: [], trackingNumbers: [], emails: [] }
  });

  assert.deepEqual(queries.slice(0, 4), [
    'name:#2280',
    'name:#2280 status:open',
    'name:#2280 status:closed',
    'name:#2280 status:cancelled'
  ]);
  assert.equal(queries.includes('email:other@example.com'), true);
});

test('builds phone fallback lookup queries without using phone filter syntax', () => {
  const queries = buildShopifyQueries({
    contactEmail: '',
    identifiers: { orderRefs: [], trackingNumbers: [], phoneNumbers: ['+447950527911', '7950527911'], emails: [] }
  });

  assert.equal(queries.includes('+447950527911'), true);
  assert.equal(queries.includes('+447950527911 status:closed'), true);
  assert.equal(queries.includes('7950527911'), true);
  assert.equal(queries.some(query => query.startsWith('phone:')), false);
});

test('stops Shopify lookup after the first verified primary match', async t => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ({
        data: {
          orders: {
            nodes: [
              {
                id: 'gid://shopify/Order/1',
                name: '#1001',
                email: 'test@example.com',
                createdAt: '2026-07-01T00:00:00Z',
                displayFinancialStatus: 'PAID',
                displayFulfillmentStatus: 'UNFULFILLED',
                currentTotalPriceSet: { shopMoney: { amount: '10.00', currencyCode: 'EUR' } },
                customer: { email: 'test@example.com', firstName: 'Test', lastName: 'Customer', phone: null },
                phone: null,
                shippingAddress: { country: 'Spain', countryCodeV2: 'ES', phone: null },
                billingAddress: null,
                lineItems: { nodes: [] },
                fulfillments: []
              }
            ]
          }
        }
      })
    };
  };

  const context = await getShopifyContext({
    config: {
      shopifyStoreDomain: 'kits-republic.myshopify.com',
      shopifyAdminAccessToken: 'token',
      shopifyApiVersion: '2026-04',
      shopifyQueryConcurrency: 4,
      shopifyRequestTimeoutMs: 1000
    },
    contactEmail: 'test@example.com',
    contactPhone: '',
    contactCountryCode: '',
    text: '',
    selectedOrderRef: ''
  });

  assert.equal(context.selected_order.name, '#1001');
  assert.equal(calls, 1);
  assert.deepEqual(context.queries, ['email:test@example.com']);
});

test('runs archived Shopify fallback queries concurrently when the primary lookup misses', async t => {
  const originalFetch = globalThis.fetch;
  let active = 0;
  let maxActive = 0;
  let calls = 0;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (_url, options) => {
    active += 1;
    calls += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 20));
    active -= 1;
    const query = JSON.parse(options.body).variables.query;
    const orders = query.endsWith('status:closed')
      ? [{
          id: 'gid://shopify/Order/2',
          name: '#1002',
          email: 'archive@example.com',
          createdAt: '2026-06-01T00:00:00Z',
          currentTotalPriceSet: { shopMoney: { amount: '20.00', currencyCode: 'EUR' } },
          customer: { email: 'archive@example.com', firstName: 'Archive', lastName: 'Customer', phone: null },
          shippingAddress: { country: 'Spain', countryCodeV2: 'ES', phone: null },
          lineItems: { nodes: [] },
          fulfillments: []
        }]
      : [];
    return {
      ok: true,
      json: async () => ({ data: { orders: { nodes: orders } } })
    };
  };

  const context = await getShopifyContext({
    config: {
      shopifyStoreDomain: 'kits-republic.myshopify.com',
      shopifyAdminAccessToken: 'token',
      shopifyApiVersion: '2026-04',
      shopifyQueryConcurrency: 4,
      shopifyRequestTimeoutMs: 1000
    },
    contactEmail: 'archive@example.com',
    contactPhone: '',
    contactCountryCode: '',
    text: '',
    selectedOrderRef: ''
  });

  assert.equal(context.selected_order.name, '#1002');
  assert.equal(calls, 4);
  assert.ok(maxActive > 1);
});

test('selects order by explicit order ref', () => {
  const orders = [
    { id: '1', name: '#1111', email: 'one@example.com', fulfillments: [] },
    { id: '2', name: '#2222', email: 'two@example.com', fulfillments: [] }
  ];
  const selected = selectOrder(orders, { orderRefs: ['#2222'], trackingNumbers: [] });
  assert.equal(selected.order.id, '2');
  assert.deepEqual(selected.warnings, []);
});

test('selects explicit order refs even when the active email differs', () => {
  const orders = [
    { id: '1', name: '#1196', email: 'adrianxstanca@gmail.com', fulfillments: [] },
    { id: '2', name: '#2026', email: 'pietergreven@gmail.com', fulfillments: [] }
  ];
  const selected = selectOrder(
    orders,
    { orderRefs: ['#2026'], trackingNumbers: [] },
    { contactEmail: 'adrianxstanca@gmail.com' }
  );

  assert.equal(selected.order.id, '2');
  assert.match(selected.reason, /matched explicit order #2026/i);
  assert.match(selected.warnings[0], /contact email differs/i);
});

test('does not select ambiguous multiple email matches', () => {
  const orders = [
    { id: '1', name: '#1111', fulfillments: [] },
    { id: '2', name: '#2222', fulfillments: [] }
  ];
  const selected = selectOrder(orders, { orderRefs: [], trackingNumbers: [] });
  assert.equal(selected.order, null);
  assert.equal(selected.warnings.length, 1);
});

test('selects manually chosen order when it belongs to the active email', () => {
  const orders = [
    { id: '1', name: '#1111', email: 'customer@example.com', fulfillments: [] },
    { id: '2', name: '#2222', email: 'customer@example.com', fulfillments: [] }
  ];
  const selected = selectOrder(
    orders,
    { orderRefs: [], trackingNumbers: [] },
    { contactEmail: 'customer@example.com', selectedOrderRef: '#2222' }
  );

  assert.equal(selected.order.id, '2');
  assert.match(selected.reason, /agent selected order #2222/i);
  assert.deepEqual(selected.warnings, []);
});

test('selects trusted internal email fallback order when Shopify email is missing', () => {
  const orders = [
    { id: '1', name: '#1947', email: null, fulfillments: [] }
  ];
  const selected = selectOrder(
    orders,
    { orderRefs: [], trackingNumbers: [] },
    { contactEmail: 'alvarezlozano.sonia@gmail.com', trustedOrderRefs: ['#1947'] }
  );

  assert.equal(selected.order.id, '1');
  assert.match(selected.reason, /kits republic email fallback order #1947/i);
  assert.deepEqual(selected.warnings, []);
});

test('selects the only email-matched order when an unverified tracking token is present', () => {
  const orders = [
    {
      id: '1',
      name: '#3067',
      email: 'jlally1997@hotmail.com',
      fulfillments: [{ tracking_numbers: ['ZP13684781601'] }]
    }
  ];
  const selected = selectOrder(
    orders,
    { orderRefs: [], trackingNumbers: ['JLALLY1997'] },
    { contactEmail: 'jlally1997@hotmail.com' }
  );

  assert.equal(selected.order.id, '1');
  assert.match(selected.reason, /ignored unverified tracking reference/i);
  assert.deepEqual(selected.warnings, []);
});

test('selects explicit tracking refs even when the active email differs', () => {
  const orders = [
    {
      id: '1',
      name: '#2280',
      email: 'adam.yaqub123@gmail.com',
      fulfillments: [{ tracking_numbers: ['GV501781593GB'] }]
    }
  ];
  const selected = selectOrder(
    orders,
    { orderRefs: [], trackingNumbers: ['GV501781593GB'] },
    { contactEmail: 'wwwnasir786@hotmail.co.uk' }
  );

  assert.equal(selected.order.id, '1');
  assert.match(selected.reason, /matched tracking number on #2280/i);
  assert.match(selected.warnings[0], /contact email differs/i);
});

test('selects phone match only as fallback after email matching fails', () => {
  const orders = [
    {
      id: '1',
      name: '#2280',
      email: 'adam.yaqub123@gmail.com',
      phone: '+447950527911',
      customer: { phone: '+447950527911' },
      shipping_address: { country_code: 'GB', phone: '+44 7950 527911' },
      billing_address: { country_code: 'GB', phone: '+44 7903 842794' },
      fulfillments: []
    }
  ];
  const selected = selectOrder(
    orders,
    { orderRefs: [], trackingNumbers: [], phoneNumbers: normalizePhoneCandidates('07950527911', 'GB') },
    { contactEmail: 'wwwnasir786@hotmail.co.uk' }
  );

  assert.equal(selected.order.id, '1');
  assert.match(selected.reason, /matched phone number on #2280/i);
  assert.match(selected.warnings[0], /contact email differs/i);
});

test('keeps exact email match ahead of phone fallback', () => {
  const orders = [
    {
      id: '1',
      name: '#1001',
      email: 'customer@example.com',
      fulfillments: []
    },
    {
      id: '2',
      name: '#2280',
      email: 'other@example.com',
      phone: '+447950527911',
      shipping_address: { country_code: 'GB', phone: '+44 7950 527911' },
      fulfillments: []
    }
  ];
  const selected = selectOrder(
    orders,
    { orderRefs: [], trackingNumbers: [], phoneNumbers: normalizePhoneCandidates('07950527911', 'GB') },
    { contactEmail: 'customer@example.com' }
  );

  assert.equal(selected.order.id, '1');
  assert.match(selected.reason, /only one Shopify order matched/i);
});

test('does not select ambiguous multiple phone matches', () => {
  const orders = [
    {
      id: '1',
      name: '#2280',
      email: 'one@example.com',
      phone: '+447950527911',
      shipping_address: { country_code: 'GB', phone: '+44 7950 527911' },
      fulfillments: []
    },
    {
      id: '2',
      name: '#2281',
      email: 'two@example.com',
      phone: '+447950527911',
      shipping_address: { country_code: 'GB', phone: '+44 7950 527911' },
      fulfillments: []
    }
  ];
  const selected = selectOrder(
    orders,
    { orderRefs: [], trackingNumbers: [], phoneNumbers: normalizePhoneCandidates('07950527911', 'GB') },
    { contactEmail: 'unknown@example.com' }
  );

  assert.equal(selected.order, null);
  assert.match(selected.warnings[0], /multiple Shopify orders matched the phone number/i);
});

test('keeps multiple trusted internal email fallback orders unselected', () => {
  const orders = [
    { id: '1', name: '#1947', email: null, fulfillments: [] },
    { id: '2', name: '#1950', email: null, fulfillments: [] }
  ];
  const selected = selectOrder(
    orders,
    { orderRefs: [], trackingNumbers: [] },
    { contactEmail: 'alvarezlozano.sonia@gmail.com', trustedOrderRefs: ['#1947', '#1950'] }
  );

  assert.equal(selected.order, null);
  assert.match(selected.warnings[0], /multiple Shopify orders matched/i);
});

test('keeps manually chosen order even when the active email differs', () => {
  const orders = [
    { id: '1', name: '#1111', email: 'customer@example.com', fulfillments: [] },
    { id: '2', name: '#2222', email: 'other@example.com', fulfillments: [] }
  ];
  const selected = selectOrder(
    orders,
    { orderRefs: [], trackingNumbers: [] },
    { contactEmail: 'customer@example.com', selectedOrderRef: '#2222' }
  );

  assert.equal(selected.order.id, '2');
  assert.match(selected.reason, /agent selected order #2222/i);
  assert.match(selected.warnings[0], /contact email differs/i);
});
