import { appendIssueAttachmentsToFormData } from './issue-attachment-upload.js';

const ISSUE_TYPES = [
  'address',
  'customization',
  'missing_size',
  'shipping',
  'replacement',
  'missing_item',
  'stock',
  'damaged',
  'wrong_item_size',
  'other'
];

const OPENAI_TIMEOUT_MS = 20000;
const MAX_ISSUE_ATTACHMENTS = 5;
const EVIDENCE_ISSUE_TYPES = new Set(['customization', 'damaged', 'wrong_item_size', 'missing_item', 'missing_size', 'replacement']);

export async function runNewTicketCommand({ command, config, context, pendingIssue, agentEmail } = {}) {
  if (!command || command.name !== 'newticket') return null;

  const argument = String(command.argument || '').trim();
  const action = argument.toLowerCase();
  if (action === 'cancel') {
    return ticketResponse('New ticket proposal cancelled.', { pendingIssue: null });
  }
  if (action === 'approve') {
    return approvePendingIssue({ config, pendingIssue, agentEmail });
  }

  const validation = validateTicketContext(context);
  if (validation) return ticketResponse(validation, { pendingIssue: null, confidence: 'low' });

  return prepareNewTicketProposalFromContext({ config, context, hint: argument });
}

export async function runPendingTicketFeedback({ message, pendingIssue, config, context } = {}) {
  const content = String(message || '').trim();
  const current = normalizePendingIssue(pendingIssue);
  if (!content || !current) return null;

  return revisePendingTicketProposalFromFeedback({
    config,
    context,
    proposal: current,
    feedback: content
  });
}

export async function prepareNewTicketProposalFromContext({ config, context, hint = '' } = {}) {
  const fallback = fallbackProposalResult({ config, context, hint });
  if (!config?.openaiApiKey) return fallback;

  const result = await requestIssueProposal({
    config,
    prompt: buildIssueProposalPrompt({ context, hint }),
    fallback
  });
  if (result.handled) return result;

  const proposal = normalizeGeneratedProposal({
    config,
    context,
    generated: result.generated
  });
  if (!proposal) return fallback;

  return ticketResponse(formatProposal(proposal, context), {
    pendingIssue: proposal,
    confidence: result.confidence,
    warnings: result.warnings
  });
}

export async function revisePendingTicketProposalFromFeedback({ config, context, proposal, feedback } = {}) {
  const current = normalizePendingIssue(proposal);
  if (!current) return null;

  const fallbackProposal = reviseIssueProposal({ proposal: current, feedback, context });
  const fallback = ticketResponse(formatProposal(fallbackProposal, context), {
    pendingIssue: fallbackProposal,
    confidence: 'medium'
  });
  if (!config?.openaiApiKey) return fallback;

  const result = await requestIssueProposal({
    config,
    prompt: buildIssueRevisionPrompt({ context, proposal: current, feedback }),
    fallback
  });
  if (result.handled) return result;

  const updated = normalizeGeneratedProposal({
    config,
    context,
    generated: result.generated,
    baseProposal: current
  });
  if (!updated) return fallback;
  const attachmentUpdate = applyAttachmentFeedback({ proposal: updated, feedback, context });
  const finalProposal = {
    ...updated,
    ...attachmentUpdate
  };

  return ticketResponse(formatProposal(finalProposal, context), {
    pendingIssue: finalProposal,
    confidence: result.confidence,
    warnings: result.warnings
  });
}

export function normalizePendingIssue(value) {
  if (!value || typeof value !== 'object') return null;
  const orderRef = normalizeOrderRef(value.order_ref);
  const providerId = Number(value.provider_id);
  const issueType = ISSUE_TYPES.includes(value.issue_type) ? value.issue_type : 'other';
  const message = String(value.message || '').trim().slice(0, 2000);
  if (!orderRef || !Number.isInteger(providerId) || providerId <= 0 || !message) return null;
  const affectedLineItemIds = normalizeAffectedLineItemIds(value.affected_line_item_ids);
  return {
    order_ref: orderRef,
    provider_id: providerId,
    provider_label: String(value.provider_label || '').trim(),
    issue_type: issueType,
    message,
    affected_line_item_ids: affectedLineItemIds,
    affected_line_items: normalizeAffectedLineItems(value.affected_line_items, affectedLineItemIds),
    attachments: normalizeIssueAttachments(value.attachments),
    allow_without_attachments: Boolean(value.allow_without_attachments),
    admin_order_url: String(value.admin_order_url || '').trim(),
    updated_at: value.updated_at || new Date().toISOString()
  };
}

function validateTicketContext(context = {}) {
  const order = context.shopifyContext?.selected_order;
  const orders = context.shopifyContext?.orders || [];
  if (!order && orders.length > 1) {
    return 'I found multiple Shopify orders. Select one order in Context before creating a ticket.';
  }
  if (!order) {
    return 'No selected Shopify order found. Select or identify the order before creating a ticket.';
  }
  const provider = context.providerContext?.provider;
  if (!provider?.id) {
    return `No provider is assigned for ${order.name}. Assign or load the provider before creating a ticket.`;
  }
  return '';
}

function fallbackProposalResult({ config, context, hint = '' }) {
  const trimmedHint = String(hint || '').trim();
  if (!trimmedHint) {
    return ticketResponse(
      'I need one more detail before proposing an issue. Tell me briefly what problem should be reported, or add the missing context in the conversation.',
      {
        pendingIssue: null,
        confidence: 'low',
        warnings: config?.openaiApiKey ? [] : ['OpenAI is not configured, so automatic issue detection is unavailable.']
      }
    );
  }

  const proposal = buildIssueProposal({ config, context, details: trimmedHint });
  return ticketResponse(formatProposal(proposal, context), {
    pendingIssue: proposal,
    confidence: 'medium',
    warnings: config?.openaiApiKey ? [] : ['OpenAI is not configured, so the agent hint was used as the issue source.']
  });
}

function buildIssueProposal({ config, context, details }) {
  const order = context.shopifyContext.selected_order;
  const provider = context.providerContext.provider;
  const issueType = detectIssueType(details);
  const affected = resolveAffectedLineItems({ order, issueType, text: details });
  const attachments = selectIssueAttachments({ context, issueType });
  return {
    order_ref: normalizeOrderRef(order.name),
    provider_id: Number(provider.id),
    provider_label: provider.label || provider.name || provider.code || String(provider.id),
    issue_type: issueType,
    message: buildIssueMessage({ issueType, details, order }),
    affected_line_item_ids: affected.ids,
    affected_line_items: affected.items,
    attachments,
    allow_without_attachments: false,
    admin_order_url: buildAdminOrderUrl({ config, orderRef: order.name }),
    updated_at: new Date().toISOString()
  };
}

function reviseIssueProposal({ proposal, feedback, context }) {
  const issueType = detectIssueType(feedback, proposal.issue_type);
  const attachmentUpdate = applyAttachmentFeedback({
    proposal: { ...proposal, issue_type: issueType },
    feedback,
    context
  });
  let message = proposal.message;
  if (/\b(urgent|urgente|priority|prioridad)\b/i.test(feedback) && !/^Urgent:/i.test(message)) {
    message = `Urgent: ${message}`;
  }
  if (/\b(add|añade|incluye|include|pon|mete)\b/i.test(feedback)) {
    message = `${message}\nAgent update: ${feedback}`;
  } else if (issueType !== proposal.issue_type) {
    message = message.replace(/^([A-Za-z ]+ issue for order #[0-9]+:)/, `${issueLabel(issueType)} issue for order ${proposal.order_ref}:`);
  } else {
    message = `${message}\nAgent feedback: ${feedback}`;
  }
  return {
    ...proposal,
    issue_type: issueType,
    message: compactInternalIssueMessage({
      message,
      context,
      orderRef: proposal.order_ref
    }),
    ...resolveRevisionAffectedLineItems({ proposal, feedback, context, issueType }),
    ...attachmentUpdate,
    updated_at: new Date().toISOString()
  };
}

async function approvePendingIssue({ config, pendingIssue, agentEmail }) {
  const proposal = normalizePendingIssue(pendingIssue);
  if (!proposal) {
    return ticketResponse('No pending ticket proposal. Use /newticket first to generate a proposal from the current context.', {
      pendingIssue: null,
      confidence: 'low'
    });
  }
  if (!config.kitsInternalApiToken) {
    return ticketResponse('Kits internal issue API is not configured. Add KITS_INTERNAL_API_TOKEN in Railway.', {
      pendingIssue: proposal,
      confidence: 'low',
      warnings: ['KITS_INTERNAL_API_TOKEN is missing.']
    });
  }
  if (needsImageEvidence(proposal) && !proposal.attachments.length) {
    return ticketResponse(
      'This issue type should include customer photos before creating the ticket. Ask the customer for images, or reply "sin adjuntos" if you explicitly want to create it without attachments.',
      {
        pendingIssue: proposal,
        confidence: 'low',
        warnings: ['Evidence images are missing for this issue type.']
      }
    );
  }

  const payload = {
    order_ref: proposal.order_ref,
    provider_id: proposal.provider_id,
    issue_type: proposal.issue_type,
    message: proposal.message
  };
  const cleanAgentEmail = sanitizeAgentEmail(agentEmail);
  if (cleanAgentEmail) {
    payload.agent_email = cleanAgentEmail;
  }
  if (proposal.affected_line_item_ids.length) {
    payload.affected_line_item_ids = proposal.affected_line_item_ids;
  }

  const request = await buildIssueCreateRequest({ config, proposal, payload }).catch(error => ({
    error
  }));
  if (request.error) {
    return ticketResponse(`Ticket creation failed before upload: ${request.error.message}`, {
      pendingIssue: proposal,
      confidence: 'low',
      warnings: [request.error.message]
    });
  }

  const response = await fetch(`${config.kitsAdminBaseUrl}/internal/kits-republic/issues`, request.options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    const error = data.error || `HTTP ${response.status}`;
    return ticketResponse(`Ticket creation failed: ${error}`, {
      pendingIssue: proposal,
      confidence: 'low',
      warnings: [error]
    });
  }

  const adminUrl = proposal.admin_order_url || buildAdminOrderUrl({ config, orderRef: proposal.order_ref });
  return ticketResponse([
    `Issue created for ${proposal.order_ref}.`,
    '',
    `Type: ${proposal.issue_type}`,
    `Provider: ${proposal.provider_label || proposal.provider_id}`,
    ...(proposal.attachments.length ? [`Attachments: ${proposal.attachments.length} image(s)`] : []),
    '',
    adminUrl
  ].join('\n'), {
    pendingIssue: null,
    confidence: 'high'
  });
}

async function buildIssueCreateRequest({ config, proposal, payload }) {
  if (!proposal.attachments.length) {
    return {
      options: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.kitsInternalApiToken}`
        },
        body: JSON.stringify(payload)
      }
    };
  }

  const formData = new FormData();
  formData.append('order_ref', payload.order_ref);
  formData.append('provider_id', String(payload.provider_id));
  formData.append('issue_type', payload.issue_type);
  formData.append('message', payload.message);
  formData.append('reporter_type', 'customer');
  if (payload.agent_email) {
    formData.append('agent_email', payload.agent_email);
  }
  for (const lineItemId of proposal.affected_line_item_ids || []) {
    formData.append('affected_line_item_ids[]', lineItemId);
  }
  await appendIssueAttachmentsToFormData({ formData, config, attachments: proposal.attachments });

  return {
    options: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.kitsInternalApiToken}`
      },
      body: formData
    }
  };
}

function sanitizeAgentEmail(value) {
  const email = String(value || '').trim();
  if (!email || email.length > 254) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
  return email;
}

async function requestIssueProposal({ config, prompt, fallback }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.openaiBaseUrl || 'https://api.openai.com'}/v1/responses`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openaiApiKey}`
      },
      body: JSON.stringify({
        model: config.openaiModel || 'gpt-5.6-luna',
        input: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user }
        ],
        ...modelOptions(config.openaiModel)
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ...fallback,
        warnings: [...fallback.warnings, `OpenAI request failed: ${data?.error?.message || `HTTP ${response.status}`}`]
      };
    }

    const parsed = parseJsonObject(extractOutputText(data));
    if (!parsed) {
      return {
        ...fallback,
        warnings: [...fallback.warnings, 'OpenAI returned a non-JSON issue proposal.']
      };
    }
    if (parsed.action === 'clarification') {
      return ticketResponse(String(parsed.clarification || 'I need one more detail before creating this issue.'), {
        pendingIssue: null,
        confidence: normalizeConfidence(parsed.confidence),
        warnings: normalizeWarnings(parsed.warnings)
      });
    }
    return {
      generated: parsed,
      confidence: normalizeConfidence(parsed.confidence),
      warnings: normalizeWarnings(parsed.warnings)
    };
  } catch (error) {
    return {
      ...fallback,
      warnings: [...fallback.warnings, `OpenAI issue proposal failed: ${error.message}`]
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildIssueProposalPrompt({ context, hint = '' }) {
  return {
    system: [
      'You create internal Kits Republic order issue proposals for the supplier/admin team.',
      'Use the selected order, provider, customer email, latest email, conversation, tracking, line items, and optional agent hint.',
      'Do not ask the agent to write the issue details if the context is clear.',
      'If the issue affects a specific product, choose the matching line item from Selected order.line_items and return affected_line_item_ids with its shopify_line_item_id. Use an empty array only for order-level issues such as address or generic shipping.',
      'If customer image attachments are useful evidence, return attachment_ids using only IDs from Attachment candidates.',
      'For customization, damaged, wrong_item_size, missing_item, missing_size, or replacement evidence issues, include relevant attachment_ids when available.',
      'If an existing open ticket appears to cover the same issue, warn about it and only propose a new issue if the context clearly needs a separate ticket.',
      'If the issue is not clear from the context and agent hint, return action "clarification" with one short question.',
      'The issue message is internal only and must be WhatsApp-style: first line "#ORDER | TRACKING" when tracking exists, second line one short operational sentence. Max 220 characters after the reference line.',
      'Do not write paragraphs, background, greetings, sign-offs, or long explanations in the issue message.',
      'Do not write a customer-facing reply. Do not include greeting, sign-off, markdown table, or hidden reasoning.',
      `issue_type must be one of: ${ISSUE_TYPES.join(', ')}.`,
      'Return strict JSON only: {"action":"proposal","issue_type":"...","affected_line_item_ids":["..."],"attachment_ids":["..."],"message":"...","confidence":"high|medium|low","warnings":[]}.',
      'For clarification return strict JSON only: {"action":"clarification","clarification":"...","confidence":"low","warnings":[]}.'
    ].join('\n'),
    user: issuePromptPayload({ context, hint })
  };
}

function buildIssueRevisionPrompt({ context, proposal, feedback }) {
  return {
    system: [
      'You revise a pending internal Kits Republic order issue proposal from agent feedback.',
      'Keep the same selected order and provider. Apply the agent feedback directly.',
      'If feedback changes the affected product, update affected_line_item_ids using the selected order line item shopify_line_item_id.',
      'If feedback changes attachment selection, update attachment_ids using only IDs from Attachment candidates.',
      'The issue message is internal only and must be WhatsApp-style: first line "#ORDER | TRACKING" when tracking exists, second line one short operational sentence. Max 220 characters after the reference line.',
      `issue_type must be one of: ${ISSUE_TYPES.join(', ')}.`,
      'Do not create the issue. Return only the revised proposal JSON.',
      'Return strict JSON only: {"action":"proposal","issue_type":"...","affected_line_item_ids":["..."],"attachment_ids":["..."],"message":"...","confidence":"high|medium|low","warnings":[]}.'
    ].join('\n'),
    user: [
      issuePromptPayload({ context, hint: '' }),
      '',
      'Current pending issue:',
      JSON.stringify(proposal, null, 2),
      '',
      'Agent feedback:',
      feedback
    ].join('\n')
  };
}

function issuePromptPayload({ context, hint = '' }) {
  const order = context?.shopifyContext?.selected_order || null;
  const provider = context?.providerContext?.provider || null;
  return [
    `Agent hint: ${hint || '(none)'}`,
    `Customer email: ${context?.contactEmail || '(unknown)'}`,
    '',
    'Latest customer message:',
    context?.latestMessage || '(none)',
    '',
    'Conversation:',
    truncateText(context?.conversationText || '', 8000) || '(none)',
    '',
    'Selected order:',
    JSON.stringify(summarizeOrder(order), null, 2),
    '',
    'Provider:',
    JSON.stringify(provider || null, null, 2),
    '',
    'Support case:',
    JSON.stringify(context?.supportCase || null, null, 2),
    '',
    'Delivery estimate:',
    JSON.stringify(context?.deliveryEstimateContext || null, null, 2),
    '',
    'Existing open tickets for selected order:',
    JSON.stringify(context?.issueContext || null, null, 2),
    '',
    'Attachment candidates:',
    JSON.stringify(summarizeAttachmentCandidatesForPrompt(context?.attachmentCandidates), null, 2)
  ].join('\n');
}

function normalizeGeneratedProposal({ config, context, generated, baseProposal = null }) {
  if (!generated || (generated.action && generated.action !== 'proposal')) return null;
  const order = context?.shopifyContext?.selected_order;
  const provider = context?.providerContext?.provider;
  const base = normalizePendingIssue(baseProposal) || {};
  const orderRef = normalizeOrderRef(order?.name || base.order_ref);
  const providerId = Number(provider?.id || base.provider_id);
  const rawMessage = String(generated.message || '').trim();
  if (!orderRef || !Number.isInteger(providerId) || providerId <= 0 || !rawMessage) return null;
  const issueType = ISSUE_TYPES.includes(generated.issue_type) ? generated.issue_type : detectIssueType(rawMessage, base.issue_type);
  const message = compactInternalIssueMessage({
    message: rawMessage,
    context,
    orderRef
  });
  const affected = resolveAffectedLineItems({
    order,
    issueType,
    text: [
      generated.message,
      JSON.stringify(generated.affected_line_item_ids || []),
      context?.latestMessage || '',
      context?.conversationText || ''
    ].join('\n'),
    explicitIds: generated.affected_line_item_ids,
    fallbackIds: base.affected_line_item_ids
  });
  const attachments = selectIssueAttachments({
    context,
    issueType,
    generatedAttachmentIds: generated.attachment_ids,
    baseAttachments: base.attachments
  });
  return {
    order_ref: orderRef,
    provider_id: providerId,
    provider_label: provider?.label || provider?.name || provider?.code || base.provider_label || String(providerId),
    issue_type: issueType,
    message,
    affected_line_item_ids: affected.ids,
    affected_line_items: affected.items,
    attachments,
    allow_without_attachments: Boolean(base.allow_without_attachments) && attachments.length === 0,
    admin_order_url: buildAdminOrderUrl({ config, orderRef }),
    updated_at: new Date().toISOString()
  };
}

function summarizeOrder(order) {
  if (!order) return null;
  return {
    name: order.name || null,
    email: order.email || null,
    created_at: order.created_at || null,
    fulfillment_status: order.fulfillment_status || null,
    shipping_address: order.shipping_address || null,
    line_items: (order.line_items || []).slice(0, 10).map(item => ({
      shopify_line_item_id: item.shopify_line_item_id || item.id || null,
      name: item.name || null,
      quantity: item.quantity || null,
      sku: item.sku || null,
      fulfillment_status: item.fulfillment_status || null,
      custom_attributes: item.custom_attributes || []
    })),
    fulfillments: (order.fulfillments || []).slice(0, 5).map(fulfillment => ({
      created_at: fulfillment.created_at || null,
      display_status: fulfillment.display_status || null,
      tracking: fulfillment.tracking || []
    }))
  };
}

function summarizeAttachmentCandidatesForPrompt(attachments = []) {
  return normalizeIssueAttachments(attachments).map(attachment => ({
    id: attachment.id,
    filename: attachment.filename,
    content_type: attachment.content_type,
    file_size: attachment.file_size,
    width: attachment.width,
    height: attachment.height,
    message_id: attachment.message_id,
    created_at: attachment.created_at,
    source_message_preview: attachment.source_message_preview || ''
  }));
}

function detectIssueType(text = '', fallback = 'other') {
  const value = String(text || '').toLowerCase();
  if (/\b(stock|out of stock|sin stock|no stock|agotad|unavailable)\b/.test(value)) return 'stock';
  if (/\b(damaged|damage|defect|defective|broken|rip|ripped|cut|hole|stain|desperfect|roto|rota|mancha|defecto)\b/.test(value)) return 'damaged';
  if (/\b(wrong item|wrong shirt|incorrect item|wrong product|not what i ordered|producto incorrecto|camiseta equivocada)\b/.test(value)) return 'wrong_item_size';
  if (/\b(missing item|item missing|falta.*camiseta|missing jersey|not included)\b/.test(value)) return 'missing_item';
  if (/\b(replacement|replace|send.*new|mandar.*nueva|reemplaz|sustituci[oó]n)\b/.test(value)) return 'replacement';
  if (/\b(missing size|size missing|talla|size|xl|xxl|3xl|4xl)\b/.test(value)) return 'missing_size';
  if (/\b(address|direcci[oó]n|postcode|zip|house number|hausnummer)\b/.test(value)) return 'address';
  if (/\b(custom|personaliz|name|nombre|number|dorsal|print)\b/.test(value)) return 'customization';
  if (/\b(ship|shipping|tracking|carrier|aduana|customs|delivery|entrega|env[ií]o)\b/.test(value)) return 'shipping';
  return ISSUE_TYPES.includes(fallback) ? fallback : 'other';
}

function buildIssueMessage({ issueType, details, order }) {
  const cleanDetails = String(details || '').trim();
  return compactInternalIssueMessage({
    message: `${issueLabel(issueType)} issue for order ${normalizeOrderRef(order.name)}: ${cleanDetails}`,
    context: { shopifyContext: { selected_order: order } },
    orderRef: order.name
  });
}

function compactInternalIssueMessage({ message, context, orderRef }) {
  const reference = compactIssueReference({ context, orderRef });
  const body = compactIssueBody({ message, reference });
  return [reference, body].filter(Boolean).join('\n').slice(0, 500).trim();
}

function compactIssueReference({ context, orderRef }) {
  const order = context?.shopifyContext?.selected_order || {};
  const referenceOrder = normalizeOrderRef(orderRef || order.name);
  const trackingNumber = firstTrackingNumber(order);
  return [referenceOrder, trackingNumber].filter(Boolean).join(' | ');
}

function firstTrackingNumber(order = {}) {
  for (const fulfillment of Array.isArray(order.fulfillments) ? order.fulfillments : []) {
    const tracking = Array.isArray(fulfillment.tracking) ? fulfillment.tracking : [];
    const trackingNumber = tracking.find(item => item?.number)?.number
      || (Array.isArray(fulfillment.tracking_numbers) ? fulfillment.tracking_numbers.find(Boolean) : '');
    if (trackingNumber) return String(trackingNumber).trim();
  }
  return '';
}

function compactIssueBody({ message, reference }) {
  const clean = cleanIssueMessageBody(message, reference);
  if (!clean) return '';

  const sentences = clean.match(/[^.!?\n]+[.!?]?/g) || [clean];
  const customerSentence = sentences.find(sentence => /\b(customer|client|says|reports|reported|hasn'?t|cannot|can't|not received|no ha|dice)\b/i.test(sentence));
  const actionSentence = sentences.find(sentence => /\b(please|ask|contact|confirm|check|arrange|prevent|review|verify)\b/i.test(sentence));
  const selected = [customerSentence || sentences[0], actionSentence]
    .filter(Boolean)
    .map(sentence => sentence.trim())
    .filter((sentence, index, list) => list.indexOf(sentence) === index)
    .join(' ');

  return truncateAtWord(selected || clean, 220);
}

function cleanIssueMessageBody(message, reference) {
  const orderRef = reference?.match(/#\d+/)?.[0] || '';
  const tracking = reference?.split('|')?.[1]?.trim() || '';
  let clean = String(message || '')
    .replace(/\r/g, '')
    .replace(/^(address|customization|missing size|shipping|replacement|missing item|stock|damaged item|wrong item\/size|order)\s+issue\s+for\s+order\s+#?\d+\s*:\s*/i, '')
    .replace(/^order\s+#?\d+\s+(is|was)\s+/i, '')
    .replace(/\bwith\s+[A-Za-z0-9 -]*tracking\s*\.?/gi, '')
    .trim();
  if (reference) clean = clean.replace(new RegExp(`^\\s*${escapeRegExp(reference)}\\s*`, 'i'), '');
  if (orderRef) clean = clean.replace(new RegExp(escapeRegExp(orderRef), 'gi'), '');
  if (tracking) clean = clean.replace(new RegExp(escapeRegExp(tracking), 'gi'), '');
  return clean.replace(/\s+/g, ' ').trim();
}

function truncateAtWord(value, maxLength) {
  const clean = String(value || '').trim();
  if (clean.length <= maxLength) return clean;
  const truncated = clean.slice(0, maxLength + 1);
  const lastSpace = truncated.lastIndexOf(' ');
  return `${truncated.slice(0, lastSpace > 120 ? lastSpace : maxLength).trim()}...`;
}

function escapeRegExp(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveRevisionAffectedLineItems({ proposal, feedback, context, issueType }) {
  const affected = resolveAffectedLineItems({
    order: context?.shopifyContext?.selected_order,
    issueType,
    text: feedback
  });
  if (affected.ids.length) {
    return {
      affected_line_item_ids: affected.ids,
      affected_line_items: affected.items
    };
  }
  return {
    affected_line_item_ids: proposal.affected_line_item_ids || [],
    affected_line_items: proposal.affected_line_items || []
  };
}

function resolveAffectedLineItems({ order, issueType, text = '', explicitIds, fallbackIds } = {}) {
  const items = normalizeOrderLineItems(order);
  const byId = new Map(items.map(item => [item.id, item]));
  const rawExplicit = normalizeAffectedLineItemIds(explicitIds);
  const explicit = rawExplicit.filter(id => byId.has(id));
  const hasExplicitIds = explicitIds !== undefined;
  if (explicit.length || (hasExplicitIds && rawExplicit.length === 0)) {
    return {
      ids: explicit,
      items: explicit.map(id => byId.get(id)).filter(Boolean)
    };
  }

  const fallback = normalizeAffectedLineItemIds(fallbackIds).filter(id => byId.has(id));
  if (fallback.length) {
    return {
      ids: fallback,
      items: fallback.map(id => byId.get(id)).filter(Boolean)
    };
  }

  if (!items.length || !isItemIssueType(issueType)) {
    return { ids: [], items: [] };
  }
  if (items.length === 1) {
    return { ids: [items[0].id], items: [items[0]] };
  }

  const scored = items
    .map(item => ({ item, score: scoreLineItemMatch(item, text) }))
    .filter(result => result.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length || (scored[1] && scored[0].score === scored[1].score)) {
    return { ids: [], items: [] };
  }
  return {
    ids: [scored[0].item.id],
    items: [scored[0].item]
  };
}

function normalizeOrderLineItems(order) {
  return (Array.isArray(order?.line_items) ? order.line_items : [])
    .map(item => {
      const id = String(item?.shopify_line_item_id || item?.id || '').trim();
      if (!id) return null;
      const customAttributes = Array.isArray(item.custom_attributes) ? item.custom_attributes : [];
      const label = lineItemLabel(item);
      return {
        id,
        label,
        name: String(item.name || item.product_title || '').trim(),
        sku: String(item.sku || '').trim(),
        quantity: item.quantity || null,
        custom_attributes: customAttributes
      };
    })
    .filter(Boolean);
}

function normalizeAffectedLineItemIds(value = []) {
  const raw = Array.isArray(value) ? value : [value];
  const parsed = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.trim().startsWith('[')) {
      try {
        const loaded = JSON.parse(item);
        if (Array.isArray(loaded)) {
          parsed.push(...loaded);
          continue;
        }
      } catch {
        // Keep the raw string below.
      }
    }
    if (item && typeof item === 'object') {
      parsed.push(item.shopify_line_item_id || item.id || item.affected_item_key);
    } else {
      parsed.push(item);
    }
  }
  const result = [];
  const seen = new Set();
  for (const item of parsed) {
    const clean = String(item || '').trim();
    if (clean && !seen.has(clean)) {
      result.push(clean);
      seen.add(clean);
    }
  }
  return result;
}

function normalizeAffectedLineItems(value = [], ids = []) {
  const items = Array.isArray(value) ? value : [];
  if (items.length) {
    return items
      .map(item => ({
        id: String(item?.id || item?.shopify_line_item_id || item?.affected_item_key || '').trim(),
        shopify_line_item_id: String(item?.shopify_line_item_id || item?.id || item?.affected_item_key || '').trim(),
        label: String(item?.label || lineItemLabel(item) || '').trim(),
        name: String(item?.name || item?.product_title || '').trim(),
        sku: String(item?.sku || '').trim(),
        quantity: item?.quantity || null
      }))
      .filter(item => item.shopify_line_item_id || item.id || item.label);
  }
  return normalizeAffectedLineItemIds(ids).map(id => ({
    id,
    shopify_line_item_id: id,
    label: id,
    name: '',
    sku: '',
    quantity: null
  }));
}

function normalizeIssueAttachments(value = []) {
  const raw = Array.isArray(value) ? value : [];
  const result = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || item.attachment_id || '').trim();
    const dataUrl = String(item.data_url || '').trim();
    if (!id || !dataUrl || seen.has(id)) continue;
    result.push({
      id,
      attachment_id: item.attachment_id || id,
      message_id: item.message_id || null,
      filename: String(item.filename || `chatwoot-${id}.jpg`).trim(),
      content_type: String(item.content_type || '').trim(),
      file_type: String(item.file_type || 'image').trim(),
      file_size: item.file_size || null,
      width: item.width || null,
      height: item.height || null,
      data_url: dataUrl,
      thumb_url: String(item.thumb_url || '').trim(),
      created_at: item.created_at || null,
      source_message_preview: String(item.source_message_preview || '').trim()
    });
    seen.add(id);
    if (result.length >= MAX_ISSUE_ATTACHMENTS) break;
  }
  return result;
}

function selectIssueAttachments({ context, issueType, generatedAttachmentIds, baseAttachments } = {}) {
  const candidates = normalizeIssueAttachments(context?.attachmentCandidates);
  if (!candidates.length) return [];
  const byId = new Map(candidates.map(attachment => [attachment.id, attachment]));

  if (Array.isArray(generatedAttachmentIds)) {
    return generatedAttachmentIds.map(id => byId.get(String(id))).filter(Boolean).slice(0, MAX_ISSUE_ATTACHMENTS);
  }

  const base = normalizeIssueAttachments(baseAttachments).filter(attachment => byId.has(attachment.id));
  if (base.length) return base;

  if (EVIDENCE_ISSUE_TYPES.has(issueType)) return candidates.slice(0, MAX_ISSUE_ATTACHMENTS);
  return [];
}

function applyAttachmentFeedback({ proposal, feedback, context } = {}) {
  const text = String(feedback || '').toLowerCase();
  const candidates = normalizeIssueAttachments(context?.attachmentCandidates);

  if (/\b(sin adjuntos|sin fotos|no adjunt|no attachment|without attachment|without images?)\b/i.test(text)) {
    return {
      attachments: [],
      allow_without_attachments: true
    };
  }

  if (/\b(adjunta todas|todas las fotos|todos los adjuntos|all attachments|all images)\b/i.test(text)) {
    return {
      attachments: candidates,
      allow_without_attachments: false
    };
  }

  const removeIndex = requestedAttachmentIndexToRemove(text);
  if (removeIndex !== null) {
    return {
      attachments: normalizeIssueAttachments(proposal.attachments).filter((_, index) => index !== removeIndex),
      allow_without_attachments: false
    };
  }

  return {
    attachments: selectIssueAttachments({
      context,
      issueType: proposal.issue_type,
      baseAttachments: proposal.attachments
    }),
    allow_without_attachments: Boolean(proposal.allow_without_attachments)
  };
}

function requestedAttachmentIndexToRemove(text = '') {
  const patterns = [
    [/\b(quita|elimina|remove)\s+(la\s+)?(primera|first|1|1st)\b/i, 0],
    [/\b(quita|elimina|remove)\s+(la\s+)?(segunda|second|2|2nd)\b/i, 1],
    [/\b(quita|elimina|remove)\s+(la\s+)?(tercera|third|3|3rd)\b/i, 2],
    [/\b(quita|elimina|remove)\s+(la\s+)?(cuarta|fourth|4|4th)\b/i, 3],
    [/\b(quita|elimina|remove)\s+(la\s+)?(quinta|fifth|5|5th)\b/i, 4]
  ];
  for (const [pattern, index] of patterns) {
    if (pattern.test(text)) return index;
  }
  return null;
}

function needsImageEvidence(proposal = {}) {
  if (proposal.allow_without_attachments) return false;
  if (!EVIDENCE_ISSUE_TYPES.has(proposal.issue_type)) return false;
  if (['damaged', 'wrong_item_size', 'customization'].includes(proposal.issue_type)) return true;
  return /\b(photo|image|picture|foto|imagen|received|recib|wrong|incorrect|defect|damaged|missing item|falta)\b/i
    .test(proposal.message || '');
}

function isItemIssueType(issueType) {
  return ['stock', 'missing_size', 'customization', 'replacement', 'missing_item', 'damaged', 'wrong_item_size', 'other'].includes(issueType);
}

function scoreLineItemMatch(item, text = '') {
  const haystack = normalizeSearchText(text);
  if (!haystack) return 0;
  let score = 0;
  if (item.sku && haystack.includes(normalizeSearchText(item.sku))) score += 8;
  const name = normalizeSearchText(item.name || item.label);
  if (name && haystack.includes(name)) score += 6;
  const tokens = [
    ...(item.name || item.label || '').split(/\s+/),
    item.sku,
    ...item.custom_attributes.flatMap(attribute => [attribute?.key, attribute?.value])
  ]
    .map(normalizeSearchText)
    .filter(token => token.length >= 3);
  const seen = new Set();
  for (const token of tokens) {
    if (!seen.has(token) && haystack.includes(token)) {
      score += 1;
      seen.add(token);
    }
  }
  return score;
}

function normalizeSearchText(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function lineItemLabel(item = {}) {
  const name = String(item.name || item.product_title || item.label || '').trim();
  const variant = String(item.variant_title || item.size || '').trim();
  const sku = String(item.sku || '').trim();
  const parts = [name || 'Item'];
  if (variant && !parts[0].includes(variant)) parts.push(variant);
  if (sku) parts.push(sku);
  return parts.filter(Boolean).join(' · ');
}

function formatAffectedLineItemSummary(proposal = {}) {
  const items = Array.isArray(proposal.affected_line_items) ? proposal.affected_line_items : [];
  if (items.length) {
    return items.map(item => item.label || item.name || item.shopify_line_item_id || item.id).filter(Boolean).join(', ');
  }
  return normalizeAffectedLineItemIds(proposal.affected_line_item_ids).join(', ');
}

function formatProposal(proposal, context = {}) {
  const affectedSummary = formatAffectedLineItemSummary(proposal);
  const attachmentSummary = formatAttachmentSummary(proposal, context);
  return [
    ...formatOpenTicketNotice(context),
    'New issue proposal:',
    '',
    `Order: ${proposal.order_ref}`,
    `Provider: ${proposal.provider_label || proposal.provider_id}`,
    `Type: ${proposal.issue_type}`,
    ...(affectedSummary ? [`Line item: ${affectedSummary}`] : []),
    ...attachmentSummary,
    '',
    'Message:',
    proposal.message,
    '',
    'Reply with changes, or use /newticket approve to create it.'
  ].join('\n');
}

function formatAttachmentSummary(proposal = {}) {
  const attachments = normalizeIssueAttachments(proposal.attachments);
  if (attachments.length) {
    return [
      `Attachments: ${attachments.length} image(s)`,
      ...attachments.map((attachment, index) => (
        `- ${index + 1}. ${attachment.filename}${attachment.file_size ? ` (${formatBytes(attachment.file_size)})` : ''}${attachment.message_id ? ` · message ${attachment.message_id}` : ''}`
      ))
    ];
  }
  if (needsImageEvidence(proposal)) {
    return ['Attachments: none found. Ask the customer for photos before approving, or reply "sin adjuntos" to create it without images.'];
  }
  return [];
}

function formatOpenTicketNotice(context = {}) {
  const issues = Array.isArray(context.issueContext?.issues) ? context.issueContext.issues : [];
  if (!issues.length) return [];
  const lines = [
    `Open ticket already exists for ${context.issueContext.order_ref || 'this order'}:`
  ];
  for (const issue of issues.slice(0, 3)) {
    const parts = [
      issue.issue_id ? `#${issue.issue_id}` : '',
      issue.issue_type || '',
      issue.provider || '',
      issue.status || ''
    ].filter(Boolean);
    lines.push(`- ${parts.join(' · ')}${issue.url ? ` · ${issue.url}` : ''}`);
  }
  if (issues.length > 3) lines.push(`- ${issues.length - 3} more open ticket(s).`);
  lines.push('Review the existing ticket before creating another one.', '');
  return lines;
}

function ticketResponse(assistantMessage, {
  pendingIssue = null,
  confidence = 'medium',
  warnings = []
} = {}) {
  return {
    handled: true,
    assistant_message: assistantMessage,
    reasoning_summary: 'Handled by KR Copilot new ticket command.',
    confidence,
    warnings,
    preserve_draft: true,
    skip_insert: true,
    pending_issue: pendingIssue
  };
}

function issueLabel(issueType) {
  return {
    address: 'Address',
    customization: 'Customization',
    missing_size: 'Missing size',
    shipping: 'Shipping',
    replacement: 'Replacement',
    missing_item: 'Missing item',
    stock: 'Stock',
    damaged: 'Damaged item',
    wrong_item_size: 'Wrong item/size',
    other: 'Order'
  }[issueType] || 'Order';
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function normalizeOrderRef(value = '') {
  const clean = String(value || '').trim().replace(/^#?/, '');
  return clean ? `#${clean}` : '';
}

function buildAdminOrderUrl({ config, orderRef }) {
  const baseUrl = (config?.kitsAdminBaseUrl || 'https://web-production-c1320.up.railway.app').replace(/\/+$/, '');
  return `${baseUrl}/kits-republic/orders?q=${encodeURIComponent(normalizeOrderRef(orderRef))}`;
}

function truncateText(text = '', maxLength = 8000) {
  const value = String(text || '').trim();
  if (value.length <= maxLength) return value;
  return value.slice(-maxLength);
}

function extractOutputText(data) {
  if (data.output_text) return data.output_text;
  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' || content.type === 'text') {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join('\n').trim();
}

function parseJsonObject(text = '') {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function normalizeConfidence(value = 'low') {
  const normalized = String(value || '').toLowerCase();
  if (['high', 'medium', 'low'].includes(normalized)) return normalized;
  return 'low';
}

function normalizeWarnings(warnings = []) {
  return Array.isArray(warnings) ? warnings.map(String).filter(Boolean) : [];
}

function modelOptions(model) {
  if (String(model || '').startsWith('gpt-5')) return {};
  return { temperature: 0.2 };
}
