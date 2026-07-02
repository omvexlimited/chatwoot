const HELP_TEXT = [
  'Available commands:',
  '',
  '/remember <text>',
  'Save a global support memory. Example: /remember For CTT pending receipt, explain customs/pre-entry clearly.',
  '',
  '/memories',
  'Show the latest saved active memories.',
  '',
  '/forget <id>',
  'Disable a saved memory by ID. Example: /forget 12',
  '',
  '/newticket',
  'Prepare a Kits Republic order issue proposal from the current conversation, selected order, provider and context.',
  '',
  '/newticket <hint>',
  'Prepare a proposal using the current context plus an optional hint. Example: /newticket supplier says size XL is missing.',
  '',
  '/newticket approve',
  'Create the currently proposed order issue.',
  '',
  '/newticket cancel',
  'Discard the current order issue proposal.',
  '',
  '/linkorder <order>',
  'Link this conversation to a Shopify order for copilot context only. Example: /linkorder #1234',
  '',
  '/unlinkorder',
  'Remove the manually linked order and return to automatic matching.',
  '',
  '/grammar',
  'Correct spelling in the current draft only, without rewriting it.',
  '',
  '/brief',
  'Show a concise internal case brief without changing the draft.',
  '',
  '/help',
  'Show this command list.'
].join('\n');

const STOP_WORDS = new Set([
  'about',
  'after',
  'also',
  'always',
  'because',
  'before',
  'cliente',
  'cuando',
  'customer',
  'desde',
  'donde',
  'entonces',
  'hacer',
  'hasta',
  'order',
  'pedido',
  'para',
  'sobre',
  'that',
  'the',
  'this',
  'with'
]);

let ensured = false;

export function parseCopilotCommand(value = '') {
  const content = String(value || '').trim();
  if (!content.startsWith('/')) return null;

  const [rawCommand, ...parts] = content.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const argument = parts.join(' ').trim();

  if (command === '/remember') {
    return { name: 'remember', argument };
  }
  if (command === '/memories') {
    return { name: 'memories', argument };
  }
  if (command === '/forget') {
    return { name: 'forget', argument };
  }
  if (command === '/newticket') {
    return { name: 'newticket', argument };
  }
  if (command === '/grammar') {
    return { name: 'grammar', argument };
  }
  if (command === '/brief') {
    return { name: 'brief', argument };
  }
  if (command === '/linkorder') {
    return { name: 'linkorder', argument };
  }
  if (command === '/unlinkorder') {
    return { name: 'unlinkorder', argument };
  }
  if (command === '/help') {
    return { name: 'help', argument };
  }

  return { name: 'unknown', argument, raw: rawCommand };
}

export function latestUserCommand(chatMessages = []) {
  const latest = [...(Array.isArray(chatMessages) ? chatMessages : [])]
    .reverse()
    .find(message => message?.role !== 'assistant')?.content || '';
  return parseCopilotCommand(latest);
}

export async function runMemoryCommand({ command, config, context, agentEmail, store = defaultMemoryStore } = {}) {
  if (!command) return null;

  if (command.name === 'help') {
    return commandResponse(HELP_TEXT);
  }
  if (command.name === 'unknown') {
    return commandResponse(`Unknown command: ${command.raw || 'unknown'}\n\nUse /help to see available commands.`);
  }
  if (command.name === 'brief') {
    return null;
  }
  if (command.name === 'linkorder' || command.name === 'unlinkorder') {
    return commandResponse('This command is handled in the copilot browser UI. Refresh Chatwoot and try again if it did not update the context.');
  }

  if (!memoryConfigured(config)) {
    return commandResponse('Memory is not configured. Configure KITS_REPUBLIC_DATABASE_URL with the Kits Republic admin database to enable /remember, /memories and /forget.');
  }

  if (command.name === 'remember') {
    if (!command.argument) return commandResponse('Usage: /remember <text>');

    const memory = await store.save({
      config,
      record: buildMemoryRecord({
        content: command.argument,
        context,
        createdBy: agentEmail
      })
    });
    return commandResponse(`Saved memory #${memory.id}.\n\n${memory.content}`);
  }

  if (command.name === 'memories') {
    const memories = await store.list({ config, limit: 10 });
    return commandResponse(formatMemoryList(memories));
  }

  if (command.name === 'forget') {
    const id = Number(command.argument);
    if (!Number.isInteger(id) || id <= 0) return commandResponse('Usage: /forget <id>');

    const forgotten = await store.forget({ config, id });
    if (!forgotten) return commandResponse(`No active memory found for #${id}.`);
    return commandResponse(`Forgot memory #${id}.`);
  }

  return null;
}

export async function getRelevantMemories({ config, context, chatMessages = [], limit = 8 } = {}) {
  if (!memoryConfigured(config)) return { memories: [], warnings: [] };

  try {
    await ensureMemoryTable({ config });
    const rows = await fetchRecentMemories({ config, limit: 200 });
    const memories = rankRelevantMemories({ rows, context, chatMessages }).slice(0, limit);
    await markMemoriesUsed({ config, ids: memories.map(memory => memory.id) });
    return { memories, warnings: [] };
  } catch (error) {
    return { memories: [], warnings: [`Memory lookup failed: ${error.message}`] };
  }
}

export function rankRelevantMemories({ rows = [], context = {}, chatMessages = [] } = {}) {
  const queryKeywords = keywords([
    context.latestMessage,
    context.conversationText,
    latestAgentMessage(chatMessages),
    context.supportCase?.type,
    carrierFromContext(context),
    context.responseLanguage?.language
  ].filter(Boolean).join(' '));

  const supportCaseType = clean(context.supportCase?.type);
  const carrier = normalizeValue(carrierFromContext(context));
  const language = normalizeValue(context.responseLanguage?.language);

  return (Array.isArray(rows) ? rows : [])
    .filter(row => row?.active !== false && row?.content)
    .map(row => {
      const memoryKeywords = new Set([...(Array.isArray(row.tags) ? row.tags : []), ...keywords(row.content)]);
      let score = 0;
      let topicalScore = 0;

      if (supportCaseType && clean(row.support_case_type) === supportCaseType) {
        score += 5;
        topicalScore += 5;
      }
      if (carrier && normalizeValue(row.carrier) === carrier) {
        score += 4;
        topicalScore += 4;
      }
      if (language && normalizeValue(row.language) === language) score += 2;

      for (const keyword of queryKeywords) {
        if (memoryKeywords.has(keyword)) {
          score += 1;
          topicalScore += 1;
        }
      }

      return { ...formatMemory(row), relevance: score, topical_relevance: topicalScore };
    })
    .filter(memory => memory.topical_relevance > 0)
    .sort((a, b) => b.relevance - a.relevance || new Date(b.created_at || 0) - new Date(a.created_at || 0));
}

export function buildMemoryRecord({ content, context = {}, createdBy = '' } = {}) {
  const normalizedContent = String(content || '').trim();
  const supportCaseType = clean(context.supportCase?.type);
  const carrier = carrierFromContext(context);
  const language = clean(context.responseLanguage?.language);
  const tags = [
    ...keywords(normalizedContent),
    supportCaseType,
    carrier,
    language
  ].filter(Boolean).map(normalizeValue);

  return {
    content: normalizedContent,
    tags: [...new Set(tags)].slice(0, 24),
    support_case_type: supportCaseType || null,
    carrier: carrier || null,
    language: language || null,
    created_by: clean(createdBy) || null,
    conversation_id: context.conversationId ? String(context.conversationId) : null,
    contact_email: clean(context.contactEmail) || null
  };
}

export function formatPromptMemories(memories = []) {
  return (Array.isArray(memories) ? memories : []).map(memory => ({
    id: memory.id,
    content: memory.content,
    support_case_type: memory.support_case_type || null,
    carrier: memory.carrier || null,
    language: memory.language || null
  }));
}

export function memoryConfigured(config = {}) {
  return Boolean(config.copilotDatabaseUrl);
}

export async function ensureMemoryTable({ config }) {
  if (!memoryConfigured(config)) return false;
  if (ensured) return true;

  await withMemoryClient(config, async client => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS copilot_memories (
        id BIGSERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        tags TEXT[] NOT NULL DEFAULT '{}',
        support_case_type TEXT,
        carrier TEXT,
        language TEXT,
        created_by TEXT,
        conversation_id TEXT,
        contact_email TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ,
        usage_count INTEGER NOT NULL DEFAULT 0,
        active BOOLEAN NOT NULL DEFAULT TRUE
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS copilot_memories_active_created_idx ON copilot_memories (active, created_at DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS copilot_memories_support_case_idx ON copilot_memories (support_case_type)');
    await client.query('CREATE INDEX IF NOT EXISTS copilot_memories_carrier_idx ON copilot_memories (carrier)');
  });

  ensured = true;
  return true;
}

async function rememberMemory({ config, record }) {
  await ensureMemoryTable({ config });
  return withMemoryClient(config, async client => {
    const result = await client.query(
      `
      INSERT INTO copilot_memories (
        content,
        tags,
        support_case_type,
        carrier,
        language,
        created_by,
        conversation_id,
        contact_email
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
      `,
      [
        record.content,
        record.tags,
        record.support_case_type,
        record.carrier,
        record.language,
        record.created_by,
        record.conversation_id,
        record.contact_email
      ]
    );
    return formatMemory(result.rows[0]);
  });
}

async function listMemories({ config, limit = 10 }) {
  await ensureMemoryTable({ config });
  return withMemoryClient(config, async client => {
    const result = await client.query(
      `
      SELECT *
      FROM copilot_memories
      WHERE active = TRUE
      ORDER BY created_at DESC
      LIMIT $1
      `,
      [limit]
    );
    return result.rows.map(formatMemory);
  });
}

async function forgetMemory({ config, id }) {
  await ensureMemoryTable({ config });
  return withMemoryClient(config, async client => {
    const result = await client.query(
      `
      UPDATE copilot_memories
      SET active = FALSE
      WHERE id = $1 AND active = TRUE
      RETURNING *
      `,
      [id]
    );
    return result.rows[0] ? formatMemory(result.rows[0]) : null;
  });
}

async function fetchRecentMemories({ config, limit }) {
  return withMemoryClient(config, async client => {
    const result = await client.query(
      `
      SELECT *
      FROM copilot_memories
      WHERE active = TRUE
      ORDER BY created_at DESC
      LIMIT $1
      `,
      [limit]
    );
    return result.rows.map(formatMemory);
  });
}

async function markMemoriesUsed({ config, ids }) {
  const uniqueIds = [...new Set(ids.map(Number).filter(Number.isInteger))];
  if (!uniqueIds.length) return;

  await withMemoryClient(config, async client => {
    await client.query(
      `
      UPDATE copilot_memories
      SET usage_count = usage_count + 1,
          last_used_at = NOW()
      WHERE id = ANY($1::bigint[])
      `,
      [uniqueIds]
    );
  });
}

const defaultMemoryStore = {
  save: rememberMemory,
  list: listMemories,
  forget: forgetMemory
};

function commandResponse(assistantMessage) {
  return {
    handled: true,
    assistant_message: assistantMessage,
    reasoning_summary: 'Handled by KR Copilot command.',
    confidence: 'high',
    warnings: [],
    preserve_draft: true,
    skip_insert: true
  };
}

function formatMemoryList(memories = []) {
  if (!memories.length) return 'No active memories saved yet.';

  return [
    'Active memories:',
    '',
    ...memories.map(memory => {
      const meta = [memory.support_case_type, memory.carrier, memory.language].filter(Boolean).join(' · ');
      return `#${memory.id}${meta ? ` (${meta})` : ''}: ${memory.content}`;
    })
  ].join('\n');
}

function formatMemory(row = {}) {
  return {
    id: Number(row.id),
    content: String(row.content || '').trim(),
    tags: Array.isArray(row.tags) ? row.tags.map(normalizeValue).filter(Boolean) : [],
    support_case_type: clean(row.support_case_type) || null,
    carrier: clean(row.carrier) || null,
    language: clean(row.language) || null,
    created_by: clean(row.created_by) || null,
    conversation_id: clean(row.conversation_id) || null,
    contact_email: clean(row.contact_email) || null,
    created_at: row.created_at || null,
    last_used_at: row.last_used_at || null,
    usage_count: Number(row.usage_count || 0),
    active: row.active !== false
  };
}

function latestAgentMessage(chatMessages = []) {
  return [...(Array.isArray(chatMessages) ? chatMessages : [])]
    .reverse()
    .find(message => message?.role !== 'assistant')?.content || '';
}

function carrierFromContext(context = {}) {
  const summary = context.shopifyContext?.selected_order?.fulfillments?.find(fulfillment => {
    return Array.isArray(fulfillment?.tracking) && fulfillment.tracking.some(item => item?.company);
  });
  return clean(summary?.tracking?.find(item => item?.company)?.company)
    || clean(context.shopifyContext?.selected_order?.fulfillments?.[0]?.tracking?.find(item => item?.company)?.company)
    || clean(context.providerContext?.provider?.label)
    || '';
}

function keywords(value = '') {
  return normalizeText(value)
    .split(/\s+/)
    .filter(word => word.length >= 4 && !STOP_WORDS.has(word))
    .slice(0, 40);
}

function normalizeText(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9#]+/g, ' ')
    .trim();
}

function normalizeValue(value = '') {
  return normalizeText(value).replace(/\s+/g, '_');
}

function clean(value = '') {
  return String(value || '').trim();
}

async function withMemoryClient(config, callback) {
  const { Client } = await import('pg');
  const client = new Client({
    connectionString: config.copilotDatabaseUrl,
    ssl: config.copilotDatabaseSsl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 3000,
    query_timeout: 5000
  });

  try {
    await client.connect();
    return await callback(client);
  } finally {
    await client.end().catch(() => {});
  }
}
