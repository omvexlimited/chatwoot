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

  return {
    summary: buildSummary({ type, order, latestMessage }),
    detected_case: type,
    verified_facts: facts,
    missing_info: missing,
    recommended_decision: null,
    proposed_reply: '',
    after_send_action: 'manual_review',
    confidence: supportCase?.confidence || confidenceFromSignals({ facts, type }),
    warnings: ['Recommendation and post-send action must come from the selected published Playbook.']
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
