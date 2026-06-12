const ISSUE_TYPES = [
  'address',
  'customization',
  'missing_size',
  'shipping',
  'stock',
  'other'
];

export async function runNewTicketCommand({ command, config, context, pendingIssue } = {}) {
  if (!command || command.name !== 'newticket') return null;

  const argument = String(command.argument || '').trim();
  const action = argument.toLowerCase();
  if (!argument) {
    return ticketResponse([
      'Usage:',
      '/newticket <issue details>',
      '/newticket approve',
      '/newticket cancel'
    ].join('\n'), { pendingIssue });
  }
  if (action === 'cancel') {
    return ticketResponse('New ticket proposal cancelled.', { pendingIssue: null });
  }
  if (action === 'approve') {
    return approvePendingIssue({ config, pendingIssue });
  }

  const validation = validateTicketContext(context);
  if (validation) return ticketResponse(validation, { pendingIssue: null, confidence: 'low' });

  const proposal = buildIssueProposal({ config, context, details: argument });
  return ticketResponse(formatProposal(proposal), { pendingIssue: proposal });
}

export function runPendingTicketFeedback({ message, pendingIssue } = {}) {
  const content = String(message || '').trim();
  const current = normalizePendingIssue(pendingIssue);
  if (!content || !current) return null;

  const updated = reviseIssueProposal({ proposal: current, feedback: content });
  return ticketResponse(formatProposal(updated), { pendingIssue: updated });
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
    return ticketResponse('No pending ticket proposal. Use /newticket <issue details> first.', {
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
