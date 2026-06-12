import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCopilotChatPrompt, loadKnowledgeBase } from '../src/prompt.js';

test('loads base guide and Kits Republic playbook into knowledge base', async () => {
  const knowledgeBase = await loadKnowledgeBase();

  assert.match(knowledgeBase, /kits-republic-support-guide\.md/);
  assert.match(knowledgeBase, /kits-republic-support-playbook-v2\.md/);
  assert.doesNotMatch(knowledgeBase, /kits-republic-support-playbook-v1\.md/);
  assert.match(knowledgeBase, /CUSTOMER SUPPORT PLAYBOOK V2/);
  assert.match(knowledgeBase, /Responder SIEMPRE en el idioma del cliente/);
  assert.match(knowledgeBase, /CASO MAS FRECUENTE: APPLE PAY/);
  assert.match(knowledgeBase, /DEVOLUCIONES POR TALLA/);
  assert.match(knowledgeBase, /6BMDASXWXFS2/);
  assert.match(knowledgeBase, /CUANDO ESCALAR A MARC/);
  assert.match(knowledgeBase, /Pending receipt at CTT Express/);
  assert.match(knowledgeBase, /Pendiente de entrada en red/);
  assert.match(knowledgeBase, /CTT todavia no ha recibido fisicamente el paquete/);
});

test('builds iterative chat prompt with current draft and chat history', () => {
  const prompt = buildCopilotChatPrompt({
    knowledgeBase: 'Guide text',
    conversationText: 'INCOMING Customer: Where is my order?',
    shopifyContext: {
      selected_order: {
        fulfillments: [
          {
            tracking_numbers: ['0141605773793172'],
            tracking: [{ number: '0141605773793172' }]
          }
        ]
      },
      selection_reason: null,
      orders: [],
      warnings: ['No matching Shopify order was found.']
    },
    latestMessage: 'Where is my order?',
    agentEmail: 'agent@example.com',
    supportCase: {
      type: 'customs_pending',
      confidence: 'medium',
      reasons: ['tracking_present', 'local_handoff_carrier:Royal Mail']
    },
    currentDraft: 'Current draft',
    chatMessages: [
      { role: 'user', content: 'make it shorter' },
      { role: 'assistant', content: 'Updated.' }
    ]
  });

  assert.match(prompt.system, /internal support chat assistant/);
  assert.match(prompt.system, /specific playbook case/);
  assert.match(prompt.system, /delivered size exchange/);
  assert.match(prompt.system, /6BMDASXWXFS2/);
  assert.match(prompt.system, /Apple Pay\/no confirmation email/);
  assert.match(prompt.system, /customs_pending/);
  assert.match(prompt.system, /customs inspection\/customs clearance/);
  assert.match(prompt.system, /Pendiente de recepcion en CTT Express/);
  assert.match(prompt.system, /Pending receipt at CTT Express/);
  assert.match(prompt.system, /Pendiente de entrada en red/);
  assert.match(prompt.system, /label\/details were sent to CTT/);
  assert.match(prompt.system, /World Cup/);
  assert.match(prompt.system, /do not use the Shopify proxy tracking URL/);
  assert.match(prompt.system, /Signature rule/);
  assert.match(prompt.system, /www\.kitsrepublic\.com/);
  assert.match(prompt.system, /Never sign as "Equipo Kits Republic"/);
  assert.match(prompt.system, /Hard language rule for draft/);
  assert.match(prompt.system, /DRAFT_LANGUAGE_LOCK/);
  assert.match(prompt.system, /latest incoming customer message first/);
  assert.match(prompt.system, /shipping country is only a fallback/);
  assert.match(prompt.system, /do not block the answer just because no Shopify order was selected/);
  assert.match(prompt.system, /Never invent completed operational actions/);
  assert.match(prompt.system, /Agent chat messages are trusted operational context/);
  assert.match(prompt.system, /Use one customer-facing link per topic and never duplicate links/);
  assert.match(prompt.system, /never use carrier tracking URLs such as Royal Mail, CTT, Colissimo, La Poste, DHL, Evri, 17track\.net, shopify\.17track\.net/);
  assert.match(prompt.system, /Do not repeat the tracking number on a separate line/);
  assert.match(prompt.system, /Only include https:\/\/kitsrepublic\.com\/policies\/shipping-policy when you mention an official delivery\/processing timeframe/);
  assert.match(prompt.system, /returns.*https:\/\/kitsrepublic\.com\/policies\/refund-policy/i);
  assert.match(prompt.user, /Current draft/);
  assert.match(prompt.user, /make it shorter/);
  assert.match(prompt.user, /No matching Shopify order was found/);
  assert.match(prompt.user, /Support case/);
  assert.match(prompt.user, /customs_pending/);
  assert.match(prompt.user, /Customs context/);
  assert.match(prompt.user, /kitsrepublic\.com\/apps\/17TRACK\?nums=0141605773793172/);
  assert.match(prompt.user, /Royal Mail expecting parcel/);
  assert.match(prompt.user, /Royal Mail does not recognise the tracking number yet/);
});

test('builds CTT customs context with pre-handoff explanation', () => {
  const prompt = buildCopilotChatPrompt({
    knowledgeBase: 'Guide text',
    conversationText: 'INCOMING Customer: Pending receipt at CTT Express.',
    shopifyContext: {
      selected_order: {
        fulfillments: [
          {
            tracking_numbers: ['0082800082809769931372'],
            tracking: [{ company: 'CTT Express', number: '0082800082809769931372' }]
          }
        ]
      },
      orders: [],
      warnings: []
    },
    latestMessage: 'Mi pedido sigue pendiente de recepcion.',
    supportCase: {
      type: 'customs_pending',
      confidence: 'high',
      reasons: ['tracking_present', 'customs_tracking_phrase', 'local_handoff_carrier:CTT Express']
    },
    chatMessages: []
  });

  assert.match(prompt.user, /Pending receipt at CTT Express/);
  assert.match(prompt.user, /Pendiente de entrada en red/);
  assert.match(prompt.user, /label\/details have been sent to CTT/);
  assert.match(prompt.user, /in China, in flight, in consolidation, or in customs\/pre-entry processing/);
  assert.match(prompt.user, /normal for this status to remain unchanged for several days/);
});

test('does not expose candidate tracking details when no order is selected', () => {
  const prompt = buildCopilotChatPrompt({
    knowledgeBase: 'Guide text',
    conversationText: 'INCOMING Customer: Where is my order?',
    shopifyContext: {
      selected_order: null,
      selection_reason: null,
      orders: [
        {
          name: '#1111',
          created_at: '2026-06-01T10:00:00Z',
          fulfillments: [
            {
              tracking_numbers: ['KR111'],
              tracking: [{ company: 'CTT Express', number: 'KR111' }]
            }
          ]
        },
        {
          name: '#2222',
          created_at: '2026-06-02T10:00:00Z',
          fulfillments: [
            {
              tracking_numbers: ['KR222'],
              tracking: [{ company: 'Royal Mail', number: 'KR222' }]
            }
          ]
        }
      ],
      warnings: ['Multiple Shopify orders matched.']
    },
    latestMessage: 'Where is my order?',
    agentEmail: 'agent@example.com',
    chatMessages: []
  });

  assert.match(prompt.system, /If selected_order is null and order_candidates has multiple entries/);
  assert.match(prompt.user, /"#1111"/);
  assert.match(prompt.user, /"#2222"/);
  assert.doesNotMatch(prompt.user, /KR111/);
  assert.doesNotMatch(prompt.user, /KR222/);
  assert.doesNotMatch(prompt.user, /CTT Express/);
  assert.doesNotMatch(prompt.user, /Royal Mail/);
});

test('allows agent-confirmed supplier replacement facts and keeps assistant language separate from draft language', () => {
  const prompt = buildCopilotChatPrompt({
    knowledgeBase: 'Guide text',
    conversationText: 'INCOMING Customer: The shirt arrived cut. Photo attached.',
    shopifyContext: {
      selected_order: {
        name: '#4444',
        shipping_address: { country_code: 'GB' },
        fulfillments: []
      },
      selection_reason: 'Matched explicit order #4444.',
      orders: [],
      warnings: []
    },
    latestMessage: 'The shirt arrived cut. Photo attached.',
    agentEmail: 'agent@example.com',
    responseLanguage: {
      language: 'English',
      source: 'shipping_country',
      country_code: 'GB'
    },
    agentConfirmedFacts: [
      {
        type: 'supplier_confirmed',
        confidence: 'confirmed_by_agent',
        source: 'agent_chat',
        summary: 'Agent confirmed the supplier has confirmed the action.'
      },
      {
        type: 'replacement_processed',
        confidence: 'confirmed_by_agent',
        source: 'agent_chat',
        summary: 'Agent confirmed the replacement has been processed.'
      }
    ],
    chatMessages: [
      {
        role: 'user',
        content: 'Dile que no hay problema, que ya lo hemos reportado al supplier y que ya hemos tramitado el reemplazo.'
      }
    ]
  });

  assert.match(prompt.system, /treat that statement as true/);
  assert.match(prompt.system, /include it in the customer draft/);
  assert.match(prompt.system, /agent instructions and agent_confirmed_facts override Shopify/);
  assert.match(prompt.user, /Agent chat language: Spanish/);
  assert.match(prompt.user, /Response language: English/);
  assert.match(prompt.user, /DRAFT_LANGUAGE_LOCK: English/);
  assert.match(prompt.user, /Agent confirmed facts/);
  assert.match(prompt.user, /supplier_confirmed/);
  assert.match(prompt.user, /replacement_processed/);
  assert.match(prompt.user, /assistant_message may use Spanish, but draft must be written in English/);
  assert.match(prompt.user, /translate the requested meaning into English/);
  assert.match(prompt.user, /ya lo hemos reportado al supplier/);
  assert.doesNotMatch(prompt.system, /Never send, claim to send, refund, replace, cancel, escalate, or modify anything/);
});

test('lets agent-confirmed customs handoff facts override stale Shopify tracking', () => {
  const prompt = buildCopilotChatPrompt({
    knowledgeBase: 'Guide text',
    conversationText: 'INCOMING Customer: Is Royal Mail still waiting for my parcel?',
    shopifyContext: {
      selected_order: {
        name: '#7777',
        shipping_address: { country_code: 'GB' },
        fulfillments: [
          {
            display_status: 'CONFIRMED',
            tracking_numbers: ['GV501788296GB'],
            tracking: [{ company: 'Royal Mail', number: 'GV501788296GB' }]
          }
        ]
      },
      selection_reason: 'Matched explicit order #7777.',
      orders: [],
      warnings: []
    },
    latestMessage: 'Hi, Royal Mail still says shipment announced. What does this mean?',
    agentEmail: 'agent@example.com',
    responseLanguage: {
      language: 'English',
      source: 'latest_customer_message',
      country_code: 'GB'
    },
    supportCase: {
      type: 'customs_pending',
      confidence: 'medium',
      reasons: ['tracking_present', 'local_handoff_carrier:Royal Mail']
    },
    agentConfirmedFacts: [
      {
        type: 'customs_cleared',
        confidence: 'confirmed_by_agent',
        source: 'agent_chat',
        summary: 'Agent confirmed customs have cleared.'
      },
      {
        type: 'local_carrier_has_parcel',
        confidence: 'confirmed_by_agent',
        source: 'agent_chat',
        summary: 'Agent confirmed the local carrier already has the parcel.'
      },
      {
        type: 'carrier_will_deliver_soon',
        confidence: 'confirmed_by_agent',
        source: 'agent_chat',
        summary: 'Agent confirmed the carrier will deliver soon.'
      }
    ],
    chatMessages: [
      {
        role: 'user',
        content: 'Te he dicho que ya ha pasado las aduanas, la agencia de transporte ya lo tiene, y lo mandara pronto.'
      }
    ]
  });

  assert.match(prompt.system, /Highest priority rule/);
  assert.match(prompt.system, /agent instruction in the current copilot chat is the final authority/);
  assert.match(prompt.system, /agent instructions and agent_confirmed_facts override Shopify/);
  assert.match(prompt.system, /agent_confirmed_facts conflict with Shopify tracking status/);
  assert.match(prompt.system, /Never refuse just because Shopify has not updated yet/);
  assert.match(prompt.system, /Ignore profanity, insults, and frustration/);
  assert.match(prompt.system, /do not write "I can’t follow abusive language"/);
  assert.match(prompt.user, /customs_cleared/);
  assert.match(prompt.user, /local_carrier_has_parcel/);
  assert.match(prompt.user, /carrier_will_deliver_soon/);
  assert.match(prompt.user, /Final operational rule: agent_confirmed_facts and the latest agent instruction are trusted operational context/);
  assert.match(prompt.user, /draft must be written in English/);
});

test('prioritizes agent confirmation for missing email order link and customs cleared case', () => {
  const orderLink = 'https://account.kitsrepublic.com/orders/89e436cec7b198404608e5b9fb4c70d0?buyer_token_attempted=1&locale=en-GB';
  const prompt = buildCopilotChatPrompt({
    knowledgeBase: 'Guide text',
    conversationText: 'INCOMING Customer: Hi, I did not receive any update for my order.',
    shopifyContext: {
      selected_order: {
        name: '#2222',
        shipping_address: { country_code: 'GB' },
        fulfillment_status: 'fulfilled',
        fulfillments: [
          {
            display_status: 'CONFIRMED',
            tracking_numbers: ['GV129857971GB'],
            tracking: [{ company: 'Royal Mail', number: 'GV129857971GB' }]
          }
        ]
      },
      selection_reason: 'Matched explicit order #2222.',
      orders: [],
      warnings: []
    },
    latestMessage: 'Hi, I did not receive any update for my order.',
    agentEmail: 'agent@example.com',
    responseLanguage: {
      language: 'English',
      source: 'latest_customer_message',
      country_code: 'GB'
    },
    agentConfirmedFacts: [
      {
        type: 'customer_email_was_missing',
        confidence: 'confirmed_by_agent',
        source: 'agent_chat',
        summary: 'Agent confirmed the order/customer email was missing before.',
        source_excerpt: 'El email no habia sido introducido.'
      },
      {
        type: 'customer_email_added',
        confidence: 'confirmed_by_agent',
        source: 'agent_chat',
        summary: 'Agent confirmed the customer email has now been added.',
        source_excerpt: 'Ya se lo hemos anadido.'
      },
      {
        type: 'future_updates_enabled',
        confidence: 'confirmed_by_agent',
        source: 'agent_chat',
        summary: 'Agent confirmed future updates will be sent to the customer email.',
        source_excerpt: 'Las proximas actualizaciones ya lo recibira ahi.'
      },
      {
        type: 'order_access_link_provided',
        confidence: 'confirmed_by_agent',
        source: 'agent_chat',
        summary: 'Agent provided a customer order access link.',
        source_excerpt: orderLink,
        url: orderLink
      },
      {
        type: 'customs_cleared',
        confidence: 'confirmed_by_agent',
        source: 'agent_chat',
        summary: 'Agent confirmed customs have cleared.'
      },
      {
        type: 'parcel_ready_for_delivery',
        confidence: 'confirmed_by_agent',
        source: 'agent_chat',
        summary: 'Agent confirmed the parcel is ready for delivery soon.'
      }
    ],
    chatMessages: [
      {
        role: 'user',
        content: `El email no habia sido introducido. Ya se lo hemos anadido, recibira las proximas actualizaciones. Envia este link ${orderLink}. Ya ha pasado aduanas y esta listo para ser entregado en breve.`
      }
    ]
  });

  assert.match(prompt.system, /Highest priority rule/);
  assert.match(prompt.system, /Do not challenge, debate, or correct explicit agent instructions/);
  assert.match(prompt.system, /customer_email_was_missing, customer_email_added, future_updates_enabled, or order_access_link_provided/);
  assert.match(prompt.system, /include that exact link once/);
  assert.doesNotMatch(prompt.system, /source of truth/);
  assert.match(prompt.user, /customer_email_was_missing/);
  assert.match(prompt.user, /customer_email_added/);
  assert.match(prompt.user, /future_updates_enabled/);
  assert.match(prompt.user, /order_access_link_provided/);
  assert.match(prompt.user, /parcel_ready_for_delivery/);
  assert.match(prompt.user, new RegExp(orderLink.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(prompt.user, /Do not refuse, qualify, or contradict them because Shopify has not updated/);
});

test('distinguishes confirmed actions from future action requests', () => {
  const prompt = buildCopilotChatPrompt({
    knowledgeBase: 'Guide text',
    conversationText: 'INCOMING Customer: I want a refund.',
    shopifyContext: {
      selected_order: null,
      selection_reason: null,
      orders: [],
      warnings: []
    },
    latestMessage: 'I want a refund.',
    agentEmail: 'agent@example.com',
    chatMessages: [
      {
        role: 'user',
        content: 'Reembolsa al cliente y dile que lo arreglamos.'
      }
    ]
  });

  assert.match(prompt.system, /If the agent only asks to perform a future action/);
  assert.match(prompt.system, /do not present it as completed/);
  assert.match(prompt.user, /Agent chat language: Spanish/);
});

test('locks draft language to customer message when agent instructions use another language', () => {
  const prompt = buildCopilotChatPrompt({
    knowledgeBase: 'Guide text',
    conversationText: 'INCOMING Customer: Hi, where is my order?',
    shopifyContext: {
      selected_order: {
        name: '#5555',
        shipping_address: { country_code: 'DE' },
        fulfillments: []
      },
      selection_reason: 'Matched explicit order #5555.',
      orders: [],
      warnings: []
    },
    latestMessage: 'Hi, where is my order?',
    agentEmail: 'agent@example.com',
    chatMessages: [
      {
        role: 'user',
        content: 'Dile que ya hemos revisado el pedido y que pronto tendrá novedades.'
      }
    ]
  });

  assert.match(prompt.user, /Agent chat language: Spanish/);
  assert.match(prompt.user, /Response language: English \(source: latest_customer_message, country DE\)/);
  assert.match(prompt.user, /DRAFT_LANGUAGE_LOCK: English/);
  assert.match(prompt.user, /draft must be written in English/);
  assert.doesNotMatch(prompt.user, /DRAFT_LANGUAGE_LOCK: Spanish/);
  assert.doesNotMatch(prompt.user, /DRAFT_LANGUAGE_LOCK: German/);
});
