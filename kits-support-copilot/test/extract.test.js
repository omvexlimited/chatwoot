import test from 'node:test';
import assert from 'node:assert/strict';
import { extractIdentifiers, normalizeOrderRef } from '../src/extract.js';
import { selectOrder } from '../src/shopify.js';

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

test('normalizes order refs', () => {
  assert.equal(normalizeOrderRef('1234'), '#1234');
  assert.equal(normalizeOrderRef('#1234'), '#1234');
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
