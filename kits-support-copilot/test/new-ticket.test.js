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
  assert.match(result.pending_issue.message, /customer reports no tracking updates/i);
  assert.match(result.assistant_message, /New issue proposal/);
  assert.match(result.assistant_message, /\/newticket approve/);
  assert.equal(result.skip_insert, true);
  assert.match(calls[0].options.body, /Latest customer message/);
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
  assert.match(result.pending_issue.message, /supplier says no stock for XL/i);
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
  assert.match(result.pending_issue.message, /^Urgent missing size/i);
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
  assert.match(result.pending_issue.message, /^Urgent:/);
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

function context(overrides = {}) {
  return {
    contactEmail: 'craig@example.com',
    latestMessage: overrides.latestMessage || 'The supplier says size XL is not available.',
    conversationText: overrides.conversationText || 'Customer: The supplier says size XL is not available.',
    supportCase: overrides.supportCase || null,
    deliveryEstimateContext: null,
    shopifyContext: {
      selected_order: {
        name: '#2590',
        email: 'craig@example.com',
        created_at: '2026-06-10T19:10:00Z',
        fulfillment_status: 'UNFULFILLED',
        shipping_address: { country: 'United Kingdom', country_code: 'GB' },
        line_items: [
          {
            name: 'England 2026 Home Jersey',
            quantity: 1,
            sku: 'ENG-HOME-XL',
            fulfillment_status: null,
            custom_attributes: [{ key: 'Size', value: 'XL' }]
          }
        ],
        fulfillments: []
      },
      orders: [{ name: '#2590' }]
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
    openaiModel: 'gpt-5.4-mini'
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
