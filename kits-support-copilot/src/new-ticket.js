const ISSUE_TYPES = [
  'address',
  'customization',
  'missing_size',
  'shipping',
  'stock',
  'other'
];

const OPENAI_TIMEOUT_MS = 20000;

export async function runNewTicketCommand({ command, config, context, pendingIssue } = {}) {
  if (!command || command.name !== 'newticket') return null;

  const argument = String(command.argument || '').trim();
  const action = argument.toLowerCase();
  if (action === 'cancel') {
    return ticketResponse('New ticket proposal cancelled.', { pendingIssue: null });
  }
  if (action === 'approve') {
    return approvePendingIssue({ config, pendingIssue });
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

  return ticketResponse(formatProposal(proposal), {
    pendingIssue: proposal,
    confidence: result.confidence,
    warnings: result.warnings
  });
}

export async function revisePendingTicketProposalFromFeedback({ config, context, proposal, feedback } = {}) {
  const current = normalizePendingIssue(proposal);
  if (!current) return null;

  const fallbackProposal = reviseIssueProposal({ proposal: current, feedback });
  const fallback = ticketResponse(formatProposal(fallbackProposal), {
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

  return ticketResponse(formatProposal(updated), {
    pendingIssue: updated,
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
  return {
    order_ref: orderRef,
    provider_id: providerId,
    provider_label: String(value.provider_label || '').trim(),
    issue_type: issueType,
    message,
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
  return ticketResponse(formatProposal(proposal), {
    pendingIssue: proposal,
    confidence: 'medium',
    warnings: config?.openaiApiKey ? [] : ['OpenAI is not configured, so the agent hint was used as the issue source.']
  });
}

function buildIssueProposal({ config, context, details }) {
  const order = context.shopifyContext.selected_order;
  const provider = context.providerContext.provider;
  const issueType = detectIssueType(details);
  return {
    order_ref: normalizeOrderRef(order.name),
    provider_id: Number(provider.id),
    provider_label: provider.label || provider.name || provider.code || String(provider.id),
    issue_type: issueType,
    message: buildIssueMessage({ issueType, details, order }),
    admin_order_url: buildAdminOrderUrl({ config, orderRef: order.name }),
    updated_at: new Date().toISOString()
  };
}

function reviseIssueProposal({ proposal, feedback }) {
  const issueType = detectIssueType(feedback, proposal.issue_type);
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
    message: message.trim().slice(0, 2000),
    updated_at: new Date().toISOString()
  };
}

async function approvePendingIssue({ config, pendingIssue }) {
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

  const response = await fetch(`${config.kitsAdminBaseUrl}/internal/kits-republic/issues`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.kitsInternalApiToken}`
    },
    body: JSON.stringify({
      order_ref: proposal.order_ref,
      provider_id: proposal.provider_id,
      issue_type: proposal.issue_type,
      message: proposal.message
    })
  });
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
    '',
    adminUrl
  ].join('\n'), {
    pendingIssue: null,
    confidence: 'high'
  });
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
        model: config.openaiModel || 'gpt-5.4-mini',
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
      'If the issue is not clear from the context and agent hint, return action "clarification" with one short question.',
      'The issue message is internal only, written in English, concise, operational, and suitable for a supplier/admin issue.',
      'Do not write a customer-facing reply. Do not include greeting, sign-off, markdown table, or hidden reasoning.',
      `issue_type must be one of: ${ISSUE_TYPES.join(', ')}.`,
      'Return strict JSON only: {"action":"proposal","issue_type":"...","message":"...","confidence":"high|medium|low","warnings":[]}.',
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
      'The issue message is internal only, written in English, concise, operational, and suitable for a supplier/admin issue.',
      `issue_type must be one of: ${ISSUE_TYPES.join(', ')}.`,
      'Do not create the issue. Return only the revised proposal JSON.',
      'Return strict JSON only: {"action":"proposal","issue_type":"...","message":"...","confidence":"high|medium|low","warnings":[]}.'
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
    JSON.stringify(context?.deliveryEstimateContext || null, null, 2)
  ].join('\n');
}

function normalizeGeneratedProposal({ config, context, generated, baseProposal = null }) {
  if (!generated || (generated.action && generated.action !== 'proposal')) return null;
  const order = context?.shopifyContext?.selected_order;
  const provider = context?.providerContext?.provider;
  const base = normalizePendingIssue(baseProposal) || {};
  const orderRef = normalizeOrderRef(order?.name || base.order_ref);
  const providerId = Number(provider?.id || base.provider_id);
  const message = String(generated.message || '').trim().slice(0, 2000);
  if (!orderRef || !Number.isInteger(providerId) || providerId <= 0 || !message) return null;
  const issueType = ISSUE_TYPES.includes(generated.issue_type) ? generated.issue_type : detectIssueType(message, base.issue_type);
  return {
    order_ref: orderRef,
    provider_id: providerId,
    provider_label: provider?.label || provider?.name || provider?.code || base.provider_label || String(providerId),
    issue_type: issueType,
    message,
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

function detectIssueType(text = '', fallback = 'other') {
  const value = String(text || '').toLowerCase();
  if (/\b(stock|out of stock|sin stock|no stock|agotad|unavailable)\b/.test(value)) return 'stock';
  if (/\b(missing size|size missing|talla|size|xl|xxl|3xl|4xl)\b/.test(value)) return 'missing_size';
  if (/\b(address|direcci[oó]n|postcode|zip|house number|hausnummer)\b/.test(value)) return 'address';
  if (/\b(custom|personaliz|name|nombre|number|dorsal|print)\b/.test(value)) return 'customization';
  if (/\b(ship|shipping|tracking|carrier|aduana|customs|delivery|entrega|env[ií]o)\b/.test(value)) return 'shipping';
  return ISSUE_TYPES.includes(fallback) ? fallback : 'other';
}

function buildIssueMessage({ issueType, details, order }) {
  const cleanDetails = String(details || '').trim();
  return `${issueLabel(issueType)} issue for order ${normalizeOrderRef(order.name)}: ${cleanDetails}`;
}

function formatProposal(proposal) {
  return [
    'New issue proposal:',
    '',
    `Order: ${proposal.order_ref}`,
    `Provider: ${proposal.provider_label || proposal.provider_id}`,
    `Type: ${proposal.issue_type}`,
    '',
    'Message:',
    proposal.message,
    '',
    'Reply with changes, or use /newticket approve to create it.'
  ].join('\n');
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
    stock: 'Stock',
    other: 'Order'
  }[issueType] || 'Order';
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
