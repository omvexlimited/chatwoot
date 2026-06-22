import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import {
  buildAgentBriefing,
  buildPreparedDraftPayload,
  enqueuePreparedDraftFromWebhook,
  formatAgentBriefingForChat,
  getPreparedDraft,
  parsePreparedDraftWebhook,
  verifyChatwootWebhookSignature
} from '../src/prepared-drafts.js';

test('verifies Chatwoot webhook HMAC signatures', () => {
  const secret = 'webhook-secret';
  const rawBody = JSON.stringify({ event: 'message_created', content: 'Hi' });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;

  assert.equal(verifyChatwootWebhookSignature({ secret, rawBody, timestamp, signature }), true);
  assert.equal(verifyChatwootWebhookSignature({ secret, rawBody, timestamp, signature: 'sha256=bad' }), false);
});

test('rejects stale Chatwoot webhook signatures', () => {
  const secret = 'webhook-secret';
  const rawBody = '{}';
  const timestamp = '100';
  const signature = `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;

  assert.equal(
    verifyChatwootWebhookSignature({
      secret,
      rawBody,
      timestamp,
      signature,
      now: 1_000_000_000
    }),
    false
  );
});

test('parses incoming public Chatwoot webhooks into prepared draft jobs', () => {
  const parsed = parsePreparedDraftWebhook({
    event: 'message_created',
    id: 987,
    message_type: 'incoming',
    private: false,
    content: 'Where is my order?',
    account: { id: 1 },
    conversation: { id: 204, meta: { sender: { email: 'customer@example.com' } } },
    sender: { email: 'customer@example.com' }
  });

  assert.equal(parsed.ignored, false);
  assert.deepEqual(parsed.job, {
    account_id: '1',
    conversation_id: '204',
    chatwoot_message_id: '987',
    contact_email: 'customer@example.com',
    webhook_payload: {
      event: 'message_created',
      id: 987,
      message_type: 'incoming',
      private: false,
      content: 'Where is my order?',
      account: { id: 1 },
      conversation: { id: 204, meta: { sender: { email: 'customer@example.com' } } },
      sender: { email: 'customer@example.com' }
    }
  });
});

test('prefers Chatwoot display conversation_id from message webhooks', () => {
  const parsed = parsePreparedDraftWebhook({
    event: 'message_created',
    id: 987,
    message_type: 0,
    private: false,
    content: 'Where is my order?',
    account: { id: 1 },
    conversation_id: 620,
    conversation: { id: 12345, display_id: 620, meta: { sender: { email: 'customer@example.com' } } },
    sender: { email: 'customer@example.com' }
  });

  assert.equal(parsed.ignored, false);
  assert.equal(parsed.job.conversation_id, '620');
});

test('ignores outgoing, private and empty webhooks', () => {
  assert.equal(parsePreparedDraftWebhook({ event: 'message_created', message_type: 'outgoing' }).reason, 'not_incoming');
  assert.equal(parsePreparedDraftWebhook({ event: 'message_created', message_type: 'incoming', private: true }).reason, 'private_message');
  assert.equal(parsePreparedDraftWebhook({ event: 'message_created', message_type: 'incoming', content: '' }).reason, 'empty_content');
});

test('builds the context payload from a prepared draft row', () => {
  const payload = buildPreparedDraftPayload({
    account_id: '1',
    conversation_id: '204',
    contact_email: 'customer@example.com',
    webhook_payload: {
      content: 'Order number 2280 has it been dispatched',
      content_attributes: { email: { subject: 'Commande #2280' } },
      conversation: { id: 204, display_id: 204 },
      sender: { email: 'customer@example.com', phone_number: '07950527911' }
    }
  });

  assert.equal(payload.account_id, '1');
  assert.equal(payload.conversation_id, '204');
  assert.equal(payload.contact_email, 'customer@example.com');
  assert.equal(payload.contact_phone, '07950527911');
  assert.equal(payload.latest_message, 'Order number 2280 has it been dispatched');
  assert.equal(payload.latest_subject, 'Commande #2280');
});

test('stores prepared draft jobs in memory when database is not configured', async () => {
  const payload = {
    event: 'message_created',
    id: 'memory-message-1',
    message_type: 'incoming',
    private: false,
    content: 'Where is my order?',
    account: { id: 'memory-account' },
    conversation: { id: 'memory-conversation' },
    sender: { email: 'customer@example.com' }
  };

  const result = await enqueuePreparedDraftFromWebhook({ config: {}, payload });
  assert.equal(result.enqueued, true);

  const stored = await getPreparedDraft({
    config: {},
    accountId: 'memory-account',
    conversationId: 'memory-conversation',
    latestMessageId: 'memory-message-1'
  });
  assert.equal(stored.status, 'pending');
  assert.equal(stored.chatwoot_message_id, 'memory-message-1');
});

test('stores generated memory prepared drafts with inserted timestamp', async () => {
  const payload = {
    event: 'message_created',
    id: 'memory-message-inserted',
    message_type: 'incoming',
    private: false,
    content: 'Where is my order?',
    account: { id: 'memory-account' },
    conversation: { id: 'memory-conversation' },
    sender: { email: 'customer@example.com' }
  };

  await enqueuePreparedDraftFromWebhook({ config: {}, payload });
  const { processPendingPreparedDrafts } = await import('../src/prepared-drafts.js');
  await processPendingPreparedDrafts({
    config: {},
    generate: async () => ({
      draft: 'Prepared draft',
      assistant_message: 'Prepared.',
      inserted_at: '2026-06-19T10:00:00.000Z'
    }),
    limit: 1
  });

  const stored = await getPreparedDraft({
    config: {},
    accountId: 'memory-account',
    conversationId: 'memory-conversation',
    latestMessageId: 'memory-message-inserted'
  });

  assert.equal(stored.status, 'generated');
  assert.equal(stored.inserted_at, '2026-06-19T10:00:00.000Z');
});

test('builds actionable agent briefing for size change requests', () => {
  const briefing = buildAgentBriefing({
    context: {
      latestMessage: 'Hi, can you switch both shirts to XXL instead of XL?',
      conversationText: '',
      warnings: [],
      shopifyContext: {
        selected_order: {
          name: '#1001',
          fulfillment_status: 'UNFULFILLED',
          fulfillments: []
        }
      }
    },
    result: {
      reasoning_summary: 'Customer asked for a size change.',
      warnings: []
    }
  });

  assert.equal(briefing.detected_case, 'size_change_request');
  assert.equal(briefing.action_required, true);
  assert.match(briefing.before_sending_checklist.join('\n'), /#1001/);
  assert.match(briefing.before_sending_checklist.join('\n'), /XL a XXL/);
});

test('formats agent briefing for the copilot chat bubble', () => {
  const text = formatAgentBriefingForChat({
    detected_case: 'tracking_update',
    before_sending_checklist: ['Review the draft and send if correct.'],
    customer_reply_summary: ['Explain the shipment status.'],
    risks_or_warnings: ['Email differs from Shopify order email.']
  });

  assert.match(text, /Borrador preparado/);
  assert.match(text, /Acción necesaria antes de enviar/);
  assert.match(text, /Resumen de respuesta al cliente/);
  assert.match(text, /Avisos/);
});
