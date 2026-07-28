import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { loadConfig, getConfigStatus } from './config.js';
import {
  fetchConversationMessages,
  createPrivateNote,
  getDraftReply,
  listConversations,
  prepareDraftReply
} from './chatwoot.js';
import { getShopifyContext } from './shopify.js';
import { getAssignedProviders } from './provider-lookup.js';
import { getProviderTrackingContext } from './provider-tracking.js';
import { getDeliveryEstimateContext } from './delivery-estimates.js';
import { getIssueContext } from './issue-lookup.js';
import { applyAgentDraftLanguageOverride, detectLanguageFromText, inferResponseLanguage } from './language.js';
import { applyForcedSupportCase, detectSupportCase, normalizeSupportCaseType } from './support-case.js';
import { enforceDraftRequirements } from './draft-rules.js';
import { buildPublicTrackingUrl } from './tracking-url.js';
import { extractAgentConfirmedFacts } from './agent-facts.js';
import { extractAttachmentCandidates } from './attachment-candidates.js';
import { analyzeAttachmentCandidates } from './attachment-analysis.js';
import { buildCaseReview, withCaseReviewDraft } from './case-review.js';
import { createPlaybookKnowledgeProvider } from './playbook-knowledge.js';
import { resolveCopilotInteraction } from './agent-intent.js';
import {
  ensureMemoryTable,
  formatPromptMemories,
  getRelevantMemories,
  latestUserCommand,
  runMemoryCommand
} from './memory.js';
import {
  normalizePendingIssue,
  runNewTicketCommand,
  runPendingTicketFeedback
} from './new-ticket.js';
import { runGrammarCommand } from './grammar.js';
import {
  buildAgentBriefing,
  buildPreparedDraftPayload,
  enqueuePreparedDraftFromWebhook,
  ensurePreparedDraftsTable,
  formatCompactAgentBriefingForChat,
  getLatestInsertedPreparedDraft,
  getPreparedDraft,
  normalizeAgentBriefing,
  processPendingPreparedDrafts,
  startPreparedDraftWorker,
  verifyChatwootWebhookSignature
} from './prepared-drafts.js';
import {
  buildCopilotChatPrompt,
  buildFallbackDraft,
  buildPrompt,
  conversationToText,
  latestIncomingMessage,
  loadKnowledgeBase,
  prependSubjectToText
} from './prompt.js';
import { generateChatWithOpenAI, generateDraftWithOpenAI } from './openai.js';
import { closeDatabasePools } from './database.js';
import { createContextFingerprint, createContextJobStore } from './context-cache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');
const config = loadConfig();
const contextJobs = createContextJobStore({
  ttlMs: config.contextCacheTtlMs,
  maxEntries: config.contextCacheMaxEntries
});
const fallbackKnowledgeBase = await loadKnowledgeBase();
const getKnowledge = createPlaybookKnowledgeProvider({ config, fallbackKnowledgeBase });
await ensureMemoryTable({ config }).catch(error => {
  console.warn(`KR Copilot memory disabled: ${error.message}`);
});
await ensurePreparedDraftsTable({ config }).catch(error => {
  console.warn(`KR Copilot prepared drafts disabled: ${error.message}`);
});
startPreparedDraftWorker({
  config,
  generate: generatePreparedDraftForJob,
  intervalMs: config.preparedDraftWorkerIntervalMs
});

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(error => {
    handleRequestError({ req, res, error });
  });
});

async function handleRequest(req, res) {
  try {
    addSecurityHeaders(req, res);
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'kits-support-copilot',
        version: '0.1.0',
        config: getConfigStatus(config)
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/chatwoot-webhook') {
      return handleChatwootWebhook(req, res);
    }

    if (req.method === 'POST' && url.pathname === '/api/suggest-reply') {
      if (!authorizeApiRequest(req, url, res)) return;
      return handleSuggestReply(req, res);
    }

    if (req.method === 'POST' && url.pathname === '/api/context') {
      if (!authorizeApiRequest(req, url, res)) return;
      return handleContext(req, res);
    }

    if (req.method === 'POST' && url.pathname === '/api/context/enrichments') {
      if (!authorizeApiRequest(req, url, res)) return;
      return handleContextEnrichments(req, res);
    }

    if (req.method === 'POST' && url.pathname === '/api/copilot-chat') {
      if (!authorizeApiRequest(req, url, res)) return;
      return handleCopilotChat(req, res);
    }

    if (req.method === 'POST' && url.pathname === '/api/prepared-draft') {
      if (!authorizeApiRequest(req, url, res)) return;
      return handlePreparedDraft(req, res);
    }

    if (req.method === 'POST' && url.pathname === '/api/prepared-drafts/backfill') {
      if (!authorizeApiRequest(req, url, res)) return;
      return handlePreparedDraftBackfill(req, res);
    }

    if (req.method === 'POST' && url.pathname === '/api/private-note') {
      if (!authorizeApiRequest(req, url, res)) return;
      return handlePrivateNote(req, res);
    }

    if (req.method === 'POST' && url.pathname === '/api/prepare-reply') {
      if (!authorizeApiRequest(req, url, res)) return;
      return handlePrepareReply(req, res);
    }

    if (req.method === 'GET') {
      return serveStatic(url.pathname, res);
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    if (isRequestAbortError(error)) return;
    return sendJson(res, 500, { error: error.message });
  }
}

function handleRequestError({ req, res, error }) {
  if (isRequestAbortError(error) || req.destroyed || res.destroyed) return;
  if (res.headersSent) {
    res.destroy(error);
    return;
  }
  sendJson(res, 500, { error: error.message });
}

server.listen(config.port, () => {
  console.log(`KR Copilot listening on ${config.port}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    server.close(async () => {
      await closeDatabasePools();
      process.exit(0);
    });
  });
}

async function handleChatwootWebhook(req, res) {
  const rawBody = await readRawBody(req);
  const validSignature = verifyChatwootWebhookSignature({
    secret: config.chatwootWebhookSecret,
    rawBody,
    signature: req.headers['x-chatwoot-signature'],
    timestamp: req.headers['x-chatwoot-timestamp']
  });

  if (!validSignature) {
    return sendJson(res, 401, { error: 'Invalid webhook signature' });
  }

  const payload = rawBody ? JSON.parse(rawBody) : {};
  const result = await enqueuePreparedDraftFromWebhook({ config, payload });

  if (result.enqueued) {
    setTimeout(() => {
      processPendingPreparedDrafts({ config, generate: generatePreparedDraftForJob, limit: 1 }).catch(error => {
        console.warn(`Prepared draft immediate worker failed: ${error.message}`);
      });
    }, 0).unref?.();
  }

  return sendJson(res, result.reason === 'database_not_configured' ? 503 : 202, result);
}

async function handleSuggestReply(req, res) {
  const body = await readJsonBody(req);
  const context = await prepareConversationContext(body);

  const fallback = buildFallbackDraft({
    shopifyContext: context.shopifyContext,
    latestMessage: context.latestMessage
  });
  fallback.warnings.push(...context.warnings);

  const knowledge = await getKnowledge();
  fallback.warnings.push(...(knowledge.warnings || []));
  const prompt = buildPrompt({
    knowledgeBase: knowledge.markdown,
    conversationText: context.conversationText,
    shopifyContext: context.shopifyContext,
    latestMessage: context.latestMessage,
    agentEmail: body.agent_email,
    responseLanguage: context.responseLanguage,
    supportCase: context.supportCase,
    deliveryEstimateContext: context.deliveryEstimateContext,
    providerTrackingContext: context.providerTrackingContext,
    issueContext: context.issueContext,
    attachmentAnalysis: context.attachmentAnalysis,
    caseReview: context.caseReview
  });

  const result = await generateDraftWithOpenAI({ config, prompt, fallback });
  const draft = enforceDraftRequirements({
    draft: result.draft,
    supportCase: context.supportCase,
    shopifyContext: context.shopifyContext,
    responseLanguage: context.responseLanguage,
    deliveryEstimateContext: context.deliveryEstimateContext,
    latestMessage: context.latestMessage
  });

  return sendJson(res, 200, {
    draft,
    reasoning_summary: result.reasoning_summary,
    shopify_context: context.shopifyContext,
    provider_context: context.providerContext,
    provider_tracking_context: context.providerTrackingContext,
    issue_context: context.issueContext,
    attachment_candidates: context.attachmentCandidates,
    attachment_analysis: context.attachmentAnalysis,
    duplicate_context: context.duplicateContext,
    case_review: withCaseReviewDraft(context.caseReview, draft),
    context_summary: summarizeContext(context),
    contact_email: context.contactEmail,
    response_language: context.responseLanguage,
    support_case: context.supportCase,
    confidence: result.confidence,
    warnings: uniqueStrings([...(result.warnings || []), ...(knowledge.warnings || []), ...context.warnings])
  });
}

async function handleContext(req, res) {
  const body = await readJsonBody(req);
  const preparedDraftContext = config.progressiveContext
    ? await contextFromPreparedDraft(body).catch(() => null)
    : null;
  if (preparedDraftContext) {
    logContextTiming({
      fingerprint: preparedDraftContext.fingerprint,
      status: 'ready',
      cacheHit: 'prepared_draft',
      timings: {}
    });
    return sendJson(res, 200, {
      ...preparedDraftContext.payload,
      context_status: 'ready',
      enrichment_status: 'ready'
    });
  }

  const requestFingerprint = contextFingerprintFromBody(body);
  const cached = requestFingerprint ? contextJobs.get(requestFingerprint) : null;
  if (cached?.status === 'ready' && cached.value) {
    logContextTiming({
      fingerprint: requestFingerprint,
      status: 'ready',
      cacheHit: 'memory',
      timings: cached.value.timings,
      context: cached.value
    });
    return sendJson(res, 200, contextPayload(cached.value, {
      contextFingerprint: requestFingerprint,
      contextStatus: 'ready',
      enrichmentStatus: 'ready'
    }), serverTimingHeaders(cached.value.timings));
  }

  const prepared = await prepareConversationCore(body);
  const fingerprint = prepared.contextFingerprint;

  if (!config.progressiveContext) {
    const context = await completeConversationContext(prepared);
    contextJobs.setReady(fingerprint, context);
    logContextTiming({
      fingerprint,
      status: 'ready',
      cacheHit: false,
      timings: context.timings,
      context
    });
    return sendJson(res, 200, contextPayload(context, {
      contextFingerprint: fingerprint,
      contextStatus: 'ready',
      enrichmentStatus: 'ready'
    }), serverTimingHeaders(context.timings));
  }

  const existing = contextJobs.get(fingerprint);
  if (existing?.status === 'ready' && existing.value) {
    logContextTiming({
      fingerprint,
      status: 'ready',
      cacheHit: 'memory',
      timings: existing.value.timings,
      context: existing.value
    });
    return sendJson(res, 200, contextPayload(existing.value, {
      contextFingerprint: fingerprint,
      contextStatus: 'ready',
      enrichmentStatus: 'ready'
    }), serverTimingHeaders(existing.value.timings));
  }
  if (existing?.status === 'failed') contextJobs.remove(fingerprint);

  contextJobs.start(fingerprint, () => completeConversationContext(prepared));
  const context = buildCoreConversationContext(prepared);
  logContextTiming({
    fingerprint,
    status: 'core',
    cacheHit: false,
    timings: context.timings,
    context
  });
  return sendJson(res, 200, contextPayload(context, {
    contextFingerprint: fingerprint,
    contextStatus: 'core',
    enrichmentStatus: 'pending'
  }), serverTimingHeaders(context.timings));
}

async function handleContextEnrichments(req, res) {
  const body = await readJsonBody(req);
  const fingerprint = String(body.context_fingerprint || '').trim();
  if (!fingerprint) return sendJson(res, 422, { error: 'context_fingerprint is required' });

  const entry = contextJobs.get(fingerprint);
  if (!entry) {
    return sendJson(res, 404, {
      context_fingerprint: fingerprint,
      enrichment_status: 'expired'
    });
  }
  if (entry.status === 'pending') {
    return sendJson(res, 200, {
      context_fingerprint: fingerprint,
      enrichment_status: 'pending'
    });
  }
  if (entry.status === 'failed' || !entry.value) {
    return sendJson(res, 200, {
      context_fingerprint: fingerprint,
      enrichment_status: 'failed',
      error: entry.error?.message || 'Context enrichment failed.'
    });
  }

  logContextTiming({
    fingerprint,
    status: 'ready',
    cacheHit: 'enrichment',
    timings: entry.value.timings,
    context: entry.value
  });
  return sendJson(res, 200, {
    context_fingerprint: fingerprint,
    enrichment_status: 'ready',
    context: contextPayload(entry.value, {
      contextFingerprint: fingerprint,
      contextStatus: 'ready',
      enrichmentStatus: 'ready'
    })
  }, serverTimingHeaders(entry.value.timings));
}

async function contextFromPreparedDraft(body) {
  const accountId = body.account_id || body.conversation?.account_id || config.chatwootAccountId;
  const conversationId = body.conversation_display_id || body.conversation?.display_id
    || body.conversation_id || body.conversation?.id;
  const latestMessageId = body.latest_message_id || body.message_id || '';
  if (!accountId || !conversationId || !latestMessageId) return null;

  const fingerprint = createContextFingerprint({
    accountId,
    conversationId,
    latestMessageId,
    selectedOrderRef: body.selected_order_ref,
    forcedSupportCase: body.forced_support_case
  });
  const draft = await getPreparedDraft({
    config,
    accountId,
    conversationId,
    latestMessageId
  });
  if (
    draft.status !== 'generated'
    || draft.context_fingerprint !== fingerprint
    || !draft.context_payload
  ) {
    return null;
  }

  return {
    fingerprint,
    payload: draft.context_payload
  };
}

function contextFingerprintFromBody(body) {
  const accountId = body.account_id || body.conversation?.account_id || config.chatwootAccountId;
  const conversationId = body.conversation_display_id || body.conversation?.display_id
    || body.conversation_id || body.conversation?.id;
  const latestMessageId = body.latest_message_id || body.message_id || '';
  if (!accountId || !conversationId || !latestMessageId) return null;

  return createContextFingerprint({
    accountId,
    conversationId,
    latestMessageId,
    selectedOrderRef: body.selected_order_ref,
    forcedSupportCase: body.forced_support_case
  });
}

async function handleCopilotChat(req, res) {
  const body = await readJsonBody(req);
  const context = await prepareConversationContext(body);
  const chatMessages = normalizeChatMessages(body.chat_messages);
  const effectiveResponseLanguage = applyAgentDraftLanguageOverride(context.responseLanguage, chatMessages);
  const responseContext = { ...context, responseLanguage: effectiveResponseLanguage };
  const agentConfirmedFacts = extractAgentConfirmedFacts(chatMessages);
  const currentDraft = String(body.current_draft || '').trim();
  const command = latestUserCommand(chatMessages);
  const pendingIssue = normalizePendingIssue(body.pending_issue);
  const latestUserMessage = latestUserChatMessage(chatMessages);
  const interactionType = resolveCopilotInteraction({
    message: latestUserMessage,
    currentDraft
  });
  const agentQuestionOnly = interactionType === 'agent_question';
  const briefOnly = interactionType === 'brief_command';
  const initialBrief = interactionType === 'initial_brief';
  const draftCommand = interactionType === 'draft_command' || interactionType === 'draft_edit' || interactionType === 'utility_command';
  const ticketResult = await runNewTicketCommand({
    command,
    config,
    context: responseContext,
    pendingIssue,
    agentEmail: body.agent_email
  }) || (!command && pendingIssue ? await runPendingTicketFeedback({
    message: latestUserMessage,
    pendingIssue,
    config,
    context: responseContext
  }) : null);

  if (ticketResult?.handled) {
    return sendCopilotChatResponse(res, {
      context,
      responseContext,
      assistantMessage: ticketResult.assistant_message,
      draft: currentDraft,
      reasoningSummary: ticketResult.reasoning_summary,
      confidence: ticketResult.confidence,
      warnings: ticketResult.warnings,
      agentConfirmedFacts,
      preserveDraft: ticketResult.preserve_draft,
      skipInsert: ticketResult.skip_insert,
      approvedMemories: [],
      pendingIssue: ticketResult.pending_issue ?? null
    });
  }

  const grammarResult = await runGrammarCommand({
    command,
    config,
    currentDraft
  }).catch(error => ({
    handled: true,
    assistant_message: `Grammar command failed: ${error.message}`,
    draft: currentDraft,
    reasoning_summary: 'KR Copilot grammar command failed.',
    confidence: 'low',
    warnings: [error.message],
    preserve_draft: true,
    skip_insert: true
  }));

  if (grammarResult?.handled) {
    return sendCopilotChatResponse(res, {
      context,
      responseContext,
      assistantMessage: grammarResult.assistant_message,
      draft: grammarResult.draft ?? currentDraft,
      reasoningSummary: grammarResult.reasoning_summary,
      confidence: grammarResult.confidence,
      warnings: grammarResult.warnings,
      agentConfirmedFacts,
      preserveDraft: grammarResult.preserve_draft,
      skipInsert: grammarResult.skip_insert,
      approvedMemories: [],
      pendingIssue
    });
  }

  const commandResult = await runMemoryCommand({
    command,
    config,
    context: responseContext,
    agentEmail: body.agent_email,
    currentDraft
  }).catch(error => ({
    handled: true,
    assistant_message: `Command failed: ${error.message}`,
    reasoning_summary: 'KR Copilot command failed.',
    confidence: 'low',
    warnings: [error.message],
    preserve_draft: true,
    skip_insert: true
  }));

  if (commandResult?.handled) {
    return sendCopilotChatResponse(res, {
      context,
      responseContext,
      assistantMessage: commandResult.assistant_message,
      draft: currentDraft,
      reasoningSummary: commandResult.reasoning_summary,
      confidence: commandResult.confidence,
      warnings: commandResult.warnings,
      agentConfirmedFacts,
      preserveDraft: commandResult.preserve_draft,
      skipInsert: commandResult.skip_insert,
      approvedMemories: [],
      pendingIssue
    });
  }

  const memoryResult = await getRelevantMemories({
    config,
    context: responseContext,
    chatMessages
  });

  const fallbackDraft = buildFallbackDraft({
    shopifyContext: context.shopifyContext,
    latestMessage: context.latestMessage
  });
  const knowledge = await getKnowledge();
  fallbackDraft.warnings.push(...context.warnings, ...memoryResult.warnings, ...(knowledge.warnings || []));
  const fallbackBriefing = buildAgentBriefing({
    context,
    result: {
      reasoning_summary: fallbackDraft.reasoning_summary,
      warnings: fallbackDraft.warnings
    }
  });

  const fallback = agentQuestionOnly
    ? {
      assistant_message: 'No puedo responder esa pregunta interna ahora mismo porque OpenAI no está disponible. Conservé el borrador actual sin cambios.',
      draft: currentDraft,
      agent_briefing: null,
      reasoning_summary: 'OpenAI was unavailable, so the internal agent question could not be answered and the draft was preserved.',
      confidence: 'low',
      warnings: fallbackDraft.warnings
    }
    : draftCommand
      ? {
        assistant_message: currentDraft || fallbackDraft.draft,
        draft: currentDraft || fallbackDraft.draft,
        agent_briefing: null,
        reasoning_summary: currentDraft
          ? 'OpenAI was unavailable, so the current draft was preserved for the agent command.'
          : fallbackDraft.reasoning_summary,
        confidence: currentDraft ? 'low' : fallbackDraft.confidence,
        warnings: fallbackDraft.warnings
      }
    : {
      assistant_message: formatCompactAgentBriefingForChat(fallbackBriefing),
      draft: briefOnly ? currentDraft : currentDraft || fallbackDraft.draft,
      agent_briefing: fallbackBriefing,
      reasoning_summary: briefOnly
        ? 'OpenAI was unavailable, so the current draft was preserved and a fallback brief was shown.'
        : currentDraft
        ? 'OpenAI was unavailable, so the existing draft was preserved.'
        : fallbackDraft.reasoning_summary,
      confidence: currentDraft ? 'low' : fallbackDraft.confidence,
      warnings: fallbackDraft.warnings
    };

  const prompt = buildCopilotChatPrompt({
    knowledgeBase: knowledge.markdown,
    conversationText: context.conversationText,
    shopifyContext: context.shopifyContext,
    latestMessage: context.latestMessage,
    agentEmail: body.agent_email,
    chatMessages,
    currentDraft,
    responseLanguage: effectiveResponseLanguage,
    supportCase: context.supportCase,
    agentConfirmedFacts,
    deliveryEstimateContext: context.deliveryEstimateContext,
    providerTrackingContext: context.providerTrackingContext,
    approvedMemories: memoryResult.memories,
    issueContext: context.issueContext,
    attachmentAnalysis: context.attachmentAnalysis,
    caseReview: context.caseReview,
    interactionMode: interactionType
  });

  const result = await generateChatWithOpenAI({ config, prompt, fallback });
  if (agentQuestionOnly) {
    const warnings = uniqueStrings([...(result.warnings || []), ...memoryResult.warnings, ...(knowledge.warnings || [])]);
    const assistantMessage = normalizeAssistantMessage({
      assistantMessage: result.assistant_message || fallback.assistant_message,
      agentConfirmedFacts,
      chatMessages
    });

    return sendCopilotChatResponse(res, {
      context,
      responseContext,
      assistantMessage,
      draft: currentDraft,
      reasoningSummary: result.reasoning_summary,
      confidence: result.confidence,
      warnings,
      agentConfirmedFacts,
      approvedMemories: memoryResult.memories,
      preserveDraft: true,
      skipInsert: true,
      agentBriefing: null,
      interactionType
    });
  }

  if (briefOnly) {
    const warnings = uniqueStrings([...(result.warnings || []), ...memoryResult.warnings, ...(knowledge.warnings || [])]);
    const agentBriefing = normalizeAgentBriefing(result.agent_briefing, {
      context,
      result: {
        ...result,
        draft: currentDraft,
        warnings
      }
    });
    return sendCopilotChatResponse(res, {
      context,
      responseContext,
      assistantMessage: formatCompactAgentBriefingForChat(agentBriefing),
      draft: currentDraft,
      reasoningSummary: result.reasoning_summary,
      confidence: result.confidence,
      warnings,
      agentConfirmedFacts,
      approvedMemories: memoryResult.memories,
      preserveDraft: true,
      skipInsert: true,
      agentBriefing,
      interactionType
    });
  }

  const draft = enforceDraftRequirements({
    draft: result.draft,
    supportCase: context.supportCase,
    shopifyContext: context.shopifyContext,
    responseLanguage: effectiveResponseLanguage,
    deliveryEstimateContext: context.deliveryEstimateContext,
    latestMessage: context.latestMessage
  });
  const warnings = uniqueStrings([...(result.warnings || []), ...memoryResult.warnings, ...(knowledge.warnings || [])]);
  const agentBriefing = normalizeAgentBriefing(result.agent_briefing, {
    context,
    result: {
      ...result,
      draft,
      warnings
    }
  });
  const assistantMessage = normalizeAssistantMessage({
    assistantMessage: initialBrief
      ? formatCompactAgentBriefingForChat(agentBriefing)
      : draft,
    agentConfirmedFacts,
    chatMessages
  });

  return sendCopilotChatResponse(res, {
    context,
    responseContext,
    assistantMessage,
    draft,
    reasoningSummary: result.reasoning_summary,
    confidence: result.confidence,
    warnings,
    agentConfirmedFacts,
    approvedMemories: memoryResult.memories,
    agentBriefing: initialBrief ? agentBriefing : null,
    interactionType,
    allowComposerOverwrite: draftCommand
  });
}

async function handlePreparedDraft(req, res) {
  const body = await readJsonBody(req);
  const accountId = body.account_id || body.conversation?.account_id || config.chatwootAccountId;
  const conversationId = body.conversation_display_id || body.conversation?.display_id || body.conversation_id || body.conversation?.id;
  const latestMessageId = body.latest_message_id || body.message_id || '';
  const result = await getPreparedDraft({
    config,
    accountId,
    conversationId,
    latestMessageId
  });
  return sendJson(res, 200, result);
}

async function handlePreparedDraftBackfill(req, res) {
  const body = await readJsonBody(req);
  const accountId = body.account_id || config.chatwootAccountId;
  const statuses = normalizeBackfillStatuses(body.statuses || body.status || ['open', 'pending', 'snoozed']);
  const maxPages = clampNumber(body.pages, 1, 10, 3);
  const limit = clampNumber(body.limit, 1, 100, 50);
  const results = {
    scanned: 0,
    eligible: 0,
    enqueued: 0,
    ignored: 0,
    errors: []
  };

  if (!accountId) return sendJson(res, 422, { error: 'account_id is required' });

  for (const status of statuses) {
    for (let page = 1; page <= maxPages && results.enqueued < limit; page += 1) {
      const data = await listConversations({ config, accountId, status, page });
      const conversations = extractConversationList(data);
      if (!conversations.length) break;

      for (const conversation of conversations) {
        if (results.enqueued >= limit) break;
        results.scanned += 1;
        const displayId = conversation.display_id || conversation.id;
        if (!displayId) continue;

        try {
          const messageResult = await fetchConversationMessages({ config, accountId, conversationId: displayId });
          const latestPublic = latestPublicChatMessage(messageResult.messages);
          if (!latestPublic || !isIncomingMessageType(latestPublic.message_type)) continue;

          results.eligible += 1;
          const enqueueResult = await enqueuePreparedDraftFromWebhook({
            config,
            payload: preparedDraftWebhookFromConversation({
              accountId,
              conversation,
              latestMessage: latestPublic
            })
          });

          if (enqueueResult.enqueued) results.enqueued += 1;
          else results.ignored += 1;
        } catch (error) {
          results.errors.push(`Conversation ${displayId}: ${error.message}`);
        }
      }
    }
  }

  if (results.enqueued) {
    setTimeout(() => {
      processPendingPreparedDrafts({ config, generate: generatePreparedDraftForJob, limit: Math.min(5, results.enqueued) }).catch(error => {
        console.warn(`Prepared draft backfill worker failed: ${error.message}`);
      });
    }, 0).unref?.();
  }

  return sendJson(res, 202, results);
}

async function handlePrivateNote(req, res) {
  const body = await readJsonBody(req);
  const accountId = body.account_id || body.conversation?.account_id || config.chatwootAccountId;
  const conversationId = body.conversation_display_id || body.conversation?.display_id || body.conversation_id;
  const draft = String(body.draft || '').trim();

  if (!draft) return sendJson(res, 422, { error: 'draft is required' });

  const metadata = body.metadata || {};
  const note = [
    '[KR Copilot draft - review before sending]',
    '',
    draft,
    '',
    metadata.confidence ? `Confidence: ${metadata.confidence}` : '',
    metadata.reasoning_summary ? `Context: ${metadata.reasoning_summary}` : ''
  ].filter(Boolean).join('\n');

  await createPrivateNote({ config, accountId, conversationId, content: note });
  return sendJson(res, 200, { ok: true });
}

function sendCopilotChatResponse(res, {
  context,
  responseContext,
  assistantMessage,
  draft,
  reasoningSummary,
  confidence,
  warnings = [],
  agentConfirmedFacts = [],
  approvedMemories = [],
  preserveDraft = false,
  skipInsert = false,
  pendingIssue = null,
  agentBriefing = null,
  interactionType = '',
  allowComposerOverwrite = false
}) {
  return sendJson(res, 200, {
    assistant_message: assistantMessage,
    draft,
    agent_briefing: agentBriefing,
    reasoning_summary: reasoningSummary,
    shopify_context: context.shopifyContext,
    provider_context: context.providerContext,
    provider_tracking_context: context.providerTrackingContext,
    issue_context: context.issueContext,
    attachment_candidates: context.attachmentCandidates,
    attachment_analysis: context.attachmentAnalysis,
    duplicate_context: context.duplicateContext,
    case_review: withCaseReviewDraft(context.caseReview, draft),
    context_summary: summarizeContext(responseContext),
    contact_email: context.contactEmail,
    response_language: responseContext.responseLanguage,
    support_case: context.supportCase,
    agent_confirmed_facts: agentConfirmedFacts,
    approved_memories: formatPromptMemories(approvedMemories),
    confidence,
    warnings: uniqueStrings([...warnings, ...(context.warnings || [])]),
    preserve_draft: preserveDraft,
    skip_insert: skipInsert,
    pending_issue: pendingIssue,
    interaction_type: interactionType,
    allow_composer_overwrite: allowComposerOverwrite
  });
}

async function handlePrepareReply(req, res) {
  const body = await readJsonBody(req);
  const accountId = body.account_id || body.conversation?.account_id || config.chatwootAccountId;
  const conversationId = body.conversation_display_id || body.conversation?.display_id || body.conversation_id;
  const draft = String(body.draft || '').trim();

  if (!draft) return sendJson(res, 422, { error: 'draft is required' });

  await prepareDraftReply({ config, accountId, conversationId, content: draft });
  return sendJson(res, 200, { ok: true });
}

async function prepareConversationContext(body) {
  const requestFingerprint = contextFingerprintFromBody(body);
  const requestEntry = requestFingerprint ? contextJobs.get(requestFingerprint) : null;
  if (requestEntry?.status === 'ready' && requestEntry.value) return requestEntry.value;
  if (requestEntry?.status === 'pending') {
    const context = await requestEntry.promise;
    if (context) return context;
  }
  if (requestEntry?.status === 'failed') contextJobs.remove(requestFingerprint);

  const prepared = await prepareConversationCore(body);
  const existing = contextJobs.get(prepared.contextFingerprint);
  if (existing?.status === 'ready' && existing.value) return existing.value;
  if (existing?.status === 'failed') contextJobs.remove(prepared.contextFingerprint);

  const entry = contextJobs.start(
    prepared.contextFingerprint,
    () => completeConversationContext(prepared)
  );
  const context = await entry.promise;
  if (!context) throw entry.error || new Error('Context enrichment failed.');
  return context;
}

async function prepareConversationCore(body) {
  const timings = {};
  const contextStartedAt = performance.now();
  const accountId = body.account_id || body.conversation?.account_id || config.chatwootAccountId;
  const conversationId = body.conversation_display_id || body.conversation?.display_id || body.conversation_id || body.conversation?.id;
  const fallbackMessages = body.conversation?.messages || [];

  const chatwootResult = await measureStage(timings, 'chatwoot', () => fetchConversationMessages({
    config,
    accountId,
    conversationId
  })).catch(error => ({
    available: false,
    messages: [],
    warnings: [`Chatwoot API lookup failed: ${error.message}`]
  }));

  const messages = chatwootResult.messages.length ? chatwootResult.messages : fallbackMessages;
  const attachmentCandidates = extractAttachmentCandidates(messages);
  const fallbackLatestMessage = prependSubjectToText(body.latest_message || '', body.latest_subject || '');
  const chatwootLatestMessage = latestIncomingMessage(messages);
  const latestMessage = chatwootLatestMessage
    ? prependSubjectToText(chatwootLatestMessage, body.latest_subject || '')
    : fallbackLatestMessage;
  const conversationText = conversationToText(messages);
  const contact = body.contact || body.conversation?.meta?.sender || {};
  const contactEmail = body.contact_email || contact.email || '';
  const contactPhone = body.contact_phone || contact.phone || contact.phone_number
    || contact.additional_attributes?.phone_number || contact.additional_attributes?.phone || '';
  const contactCountryCode = body.country_code || contact.country_code
    || contact.additional_attributes?.country_code || contact.additional_attributes?.country || '';

  const attachmentAnalysisPromise = measureStage(timings, 'attachments', () => analyzeAttachmentCandidates({
    config,
    attachments: attachmentCandidates
  })).catch(error => ({
    available: false,
    source: null,
    reason: 'lookup_failed',
    analyzed_count: 0,
    analyses: [],
    warnings: [`Attachment analysis failed: ${error.message}`]
  }));
  const shopifyContext = await measureStage(timings, 'shopify', () => getShopifyContext({
    config,
    contactEmail,
    contactPhone,
    contactCountryCode,
    text: [latestMessage, conversationText].join('\n'),
    selectedOrderRef: body.selected_order_ref
  }));
  const providerLookupPromise = measureStage(timings, 'provider', () => getAssignedProviders({
    config,
    orders: shopifyContext.orders
  })).catch(error => ({
    available: false,
    source: null,
    reason: 'lookup_failed',
    providers_by_order_ref: {},
    provider: null,
    warnings: [`Provider lookup failed: ${error.message}`]
  }));
  const deliveryEstimatePromise = measureStage(timings, 'delivery', () => getDeliveryEstimateContext({
    config,
    order: shopifyContext.selected_order
  })).catch(error => ({
    available: false,
    source: null,
    reason: 'lookup_failed',
    warnings: [`Delivery analytics lookup failed: ${error.message}`]
  }));
  const issuePromise = measureStage(timings, 'issues', () => getIssueContext({
    config,
    order: shopifyContext.selected_order
  })).catch(error => ({
    available: false,
    source: null,
    reason: 'lookup_failed',
    order_ref: shopifyContext.selected_order?.name || null,
    total: 0,
    issues: [],
    warnings: [`Issue lookup failed: ${error.message}`]
  }));
  const duplicatePromise = measureStage(timings, 'duplicates', () => getDuplicateContext({
    body,
    accountId,
    conversationId,
    contactEmail,
    shopifyContext
  })).catch(error => ({
    available: false,
    source: null,
    reason: 'lookup_failed',
    possible_duplicates: [],
    confirmed_duplicate: false,
    warnings: [`Duplicate lookup failed: ${error.message}`]
  }));

  const providerLookupContext = await providerLookupPromise;
  attachProvidersToShopifyContext(shopifyContext, providerLookupContext);
  const providerContext = selectedProviderContext({ providerLookupContext, order: shopifyContext.selected_order });
  attachProviderToShopifyContext(shopifyContext, providerContext);

  const providerTrackingPromise = measureStage(timings, 'tracking', () => getProviderTrackingContext({
    provider: providerContext.provider,
    order: shopifyContext.selected_order
  })).catch(error => ({
    available: false,
    source: null,
    reason: 'lookup_failed',
    warnings: [`Provider tracking lookup failed: ${error.message}`],
    latest_events: [],
    timeline: []
  }));

  const latestPublicMessage = latestPublicChatMessage(messages);
  const latestMessageId = body.latest_message_id || body.message_id
    || latestPublicMessage?.id || messages.at(-1)?.id
    || `${messages.length}:${latestMessage.slice(0, 80)}`;
  const contextFingerprint = createContextFingerprint({
    accountId,
    conversationId,
    latestMessageId,
    selectedOrderRef: body.selected_order_ref,
    forcedSupportCase: body.forced_support_case
  });
  timings.core = roundDuration(performance.now() - contextStartedAt);

  return {
    body,
    contextFingerprint,
    contextStartedAt,
    timings,
    base: {
      accountId,
      conversationId,
      displayId: body.conversation?.display_id || conversationId,
      contactEmail,
      contactPhone,
      latestMessage,
      conversationText,
      messageCount: messages.length,
      attachmentCandidates,
      chatwootAvailable: Boolean(chatwootResult.available),
      chatwootWarnings: chatwootResult.warnings || [],
      shopifyContext,
      providerContext
    },
    pending: {
      deliveryEstimatePromise,
      providerTrackingPromise,
      issuePromise,
      attachmentAnalysisPromise,
      duplicatePromise
    }
  };
}

async function completeConversationContext(prepared) {
  const [
    deliveryEstimateContext,
    providerTrackingContext,
    issueContext,
    attachmentAnalysis,
    duplicateContext
  ] = await Promise.all([
    prepared.pending.deliveryEstimatePromise,
    prepared.pending.providerTrackingPromise,
    prepared.pending.issuePromise,
    prepared.pending.attachmentAnalysisPromise,
    prepared.pending.duplicatePromise
  ]);
  prepared.timings.total = roundDuration(performance.now() - prepared.contextStartedAt);

  return finalizeConversationContext({
    prepared,
    deliveryEstimateContext,
    providerTrackingContext,
    issueContext,
    attachmentAnalysis,
    duplicateContext
  });
}

function buildCoreConversationContext(prepared) {
  const hasAttachments = prepared.base.attachmentCandidates.length > 0;
  return finalizeConversationContext({
    prepared,
    deliveryEstimateContext: null,
    providerTrackingContext: pendingProviderTrackingContext(),
    issueContext: pendingIssueContext(prepared.base.shopifyContext.selected_order),
    attachmentAnalysis: {
      available: false,
      source: null,
      reason: hasAttachments ? 'pending' : 'no_image_attachments',
      analyzed_count: 0,
      analyses: [],
      warnings: []
    },
    duplicateContext: {
      available: false,
      source: null,
      reason: 'pending',
      possible_duplicates: [],
      confirmed_duplicate: false,
      warnings: []
    }
  });
}

function finalizeConversationContext({
  prepared,
  deliveryEstimateContext,
  providerTrackingContext,
  issueContext,
  attachmentAnalysis,
  duplicateContext
}) {
  const { body, base } = prepared;
  const {
    accountId,
    conversationId,
    displayId,
    contactEmail,
    contactPhone,
    latestMessage,
    conversationText,
    messageCount,
    attachmentCandidates,
    chatwootAvailable,
    chatwootWarnings,
    shopifyContext,
    providerContext
  } = base;

  const warnings = uniqueStrings([
    ...chatwootWarnings,
    ...(shopifyContext.warnings || []),
    ...(providerContext.warnings || []),
    ...(providerTrackingContext?.warnings || []),
    ...(deliveryEstimateContext?.warnings || []),
    ...(issueContext?.warnings || []),
    ...(attachmentAnalysis?.warnings || []),
    ...(duplicateContext?.warnings || [])
  ]);
  const responseLanguage = inferResponseLanguage({ latestMessage, shopifyContext });
  const detectedSupportCase = detectSupportCase({
    latestMessage,
    conversationText,
    shopifyContext,
    providerTrackingContext,
    issueContext,
    attachmentAnalysis,
    duplicateContext
  });
  const requestedForcedSupportCase = String(body.forced_support_case || '').trim();
  const forcedSupportCaseType = normalizeSupportCaseType(requestedForcedSupportCase);
  if (requestedForcedSupportCase && !forcedSupportCaseType) {
    warnings.push(`Invalid forced support case ignored: ${requestedForcedSupportCase}`);
  }
  const supportCase = applyForcedSupportCase({
    detectedSupportCase,
    forcedSupportCaseType
  });
  const caseReview = buildCaseReview({
    supportCase,
    latestMessage,
    shopifyContext,
    providerTrackingContext,
    issueContext,
    attachmentAnalysis,
    duplicateContext
  });

  return {
    contextFingerprint: prepared.contextFingerprint,
    timings: { ...prepared.timings },
    accountId,
    conversationId,
    displayId,
    contactEmail,
    contactPhone,
    latestMessage,
    conversationText,
    messageCount,
    attachmentCandidates,
    chatwootAvailable,
    shopifyContext,
    providerContext,
    providerTrackingContext,
    deliveryEstimateContext,
    issueContext,
    attachmentAnalysis,
    duplicateContext,
    responseLanguage,
    supportCase,
    detectedSupportCase,
    forcedSupportCase: forcedSupportCaseType || null,
    caseReview,
    warnings
  };
}

function pendingProviderTrackingContext() {
  return {
    available: false,
    source: null,
    reason: 'pending',
    latest_events: [],
    timeline: [],
    warnings: []
  };
}

function pendingIssueContext(order) {
  return {
    available: false,
    source: null,
    reason: 'pending',
    order_ref: order?.name || null,
    total: 0,
    issues: [],
    warnings: []
  };
}

async function getDuplicateContext({ body, accountId, conversationId, contactEmail, shopifyContext }) {
  const provided = normalizeProvidedDuplicateContext(body.duplicate_context);
  if (provided) return provided;

  if (!config.chatwootBaseUrl || !config.chatwootApiToken || !accountId || !contactEmail) {
    return {
      available: false,
      source: null,
      reason: 'not_configured_or_missing_contact',
      possible_duplicates: [],
      confirmed_duplicate: false,
      warnings: []
    };
  }

  const data = await listConversations({ config, accountId, status: 'open', page: 1 });
  const selectedOrderRef = shopifyContext?.selected_order?.name || '';
  const trackingNumbers = trackingNumbersFromOrder(shopifyContext?.selected_order);
  const possible = extractConversationList(data)
    .map(conversation => normalizeConversationDuplicateCandidate({
      conversation,
      currentConversationId: conversationId,
      contactEmail,
      selectedOrderRef,
      trackingNumbers
    }))
    .filter(Boolean)
    .slice(0, 5);

  return {
    available: true,
    source: 'chatwoot_conversations',
    reason: possible.length ? 'possible_related_conversations' : 'no_related_conversations_found',
    possible_duplicates: possible,
    confirmed_duplicate: false,
    warnings: []
  };
}

function normalizeProvidedDuplicateContext(value) {
  if (!value || typeof value !== 'object') return null;
  const possible = Array.isArray(value.possible_duplicates)
    ? value.possible_duplicates.map(item => ({
      conversation_id: String(item.conversation_id || item.id || '').trim(),
      status: String(item.status || '').trim(),
      match_reasons: Array.isArray(item.match_reasons) ? item.match_reasons.map(String).filter(Boolean) : []
    })).filter(item => item.conversation_id)
    : [];
  return {
    available: Boolean(value.available ?? true),
    source: String(value.source || 'provided').trim(),
    reason: String(value.reason || '').trim() || (possible.length ? 'provided_duplicates' : 'provided_empty'),
    possible_duplicates: possible,
    confirmed_duplicate: Boolean(value.confirmed_duplicate),
    warnings: Array.isArray(value.warnings) ? value.warnings.map(String).filter(Boolean) : []
  };
}

function normalizeConversationDuplicateCandidate({
  conversation,
  currentConversationId,
  contactEmail,
  selectedOrderRef,
  trackingNumbers
}) {
  const id = String(conversation.display_id || conversation.id || '').trim();
  if (!id || id === String(currentConversationId || '')) return null;

  const sender = conversation.meta?.sender || conversation.contact || conversation.sender || {};
  const email = String(sender.email || conversation.contact_email || '').trim().toLowerCase();
  const matchReasons = [];
  if (email && email === String(contactEmail || '').trim().toLowerCase()) matchReasons.push('same_contact_email');

  const haystack = JSON.stringify(conversation).toLowerCase();
  if (selectedOrderRef && haystack.includes(String(selectedOrderRef).toLowerCase())) matchReasons.push('same_order_ref');
  for (const trackingNumber of trackingNumbers) {
    if (trackingNumber && haystack.includes(trackingNumber.toLowerCase())) matchReasons.push('same_tracking_number');
  }

  if (!matchReasons.length) return null;
  return {
    conversation_id: id,
    status: String(conversation.status || '').trim(),
    assignee: conversation.assignee?.name || conversation.assignee?.email || null,
    last_activity_at: conversation.last_activity_at || null,
    match_reasons: matchReasons
  };
}

function trackingNumbersFromOrder(order = {}) {
  const fulfillments = Array.isArray(order?.fulfillments) ? order.fulfillments : [];
  return uniqueStrings(fulfillments.flatMap(fulfillment => {
    const numbers = Array.isArray(fulfillment.tracking_numbers) ? fulfillment.tracking_numbers : [];
    const tracking = Array.isArray(fulfillment.tracking) ? fulfillment.tracking.map(item => item?.number) : [];
    return [...numbers, ...tracking].map(item => String(item || '').trim()).filter(Boolean);
  }));
}

async function generatePreparedDraftForJob(row) {
  const context = await prepareConversationContext(buildPreparedDraftPayload(row));
  const memoryResult = await getRelevantMemories({
    config,
    context,
    chatMessages: [{ role: 'user', content: 'Generate a reply for this customer.' }]
  });
  const fallbackDraft = buildFallbackDraft({
    shopifyContext: context.shopifyContext,
    latestMessage: context.latestMessage
  });
  const knowledge = await getKnowledge();
  fallbackDraft.warnings.push(...context.warnings, ...memoryResult.warnings, ...(knowledge.warnings || []));

  const fallbackBriefing = buildAgentBriefing({
    context,
    result: {
      reasoning_summary: fallbackDraft.reasoning_summary,
      warnings: fallbackDraft.warnings
    }
  });
  const fallback = {
    assistant_message: formatCompactAgentBriefingForChat(fallbackBriefing),
    draft: fallbackDraft.draft,
    agent_briefing: fallbackBriefing,
    reasoning_summary: fallbackDraft.reasoning_summary,
    confidence: fallbackDraft.confidence,
    warnings: fallbackDraft.warnings
  };
  const prompt = buildPreparedDraftPrompt({
    context,
    approvedMemories: memoryResult.memories,
    knowledgeBase: knowledge.markdown
  });
  const result = await generateChatWithOpenAI({ config, prompt, fallback });
  const draft = enforceDraftRequirements({
    draft: result.draft,
    supportCase: context.supportCase,
    shopifyContext: context.shopifyContext,
    responseLanguage: context.responseLanguage,
    deliveryEstimateContext: context.deliveryEstimateContext,
    latestMessage: context.latestMessage
  });
  const warnings = uniqueStrings([...(result.warnings || []), ...memoryResult.warnings, ...(knowledge.warnings || []), ...context.warnings]);
  const agentBriefing = normalizeAgentBriefing(result.agent_briefing, {
    context,
    result: {
      ...result,
      draft,
      warnings
    }
  });
  const nativeDraft = await writePreparedDraftToChatwoot({
    row,
    draft
  });

  return {
    draft,
    assistant_message: formatCompactAgentBriefingForChat(agentBriefing),
    agent_briefing: agentBriefing,
    reasoning_summary: result.reasoning_summary,
    context_summary: summarizeContext(context),
    context_payload: contextPayload(context, {
      contextFingerprint: context.contextFingerprint,
      contextStatus: 'ready',
      enrichmentStatus: 'ready'
    }),
    context_fingerprint: context.contextFingerprint,
    confidence: result.confidence,
    warnings: uniqueStrings([...warnings, ...nativeDraft.warnings]),
    inserted_at: nativeDraft.inserted_at
  };
}

async function writePreparedDraftToChatwoot({ row, draft }) {
  const content = String(draft || '').trim();
  if (!content) return { inserted_at: null, warnings: [] };

  try {
    const existing = await getDraftReply({
      config,
      accountId: row.account_id,
      conversationId: row.conversation_id
    });
    const existingMessage = String(existing.message || '').trim();
    const previousCopilotDraft = await getLatestInsertedPreparedDraft({
      config,
      accountId: row.account_id,
      conversationId: row.conversation_id,
      excludeId: row.id
    });
    const existingIsPreviousCopilotDraft = previousCopilotDraft?.draft
      && sameDraftText(existingMessage, previousCopilotDraft.draft);
    const canWrite = !existing.has_draft || !existingMessage || existingIsPreviousCopilotDraft;

    if (!canWrite) {
      return {
        inserted_at: null,
        warnings: ['Chatwoot already has a non-empty draft. The prepared draft was not inserted to avoid overwriting agent text.']
      };
    }

    await prepareDraftReply({
      config,
      accountId: row.account_id,
      conversationId: row.conversation_id,
      content
    });

    return { inserted_at: new Date().toISOString(), warnings: [] };
  } catch (error) {
    return {
      inserted_at: null,
      warnings: [`Chatwoot native draft insert failed: ${error.message}`]
    };
  }
}

function buildPreparedDraftPrompt({ context, approvedMemories = [], knowledgeBase }) {
  const prompt = buildPrompt({
    knowledgeBase,
    conversationText: context.conversationText,
    shopifyContext: context.shopifyContext,
    latestMessage: context.latestMessage,
    agentEmail: 'background@kitsrepublic.com',
    responseLanguage: context.responseLanguage,
    supportCase: context.supportCase,
    deliveryEstimateContext: context.deliveryEstimateContext,
    providerTrackingContext: context.providerTrackingContext,
    issueContext: context.issueContext,
    attachmentAnalysis: context.attachmentAnalysis,
    caseReview: context.caseReview
  });

  return {
    system: prompt.system.replace(
      'Return strict JSON only with keys: draft, reasoning_summary, confidence, warnings.',
      [
        'Return strict JSON only with keys: assistant_message, draft, agent_briefing, reasoning_summary, confidence, warnings.',
        'assistant_message is internal and must be written in concise English for the support agent.',
        'agent_briefing is internal and must be a concise English JSON object with keys: summary, detected_case, playbook_used, decision_path, verified_facts, missing_information, recommended_decision, action_required, before_sending_checklist, customer_reply_summary, post_send_action, risks_or_warnings.',
        'Use the published Playbook documentation and Decision Tree when relevant. Include the selected Playbook and tree path in agent_briefing, not in the customer draft.',
        'Keep the visible brief short: 8-12 lines maximum when formatted.',
        'before_sending_checklist must only list manual Shopify/admin/supplier actions that matter before sending.',
        'If no manual action is needed, before_sending_checklist must include exactly: "No manual action needed. Review the draft and send it if correct."',
        'Never put agent_briefing content inside the customer draft.'
      ].join('\n')
    ),
    user: [
      prompt.user,
      '',
      'Background pre-draft task:',
      'Generate the customer draft now. Also generate a concise English internal agent_briefing that summarizes what the agent must do before sending.',
      '',
      'Approved support memories:',
      JSON.stringify(formatPromptMemories(approvedMemories), null, 2)
    ].join('\n')
  };
}

function attachProviderToShopifyContext(shopifyContext, providerContext) {
  const provider = providerContext?.provider;
  if (!shopifyContext?.selected_order || !provider) return;

  shopifyContext.selected_order.provider = provider.label;
  shopifyContext.selected_order.assigned_provider = provider;
}

function attachProvidersToShopifyContext(shopifyContext, providerLookupContext) {
  const providersByOrderRef = providerLookupContext?.providers_by_order_ref || {};
  if (!shopifyContext?.orders?.length) return;

  for (const order of shopifyContext.orders) {
    const provider = providersByOrderRef[order.name]?.provider;
    if (!provider) continue;
    order.provider = provider.label;
    order.assigned_provider = provider;
  }
}

function selectedProviderContext({ providerLookupContext, order }) {
  if (!order) return { available: false, source: null, reason: 'no_order', provider: null, warnings: [] };
  if (!providerLookupContext?.available) {
    return {
      available: false,
      source: null,
      reason: providerLookupContext?.reason || 'lookup_failed',
      provider: null,
      warnings: providerLookupContext?.warnings || []
    };
  }

  return providerLookupContext.providers_by_order_ref?.[order.name] || {
    available: false,
    source: providerLookupContext.source || null,
    reason: 'order_not_found',
    provider: null,
    warnings: [`Provider lookup could not find ${order.name || 'the selected order'} in the Kits Republic orders database.`]
  };
}

function contextPayload(context, {
  contextFingerprint = null,
  contextStatus = 'ready',
  enrichmentStatus = 'ready'
} = {}) {
  return {
    context_fingerprint: contextFingerprint,
    context_status: contextStatus,
    enrichment_status: enrichmentStatus,
    account_id: context.accountId,
    conversation_id: context.conversationId,
    display_id: context.displayId,
    contact_email: context.contactEmail,
    contact_phone: context.contactPhone || null,
    latest_message: context.latestMessage,
    message_count: context.messageCount,
    chatwoot_available: context.chatwootAvailable,
    response_language: context.responseLanguage,
    support_case: context.supportCase,
    detected_support_case: context.detectedSupportCase,
    forced_support_case: context.forcedSupportCase,
    provider_context: context.providerContext,
    provider_tracking_context: context.providerTrackingContext,
    delivery_estimate_context: context.deliveryEstimateContext,
    issue_context: context.issueContext,
    attachment_candidates: summarizeAttachmentCandidates(context.attachmentCandidates),
    attachment_analysis: context.attachmentAnalysis,
    duplicate_context: context.duplicateContext,
    case_review: context.caseReview,
    shopify_context: context.shopifyContext,
    context_summary: summarizeContext(context),
    warnings: context.warnings
  };
}

function summarizeContext(context) {
  const order = context.shopifyContext.selected_order;
  if (!order) {
    return {
      customer: context.contactEmail || null,
      order: null,
      status: 'No single Shopify order selected.',
      selected_order_ref: null,
      order_candidates: summarizeOrderCandidates(context.shopifyContext.orders),
      provider_tracking_context: null,
      delivery_estimate_context: null,
      issue_context: context.issueContext,
      attachment_candidates: summarizeAttachmentCandidates(context.attachmentCandidates),
      attachment_analysis: context.attachmentAnalysis,
      duplicate_context: context.duplicateContext,
      case_review: context.caseReview,
      response_language: context.responseLanguage,
      support_case: context.supportCase,
      detected_support_case: context.detectedSupportCase,
      forced_support_case: context.forcedSupportCase
    };
  }

  const fulfillment = selectSummaryFulfillment(order);
  const tracking = fulfillment?.tracking?.find(item => item?.number || item?.url) || fulfillment?.tracking?.[0];
  return {
    customer: order.email || context.contactEmail || null,
    order: order.name,
    admin_order_url: buildKitsAdminOrderUrl(order),
    shopify_admin_url: buildShopifyAdminOrderUrl(order),
    selected_order_ref: order.name,
    order_candidates: summarizeOrderCandidates(context.shopifyContext.orders, order.name),
    order_created_at: order.created_at || null,
    provider: context.providerContext?.provider?.label || null,
    provider_source: context.providerContext?.source || null,
    provider_code: context.providerContext?.provider?.code || null,
    provider_name: context.providerContext?.provider?.name || null,
    provider_assigned_at: context.providerContext?.provider?.assigned_at || null,
    provider_assignment_source: context.providerContext?.provider?.assignment_source || null,
    line_items: summarizeLineItems(order.line_items),
    fulfillment_status: order.fulfillment_status || null,
    fulfillment_created_at: fulfillment?.created_at || null,
    shipment_status: fulfillment?.display_status || null,
    tracking_carrier: tracking?.company || null,
    tracking_number: tracking?.number || null,
    tracking_url: buildPublicTrackingUrl(tracking?.number) || tracking?.url || null,
    provider_tracking_context: context.providerTrackingContext,
    delivery_estimate_context: context.deliveryEstimateContext,
    issue_context: context.issueContext,
    attachment_candidates: summarizeAttachmentCandidates(context.attachmentCandidates),
    attachment_analysis: context.attachmentAnalysis,
    duplicate_context: context.duplicateContext,
    case_review: context.caseReview,
    shipping_country: order.shipping_address?.country || null,
    shipping_country_code: order.shipping_address?.country_code || null,
    response_language: context.responseLanguage,
    support_case: context.supportCase,
    detected_support_case: context.detectedSupportCase,
    forced_support_case: context.forcedSupportCase
  };
}

function summarizeLineItems(lineItems = []) {
  return (Array.isArray(lineItems) ? lineItems : []).slice(0, 10).map(item => ({
    id: item.id || item.shopify_line_item_id || null,
    shopify_line_item_id: item.shopify_line_item_id || item.id || null,
    name: item.name || null,
    quantity: item.quantity || null,
    sku: item.sku || null,
    fulfillment_status: item.fulfillment_status || null,
    custom_attributes: summarizeCustomAttributes(item.custom_attributes)
  }));
}

function summarizeAttachmentCandidates(attachments = []) {
  return (Array.isArray(attachments) ? attachments : []).slice(0, 5).map(attachment => ({
    id: attachment.id || null,
    filename: attachment.filename || null,
    content_type: attachment.content_type || null,
    file_size: attachment.file_size || null,
    width: attachment.width || null,
    height: attachment.height || null,
    message_id: attachment.message_id || null,
    created_at: attachment.created_at || null
  }));
}

function summarizeCustomAttributes(attributes = []) {
  return (Array.isArray(attributes) ? attributes : [])
    .map(attribute => ({
      key: String(attribute?.key || '').trim(),
      value: String(attribute?.value || '').trim()
    }))
    .filter(attribute => attribute.key || attribute.value);
}

function summarizeOrderCandidates(orders = [], selectedOrderRef = '') {
  return orders.map(order => {
    const fulfillment = selectSummaryFulfillment(order);
    const tracking = fulfillment?.tracking?.find(item => item?.number || item?.url) || fulfillment?.tracking?.[0];
    return {
      order: order.name,
      admin_order_url: buildKitsAdminOrderUrl(order),
      shopify_admin_url: buildShopifyAdminOrderUrl(order),
      date: order.created_at || null,
      shopify_status: order.fulfillment_status || null,
      provider: order.provider || order.assigned_provider?.label || null,
      provider_code: order.assigned_provider?.code || null,
      provider_name: order.assigned_provider?.name || null,
      shipment_status: fulfillment?.display_status || null,
      country: order.shipping_address?.country || null,
      country_code: order.shipping_address?.country_code || null,
      tracking_carrier: tracking?.company || null,
      tracking_number: tracking?.number || null,
      selected: Boolean(selectedOrderRef && order.name === selectedOrderRef)
    };
  });
}

function buildShopifyAdminOrderUrl(order = {}) {
  const orderId = String(order.id || '').match(/(\d+)$/)?.[1];
  if (!config.shopifyStoreDomain || !orderId) return null;
  return `https://${config.shopifyStoreDomain}/admin/orders/${orderId}`;
}

function buildKitsAdminOrderUrl(order = {}) {
  const orderName = String(order.name || '').trim();
  if (!config.kitsAdminBaseUrl || !orderName) return null;
  return `${config.kitsAdminBaseUrl}/kits-republic/orders?q=${encodeURIComponent(orderName)}`;
}

function selectSummaryFulfillment(order = {}) {
  const fulfillments = Array.isArray(order.fulfillments) ? order.fulfillments : [];
  return fulfillments.find(fulfillment => {
    return Array.isArray(fulfillment.tracking) && fulfillment.tracking.some(item => item?.number || item?.url);
  }) || fulfillments[0];
}

function normalizeChatMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map(message => ({
      role: message?.role === 'assistant' ? 'assistant' : 'user',
      content: String(message?.content || '').trim()
    }))
    .filter(message => message.content)
    .slice(-24);
}

function normalizeBackfillStatuses(value) {
  const raw = Array.isArray(value) ? value : [value];
  const statuses = raw.map(item => String(item || '').trim().toLowerCase()).filter(Boolean);
  return statuses.length ? [...new Set(statuses)] : ['open', 'pending', 'snoozed'];
}

function extractConversationList(data = {}) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.payload)) return data.payload;
  if (Array.isArray(data.conversations)) return data.conversations;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.data?.payload)) return data.data.payload;
  if (Array.isArray(data.data?.conversations)) return data.data.conversations;
  return [];
}

function latestPublicChatMessage(messages = []) {
  const publicMessages = (Array.isArray(messages) ? messages : [])
    .filter(message => message && message.private !== true)
    .filter(message => String(message.message_type || '').toLowerCase() !== 'activity')
    .sort((a, b) => messageTimestamp(a) - messageTimestamp(b));
  return publicMessages.at(-1) || null;
}

function messageTimestamp(message = {}) {
  const raw = message.created_at || message.createdAt || message.timestamp || 0;
  if (typeof raw === 'number') return raw;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isIncomingMessageType(value) {
  return value === 0 || value === '0' || String(value || '').toLowerCase() === 'incoming';
}

function preparedDraftWebhookFromConversation({ accountId, conversation = {}, latestMessage = {} }) {
  const contact = latestMessage.sender || conversation.meta?.sender || {};
  const displayId = conversation.display_id || conversation.id;
  return {
    event: 'message_created',
    id: latestMessage.id,
    message_type: latestMessage.message_type,
    private: false,
    content: latestMessage.content || latestMessage.processed_message_content || '',
    content_attributes: latestMessage.content_attributes || {},
    account: { id: accountId },
    conversation: {
      ...conversation,
      id: displayId,
      display_id: displayId
    },
    conversation_id: displayId,
    sender: contact
  };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function sameDraftText(left = '', right = '') {
  return normalizeDraftForComparison(left) === normalizeDraftForComparison(right);
}

function normalizeDraftForComparison(value = '') {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function latestUserChatMessage(messages = []) {
  return [...messages].reverse().find(message => message?.role !== 'assistant')?.content || '';
}

function buildFallbackAssistantMessage({ context, currentDraft, agentConfirmedFacts = [] }) {
  if (agentConfirmedFacts.length) {
    return 'I used the agent-confirmed operational context and kept the draft ready for human review.';
  }
  if (currentDraft) {
    return 'OpenAI is unavailable right now, so I kept the current draft unchanged. Review the context warnings before sending.';
  }
  if (!context.shopifyContext.selected_order) {
    return 'I could not select a single Shopify order from the available context. The draft asks the customer for the missing order details.';
  }
  return 'I prepared a conservative draft from the selected Shopify order context.';
}

function normalizeAssistantMessage({ assistantMessage = '', agentConfirmedFacts = [], chatMessages = [] }) {
  const message = String(assistantMessage || '').trim();
  if (!agentConfirmedFacts.length) return message;

  const isRefusalOrToneLecture =
    /\b(abusive language|can't follow|cannot follow|can't state|cannot state|should avoid saying|avoid saying|one note:|verified Shopify|Shopify already shows|Shopify tracking only supports|Shopify only supports|source of truth)\b/i.test(message);

  if (!isRefusalOrToneLecture) return message;

  const agentLanguage = detectLanguageFromText([...chatMessages].reverse().find(item => item.role === 'user')?.content || '');
  if (agentLanguage === 'Spanish') return 'He usado tu confirmación operativa y he ajustado el draft.';
  return 'I used your operational confirmation and updated the draft.';
}

function authorizeApiRequest(req, url, res) {
  if (!config.copilotApiToken) return true;
  const header = req.headers.authorization || '';
  const bearer = header.replace(/^Bearer\s+/i, '').trim();
  const queryToken = url.searchParams.get('token') || '';

  if (bearer === config.copilotApiToken || queryToken === config.copilotApiToken) return true;

  sendJson(res, 401, { error: 'Unauthorized' });
  return false;
}

async function readJsonBody(req) {
  const raw = await readRawBody(req);
  return raw ? JSON.parse(raw) : {};
}

async function readRawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isRequestAbortError(error) {
  if (!error) return false;
  return error.code === 'ECONNRESET' ||
    error.name === 'AbortError' ||
    error.message === 'aborted' ||
    error.message === 'The operation was aborted';
}

async function serveStatic(pathname, res) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }

  try {
    const file = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': mimeType(filePath) });
    return res.end(file);
  } catch {
    return sendJson(res, 404, { error: 'Not found' });
  }
}

function addSecurityHeaders(_req, res) {
  const frameAncestors = ["'self'"];
  if (config.chatwootBaseUrl) frameAncestors.push(new URL(config.chatwootBaseUrl).origin);
  res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors.join(' ')}; default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';`);
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...headers
  });
  res.end(JSON.stringify(data));
}

async function measureStage(timings, name, operation) {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    timings[name] = roundDuration(performance.now() - startedAt);
  }
}

function roundDuration(value) {
  return Math.round(Number(value) * 10) / 10;
}

function serverTimingHeaders(timings = {}) {
  const metrics = Object.entries(timings)
    .filter(([, duration]) => Number.isFinite(Number(duration)))
    .map(([name, duration]) => `${name.replace(/[^a-z0-9_-]/gi, '_')};dur=${Number(duration)}`);
  return metrics.length ? { 'Server-Timing': metrics.join(', ') } : {};
}

function logContextTiming({
  fingerprint,
  status,
  cacheHit,
  timings = {},
  context = null
}) {
  console.log(JSON.stringify({
    event: 'context_timing',
    fingerprint: String(fingerprint || '').slice(0, 12),
    status,
    cache_hit: cacheHit,
    timings_ms: timings,
    shopify_queries: context?.shopifyContext?.queries?.length || 0,
    attachments: context?.attachmentCandidates?.length || 0,
    warnings: context?.warnings?.length || 0
  }));
}

function mimeType(filePath) {
  const ext = extname(filePath);
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  return 'application/octet-stream';
}

function uniqueStrings(values = []) {
  return [...new Set(values.filter(Boolean).map(String))];
}
