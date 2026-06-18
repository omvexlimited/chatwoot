import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { loadConfig, getConfigStatus } from './config.js';
import { fetchConversationMessages, createPrivateNote, prepareDraftReply } from './chatwoot.js';
import { getShopifyContext } from './shopify.js';
import { getAssignedProviders } from './provider-lookup.js';
import { getProviderTrackingContext } from './provider-tracking.js';
import { getDeliveryEstimateContext } from './delivery-estimates.js';
import { getIssueContext } from './issue-lookup.js';
import { applyAgentDraftLanguageOverride, detectLanguageFromText, inferResponseLanguage } from './language.js';
import { detectSupportCase } from './support-case.js';
import { enforceDraftRequirements } from './draft-rules.js';
import { buildPublicTrackingUrl } from './tracking-url.js';
import { extractAgentConfirmedFacts } from './agent-facts.js';
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
  formatAgentBriefingForChat,
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');
const config = loadConfig();
const knowledgeBase = await loadKnowledgeBase();
await ensureMemoryTable({ config }).catch(error => {
  console.warn(`KR Copilot memory disabled: ${error.message}`);
});
await ensurePreparedDraftsTable({ config }).catch(error => {
  console.warn(`KR Copilot prepared drafts disabled: ${error.message}`);
});
startPreparedDraftWorker({ config, generate: generatePreparedDraftForJob });

const server = http.createServer(async (req, res) => {
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

    if (req.method === 'POST' && url.pathname === '/api/copilot-chat') {
      if (!authorizeApiRequest(req, url, res)) return;
      return handleCopilotChat(req, res);
    }

    if (req.method === 'POST' && url.pathname === '/api/prepared-draft') {
      if (!authorizeApiRequest(req, url, res)) return;
      return handlePreparedDraft(req, res);
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
    return sendJson(res, 500, { error: error.message });
  }
});

server.listen(config.port, () => {
  console.log(`KR Copilot listening on ${config.port}`);
});

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

  const prompt = buildPrompt({
    knowledgeBase,
    conversationText: context.conversationText,
    shopifyContext: context.shopifyContext,
    latestMessage: context.latestMessage,
    agentEmail: body.agent_email,
    responseLanguage: context.responseLanguage,
    supportCase: context.supportCase,
    deliveryEstimateContext: context.deliveryEstimateContext,
    providerTrackingContext: context.providerTrackingContext,
    issueContext: context.issueContext
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
    context_summary: summarizeContext(context),
    contact_email: context.contactEmail,
    response_language: context.responseLanguage,
    support_case: context.supportCase,
    confidence: result.confidence,
    warnings: uniqueStrings([...(result.warnings || []), ...context.warnings])
  });
}

async function handleContext(req, res) {
  const body = await readJsonBody(req);
  const context = await prepareConversationContext(body);
  return sendJson(res, 200, contextPayload(context));
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
  const ticketResult = await runNewTicketCommand({
    command,
    config,
    context: responseContext,
    pendingIssue
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
  fallbackDraft.warnings.push(...context.warnings, ...memoryResult.warnings);

  const fallback = {
    assistant_message: buildFallbackAssistantMessage({ context: responseContext, currentDraft, agentConfirmedFacts }),
    draft: currentDraft || fallbackDraft.draft,
    reasoning_summary: currentDraft
      ? 'OpenAI was unavailable, so the existing draft was preserved.'
      : fallbackDraft.reasoning_summary,
    confidence: currentDraft ? 'low' : fallbackDraft.confidence,
    warnings: fallbackDraft.warnings
  };

  const prompt = buildCopilotChatPrompt({
    knowledgeBase,
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
    issueContext: context.issueContext
  });

  const result = await generateChatWithOpenAI({ config, prompt, fallback });
  const assistantMessage = normalizeAssistantMessage({
    assistantMessage: result.assistant_message,
    agentConfirmedFacts,
    chatMessages
  });
  const draft = enforceDraftRequirements({
    draft: result.draft,
    supportCase: context.supportCase,
    shopifyContext: context.shopifyContext,
    responseLanguage: effectiveResponseLanguage,
    deliveryEstimateContext: context.deliveryEstimateContext,
    latestMessage: context.latestMessage
  });

  return sendCopilotChatResponse(res, {
    context,
    responseContext,
    assistantMessage,
    draft,
    reasoningSummary: result.reasoning_summary,
    confidence: result.confidence,
    warnings: [...(result.warnings || []), ...memoryResult.warnings],
    agentConfirmedFacts,
    approvedMemories: memoryResult.memories
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
  pendingIssue = null
}) {
  return sendJson(res, 200, {
    assistant_message: assistantMessage,
    draft,
    reasoning_summary: reasoningSummary,
    shopify_context: context.shopifyContext,
    provider_context: context.providerContext,
    provider_tracking_context: context.providerTrackingContext,
    issue_context: context.issueContext,
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
    pending_issue: pendingIssue
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
  const accountId = body.account_id || body.conversation?.account_id || config.chatwootAccountId;
  const conversationId = body.conversation_display_id || body.conversation?.display_id || body.conversation_id || body.conversation?.id;
  const fallbackMessages = body.conversation?.messages || [];

  const chatwootResult = await fetchConversationMessages({
    config,
    accountId,
    conversationId
  }).catch(error => ({
    available: false,
    messages: [],
    warnings: [`Chatwoot API lookup failed: ${error.message}`]
  }));

  const messages = chatwootResult.messages.length ? chatwootResult.messages : fallbackMessages;
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

  const shopifyContext = await getShopifyContext({
    config,
    contactEmail,
    contactPhone,
    contactCountryCode,
    text: [latestMessage, conversationText].join('\n'),
    selectedOrderRef: body.selected_order_ref
  });
  const providerLookupContext = await getAssignedProviders({
    config,
    orders: shopifyContext.orders
  }).catch(error => ({
    available: false,
    source: null,
    reason: 'lookup_failed',
    providers_by_order_ref: {},
    provider: null,
    warnings: [`Provider lookup failed: ${error.message}`]
  }));
  attachProvidersToShopifyContext(shopifyContext, providerLookupContext);
  const providerContext = selectedProviderContext({ providerLookupContext, order: shopifyContext.selected_order });
  attachProviderToShopifyContext(shopifyContext, providerContext);

  const deliveryEstimateContext = await getDeliveryEstimateContext({
    config,
    order: shopifyContext.selected_order
  }).catch(error => ({
    available: false,
    source: null,
    reason: 'lookup_failed',
    warnings: [`Delivery analytics lookup failed: ${error.message}`]
  }));

  const providerTrackingContext = await getProviderTrackingContext({
    provider: providerContext.provider,
    order: shopifyContext.selected_order
  }).catch(error => ({
    available: false,
    source: null,
    reason: 'lookup_failed',
    warnings: [`Provider tracking lookup failed: ${error.message}`],
    latest_events: [],
    timeline: []
  }));

  const issueContext = await getIssueContext({
    config,
    order: shopifyContext.selected_order
  }).catch(error => ({
    available: false,
    source: null,
    reason: 'lookup_failed',
    order_ref: shopifyContext.selected_order?.name || null,
    total: 0,
    issues: [],
    warnings: [`Issue lookup failed: ${error.message}`]
  }));

  const warnings = uniqueStrings([
    ...(chatwootResult.warnings || []),
    ...(shopifyContext.warnings || []),
    ...(providerContext.warnings || []),
    ...(providerTrackingContext?.warnings || []),
    ...(deliveryEstimateContext?.warnings || []),
    ...(issueContext?.warnings || [])
  ]);
  const responseLanguage = inferResponseLanguage({ latestMessage, shopifyContext });
  const supportCase = detectSupportCase({ latestMessage, conversationText, shopifyContext });

  return {
    accountId,
    conversationId,
    displayId: body.conversation?.display_id || conversationId,
    contactEmail,
    contactPhone,
    latestMessage,
    conversationText,
    messageCount: messages.length,
    chatwootAvailable: Boolean(chatwootResult.available),
    shopifyContext,
    providerContext,
    providerTrackingContext,
    deliveryEstimateContext,
    issueContext,
    responseLanguage,
    supportCase,
    warnings
  };
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
  fallbackDraft.warnings.push(...context.warnings, ...memoryResult.warnings);

  const fallbackBriefing = buildAgentBriefing({
    context,
    result: {
      reasoning_summary: fallbackDraft.reasoning_summary,
      warnings: fallbackDraft.warnings
    }
  });
  const fallback = {
    assistant_message: formatAgentBriefingForChat(fallbackBriefing),
    draft: fallbackDraft.draft,
    agent_briefing: fallbackBriefing,
    reasoning_summary: fallbackDraft.reasoning_summary,
    confidence: fallbackDraft.confidence,
    warnings: fallbackDraft.warnings
  };
  const prompt = buildPreparedDraftPrompt({
    context,
    approvedMemories: memoryResult.memories
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
  const warnings = uniqueStrings([...(result.warnings || []), ...memoryResult.warnings, ...context.warnings]);
  const agentBriefing = normalizeAgentBriefing(result.agent_briefing, {
    context,
    result: {
      ...result,
      draft,
      warnings
    }
  });

  return {
    draft,
    assistant_message: formatAgentBriefingForChat(agentBriefing),
    agent_briefing: agentBriefing,
    reasoning_summary: result.reasoning_summary,
    context_summary: summarizeContext(context),
    confidence: result.confidence,
    warnings
  };
}

function buildPreparedDraftPrompt({ context, approvedMemories = [] }) {
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
    issueContext: context.issueContext
  });

  return {
    system: prompt.system.replace(
      'Return strict JSON only with keys: draft, reasoning_summary, confidence, warnings.',
      [
        'Return strict JSON only with keys: assistant_message, draft, agent_briefing, reasoning_summary, confidence, warnings.',
        'assistant_message is internal and must be written in Spanish for the support agent.',
        'agent_briefing is internal and must be a JSON object in Spanish with keys: summary, detected_case, action_required, before_sending_checklist, customer_reply_summary, risks_or_warnings.',
        'before_sending_checklist must explicitly list any manual Shopify/admin/supplier action needed before sending the customer reply.',
        'If no manual action is needed, before_sending_checklist must include exactly: "No hace falta acción manual. Revisa el borrador y envíalo si está correcto."',
        'Never put agent_briefing content inside the customer draft.'
      ].join('\n')
    ),
    user: [
      prompt.user,
      '',
      'Background pre-draft task:',
      'Generate the customer draft now. Also generate an internal Spanish agent_briefing that summarizes what the agent must do before sending.',
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

function contextPayload(context) {
  return {
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
    provider_context: context.providerContext,
    provider_tracking_context: context.providerTrackingContext,
    delivery_estimate_context: context.deliveryEstimateContext,
    issue_context: context.issueContext,
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
      response_language: context.responseLanguage,
      support_case: context.supportCase
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
    shipping_country: order.shipping_address?.country || null,
    shipping_country_code: order.shipping_address?.country_code || null,
    response_language: context.responseLanguage,
    support_case: context.supportCase
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

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
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
