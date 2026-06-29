import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCopilotCommand } from '../src/memory.js';
import {
  runNewTicketCommand,
  runPendingTicketFeedback
} from '../src/new-ticket.js';

test('prepares a new ticket proposal from selected order provider and conversation context', async t => {
  const calls = mockFetch(t, async () => openAiResponse({
    action: 'proposal',
    issue_type: 'shipping',
    affected_line_item_ids: ['gid://shopify/LineItem/111'],
    message: 'Shipping issue for order #2590: customer reports no tracking updates after dispatch; ask supplier to confirm parcel handoff status.',
    confidence: 'high',
    warnings: []
  }));

  const result = await runNewTicketCommand({
    command: parseCopilotCommand('/newticket'),
    config: openAiConfig(),
    context: context({
      latestMessage: 'My tracking has not updated for several days. Can you check it?'
    })
  });

  assert.equal(result.handled, true);
  assert.equal(result.pending_issue.order_ref, '#2590');
  assert.equal(result.pending_issue.provider_id, 7);
  assert.equal(result.pending_issue.issue_type, 'shipping');
  assert.deepEqual(result.pending_issue.affected_line_item_ids, ['gid://shopify/LineItem/111']);
  assert.match(result.assistant_message, /Line item: England 2026 Home Jersey/);
  assert.match(result.pending_issue.message, /customer reports no tracking updates/i);
  assert.match(result.assistant_message, /New issue proposal/);
  assert.match(result.assistant_message, /\/newticket approve/);
  assert.equal(result.skip_insert, true);
  assert.match(calls[0].options.body, /Latest customer message/);
});

test('formats generated issue message as brief whatsapp-style note', async t => {
  mockFetch(t, async () => openAiResponse({
    action: 'proposal',
    issue_type: 'shipping',
    message: 'Order #3440 is marked not delivered with CTT Express tracking 0082800082809770332134. Customer reports they cannot reach CTT by email or phone, and tracking shows the parcel is pending to be sent/picked up. Please contact CTT/carrier to confirm parcel status, prevent return if applicable, and arrange delivery or pickup instructions for the customer.',
    confidence: 'high',
    warnings: []
  }));

  const result = await runNewTicketCommand({
    command: parseCopilotCommand('/newticket'),
    config: openAiConfig(),
    context: context({
      orderOverrides: {
        name: '#3440',
        fulfillments: [
          {
            tracking: [
              {
                company: 'CTT Express',
                number: '0082800082809770332134'
              }
            ]
          }
        ]
      }
    })
  });

  assert.match(result.pending_issue.message, /^#3440 \| 0082800082809770332134\n/);
  assert.match(result.pending_issue.message, /Customer reports they cannot reach CTT/i);
  assert.ok(result.pending_issue.message.length < 300);
  assert.doesNotMatch(result.pending_issue.message, /prevent return if applicable, and arrange delivery or pickup instructions/);
});

test('uses optional newticket hint with context when OpenAI is unavailable', async () => {
  const result = await runNewTicketCommand({
    command: parseCopilotCommand('/newticket supplier says no stock for XL'),
    config: { kitsAdminBaseUrl: 'https://admin.example.com' },
    context: context()
  });

  assert.equal(result.handled, true);
  assert.equal(result.pending_issue.order_ref, '#2590');
  assert.equal(result.pending_issue.provider_id, 7);
  assert.equal(result.pending_issue.issue_type, 'stock');
  assert.deepEqual(result.pending_issue.affected_line_item_ids, ['gid://shopify/LineItem/111']);
  assert.match(result.pending_issue.message, /supplier says no stock for XL/i);
});

test('warns about existing open ticket before showing a new proposal', async t => {
  mockFetch(t, async () => openAiResponse({
    action: 'proposal',
    issue_type: 'shipping',
    message: 'Shipping issue for order #2590: ask supplier to check handoff.',
    confidence: 'medium',
    warnings: []
  }));

  const result = await runNewTicketCommand({
    command: parseCopilotCommand('/newticket'),
    config: openAiConfig(),
    context: context({
      issueContext: {
        available: true,
        order_ref: '#2590',
        total: 1,
        issues: [
          {
            issue_id: 22,
            issue_type: 'shipping',
            provider: 'Mign Jin (1)',
            status: 'open',
            url: 'https://admin.example.com/kits-republic/issues/22'
          }
        ]
      }
    })
  });

  assert.match(result.assistant_message, /Open ticket already exists/i);
  assert.match(result.assistant_message, /#22 · shipping · Mign Jin \(1\) · open/);
  assert.match(result.assistant_message, /New issue proposal/);
  assert.match(result.assistant_message, /\/newticket approve/);
});

test('adds image attachments to evidence issue proposals', async t => {
  mockFetch(t, async () => openAiResponse({
    action: 'proposal',
    issue_type: 'damaged',
    affected_line_item_ids: ['gid://shopify/LineItem/111'],
    attachment_ids: ['att-1'],
    message: 'Customer reports the shirt arrived damaged. Ask supplier to replace the affected item.',
    confidence: 'high',
    warnings: []
  }));

  const result = await runNewTicketCommand({
    command: parseCopilotCommand('/newticket'),
    config: openAiConfig(),
    context: context({
      attachmentCandidates: [
        {
          id: 'att-1',
          filename: 'damage.jpg',
          content_type: 'image/jpeg',
          file_size: 512000,
          width: 1200,
          height: 900,
          data_url: '/rails/active_storage/damage',
          message_id: 100
        }
      ]
    })
  });

  assert.equal(result.pending_issue.issue_type, 'damaged');
  assert.equal(result.pending_issue.attachments.length, 1);
  assert.match(result.assistant_message, /Attachments: 1 image\(s\)/);
  assert.match(result.assistant_message, /damage\.jpg/);
});

test('asks for detail when newticket has no hint and OpenAI is unavailable', async () => {
  const result = await runNewTicketCommand({
    command: parseCopilotCommand('/newticket'),
    config: { kitsAdminBaseUrl: 'https://admin.example.com' },
    context: context()
  });

  assert.equal(result.pending_issue, null);
  assert.match(result.assistant_message, /one more detail/i);
});

test('blocks new ticket proposal when no single order is selected', async () => {
  const result = await runNewTicketCommand({
    command: parseCopilotCommand('/newticket'),
    config: { kitsAdminBaseUrl: 'https://admin.example.com' },
    context: {
      shopifyContext: { selected_order: null, orders: [{ name: '#1' }, { name: '#2' }] },
      providerContext: { provider: null }
    }
  });

  assert.equal(result.pending_issue, null);
  assert.match(result.assistant_message, /multiple Shopify orders/i);
});

test('revises pending ticket from agent feedback with OpenAI', async t => {
  mockFetch(t, async () => openAiResponse({
    action: 'proposal',
    issue_type: 'missing_size',
    message: 'Urgent missing size issue for order #2590: supplier needs to confirm availability of size XL before processing.',
    confidence: 'high',
    warnings: []
  }));
  const pendingIssue = {
    order_ref: '#2590',
    provider_id: 7,
    provider_label: 'Mign Jin (1)',
    issue_type: 'stock',
    message: 'Stock issue for order #2590: supplier says no stock'
  };

  const result = await runPendingTicketFeedback({
    message: 'cambialo a missing size y añade que es urgente',
    pendingIssue,
    config: openAiConfig(),
    context: context()
  });

  assert.equal(result.pending_issue.issue_type, 'missing_size');
  assert.match(result.pending_issue.message, /^#2590\nUrgent missing size/i);
  assert.doesNotMatch(result.pending_issue.message, /order #2590/i);
});

test('falls back when revising pending ticket without OpenAI', async () => {
  const pendingIssue = {
    order_ref: '#2590',
    provider_id: 7,
    provider_label: 'Mign Jin (1)',
    issue_type: 'stock',
    message: 'Stock issue for order #2590: supplier says no stock'
  };

  const result = await runPendingTicketFeedback({
    message: 'cambialo a missing size y añade que es urgente',
    pendingIssue,
    config: {},
    context: context()
  });

  assert.equal(result.pending_issue.issue_type, 'missing_size');
  assert.match(result.pending_issue.message, /^#2590\nUrgent:/);
  assert.match(result.pending_issue.message, /Agent update:/);
});

test('approves pending ticket through internal admin API', async t => {
  const calls = mockFetch(t, async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, issue: { id: 22 } })
  }));

  const result = await runNewTicketCommand({
    command: parseCopilotCommand('/newticket approve'),
    config: {
      kitsAdminBaseUrl: 'https://admin.example.com',
      kitsInternalApiToken: 'secret'
    },
    context: context(),
    pendingIssue: {
      order_ref: '#2590',
      provider_id: 7,
      provider_label: 'Mign Jin (1)',
      issue_type: 'stock',
      message: 'Stock issue for order #2590: no stock'
    }
  });

  assert.equal(result.pending_issue, null);
  assert.match(result.assistant_message, /Issue created/);
  assert.equal(calls[0].url, 'https://admin.example.com/internal/kits-republic/issues');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    order_ref: '#2590',
    provider_id: 7,
    issue_type: 'stock',
    message: 'Stock issue for order #2590: no stock'
  });
});

test('approves pending ticket with affected line item ids', async t => {
  const calls = mockFetch(t, async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, issue: { id: 23 } })
  }));

  const result = await runNewTicketCommand({
    command: parseCopilotCommand('/newticket approve'),
    config: {
      kitsAdminBaseUrl: 'https://admin.example.com',
      kitsInternalApiToken: 'secret'
    },
    context: context(),
    pendingIssue: {
      order_ref: '#2590',
      provider_id: 7,
      provider_label: 'Mign Jin (1)',
      issue_type: 'missing_size',
      affected_line_item_ids: ['gid://shopify/LineItem/111'],
      affected_line_items: [
        {
          shopify_line_item_id: 'gid://shopify/LineItem/111',
          label: 'England 2026 Home Jersey · ENG-HOME-XL'
        }
      ],
      allow_without_attachments: true,
      message: 'Missing size issue for order #2590: wrong size received'
    }
  });

  assert.equal(result.pending_issue, null);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    order_ref: '#2590',
    provider_id: 7,
    issue_type: 'missing_size',
    message: 'Missing size issue for order #2590: wrong size received',
    affected_line_item_ids: ['gid://shopify/LineItem/111']
  });
});

test('approves pending ticket with image attachments through multipart API', async t => {
  const calls = mockFetch(t, async (url) => {
    if (String(url).includes('/rails/active_storage/damage')) {
      return {
        ok: true,
        status: 200,
        headers: { get: key => (key.toLowerCase() === 'content-type' ? 'image/jpeg' : '') },
        arrayBuffer: async () => Buffer.from('fake-image')
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, issue: { id: 24, attachment_count: 1 } })
    };
  });

  const result = await runNewTicketCommand({
    command: parseCopilotCommand('/newticket approve'),
    config: {
      kitsAdminBaseUrl: 'https://admin.example.com',
      kitsInternalApiToken: 'secret',
      chatwootBaseUrl: 'https://chatwoot.example.com',
      chatwootApiToken: 'chatwoot-secret'
    },
    context: context(),
    pendingIssue: {
      order_ref: '#2590',
      provider_id: 7,
      provider_label: 'Mign Jin (1)',
      issue_type: 'damaged',
      affected_line_item_ids: ['gid://shopify/LineItem/111'],
      attachments: [
        {
          id: 'att-1',
          filename: 'damage.jpg',
          content_type: 'image/jpeg',
          data_url: '/rails/active_storage/damage'
        }
      ],
      message: 'Customer reports the item arrived damaged.'
    }
  });

  assert.equal(result.pending_issue, null);
  assert.equal(calls[0].url, 'https://chatwoot.example.com/rails/active_storage/damage');
  assert.equal(calls[1].url, 'https://admin.example.com/internal/kits-republic/issues');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer secret');
  assert.equal(calls[1].options.body instanceof FormData, true);
  assert.match(result.assistant_message, /Attachments: 1 image\(s\)/);
});

test('blocks evidence issue approval without attachments until agent explicitly removes them', async () => {
  const result = await runNewTicketCommand({
    command: parseCopilotCommand('/newticket approve'),
    config: {
      kitsAdminBaseUrl: 'https://admin.example.com',
      kitsInternalApiToken: 'secret'
    },
    context: context(),
    pendingIssue: {
      order_ref: '#2590',
      provider_id: 7,
      provider_label: 'Mign Jin (1)',
      issue_type: 'damaged',
      message: 'Customer reports the item arrived damaged.'
    }
  });

  assert.equal(result.pending_issue.issue_type, 'damaged');
  assert.match(result.assistant_message, /customer photos/i);
});

test('agent feedback can remove pending issue attachments', async () => {
  const result = await runPendingTicketFeedback({
    message: 'sin adjuntos',
    pendingIssue: {
      order_ref: '#2590',
      provider_id: 7,
      provider_label: 'Mign Jin (1)',
      issue_type: 'damaged',
      attachments: [
        {
          id: 'att-1',
          filename: 'damage.jpg',
          content_type: 'image/jpeg',
          data_url: '/rails/active_storage/damage'
        }
      ],
      message: 'Customer reports the item arrived damaged.'
    },
    config: {},
    context: context()
  });

  assert.equal(result.pending_issue.attachments.length, 0);
  assert.equal(result.pending_issue.allow_without_attachments, true);
});

function context(overrides = {}) {
  const selectedOrder = {
    name: '#2590',
    email: 'craig@example.com',
    created_at: '2026-06-10T19:10:00Z',
    fulfillment_status: 'UNFULFILLED',
    shipping_address: { country: 'United Kingdom', country_code: 'GB' },
    line_items: [
      {
        id: 'gid://shopify/LineItem/111',
        shopify_line_item_id: 'gid://shopify/LineItem/111',
        name: 'England 2026 Home Jersey',
        quantity: 1,
        sku: 'ENG-HOME-XL',
        fulfillment_status: null,
        custom_attributes: [{ key: 'Size', value: 'XL' }]
      }
    ],
    fulfillments: [],
    ...(overrides.orderOverrides || {})
  };
  return {
    contactEmail: 'craig@example.com',
    latestMessage: overrides.latestMessage || 'The supplier says size XL is not available.',
    conversationText: overrides.conversationText || 'Customer: The supplier says size XL is not available.',
    supportCase: overrides.supportCase || null,
    deliveryEstimateContext: null,
    issueContext: overrides.issueContext || null,
    attachmentCandidates: overrides.attachmentCandidates || [],
    shopifyContext: {
      selected_order: selectedOrder,
      orders: [{ name: selectedOrder.name }]
    },
    providerContext: {
      provider: {
        id: 7,
        label: 'Mign Jin (1)',
        code: '194939'
      }
    }
  };
}

function openAiConfig() {
  return {
    kitsAdminBaseUrl: 'https://admin.example.com',
    openaiApiKey: 'openai-secret',
    openaiBaseUrl: 'https://openai.example.com',
    openaiModel: 'gpt-5.5'
  };
}

function mockFetch(t, handler) {
  const calls = [];
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options);
  };
  return calls;
}

function openAiResponse(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ output_text: JSON.stringify(payload) })
  };
}
