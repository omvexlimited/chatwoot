import { createHmac, timingSafeEqual } from 'node:crypto';
import { messageSubject } from './prompt.js';
import { withDatabaseClient } from './database.js';

const ACTIVE_STATUSES = ['pending', 'processing', 'generated'];
const WEBHOOK_MAX_AGE_SECONDS = 10 * 60;

let ensured = false;
let workerRunning = false;
let workerTimer = null;
let memoryNextId = 1;
const memoryRows = new Map();

export function preparedDraftsConfigured(config = {}) {
  return Boolean(config);
}

export async function ensurePreparedDraftsTable({ config }) {
  if (!usesDatabase(config)) return false;
  if (ensured) return true;

  await withPreparedDraftClient(config, async client => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS copilot_prepared_drafts (
        id BIGSERIAL PRIMARY KEY,
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        chatwoot_message_id TEXT NOT NULL UNIQUE,
        contact_email TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        draft TEXT,
        assistant_message TEXT,
        agent_briefing JSONB,
        context_summary JSONB,
        context_payload JSONB,
        context_fingerprint TEXT,
        warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
        confidence TEXT,
        failure_reason TEXT,
        webhook_payload JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        inserted_at TIMESTAMPTZ
      )
    `);
    await client.query('ALTER TABLE copilot_prepared_drafts ADD COLUMN IF NOT EXISTS context_payload JSONB');
    await client.query('ALTER TABLE copilot_prepared_drafts ADD COLUMN IF NOT EXISTS context_fingerprint TEXT');
    await client.query('CREATE INDEX IF NOT EXISTS copilot_prepared_drafts_conversation_idx ON copilot_prepared_drafts (account_id, conversation_id, updated_at DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS copilot_prepared_drafts_status_idx ON copilot_prepared_drafts (status, created_at ASC)');
  });

  ensured = true;
  return true;
}

export function verifyChatwootWebhookSignature({
  secret,
  rawBody = '',
  signature = '',
  timestamp = '',
  now = Date.now()
} = {}) {
  if (!secret || !signature || !timestamp) return false;

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  const ageSeconds = Math.abs(Math.floor(now / 1000) - timestampSeconds);
  if (ageSeconds > WEBHOOK_MAX_AGE_SECONDS) return false;

  const expected = `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(String(signature));
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

export function parsePreparedDraftWebhook(payload = {}) {
  if (payload?.event !== 'message_created') return ignored('unsupported_event');
  if (!isIncomingMessage(payload.message_type)) return ignored('not_incoming');
  if (payload.private === true) return ignored('private_message');

  const content = clean(payload.content);
  if (!content) return ignored('empty_content');

  const accountId = clean(payload.account?.id);
  const conversationId = clean(payload.conversation_id || payload.conversation?.display_id || payload.conversation?.id);
  const messageId = clean(payload.id);
  if (!accountId || !conversationId || !messageId) return ignored('missing_required_ids');

  return {
    ignored: false,
    job: {
      account_id: accountId,
      conversation_id: conversationId,
      chatwoot_message_id: messageId,
      contact_email: clean(payload.sender?.email || payload.conversation?.meta?.sender?.email),
      webhook_payload: payload
    }
  };
}

export async function enqueuePreparedDraftFromWebhook({ config, payload }) {
  const parsed = parsePreparedDraftWebhook(payload);
  if (parsed.ignored) return { enqueued: false, ignored: true, reason: parsed.reason };
  if (!usesDatabase(config)) return enqueueMemoryPreparedDraft(parsed.job);

  await ensurePreparedDraftsTable({ config });
  return withPreparedDraftClient(config, async client => {
    await client.query('BEGIN');
    try {
      const existing = await client.query(
        'SELECT id, status FROM copilot_prepared_drafts WHERE chatwoot_message_id = $1 LIMIT 1',
        [parsed.job.chatwoot_message_id]
      );

      if (existing.rows[0]) {
        await client.query('COMMIT');
        return {
          enqueued: false,
          ignored: true,
          reason: 'duplicate_message',
          draft_id: Number(existing.rows[0].id),
          status: existing.rows[0].status
        };
      }

      await client.query(
        `
        UPDATE copilot_prepared_drafts
        SET status = 'stale',
            updated_at = NOW()
        WHERE account_id = $1
          AND conversation_id = $2
          AND status = ANY($3::text[])
        `,
        [parsed.job.account_id, parsed.job.conversation_id, ACTIVE_STATUSES]
      );

      const inserted = await client.query(
        `
        INSERT INTO copilot_prepared_drafts (
          account_id,
          conversation_id,
          chatwoot_message_id,
          contact_email,
          status,
          webhook_payload
        )
        VALUES ($1, $2, $3, $4, 'pending', $5::jsonb)
        RETURNING *
        `,
        [
          parsed.job.account_id,
          parsed.job.conversation_id,
          parsed.job.chatwoot_message_id,
          parsed.job.contact_email,
          JSON.stringify(parsed.job.webhook_payload)
        ]
      );
      await client.query('COMMIT');
      return { enqueued: true, ignored: false, draft: formatPreparedDraftRow(inserted.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });
}

export function startPreparedDraftWorker({ config, generate, intervalMs = 5000, limit = 2 }) {
  if (!preparedDraftsConfigured(config) || typeof generate !== 'function') return null;
  if (workerTimer) return workerTimer;

  const tick = () => {
    processPendingPreparedDrafts({ config, generate, limit }).catch(error => {
      console.warn(`Prepared draft worker failed: ${error.message}`);
    });
  };
  workerTimer = setInterval(tick, intervalMs);
  workerTimer.unref?.();
  setTimeout(tick, 0).unref?.();
  return workerTimer;
}

export async function processPendingPreparedDrafts({ config, generate, limit = 2 }) {
  if (workerRunning || !preparedDraftsConfigured(config)) return { processed: 0 };
  workerRunning = true;

  try {
    if (!usesDatabase(config)) {
      const rows = claimMemoryPendingPreparedDrafts(limit);
      for (const row of rows) {
        await processPreparedDraftRow({ config, generate, row });
      }
      return { processed: rows.length };
    }

    await ensurePreparedDraftsTable({ config });
    const rows = await claimPendingPreparedDrafts({ config, limit });
    for (const row of rows) {
      await processPreparedDraftRow({ config, generate, row });
    }
    return { processed: rows.length };
  } finally {
    workerRunning = false;
  }
}

export async function getLatestInsertedPreparedDraft({ config, accountId, conversationId, excludeId = null }) {
  if (!accountId || !conversationId || !usesDatabase(config)) return null;

  await ensurePreparedDraftsTable({ config });
  return withPreparedDraftClient(config, async client => {
    const params = [String(accountId), String(conversationId)];
    let query = `
      SELECT *
      FROM copilot_prepared_drafts
      WHERE account_id = $1
        AND conversation_id = $2
        AND inserted_at IS NOT NULL
        AND COALESCE(draft, '') <> ''
    `;

    if (excludeId) {
      params.push(Number(excludeId));
      query += ` AND id <> $3`;
    }

    query += ` ORDER BY inserted_at DESC LIMIT 1`;

    const result = await client.query(query, params);
    const row = result.rows[0];
    return row ? formatPreparedDraftRow(row) : null;
  });
}

export async function getPreparedDraft({ config, accountId, conversationId, latestMessageId = '' }) {
  if (!accountId || !conversationId) {
    return { status: 'not_found', reason: 'missing_conversation' };
  }
  if (!usesDatabase(config)) return getMemoryPreparedDraft({ accountId, conversationId, latestMessageId });

  await ensurePreparedDraftsTable({ config });
  return withPreparedDraftClient(config, async client => {
    const params = [String(accountId), String(conversationId)];
    let query = `
      SELECT *
      FROM copilot_prepared_drafts
      WHERE account_id = $1
        AND conversation_id = $2
    `;
    if (latestMessageId) {
      params.push(String(latestMessageId));
      query += ` AND chatwoot_message_id = $3`;
    }
    query += ` ORDER BY created_at DESC LIMIT 1`;

    const result = await client.query(query, params);
    const row = result.rows[0];
    if (!row) return { status: 'not_found' };
    return formatPreparedDraftRow(row);
  });
}

export function buildPreparedDraftPayload(row = {}) {
  const payload = row.webhook_payload || {};
  const conversation = payload.conversation || {};
  const sender = payload.sender || conversation?.meta?.sender || {};

  return {
    account_id: row.account_id || payload.account?.id,
    conversation_id: row.conversation_id || conversation.id || payload.conversation_id,
    conversation_display_id: row.conversation_id || conversation.id || payload.conversation_id,
    latest_message_id: row.chatwoot_message_id || payload.id || null,
    contact_email: row.contact_email || sender.email,
    contact_phone: sender.phone_number || sender.phone || '',
    latest_message: payload.content || '',
    latest_subject: messageSubject(payload) || messageSubject(conversation),
    conversation,
    contact: sender
  };
}

export function buildAgentBriefing({ context = {}, result = {}, fallbackMessage = '' } = {}) {
  const detectedCase = inferDetectedCase(context);
  const caseReview = context.caseReview || {};
  const selectedPlaybooks = normalizeSelectedPlaybooks(context.selectedPlaybooks);
  const actionChecklist = neutralActionChecklist(context);
  const warnings = [
    ...normalizeArray(result.warnings),
    ...normalizeArray(context.warnings)
  ];

  return {
    summary: clean(result.reasoning_summary) || clean(fallbackMessage) || 'Borrador preparado para revisión humana.',
    detected_case: detectedCase,
    playbook_used: selectedPlaybooks.map(playbook => playbook.title).filter(Boolean).join(' + ') || 'Published Playbook selection required',
    decision_path: selectedPlaybooks.length
      ? [`Selected by published case_types metadata: ${selectedPlaybooks.map(playbook => playbook.slug).join(', ')}`]
      : ['No published Playbook was selected; do not make a commercial recommendation.'],
    verified_facts: normalizeArray(caseReview.verified_facts),
    missing_information: normalizeArray(caseReview.missing_info),
    recommended_decision: 'Apply the selected published Playbook to the verified case facts before sending.',
    action_required: actionChecklist.some(item => !/^(No manual action|No hace falta acción manual)/i.test(item)),
    before_sending_checklist: actionChecklist,
    customer_reply_summary: ['Reply to the latest customer message using verified facts and the selected published Playbook.'],
    post_send_action: 'manual_review',
    risks_or_warnings: [...new Set(warnings)].slice(0, 8)
  };
}

export function normalizeAgentBriefing(value, fallback) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return buildAgentBriefing(fallback);
  }

  const fallbackBriefing = buildAgentBriefing(fallback);
  return {
    summary: clean(value.summary) || fallbackBriefing.summary,
    detected_case: clean(value.detected_case) || fallbackBriefing.detected_case,
    playbook_used: clean(value.playbook_used) || fallbackBriefing.playbook_used,
    decision_path: normalizeArray(value.decision_path).length
      ? normalizeArray(value.decision_path)
      : fallbackBriefing.decision_path,
    verified_facts: normalizeArray(value.verified_facts).length
      ? normalizeArray(value.verified_facts)
      : fallbackBriefing.verified_facts,
    missing_information: normalizeArray(value.missing_information).length
      ? normalizeArray(value.missing_information)
      : fallbackBriefing.missing_information,
    recommended_decision: clean(value.recommended_decision) || fallbackBriefing.recommended_decision,
    action_required: typeof value.action_required === 'boolean' ? value.action_required : fallbackBriefing.action_required,
    before_sending_checklist: normalizeArray(value.before_sending_checklist).length
      ? normalizeArray(value.before_sending_checklist)
      : fallbackBriefing.before_sending_checklist,
    customer_reply_summary: normalizeArray(value.customer_reply_summary).length
      ? normalizeArray(value.customer_reply_summary)
      : fallbackBriefing.customer_reply_summary,
    post_send_action: clean(value.post_send_action) || fallbackBriefing.post_send_action,
    risks_or_warnings: normalizeArray(value.risks_or_warnings).length
      ? normalizeArray(value.risks_or_warnings)
      : fallbackBriefing.risks_or_warnings
  };
}

export function formatAgentBriefingForChat(briefing = {}) {
  const lines = [
    'Borrador preparado.'
  ];

  if (briefing.detected_case) {
    lines.push('', `Caso detectado: ${briefing.detected_case}.`);
  }
  if (briefing.playbook_used) {
    lines.push(`Playbook/SOP aplicado: ${briefing.playbook_used}.`);
  }
  if (briefing.recommended_decision) {
    lines.push(`Decisión recomendada: ${briefing.recommended_decision}.`);
  }

  const decisionPath = normalizeArray(briefing.decision_path);
  if (decisionPath.length) {
    lines.push('', 'Camino de decisión:');
    lines.push(...decisionPath.map(item => `- ${item}`));
  }

  const facts = normalizeArray(briefing.verified_facts);
  if (facts.length) {
    lines.push('', 'Hechos verificados:');
    lines.push(...facts.map(item => `- ${item}`));
  }

  const missing = normalizeArray(briefing.missing_information);
  if (missing.length) {
    lines.push('', 'Falta comprobar:');
    lines.push(...missing.map(item => `- ${item}`));
  }

  lines.push('', 'Acción necesaria antes de enviar:');
  const checklist = normalizeArray(briefing.before_sending_checklist);
  if (checklist.length) {
    lines.push(...checklist.map((item, index) => `${index + 1}. ${item}`));
  } else {
    lines.push('No hace falta acción manual. Revisa el borrador y envíalo si está correcto.');
  }

  const summary = normalizeArray(briefing.customer_reply_summary);
  if (summary.length) {
    lines.push('', 'Resumen de respuesta al cliente:');
    lines.push(...summary.map(item => `- ${item}`));
  }

  if (briefing.post_send_action) {
    lines.push('', `Después de enviar: ${briefing.post_send_action}.`);
  }

  const warnings = normalizeArray(briefing.risks_or_warnings);
  if (warnings.length) {
    lines.push('', 'Avisos:');
    lines.push(...warnings.map(item => `- ${item}`));
  }

  return lines.join('\n');
}

export function formatCompactAgentBriefingForChat(briefing = {}) {
  const lines = ['Brief prepared.'];
  const facts = normalizeArray(briefing.verified_facts).slice(0, 3);
  const missing = normalizeArray(briefing.missing_information).slice(0, 2);
  const risks = normalizeArray(briefing.risks_or_warnings).slice(0, 2);

  if (briefing.detected_case) lines.push(`Case: ${briefing.detected_case}`);
  if (briefing.playbook_used) lines.push(`SOP used: ${briefing.playbook_used}`);
  if (briefing.recommended_decision) lines.push(`Decision: ${briefing.recommended_decision}`);
  if (facts.length) lines.push(`Key facts: ${facts.join(' / ')}`);
  if (missing.length) lines.push(`Missing / check before sending: ${missing.join(' / ')}`);

  const checklist = normalizeArray(briefing.before_sending_checklist)
    .filter(item => !/^(No manual action|No hace falta acción manual)/i.test(item))
    .slice(0, 2);
  if (!missing.length && checklist.length) {
    lines.push(`Missing / check before sending: ${checklist.join(' / ')}`);
  }

  if (briefing.post_send_action) lines.push(`After sending: ${briefing.post_send_action}`);
  if (risks.length) lines.push(`Risks: ${risks.join(' / ')}`);

  return lines.slice(0, 9).join('\n');
}

async function claimPendingPreparedDrafts({ config, limit }) {
  return withPreparedDraftClient(config, async client => {
    const result = await client.query(
      `
      UPDATE copilot_prepared_drafts
      SET status = 'processing',
          updated_at = NOW()
      WHERE id IN (
        SELECT id
        FROM copilot_prepared_drafts
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
      `,
      [limit]
    );
    return result.rows.map(formatPreparedDraftRow);
  });
}

async function processPreparedDraftRow({ config, generate, row }) {
  try {
    const result = await generate(row);
    if (!usesDatabase(config)) {
      updateMemoryPreparedDraft(row.id, {
        status: 'generated',
        draft: result.draft || '',
        assistant_message: result.assistant_message || '',
        agent_briefing: result.agent_briefing || null,
        context_summary: result.context_summary || null,
        context_payload: result.context_payload || null,
        context_fingerprint: result.context_fingerprint || null,
        warnings: normalizeArray(result.warnings),
        confidence: result.confidence || 'low',
        failure_reason: null,
        inserted_at: result.inserted_at || null
      });
      return;
    }

    await withPreparedDraftClient(config, async client => {
      await client.query(
        `
        UPDATE copilot_prepared_drafts
        SET status = 'generated',
            draft = $2,
            assistant_message = $3,
            agent_briefing = $4::jsonb,
            context_summary = $5::jsonb,
            context_payload = $6::jsonb,
            context_fingerprint = $7,
            warnings = $8::jsonb,
            confidence = $9,
            inserted_at = COALESCE($10::timestamptz, inserted_at),
            failure_reason = NULL,
            updated_at = NOW()
        WHERE id = $1
        `,
        [
          row.id,
          result.draft || '',
          result.assistant_message || '',
          JSON.stringify(result.agent_briefing || null),
          JSON.stringify(result.context_summary || null),
          JSON.stringify(result.context_payload || null),
          result.context_fingerprint || null,
          JSON.stringify(normalizeArray(result.warnings)),
          result.confidence || 'low',
          result.inserted_at || null
        ]
      );
    });
  } catch (error) {
    if (!usesDatabase(config)) {
      updateMemoryPreparedDraft(row.id, {
        status: 'failed',
        failure_reason: error.message,
        warnings: [error.message]
      });
      return;
    }

    await withPreparedDraftClient(config, async client => {
      await client.query(
        `
        UPDATE copilot_prepared_drafts
        SET status = 'failed',
            failure_reason = $2,
            warnings = $3::jsonb,
            updated_at = NOW()
        WHERE id = $1
        `,
        [row.id, error.message, JSON.stringify([error.message])]
      );
    });
  }
}

function isIncomingMessage(value) {
  return value === 0 || value === '0' || String(value || '').toLowerCase() === 'incoming';
}

function ignored(reason) {
  return { ignored: true, reason };
}

function enqueueMemoryPreparedDraft(job) {
  const existing = [...memoryRows.values()].find(row => row.chatwoot_message_id === job.chatwoot_message_id);
  if (existing) {
    return {
      enqueued: false,
      ignored: true,
      reason: 'duplicate_message',
      draft_id: existing.id,
      status: existing.status
    };
  }

  for (const row of memoryRows.values()) {
    if (
      row.account_id === job.account_id &&
      row.conversation_id === job.conversation_id &&
      ACTIVE_STATUSES.includes(row.status)
    ) {
      row.status = 'stale';
      row.updated_at = new Date().toISOString();
    }
  }

  const now = new Date().toISOString();
  const row = {
    id: memoryNextId,
    account_id: job.account_id,
    conversation_id: job.conversation_id,
    chatwoot_message_id: job.chatwoot_message_id,
    contact_email: job.contact_email,
    status: 'pending',
    draft: '',
    assistant_message: '',
    agent_briefing: null,
    context_summary: null,
    context_payload: null,
    context_fingerprint: null,
    warnings: [],
    confidence: null,
    failure_reason: null,
    webhook_payload: job.webhook_payload,
    created_at: now,
    updated_at: now,
    inserted_at: null
  };
  memoryNextId += 1;
  memoryRows.set(row.id, row);
  pruneMemoryRows();
  return { enqueued: true, ignored: false, draft: formatPreparedDraftRow(row) };
}

function claimMemoryPendingPreparedDrafts(limit) {
  const rows = [...memoryRows.values()]
    .filter(row => row.status === 'pending')
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .slice(0, limit);
  const now = new Date().toISOString();
  for (const row of rows) {
    row.status = 'processing';
    row.updated_at = now;
  }
  return rows.map(formatPreparedDraftRow);
}

function updateMemoryPreparedDraft(id, updates) {
  const row = memoryRows.get(Number(id));
  if (!row) return;
  Object.assign(row, updates, { updated_at: new Date().toISOString() });
}

function getMemoryPreparedDraft({ accountId, conversationId, latestMessageId = '' }) {
  const rows = [...memoryRows.values()]
    .filter(row => row.account_id === String(accountId) && row.conversation_id === String(conversationId))
    .filter(row => !latestMessageId || row.chatwoot_message_id === String(latestMessageId))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  const row = rows[0];
  if (!row) return { status: 'not_found' };
  return formatPreparedDraftRow(row);
}

function pruneMemoryRows(maxRows = 250) {
  if (memoryRows.size <= maxRows) return;
  const rows = [...memoryRows.values()].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  for (const row of rows.slice(0, Math.max(0, memoryRows.size - maxRows))) {
    memoryRows.delete(row.id);
  }
}

function inferDetectedCase(context = {}) {
  if (context.caseReview?.detected_case) return context.caseReview.detected_case;
  if (context.supportCase?.type) return context.supportCase.type;

  const text = `${context.latestMessage || ''}\n${context.conversationText || ''}`.toLowerCase();
  if (/(change|switch|update|cambiar|changer|ändern|modificar).{0,60}\b(size|talla|taille|größe|xl|xxl|xs|small|medium|large)\b/.test(text)) {
    return 'size_change_request';
  }
  if (/\b(address|direcci[oó]n|adresse|direccion|postcode|postal code|zip|hausnummer)\b/.test(text)) {
    return 'address_change_request';
  }
  if (/\b(cancel|cancelar|annuler|stornieren|refund|reembolso|remboursement|return|devoluci[oó]n)\b/.test(text)) {
    return 'refund_or_cancel_request';
  }
  if (/(confirmation email|confirmaci[oó]n|no current orders|no aparece.*pedido|charged|cobrado)/.test(text)) {
    return 'confirmation_email_or_missing_order';
  }
  if (context.shopifyContext?.selected_order?.fulfillments?.some(hasTracking)) {
    return 'tracking_update';
  }
  return 'general_support';
}

function neutralActionChecklist(context = {}) {
  const checks = ['Review the generated draft against the selected published Playbook before sending.'];
  if (!context.shopifyContext?.selected_order) {
    checks.push('Select the correct order before confirming any order-specific action or status.');
  }
  if (normalizeArray(context.caseReview?.missing_info).length) {
    checks.push('Verify the missing case facts required by the selected Playbook.');
  }
  return checks;
}

function normalizeSelectedPlaybooks(value) {
  if (!Array.isArray(value)) return [];
  return value.map(playbook => ({
    slug: clean(playbook?.slug),
    title: clean(playbook?.title)
  })).filter(playbook => playbook.slug || playbook.title);
}

function hasTracking(fulfillment = {}) {
  const numbers = Array.isArray(fulfillment.tracking_numbers) ? fulfillment.tracking_numbers : [];
  const tracking = Array.isArray(fulfillment.tracking) ? fulfillment.tracking : [];
  return numbers.some(Boolean) || tracking.some(item => item?.number);
}

function normalizeArray(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw.map(item => clean(item)).filter(Boolean);
}

function formatPreparedDraftRow(row = {}) {
  return {
    id: Number(row.id),
    account_id: clean(row.account_id),
    conversation_id: clean(row.conversation_id),
    chatwoot_message_id: clean(row.chatwoot_message_id),
    contact_email: clean(row.contact_email),
    status: clean(row.status),
    draft: row.draft || '',
    assistant_message: row.assistant_message || '',
    agent_briefing: row.agent_briefing || null,
    context_summary: row.context_summary || null,
    context_payload: row.context_payload || null,
    context_fingerprint: clean(row.context_fingerprint) || null,
    warnings: normalizeArray(row.warnings),
    confidence: row.confidence || null,
    failure_reason: row.failure_reason || null,
    webhook_payload: row.webhook_payload || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    inserted_at: row.inserted_at || null
  };
}

function clean(value = '') {
  return String(value || '').trim();
}

async function withPreparedDraftClient(config, callback) {
  return withDatabaseClient({
    role: 'copilot',
    connectionString: config.copilotDatabaseUrl,
    ssl: config.copilotDatabaseSsl,
    max: config.copilotDatabasePoolSize,
    connectionTimeoutMs: 3000,
    queryTimeoutMs: 10000
  }, callback);
}

function usesDatabase(config = {}) {
  return Boolean(config.copilotDatabaseUrl);
}
