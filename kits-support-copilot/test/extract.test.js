import test from 'node:test';
import assert from 'node:assert/strict';
import { extractIdentifiers, normalizeOrderRef } from '../src/extract.js';
import { buildShopifyQueries, selectOrder } from '../src/shopify.js';

test('extracts emails and explicit order refs', () => {
  const result = extractIdentifiers('My email is Test@Example.com and order #12345 has no tracking.');
  assert.deepEqual(result.emails, ['test@example.com']);
  assert.equal(result.orderRefs.includes('#12345'), true);
});

test('does not treat bare years as order refs', () => {
  const result = extractIdentifiers('Oyeeee, se acaba el Mundial 2026 y sigo sin recibir las camisetas.');
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

test('selects order by explicit order ref', () => {
  const orders = [
    { id: '1', name: '#1111', email: 'one@example.com', fulfillments: [] },
    { id: '2', name: '#2222', email: 'two@example.com', fulfillments: [] }
  ];
  const selected = selectOrder(orders, { orderRefs: ['#2222'], trackingNumbers: [] });
  assert.equal(selected.order.id, '2');
  assert.deepEqual(selected.warnings, []);
});

test('does not select explicit order refs belonging to a different active email', () => {
  const orders = [
    { id: '1', name: '#1196', email: 'adrianxstanca@gmail.com', fulfillments: [] },
    { id: '2', name: '#2026', email: 'pietergreven@gmail.com', fulfillments: [] }
  ];
  const selected = selectOrder(
    orders,
    { orderRefs: ['#2026'], trackingNumbers: [] },
    { contactEmail: 'adrianxstanca@gmail.com' }
  );

  assert.equal(selected.order, null);
  assert.match(selected.warnings[0], /explicit order #2026 did not match the active contact email/i);
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

test('rejects manually chosen order from another active email', () => {
  const orders = [
    { id: '1', name: '#1111', email: 'customer@example.com', fulfillments: [] },
    { id: '2', name: '#2222', email: 'other@example.com', fulfillments: [] }
  ];
  const selected = selectOrder(
    orders,
    { orderRefs: [], trackingNumbers: [] },
    { contactEmail: 'customer@example.com', selectedOrderRef: '#2222' }
  );

  assert.equal(selected.order, null);
  assert.match(selected.warnings[0], /selected order #2222 did not match the active contact email/i);
});
