export function buildCaseReview({
  supportCase,
  latestMessage = '',
  shopifyContext = {},
  providerTrackingContext = null,
  issueContext = null,
  attachmentAnalysis = null,
  duplicateContext = null
} = {}) {
  const order = shopifyContext?.selected_order || null;
  const type = supportCase?.type || (issueContext?.issues?.length ? 'supplier_issue_open' : 'other');
  const facts = verifiedFacts({
    order,
    shopifyContext,
    providerTrackingContext,
    issueContext,
    attachmentAnalysis,
    duplicateContext
  });
  const missing = missingInfo({ type, order, attachmentAnalysis, duplicateContext });
  const decision = decisionForCase(type);

  return {
    summary: buildSummary({ type, order, latestMessage }),
    detected_case: type,
    verified_facts: facts,
    missing_info: missing,
    recommended_decision: decision.recommended_decision,
    proposed_reply: '',
    after_send_action: decision.after_send_action,
    confidence: supportCase?.confidence || confidenceFromSignals({ facts, type }),
    warnings: []
  };
}

export function withCaseReviewDraft(caseReview, draft = '') {
  if (!caseReview) return null;
  return {
    ...caseReview,
    proposed_reply: String(draft || '').trim()
  };
}

function verifiedFacts({
  order,
  shopifyContext,
  providerTrackingContext,
  issueContext,
  attachmentAnalysis,
  duplicateContext
}) {
  const facts = [];
  if (order?.name) facts.push(`Selected Shopify order: ${order.name}.`);
  if (order?.fulfillment_status) facts.push(`Shopify fulfillment status: ${order.fulfillment_status}.`);

  const fulfillment = selectFulfillment(order);
  if (fulfillment?.display_status) facts.push(`Shipment status: ${fulfillment.display_status}.`);
  if (fulfillment?.delivered_at) facts.push(`Shopify delivered at: ${fulfillment.delivered_at}.`);

  const tracking = selectTracking(fulfillment);
  if (tracking?.number) facts.push(`Tracking number: ${tracking.number}${tracking.company ? ` (${tracking.company})` : ''}.`);
  if (providerTrackingContext?.available) {
    facts.push(`Provider tracking latest event: ${[providerTrackingContext.last_update_at, providerTrackingContext.last_record].filter(Boolean).join(' - ')}.`);
    if (providerTrackingContext.customs_status) facts.push(`Provider customs status: ${providerTrackingContext.customs_status}.`);
  }

  const issueCount = Number(issueContext?.total || issueContext?.issues?.length || 0);
  if (issueCount > 0) facts.push(`Open internal issue count: ${issueCount}.`);
  for (const issue of (issueContext?.issues || []).slice(0, 3)) {
    facts.push(`Open issue ${issue.issue_id}: ${[issue.issue_type, issue.status, issue.message_preview].filter(Boolean).join(' | ')}.`);
    for (const item of (issue.affected_items || []).slice(0, 3)) {
      facts.push(`Affected item in issue ${issue.issue_id}: ${[item.name, item.sku, item.variant_title].filter(Boolean).join(' | ')}.`);
    }
  }

  if (attachmentAnalysis?.available) {
    for (const analysis of attachmentAnalysis.analyses || []) {
      facts.push(`Image ${analysis.id}: ${analysis.summary}`);
      if (analysis.visible_text?.length) facts.push(`Image ${analysis.id} visible text: ${analysis.visible_text.join(' | ')}.`);
    }
  }

  if (duplicateContext?.possible_duplicates?.length) {
    facts.push(`Possible related Chatwoot conversations: ${duplicateContext.possible_duplicates.map(item => `#${item.conversation_id}`).join(', ')}.`);
  }

  if (shopifyContext?.selection_reason) facts.push(`Order selection: ${shopifyContext.selection_reason}`);
  return facts.length ? facts : ['No verified order facts are available yet.'];
}

function missingInfo({ type, order, attachmentAnalysis, duplicateContext }) {
  const missing = [];
  if (!order) missing.push('A single Shopify order is not selected.');
  if (['wrong_item', 'product_mismatch', 'size_issue'].includes(type) && !attachmentAnalysis?.available) {
    missing.push('Customer image evidence has not been analyzed or is unavailable.');
  }
  if (type === 'duplicate_thread' && !duplicateContext?.possible_duplicates?.length) {
    missing.push('The exact duplicate conversation has not been confirmed from Chatwoot context.');
  }
  return missing;
}

function decisionForCase(type) {
  return {
    customs_pending: {
      recommended_decision: 'Explain customs/local handoff status using safe customer wording and include the canonical Kits tracking link.',
      after_send_action: 'leave_open'
    },
    order_update: {
      recommended_decision: 'Give a concise order/tracking update from verified Shopify/provider data.',
      after_send_action: 'leave_open'
    },
    failed_delivery_attempt: {
      recommended_decision: 'Tell the customer the carrier attempted delivery and ask them to contact or rebook with the local carrier using the tracking details.',
      after_send_action: 'leave_open'
    },
    delivered_not_found: {
      recommended_decision: 'Ask the customer to check safe places/neighbours and tell them we are checking delivery proof with logistics if needed.',
      after_send_action: 'wait_customer'
    },
    return_request: {
      recommended_decision: 'Explain return conditions and next steps. Use the China return address only if the return is applicable and approved for this case.',
      after_send_action: 'leave_open'
    },
    refund_request: {
      recommended_decision: 'Acknowledge the refund request, verify eligibility, and avoid promising a refund unless already confirmed.',
      after_send_action: 'leave_open'
    },
    size_issue: {
      recommended_decision: 'Handle as sizing/size exchange. Explain return policy and use the approved coupon only when the case calls for it.',
      after_send_action: 'leave_open'
    },
    wrong_item: {
      recommended_decision: 'Acknowledge the wrong item report, apologize, use image/order evidence, and escalate or wait for supplier/admin confirmation before promising a remedy.',
      after_send_action: 'wait_supplier'
    },
    product_mismatch: {
      recommended_decision: 'Compare the customer claim with product/order evidence, acknowledge any mismatch, and offer the approved resolution without overstating facts.',
      after_send_action: 'leave_open'
    },
    invoice_request: {
      recommended_decision: 'Send a concise invoice response only if the invoice is prepared or attached; otherwise say it is being prepared.',
      after_send_action: 'leave_open'
    },
    duplicate_thread: {
      recommended_decision: 'Avoid duplicate replies. Use one main conversation and close or leave the duplicate without repeating conflicting information.',
      after_send_action: 'mark_duplicate'
    },
    supplier_issue_open: {
      recommended_decision: 'Use the open internal issue as pending supplier/admin work and avoid creating duplicate tickets.',
      after_send_action: 'wait_supplier'
    },
    other: {
      recommended_decision: 'Answer conservatively from verified context and ask for missing details if needed.',
      after_send_action: 'leave_open'
    }
  }[type] || {
    recommended_decision: 'Answer conservatively from verified context and ask for missing details if needed.',
    after_send_action: 'leave_open'
  };
}

function buildSummary({ type, order, latestMessage }) {
  const orderLabel = order?.name ? ` for ${order.name}` : '';
  const customerText = String(latestMessage || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  return [
    `Detected ${type}${orderLabel}.`,
    customerText ? `Latest customer message: ${customerText}` : ''
  ].filter(Boolean).join(' ');
}

function confidenceFromSignals({ facts, type }) {
  if (type !== 'other' && facts.length > 2) return 'medium';
  return type === 'other' ? 'low' : 'medium';
}

function selectFulfillment(order = {}) {
  const fulfillments = Array.isArray(order?.fulfillments) ? order.fulfillments : [];
  return fulfillments.find(item => selectTracking(item)) || fulfillments[0] || null;
}

function selectTracking(fulfillment = {}) {
  const tracking = Array.isArray(fulfillment?.tracking) ? fulfillment.tracking : [];
  return tracking.find(item => item?.number || item?.url) || tracking[0] || null;
}
