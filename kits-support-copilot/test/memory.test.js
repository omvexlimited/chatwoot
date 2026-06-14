import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildMemoryRecord,
  formatPromptMemories,
  getRelevantMemories,
  latestUserCommand,
  parseCopilotCommand,
  rankRelevantMemories,
  runMemoryCommand
} from '../src/memory.js';

test('parses copilot memory commands', () => {
  assert.deepEqual(parseCopilotCommand('/remember For CTT pending receipt, explain customs.'), {
    name: 'remember',
    argument: 'For CTT pending receipt, explain customs.'
  });
  assert.deepEqual(parseCopilotCommand('/memories'), { name: 'memories', argument: '' });
  assert.deepEqual(parseCopilotCommand('/forget 12'), { name: 'forget', argument: '12' });
  assert.deepEqual(parseCopilotCommand('/newticket supplier says no stock'), {
    name: 'newticket',
    argument: 'supplier says no stock'
  });
  assert.deepEqual(parseCopilotCommand('/grammar'), { name: 'grammar', argument: '' });
  assert.deepEqual(parseCopilotCommand('/help'), { name: 'help', argument: '' });
  assert.equal(parseCopilotCommand('normal message'), null);
});

test('finds latest user slash command from chat messages', () => {
  const command = latestUserCommand([
    { role: 'user', content: '/remember Old rule' },
    { role: 'assistant', content: 'Saved.' },
    { role: 'user', content: '/help' }
  ]);

  assert.deepEqual(command, { name: 'help', argument: '' });
});

test('builds memory record with context tags', () => {
  const record = buildMemoryRecord({
    content: 'For CTT pending receipt, explain customs pre-entry clearly.',
    createdBy: 'agent@example.com',
    context: {
      conversationId: 37,
      contactEmail: 'customer@example.com',
      responseLanguage: { language: 'English' },
      supportCase: { type: 'customs_pending' },
      shopifyContext: {
        selected_order: {
          fulfillments: [
            {
              tracking: [{ company: 'CTT Express', number: '0082800082809769931372' }]
            }
          ]
        }
      }
    }
  });

  assert.equal(record.content, 'For CTT pending receipt, explain customs pre-entry clearly.');
  assert.equal(record.support_case_type, 'customs_pending');
  assert.equal(record.carrier, 'CTT Express');
  assert.equal(record.language, 'English');
  assert.equal(record.created_by, 'agent@example.com');
  assert.equal(record.conversation_id, '37');
  assert.equal(record.contact_email, 'customer@example.com');
  assert.ok(record.tags.includes('customs_pending'));
  assert.ok(record.tags.includes('ctt_express'));
});

test('runs /help without memory database configuration', async () => {
  const result = await runMemoryCommand({
    command: parseCopilotCommand('/help'),
    config: {}
  });

  assert.equal(result.handled, true);
  assert.equal(result.preserve_draft, true);
  assert.equal(result.skip_insert, true);
  assert.match(result.assistant_message, /\/remember <text>/);
  assert.match(result.assistant_message, /\/memories/);
  assert.match(result.assistant_message, /\/forget <id>/);
  assert.match(result.assistant_message, /\/grammar/);
  assert.match(result.assistant_message, /\/help/);
});

test('returns clear memory not configured response for storage commands', async () => {
  const result = await runMemoryCommand({
    command: parseCopilotCommand('/remember Use a single tracking link.'),
    config: {}
  });

  assert.equal(result.handled, true);
  assert.match(result.assistant_message, /Memory is not configured/);
});

test('runs /remember with injectable store without calling OpenAI', async () => {
  const savedRecords = [];
  const result = await runMemoryCommand({
    command: parseCopilotCommand('/remember Always use one tracking link.'),
    config: { copilotDatabaseUrl: 'postgres://memory' },
    agentEmail: 'agent@example.com',
    context: {
      conversationId: 37,
      contactEmail: 'customer@example.com',
      responseLanguage: { language: 'English' },
      supportCase: { type: 'customs_pending' },
      shopifyContext: {}
    },
    store: {
      save: async ({ record }) => {
        savedRecords.push(record);
        return { id: 7, ...record };
      }
    }
  });

  assert.equal(savedRecords.length, 1);
  assert.equal(savedRecords[0].content, 'Always use one tracking link.');
  assert.equal(result.preserve_draft, true);
  assert.equal(result.skip_insert, true);
  assert.match(result.assistant_message, /Saved memory #7/);
});

test('runs /memories with injectable store', async () => {
  const result = await runMemoryCommand({
    command: parseCopilotCommand('/memories'),
    config: { copilotDatabaseUrl: 'postgres://memory' },
    store: {
      list: async () => [
        { id: 2, content: 'Use customs wording.', support_case_type: 'customs_pending', carrier: 'Royal Mail', language: 'English' }
      ]
    }
  });

  assert.match(result.assistant_message, /#2 \(customs_pending · Royal Mail · English\): Use customs wording\./);
});

test('runs /forget with injectable store', async () => {
  const result = await runMemoryCommand({
    command: parseCopilotCommand('/forget 2'),
    config: { copilotDatabaseUrl: 'postgres://memory' },
    store: {
      forget: async ({ id }) => ({ id, content: 'Use customs wording.' })
    }
  });

  assert.match(result.assistant_message, /Forgot memory #2/);
});

test('ranks relevant memories by support case carrier and keywords', () => {
  const memories = rankRelevantMemories({
    context: {
      latestMessage: 'Royal Mail has no updates.',
      conversationText: 'Customer asks why Royal Mail still has no update.',
      responseLanguage: { language: 'English' },
      supportCase: { type: 'customs_pending' },
      shopifyContext: {
        selected_order: {
          fulfillments: [
            {
              tracking: [{ company: 'Royal Mail', number: 'GV123' }]
            }
          ]
        }
      }
    },
    chatMessages: [{ role: 'user', content: 'Generate a reply.' }],
    rows: [
      {
        id: 1,
        content: 'For Royal Mail no updates, explain customs clearance in normal language.',
        tags: ['royal_mail', 'customs'],
        support_case_type: 'customs_pending',
        carrier: 'Royal Mail',
        language: 'English',
        active: true
      },
      {
        id: 2,
        content: 'For size exchanges, offer the 50% coupon.',
        tags: ['size', 'exchange'],
        support_case_type: null,
        carrier: null,
        language: 'English',
        active: true
      }
    ]
  });

  assert.equal(memories[0].id, 1);
  assert.equal(memories.length, 1);
});

test('formats memories for prompt without internal metadata', () => {
  assert.deepEqual(formatPromptMemories([
    {
      id: 3,
      content: 'Use one tracking link.',
      support_case_type: 'customs_pending',
      carrier: 'Royal Mail',
      language: 'English',
      created_by: 'agent@example.com'
    }
  ]), [
    {
      id: 3,
      content: 'Use one tracking link.',
      support_case_type: 'customs_pending',
      carrier: 'Royal Mail',
      language: 'English'
    }
  ]);
});

test('getRelevantMemories returns empty result when memory is not configured', async () => {
  const result = await getRelevantMemories({ config: {} });

  assert.deepEqual(result, { memories: [], warnings: [] });
});
