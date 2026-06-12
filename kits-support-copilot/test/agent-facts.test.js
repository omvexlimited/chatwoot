import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractAgentConfirmedFacts } from '../src/agent-facts.js';

test('extracts confirmed customs handoff facts from aggressive agent instructions', () => {
  const facts = extractAgentConfirmedFacts([
    {
      role: 'user',
      content: 'Te he dicho que ya ha pasado las aduanas, la agencia de transporte ya lo tiene, y lo mandara pronto.'
    }
  ]);

  assert.deepEqual(facts.map(fact => fact.type), [
    'customs_cleared',
    'local_carrier_has_parcel',
    'carrier_will_deliver_soon'
  ]);
  assert.ok(facts.every(fact => fact.confidence === 'confirmed_by_agent'));
});

test('does not treat speculative customs wording as confirmed facts', () => {
  const facts = extractAgentConfirmedFacts([
    {
      role: 'user',
      content: 'Seguramente ya paso aduanas y probablemente Royal Mail lo tiene.'
    }
  ]);

  assert.deepEqual(facts, []);
});

test('extracts supplier replacement and refund confirmations', () => {
  const facts = extractAgentConfirmedFacts([
    {
      role: 'user',
      content: 'Ya lo hemos reportado al supplier y el supplier ha confirmado que mandara una camiseta nueva. El reemplazo ya esta tramitado.'
    },
    {
      role: 'user',
      content: 'El reembolso ya esta procesado.'
    }
  ]);

  assert.deepEqual(facts.map(fact => fact.type), [
    'replacement_processed',
    'supplier_confirmed',
    'refund_processed'
  ]);
});
