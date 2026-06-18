import { createHmac, timingSafeEqual } from 'node:crypto';

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
        warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
        confidence TEXT,
        failure_reason TEXT,
        webhook_payload JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        inserted_at TIMESTAMPTZ
      )
    `);
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
  const conversationId = clean(payload.conversation?.id || payload.conversation_id);
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
    contact_email: row.contact_email || sender.email,
    contact_phone: sender.phone_number || sender.phone || '',
    latest_message: payload.content || '',
    conversation,
    contact: sender
  };
}

export function buildAgentBriefing({ context = {}, result = {}, fallbackMessage = '' } = {}) {
  const detectedCase = inferDetectedCase(context);
  const actionChecklist = actionChecklistForCase({ detectedCase, context });
  const warnings = [
    ...normalizeArray(result.warnings),
    ...normalizeArray(context.warnings)
  ];

  return {
    summary: clean(result.reasoning_summary) || clean(fallbackMessage) || 'Borrador preparado para revisión humana.',
    detected_case: detectedCase,
    action_required: actionChecklist.some(item => !/^No manual action/i.test(item)),
    before_sending_checklist: actionChecklist,
    customer_reply_summary: customerReplySummary({ detectedCase, context }),
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
    action_required: typeof value.action_required === 'boolean' ? value.action_required : fallbackBriefing.action_required,
    before_sending_checklist: normalizeArray(value.before_sending_checklist).length
      ? normalizeArray(value.before_sending_checklist)
      : fallbackBriefing.before_sending_checklist,
    customer_reply_summary: normalizeArray(value.customer_reply_summary).length
      ? normalizeArray(value.customer_reply_summary)
      : fallbackBriefing.customer_reply_summary,
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

  const warnings = normalizeArray(briefing.risks_or_warnings);
  if (warnings.length) {
    lines.push('', 'Avisos:');
    lines.push(...warnings.map(item => `- ${item}`));
  }

  return lines.join('\n');
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
        warnings: normalizeArray(result.warnings),
        confidence: result.confidence || 'low',
        failure_reason: null
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
            warnings = $6::jsonb,
            confidence = $7,
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
          JSON.stringify(normalizeArray(result.warnings)),
          result.confidence || 'low'
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

function actionChecklistForCase({ detectedCase, context }) {
  const order = context.shopifyContext?.selected_order;
  const orderRef = order?.name || 'the selected order';
  const status = String(order?.fulfillment_status || '').toUpperCase();
  const sent = status === 'FULFILLED' || order?.fulfillments?.some(hasTracking);
  const sizeChange = extractSizeChange(`${context.latestMessage || ''}\n${context.conversationText || ''}`);

  if (!order && ['size_change_request', 'address_change_request', 'refund_or_cancel_request'].includes(detectedCase)) {
    return ['Busca o selecciona el pedido antes de confirmar cualquier cambio al cliente.'];
  }

  if (detectedCase === 'size_change_request') {
    if (sent) {
      return [
        `Comprueba si ${orderRef} ya fue enviado al supplier/provider.`,
        `Pregunta al supplier/provider si el cambio de talla${sizeChange ? ` (${sizeChange})` : ''} todavía es posible antes de confirmarlo.`,
        'Solo confirma el cambio si la acción interna ya está hecha o confirmada.'
      ];
    }
    return [
      `Actualiza ${orderRef}${sizeChange ? ` ${sizeChange}` : ' con el cambio de talla solicitado'}.`,
      'Comprueba que las líneas del pedido quedaron guardadas en Shopify/admin antes de responder al cliente.'
    ];
  }

  if (detectedCase === 'address_change_request') {
    if (sent) {
      return [
        `Comprueba si ${orderRef} ya fue enviado al supplier/provider.`,
        'Si no fue enviado, actualiza la dirección de envío en Shopify/admin.',
        'Si ya fue enviado, pregunta al supplier/provider si todavía puede cambiarse antes de confirmarlo.'
      ];
    }
    return [
      `Actualiza la dirección de envío de ${orderRef} en Shopify/admin.`,
      'Verifica calle, número, código postal, ciudad y país antes de enviar la confirmación.'
    ];
  }

  if (detectedCase === 'refund_or_cancel_request') {
    return [
      `Comprueba el estado de ${orderRef} antes de prometer cancelación, reembolso o devolución.`,
      'Aplica la política de devolución/reembolso o completa la acción interna antes de confirmarlo.'
    ];
  }

  if (detectedCase === 'confirmation_email_or_missing_order') {
    return [
      'Busca el pedido por email, teléfono, nombre y dirección si no se seleccionó automáticamente.',
      'Si faltaba el email en Shopify, añádelo antes de decir al cliente que recibirá futuras actualizaciones ahí.'
    ];
  }

  return ['No hace falta acción manual. Revisa el borrador y envíalo si está correcto.'];
}

function customerReplySummary({ detectedCase, context }) {
  if (detectedCase === 'size_change_request') {
    return [
      'Agradecer el email al cliente.',
      'Explicar si el cambio de talla puede confirmarse ahora o si primero necesita confirmación del supplier/provider.',
      'No prometer el cambio salvo que la acción interna ya esté hecha o confirmada.'
    ];
  }
  if (detectedCase === 'address_change_request') {
    return [
      'Agradecer el email al cliente.',
      'Confirmar el cambio de dirección solo si ya se completó internamente.',
      'Pedir campos de dirección faltantes si hace falta.'
    ];
  }
  if (detectedCase === 'customs_pending') {
    return [
      'Explicar el estado actual de aduanas/transportista local en lenguaje claro.',
      'Incluir un único enlace de tracking de Kits Republic cerca del final.'
    ];
  }
  if (detectedCase === 'tracking_update') {
    return [
      'Explicar el estado actual del envío.',
      'Incluir un único enlace de tracking de Kits Republic cerca del final.'
    ];
  }
  if (!context.shopifyContext?.selected_order) {
    return ['Pedir los datos que faltan para localizar el pedido sin inventar estado ni tracking.'];
  }
  return ['Responder al último mensaje del cliente usando el contexto del pedido seleccionado.'];
}

function hasTracking(fulfillment = {}) {
  const numbers = Array.isArray(fulfillment.tracking_numbers) ? fulfillment.tracking_numbers : [];
  const tracking = Array.isArray(fulfillment.tracking) ? fulfillment.tracking : [];
  return numbers.some(Boolean) || tracking.some(item => item?.number);
}

function extractSizeChange(text = '') {
  const value = String(text || '');
  const toInstead = value.match(/\b(?:to|a)\s+(XS|S|M|L|XL|XXL|XXXL|2XL|3XL)\b.{0,40}\b(?:instead of|en vez de|instead)\s+(XS|S|M|L|XL|XXL|XXXL|2XL|3XL)\b/i);
  if (toInstead) return `de ${toInstead[2].toUpperCase()} a ${toInstead[1].toUpperCase()}`;
  const fromTo = value.match(/\b(?:from|de)\s+(XS|S|M|L|XL|XXL|XXXL|2XL|3XL)\b.{0,40}\b(?:to|a)\s+(XS|S|M|L|XL|XXL|XXXL|2XL|3XL)\b/i);
  if (fromTo) return `de ${fromTo[1].toUpperCase()} a ${fromTo[2].toUpperCase()}`;
  return '';
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
  const { Client } = await import('pg');
  const client = new Client({
    connectionString: config.copilotDatabaseUrl,
    ssl: config.copilotDatabaseSsl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 3000,
    query_timeout: 10000
  });

  try {
    await client.connect();
    return await callback(client);
  } finally {
    await client.end().catch(() => {});
  }
}

function usesDatabase(config = {}) {
  return Boolean(config.copilotDatabaseUrl);
}
