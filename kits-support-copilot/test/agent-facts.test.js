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

test('extracts email-added order link and customs delivery instructions from agent message', () => {
  const facts = extractAgentConfirmedFacts([
    {
      role: 'user',
      content: [
        'Vale, en este caso el email no habia sido introducido, por lo cual por eso no ha recibido nada.',
        'Dile que ya se lo hemos anadido que las proximas actualizaciones ya lo recibira ahi.',
        'Dile que puede ver su pedido en este enlace y manda la informacion sobre el estado de su pedido,',
        'que ya ha pasado el control de aduanas y esta listo para ser entregado en breve',
        'https://account.kitsrepublic.com/orders/89e436cec7b198404608e5b9fb4c70d0?buyer_token_attempted=1&locale=en-GB'
      ].join(' ')
    }
  ]);

  assert.deepEqual(facts.map(fact => fact.type), [
    'customs_cleared',
    'carrier_will_deliver_soon',
    'parcel_ready_for_delivery',
    'customer_email_was_missing',
    'customer_email_added',
    'future_updates_enabled',
    'order_access_link_provided'
  ]);
  assert.equal(
    facts.find(fact => fact.type === 'order_access_link_provided')?.url,
    'https://account.kitsrepublic.com/orders/89e436cec7b198404608e5b9fb4c70d0?buyer_token_attempted=1&locale=en-GB'
  );
  assert.match(
    facts.find(fact => fact.type === 'customer_email_added')?.source_excerpt || '',
    /proximas actualizaciones/
  );
});
