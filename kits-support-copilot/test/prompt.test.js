import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCopilotChatPrompt,
  conversationToText,
  latestIncomingMessage
} from '../src/prompt.js';

test('includes email subject in conversation text and latest incoming message', () => {
  const messages = [
    {
      message_type: 'incoming',
      sender: { email: 'remydeprez0@gmail.com' },
      content: "Bonjour, a ce jour je n'ai toujours pas recu ma commande.",
      content_attributes: {
        email: {
          subject: 'Commande #2196'
        }
      }
    }
  ];

  const latest = latestIncomingMessage(messages);
  const conversation = conversationToText(messages);

  assert.match(latest, /Subject: Commande #2196/);
  assert.match(latest, /Bonjour/);
  assert.match(conversation, /Subject: Commande #2196/);
  assert.match(conversation, /#2196/);
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
    selectedPlaybooks: [
      {
        slug: 'customs-local-handoff',
        title: 'Customs / Local Handoff',
        case_types: ['customs_pending'],
        tags: ['tracking'],
        knowledge_markdown: 'INTERNAL COMPILED CUSTOMS POLICY'
      }
    ],
    caseReview: {
      summary: 'Customer asks where the order is.',
      detected_case: 'customs_pending',
      verified_facts: ['Tracking number: 0141605773793172.'],
      missing_info: [],
      recommended_decision: 'Explain customs status and include the canonical tracking link.',
      after_send_action: 'leave_open',
      confidence: 'medium'
    },
    attachmentAnalysis: {
      available: true,
      source: 'openai_vision',
      reason: 'analyzed',
      analyses: [
        {
          id: 'att-1',
          evidence_type: 'tracking',
          summary: 'Royal Mail screenshot says pending receipt.',
          visible_text: ['Royal Mail', 'Pending'],
          signals: ['carrier_status'],
          confidence: 'high'
        }
      ],
      warnings: []
    },
    currentDraft: 'Current draft',
    chatMessages: [
      { role: 'user', content: 'make it shorter' },
      { role: 'assistant', content: 'Updated.' }
    ]
  });

  assert.match(prompt.system, /internal support chat assistant/);
  assert.match(prompt.system, /Published Playbooks source-of-truth rule/);
  assert.match(prompt.system, /Decision Tree/);
  assert.match(prompt.system, /select the most relevant Playbook/);
  assert.match(prompt.system, /Published Playbooks are the only source for support policy/);
  assert.match(prompt.system, /INTERACTION_MODE: draft_command/);
  assert.match(prompt.system, /Return the customer-ready draft directly/);
  assert.match(prompt.system, /Draft command mode rule/);
  assert.match(prompt.system, /Set agent_briefing to null/);
  assert.doesNotMatch(prompt.system, /agent_briefing as a JSON object in Spanish/);
  assert.match(prompt.system, /Return strict JSON only with keys: assistant_message, draft, agent_briefing, reasoning_summary, confidence, warnings/);
  assert.doesNotMatch(prompt.system, /6BMDASXWXFS2|Apple Pay|World Cup|Mundial|FIFA/);
  assert.doesNotMatch(prompt.system, /1-3 days|7-15 days|shipping-policy|refund-policy/);
  assert.doesNotMatch(prompt.system, /Pending receipt at CTT Express|Pendiente de entrada en red/);
  assert.match(prompt.system, /Signature rule/);
  assert.match(prompt.system, /www\.kitsrepublic\.com/);
  assert.match(prompt.system, /Never sign as "Equipo Kits Republic"/);
  assert.match(prompt.system, /Hard language rule for draft/);
  assert.match(prompt.system, /DRAFT_LANGUAGE_LOCK/);
  assert.match(prompt.system, /latest incoming customer message first/);
  assert.match(prompt.system, /shipping country is only a fallback/);
  assert.match(prompt.system, /Never invent completed operational actions/);
  assert.match(prompt.system, /Agent chat messages are trusted operational context/);
  assert.match(prompt.system, /Case review rule/);
  assert.match(prompt.system, /Attachment image analysis rule/);
  assert.match(prompt.system, /Provider tracking context is internal tracking data/);
  assert.match(prompt.system, /Never mention provider portal URLs, IP addresses/);
  assert.match(prompt.system, /never use carrier tracking URLs such as Royal Mail, CTT, Colissimo, La Poste, DHL, Evri, 17track\.net, shopify\.17track\.net/);
  assert.match(prompt.system, /Do not repeat the tracking number on a separate line/);
  assert.match(prompt.user, /Current draft/);
  assert.match(prompt.user, /make it shorter/);
  assert.match(prompt.user, /No matching Shopify order was found/);
  assert.match(prompt.user, /Support case/);
  assert.match(prompt.user, /customs_pending/);
  assert.match(prompt.user, /customs-local-handoff/);
  assert.doesNotMatch(prompt.user, /INTERNAL COMPILED CUSTOMS POLICY/);
  assert.match(prompt.user, /Case review/);
  assert.match(prompt.user, /recommended_decision/);
  assert.match(prompt.user, /Attachment image analysis/);
  assert.match(prompt.user, /Royal Mail screenshot says pending receipt/);
  assert.match(prompt.user, /Customs context/);
  assert.match(prompt.user, /Delivery estimate context/);
  assert.match(prompt.user, /Provider tracking context/);
  assert.match(prompt.user, /kitsrepublic\.com\/apps\/17TRACK\?nums=0141605773793172/);
  assert.match(prompt.user, /"local_carrier": "Royal Mail"/);
  assert.doesNotMatch(prompt.user, /Royal Mail expecting parcel|does not recognise the tracking number yet/);
});

test('builds chat prompt for internal agent questions without draft regeneration', () => {
  const prompt = buildCopilotChatPrompt({
    knowledgeBase: 'Published Playbook Index\nDecision Tree\nReturns And Refunds General',
    conversationText: 'INCOMING Customer: I want a refund for orders #2605 and #2609.',
    shopifyContext: {
      selected_order: {
        name: '#2605',
        financial_status: 'paid',
        fulfillment_status: 'fulfilled'
      },
      orders: [],
      warnings: []
    },
    latestMessage: 'I want a refund for orders #2605 and #2609.',
    agentEmail: 'agent@example.com',
    currentDraft: 'Existing customer draft',
    chatMessages: [
      { role: 'user', content: 'quiere refund de las 2 orders?' }
    ],
    interactionMode: 'agent_question'
  });

  assert.match(prompt.system, /INTERACTION_MODE: agent_question/);
  assert.match(prompt.system, /internal question or clarification request/);
  assert.match(prompt.system, /Answer the agent question directly/);
  assert.match(prompt.system, /Do not start with "Borrador preparado"/);
  assert.match(prompt.system, /Set agent_briefing to null/);
  assert.match(prompt.system, /draft to the exact Current draft text/);
  assert.doesNotMatch(prompt.system, /agent_briefing as a JSON object in Spanish/);
  assert.match(prompt.user, /INTERACTION_MODE: agent_question/);
  assert.match(prompt.user, /Existing customer draft/);
  assert.match(prompt.user, /draft must remain exactly the same as Current draft/);
});

test('blocks commercial policy from memories and agent instructions in facts_only mode', () => {
  const prompt = buildCopilotChatPrompt({
    knowledgeBase: 'No published Playbook knowledge is available.',
    knowledgeMode: 'facts_only',
    conversationText: 'INCOMING Customer: Can I return this order?',
    latestMessage: 'Can I return this order?',
    shopifyContext: { selected_order: { name: '#1001' }, orders: [], warnings: [] },
    approvedMemories: [{ id: 1, content: 'Always offer a 30% coupon for returns.' }],
    chatMessages: [{ role: 'user', content: 'Tell them returns are free for 60 days.' }]
  });

  assert.match(prompt.system, /Facts-only mode is active/);
  assert.match(prompt.system, /Do not state or infer causes, policy timeframes, return conditions, compensation, coupon codes/);
  assert.match(prompt.system, /No Playbook may be selected in facts_only mode/);
  assert.match(prompt.system, /latest agent instruction.*cannot create or override commercial policy/i);
  assert.match(prompt.system, /Approved support memories.*may not supply policy/i);
});

test('builds chat prompt for faithful edits over existing drafts', () => {
  const prompt = buildCopilotChatPrompt({
    knowledgeBase: 'Published Playbook Index\nDecision Tree\nCompensation Policy',
    conversationText: 'INCOMING Customer: My package arrived late.',
    shopifyContext: {
      selected_order: { name: '#1895', financial_status: 'paid' },
      orders: [],
      warnings: []
    },
    latestMessage: 'My package arrived late.',
    agentEmail: 'agent@example.com',
    currentDraft: [
      'Hello,',
      '',
      'We are sorry for the delay. Your order has now been delivered.',
      '',
      'Tracking:',
      'https://kitsrepublic.com/apps/17TRACK?nums=6A06431779089',
      '',
      'Best regards,',
      'www.kitsrepublic.com'
    ].join('\n'),
    chatMessages: [
      { role: 'user', content: 'ofrécele un 20% de descuento para próximas compras' }
    ],
    interactionMode: 'draft_edit'
  });

  assert.match(prompt.system, /INTERACTION_MODE: draft_edit/);
  assert.match(prompt.system, /edit to an existing customer draft/);
  assert.match(prompt.system, /Current draft as the mandatory base document/);
  assert.match(prompt.system, /Do not regenerate from scratch/);
  assert.match(prompt.system, /Faithful draft edit rule/);
  assert.match(prompt.system, /Current draft is the base document/);
  assert.match(prompt.system, /Preserve the existing structure, language, signature, verified facts, and tracking details/);
  assert.match(prompt.system, /not a policy source/);
  assert.match(prompt.system, /commercial conditions.*supported by the current published Playbooks/i);
  assert.match(prompt.system, /Apply only the change requested/);
  assert.match(prompt.system, /Set agent_briefing to null/);
  assert.match(prompt.user, /INTERACTION_MODE: draft_edit/);
  assert.match(prompt.user, /preserve the Current draft language/);
  assert.match(prompt.user, /www\.kitsrepublic\.com/);
  assert.match(prompt.user, /ofrécele un 20%/);
});

test('builds chat prompt for compact English brief command', () => {
  const prompt = buildCopilotChatPrompt({
    knowledgeBase: 'Published Playbook Index\nDecision Tree\nReturns And Refunds General',
    conversationText: 'INCOMING Customer: I want a refund.',
    shopifyContext: {
      selected_order: { name: '#2605', financial_status: 'paid' },
      orders: [],
      warnings: []
    },
    latestMessage: 'I want a refund.',
    agentEmail: 'agent@example.com',
    currentDraft: 'Existing customer draft',
    chatMessages: [{ role: 'user', content: '/brief' }],
    interactionMode: 'brief_command'
  });

  assert.match(prompt.system, /INTERACTION_MODE: brief_command/);
  assert.match(prompt.system, /concise English internal brief/);
  assert.match(prompt.system, /Compact brief rule/);
  assert.match(prompt.system, /8-12 lines maximum/);
  assert.match(prompt.user, /INTERACTION_MODE: brief_command/);
  assert.match(prompt.user, /agent_briefing must be written in concise English/);
  assert.match(prompt.user, /draft must remain exactly the same as Current draft/);
});

test('passes provider tracking context to prompt as logistics source', () => {
  const prompt = buildCopilotChatPrompt({
    knowledgeBase: 'Guide text',
    conversationText: 'INCOMING Customer: The tracking has not updated.',
    shopifyContext: {
      selected_order: {
        name: '#1421',
        fulfillments: [
          {
            display_status: 'CONFIRMED',
            tracking_numbers: ['0082800082809769818715'],
            tracking: [{ company: 'CTT Express', number: '0082800082809769818715' }]
          }
        ]
      },
      selection_reason: 'Matched explicit order #1421.',
      orders: [],
      warnings: []
    },
    latestMessage: 'The tracking has not updated.',
    agentEmail: 'agent@example.com',
    supportCase: {
      type: 'customs_pending',
      confidence: 'high',
      reasons: ['tracking_present', 'local_handoff_carrier:CTT Express']
    },
    providerTrackingContext: {
      available: true,
      source: 'provider_portal',
      provider_id: 1,
      provider_name: 'Mign Jin',
      tracking_number: '0082800082809769818715',
      last_update_at: '2026-06-18 10:14:57',
      last_record: 'Delivery Service Provider',
      normalized_status: 'delivery_service_provider',
      customs_status: 'customs_clearance_completed',
      latest_events: [
        { date: '2026-06-18 10:14:57', record: 'Delivery Service Provider', normalized_status: 'delivery_service_provider' },
        { date: '2026-06-14 12:11:20', record: 'Customs clearance completed', normalized_status: 'customs_clearance_completed' }
      ],
      timeline: []
    },
    chatMessages: [{ role: 'user', content: 'Generate a reply.' }]
  });

  assert.match(prompt.user, /Provider tracking context/);
  assert.match(prompt.user, /customs_clearance_completed/);
  assert.match(prompt.user, /Delivery Service Provider/);
  assert.match(prompt.system, /Provider tracking context overrides older Shopify\/17TRACK logistics facts/);
  assert.match(prompt.system, /Do not describe a logistics state that contradicts provider_tracking_context/);
});

test('passes carrier delivery estimates as facts without customer policy wording', () => {
  const prompt = buildCopilotChatPrompt({
    knowledgeBase: 'Guide text',
    conversationText: 'INCOMING Customer: Any update on delivery?',
    shopifyContext: {
      selected_order: {
        name: '#8888',
        fulfillments: [
          {
            created_at: '2026-06-10T12:00:00Z',
            tracking_numbers: ['GV123'],
            tracking: [{ company: 'Royal Mail', number: 'GV123' }]
          }
        ]
      },
      selection_reason: 'Matched explicit order #8888.',
      orders: [],
      warnings: []
    },
    latestMessage: 'Any update on delivery?',
    agentEmail: 'agent@example.com',
    deliveryEstimateContext: {
      available: true,
      source: 'kits_republic_orders',
      carrier: 'Royal Mail',
      avg_transit_days: 6.2,
      delivered_pct: 86.6,
      sample_size: 590,
      fulfilled_count: 681,
      delivered_count: 590,
      fulfilled_at: '2026-06-10T12:00:00.000Z',
      delivered_at: null,
      days_since_fulfillment: 3.5,
      estimated_remaining_days: 2.7,
      confidence: 'high',
      reason: 'recent_average'
    },
    chatMessages: [{ role: 'user', content: 'Tell them when it usually arrives.' }]
  });

  assert.match(prompt.system, /Delivery analytics evidence rule/);
  assert.match(prompt.system, /case evidence, not as policy or a delivery promise/);
  assert.match(prompt.system, /Never expose exact remaining-day calculations/);
  assert.doesNotMatch(prompt.system, /7-15 days|shipping-policy|Delivery timing guidance/);
  assert.match(prompt.user, /Delivery estimate context/);
  assert.doesNotMatch(prompt.user, /Delivery timing guidance|customer_guidance|"tone"/);
  assert.match(prompt.user, /"carrier": "Royal Mail"/);
  assert.match(prompt.user, /"avg_transit_days": 6.2/);
  assert.match(prompt.user, /"estimated_remaining_days": 2.7/);
});

test('passes raw delivery analytics without generated timing guidance', () => {
  const prompt = buildCopilotChatPrompt({
    knowledgeBase: 'Guide text',
    conversationText: 'INCOMING Customer: Royal Mail has no update.',
    shopifyContext: {
      selected_order: {
        name: '#9999',
        fulfillments: [
          {
            created_at: '2026-06-07T12:00:00Z',
            tracking_numbers: ['GV500891495GB'],
            tracking: [{ company: 'Royal Mail', number: 'GV500891495GB' }]
          }
        ]
      },
      selection_reason: 'Matched explicit order #9999.',
      orders: [],
      warnings: []
    },
    latestMessage: 'Royal Mail has no update.',
    supportCase: {
      type: 'customs_pending',
      confidence: 'medium',
      reasons: ['tracking_present', 'local_handoff_carrier:Royal Mail']
    },
    deliveryEstimateContext: {
      available: true,
      carrier: 'Royal Mail',
      avg_transit_days: 6.2,
      days_since_fulfillment: 5.4,
      estimated_remaining_days: 0.8,
      confidence: 'medium'
    },
    chatMessages: [{ role: 'user', content: 'Generate a reply' }]
  });

  assert.match(prompt.user, /"avg_transit_days": 6.2/);
  assert.match(prompt.user, /"estimated_remaining_days": 0.8/);
  assert.doesNotMatch(prompt.user, /"tone"|customer_guidance|updates around this point/);
  assert.match(prompt.system, /Never expose exact remaining-day calculations/);
});

test('builds CTT customs context from verified tracking facts only', () => {
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
  assert.match(prompt.user, /"local_carrier": "CTT Express"/);
  assert.match(prompt.user, /kitsrepublic\.com\/apps\/17TRACK\?nums=0082800082809769931372/);
  assert.doesNotMatch(prompt.user, /Pendiente de entrada en red|label\/details have been sent|in consolidation|normal for this status/);
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
  assert.match(prompt.user, /agent_briefing must be null/);
  assert.match(prompt.user, /draft must be written in English/);
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

  assert.match(prompt.system, /agent instructions and agent_confirmed_facts override Shopify/);
  assert.match(prompt.system, /Published Playbooks remain the only authority for commercial policy/);
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

  assert.match(prompt.system, /Do not challenge, debate, or correct explicit agent instructions/);
  assert.match(prompt.system, /customer_email_was_missing, customer_email_added, future_updates_enabled, or order_access_link_provided/);
  assert.match(prompt.system, /include that exact link once/);
  assert.match(prompt.system, /Published Playbooks source-of-truth rule/);
  assert.match(prompt.system, /cannot create or override commercial policy/);
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

test('honors explicit Catalan draft language request from the agent', () => {
  const prompt = buildCopilotChatPrompt({
    knowledgeBase: 'Guide text',
    conversationText: 'INCOMING Customer: Hola, no veo actualizaciones del envio.',
    shopifyContext: {
      selected_order: {
        name: '#9999',
        shipping_address: { country_code: 'ES' },
        fulfillments: [
          {
            tracking_numbers: ['0082800082809769931372'],
            tracking: [{ company: 'CTT Express', number: '0082800082809769931372' }]
          }
        ]
      },
      selection_reason: 'Matched explicit order #9999.',
      orders: [],
      warnings: []
    },
    latestMessage: 'Hola, no veo actualizaciones del envio.',
    agentEmail: 'agent@example.com',
    supportCase: {
      type: 'customs_pending',
      confidence: 'high',
      reasons: ['tracking_present', 'local_handoff_carrier:CTT Express']
    },
    chatMessages: [
      {
        role: 'user',
        content: 'contesta en catala. digali que si, es normal. cas aduanas'
      },
      {
        role: 'assistant',
        content: 'I will update it in Spanish.'
      },
      {
        role: 'user',
        content: 'en catalan!!!'
      }
    ]
  });

  assert.match(prompt.user, /Response language: Catalan \(source: agent_explicit_language_request, country ES\)/);
  assert.match(prompt.user, /DRAFT_LANGUAGE_LOCK: Catalan/);
  assert.match(prompt.user, /draft must be written in Catalan/);
  assert.match(prompt.system, /If Response language source is agent_explicit_language_request/);
  assert.doesNotMatch(prompt.user, /DRAFT_LANGUAGE_LOCK: Spanish/);
});

test('passes approved support memories to copilot chat prompt', () => {
  const prompt = buildCopilotChatPrompt({
    knowledgeBase: 'Guide text',
    conversationText: 'INCOMING Customer: Royal Mail has no updates.',
    shopifyContext: {
      selected_order: {
        name: '#3333',
        shipping_address: { country_code: 'GB' },
        fulfillments: [
          {
            tracking_numbers: ['GV123'],
            tracking: [{ company: 'Royal Mail', number: 'GV123' }]
          }
        ]
      },
      selection_reason: 'Matched explicit order #3333.',
      orders: [],
      warnings: []
    },
    latestMessage: 'Royal Mail has no updates.',
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
    approvedMemories: [
      {
        id: 4,
        content: 'For Royal Mail no updates, explain customs clearance in normal language.',
        support_case_type: 'customs_pending',
        carrier: 'Royal Mail',
        language: 'English'
      }
    ],
    chatMessages: [{ role: 'user', content: 'Generate a reply.' }]
  });

  assert.match(prompt.system, /Approved support memories are global, agent-approved wording and case interpretation hints/);
  assert.match(prompt.system, /may not supply policy, causes, timeframes, compensation, coupon codes/);
  assert.match(prompt.system, /must not replace Shopify order facts/);
  assert.match(prompt.user, /Approved support memories/);
  assert.match(prompt.user, /For Royal Mail no updates, explain customs clearance in normal language/);
});
