import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCopilotCommand } from '../src/memory.js';
import {
  runNewTicketCommand,
  runPendingTicketFeedback
} from '../src/new-ticket.js';

test('prepares a new ticket proposal for selected order and provider', async () => {
  const result = await runNewTicketCommand({
    command: parseCopilotCommand('/newticket supplier says no stock for XL'),
    config: { kitsAdminBaseUrl: 'https://admin.example.com' },
    context: context()
  });

  assert.equal(result.handled, true);
  assert.equal(result.pending_issue.order_ref, '#2590');
  assert.equal(result.pending_issue.provider_id, 7);
  assert.equal(result.pending_issue.issue_type, 'stock');
  assert.match(result.assistant_message, /New issue proposal/);
  assert.match(result.assistant_message, /\/newticket approve/);
  assert.equal(result.skip_insert, true);
});

test('blocks new ticket proposal when no single order is selected', async () => {
  const result = await runNewTicketCommand({
    command: parseCopilotCommand('/newticket supplier says no stock'),
    config: { kitsAdminBaseUrl: 'https://admin.example.com' },
    context: {
      shopifyContext: { selected_order: null, orders: [{ name: '#1' }, { name: '#2' }] },
      providerContext: { provider: null }
    }
  });

  assert.equal(result.pending_issue, null);
  assert.match(result.assistant_message, /multiple Shopify orders/i);
});

test('revises pending ticket from agent feedback', () => {
  const pendingIssue = {
    order_ref: '#2590',
    provider_id: 7,
    provider_label: 'Mign Jin (1)',
    issue_type: 'stock',
    message: 'Stock issue for order #2590: supplier says no stock'
  };

  const result = runPendingTicketFeedback({
    message: 'cambialo a missing size y añade que es urgente',
    pendingIssue
  });

  assert.equal(result.pending_issue.issue_type, 'missing_size');
  assert.match(result.pending_issue.message, /^Urgent:/);
  assert.match(result.pending_issue.message, /Agent update:/);
});

test('approves pending ticket through internal admin API', async t => {
  const calls = [];
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, issue: { id: 22 } })
    };
  };

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

function context() {
  return {
    shopifyContext: {
      selected_order: { name: '#2590' },
      orders: [{ name: '#2590' }]
    },
    providerContext: {
      provider: {
        id: 7,
        label: 'Mign Jin (1)'
      }
    }
  };
}
