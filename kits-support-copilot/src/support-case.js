const CUSTOMS_TRACKING_PATTERNS = [
  /pending receipt/i,
  /pending reception/i,
  /pendiente de recepci[oó]n/i,
  /royal mail expecting parcel/i,
  /tracking information isn'?t available yet/i,
  /we already have all the details of your shipment/i,
  /ctt pendiente de recepci[oó]n/i,
  /pendiente de entrada en red/i
];

const LOCAL_HANDOFF_CARRIER_PATTERN = /\b(ctt|ctt express|royal mail|correos|la poste|poste italiane|dhl|evri|hermes)\b/i;

const CUSTOMER_DELAY_PATTERNS = [
  /a[uú]n no (ha )?lleg/i,
  /no (ha )?llegad/i,
  /cu[aá]nto tard/i,
  /d[oó]nde est[aá] mi pedido/i,
  /where is my order/i,
  /hasn'?t arrived/i,
  /has not arrived/i,
  /not received/i,
  /still waiting/i,
  /no updates?/i,
  /no tracking updates?/i,
  /tracking (has )?not updated/i,
  /tracking hasn'?t updated/i,
  /tracking isn'?t updating/i,
  /tracking not updating/i,
  /status (has )?not changed/i,
  /status hasn'?t changed/i,
  /no (new )?information/i
];

const FAILED_DELIVERY_PATTERNS = [
  /delivery attempt failed/i,
  /attempted delivery/i,
  /delivery attempted/i,
  /unable to deliver/i,
  /missed delivery/i,
  /we'?ll attempt to deliver/i,
  /re[- ]?deliver/i,
  /reprogram(ar|a)? entrega/i,
  /intento de entrega fallid/i,
  /no se pudo entregar/i
];

const DELIVERED_NOT_FOUND_PATTERNS = [
  /delivered but/i,
  /says delivered/i,
  /marked as delivered/i,
  /not received/i,
  /hasn'?t been received/i,
  /haven'?t received/i,
  /have not received/i,
  /didn'?t receive/i,
  /cannot find/i,
  /can'?t find/i,
  /no lo he recibido/i,
  /no he recibido/i,
  /aparece entregado/i,
  /figura como entregado/i,
  /no encuentro el paquete/i
];

const RETURN_PATTERNS = [
  /\breturn\b/i,
  /\bexchange\b/i,
  /devoluci[oó]n/i,
  /devolver/i,
  /cambiar/i,
  /cambio/i,
  /retour/i,
  /retourner/i
];

const REFUND_PATTERNS = [
  /\brefund\b/i,
  /\breimburse/i,
  /reembolso/i,
  /reembols/i,
  /remboursement/i,
  /rimborso/i
];

const SIZE_PATTERNS = [
  /\bsize\b/i,
  /\bsizing\b/i,
  /\btoo small\b/i,
  /\btoo big\b/i,
  /\btoo large\b/i,
  /wrong size/i,
  /talla/i,
  /demasiado peque/i,
  /demasiado grande/i
];

const WRONG_ITEM_PATTERNS = [
  /wrong item/i,
  /wrong shirt/i,
  /wrong jersey/i,
  /incorrect item/i,
  /received the wrong/i,
  /art[ií]culo equivocado/i,
  /camiseta equivocada/i,
  /producto equivocado/i,
  /me ha llegado otr/i
];

const PRODUCT_MISMATCH_PATTERNS = [
  /not as advertised/i,
  /not the advertised/i,
  /different from (the )?(photo|picture|image|website)/i,
  /doesn'?t match/i,
  /does not match/i,
  /not the same/i,
  /front (is )?different/i,
  /badge (is )?different/i,
  /logo (is )?different/i,
  /no es la promocionad/i,
  /no coincide/i,
  /distint[oa] a la foto/i,
  /diferente a la web/i,
  /parte frontal/i
];

const INVOICE_PATTERNS = [
  /\binvoice\b/i,
  /(send|provide|need|can i get|could i get|please).{0,40}\breceipt\b/i,
  /\breceipt\b.{0,40}\b(order|payment|purchase)\b/i,
  /\bvat\b/i,
  /factura/i,
  /recibo/i
];

const DUPLICATE_PATTERNS = [
  /\bduplicate\b/i,
  /same case/i,
  /same issue/i,
  /already replied/i,
  /already answered/i,
  /otro hilo/i,
  /hilo duplicad/i,
  /ya respondimos/i,
  /ya le respondimos/i
];

export const SUPPORT_CASE_TYPES = [
  'duplicate_thread',
  'invoice_request',
  'wrong_item',
  'product_mismatch',
  'size_issue',
  'refund_request',
  'return_request',
  'supplier_issue_open',
  'delivered_not_found',
  'failed_delivery_attempt',
  'customs_pending'
];

const SUPPORT_CASE_TYPE_SET = new Set(SUPPORT_CASE_TYPES);

export function normalizeSupportCaseType(value = '') {
  const clean = String(value || '').trim().toLowerCase();
  return SUPPORT_CASE_TYPE_SET.has(clean) ? clean : '';
}

export function applyForcedSupportCase({ detectedSupportCase = null, forcedSupportCaseType = '' } = {}) {
  const type = normalizeSupportCaseType(forcedSupportCaseType);
  if (!type) return detectedSupportCase || null;

  return {
    type,
    confidence: 'high',
    reasons: [
      'agent_forced_case',
      detectedSupportCase?.type ? `detected_case:${detectedSupportCase.type}` : 'detected_case:none'
    ],
    forced: true,
    detected_type: detectedSupportCase?.type || null
  };
}

export function detectSupportCase({
  latestMessage = '',
  conversationText = '',
  shopifyContext = {},
  providerTrackingContext = null,
  issueContext = null,
  attachmentAnalysis = null,
  duplicateContext = null
} = {}) {
  const text = [
    latestMessage,
    conversationText,
    providerTrackingText(providerTrackingContext),
    attachmentAnalysisText(attachmentAnalysis)
  ].filter(Boolean).join('\n');

  const directCase = detectDirectCustomerCase({ text, duplicateContext });
  if (directCase) return directCase;

  const order = shopifyContext?.selected_order;
  if (issueContextHasOpenIssues(issueContext)) {
    return {
      type: 'supplier_issue_open',
      confidence: 'medium',
      reasons: ['open_internal_issue']
    };
  }
  if (!order) return null;

  const fulfillments = Array.isArray(order.fulfillments) ? order.fulfillments : [];
  const fulfillment = fulfillments.find(item => hasTracking(item)) || fulfillments[0];
  if (!fulfillment || !hasTracking(fulfillment)) return null;
  if (isDelivered(fulfillment)) {
    if (DELIVERED_NOT_FOUND_PATTERNS.some(pattern => pattern.test(text))) {
      return {
        type: 'delivered_not_found',
        confidence: 'high',
        reasons: ['shipment_delivered', 'customer_reports_not_received']
      };
    }
    return null;
  }

  const logisticsText = [
    latestMessage,
    conversationText,
    order.fulfillment_status,
    fulfillment.display_status,
    trackingText(fulfillment),
    providerTrackingText(providerTrackingContext)
  ].filter(Boolean).join('\n');

  if (FAILED_DELIVERY_PATTERNS.some(pattern => pattern.test(logisticsText))) {
    return {
      type: 'failed_delivery_attempt',
      confidence: 'high',
      reasons: ['carrier_delivery_attempt_failed', 'tracking_present']
    };
  }

  const reasons = [];
  const carrier = fulfillment.tracking?.find(info => info?.company)?.company || '';

  if (isFulfilled(order, fulfillment)) reasons.push('order_fulfilled_or_fulfillment_created');
  reasons.push('tracking_present');
  if (!fulfillment.in_transit_at) reasons.push('no_in_transit_timestamp');
  if (carrier && LOCAL_HANDOFF_CARRIER_PATTERN.test(carrier)) reasons.push(`local_handoff_carrier:${carrier}`);
  if (CUSTOMS_TRACKING_PATTERNS.some(pattern => pattern.test(logisticsText))) reasons.push('customs_tracking_phrase');
  if (CUSTOMER_DELAY_PATTERNS.some(pattern => pattern.test([latestMessage, conversationText].join('\n')))) {
    reasons.push('customer_waiting_or_delay_question');
  }

  const hasStrongTrackingPhrase = reasons.includes('customs_tracking_phrase');
  const hasLocalHandoffCarrier = reasons.some(reason => reason.startsWith('local_handoff_carrier:'));
  const hasMediumHeuristic = hasLocalHandoffCarrier
    && reasons.includes('tracking_present')
    && reasons.includes('no_in_transit_timestamp')
    && reasons.includes('customer_waiting_or_delay_question')
    && reasons.includes('order_fulfilled_or_fulfillment_created');

  if (!hasStrongTrackingPhrase && !hasMediumHeuristic) return null;

  return {
    type: 'customs_pending',
    confidence: hasStrongTrackingPhrase ? 'high' : 'medium',
    reasons
  };
}

function detectDirectCustomerCase({ text, duplicateContext }) {
  if (DUPLICATE_PATTERNS.some(pattern => pattern.test(text)) || duplicateContext?.confirmed_duplicate) {
    return {
      type: 'duplicate_thread',
      confidence: duplicateContext?.confirmed_duplicate ? 'high' : 'medium',
      reasons: ['duplicate_thread_signal']
    };
  }
  if (INVOICE_PATTERNS.some(pattern => pattern.test(text))) {
    return {
      type: 'invoice_request',
      confidence: 'high',
      reasons: ['customer_requests_invoice_or_receipt']
    };
  }
  if (WRONG_ITEM_PATTERNS.some(pattern => pattern.test(text))) {
    return {
      type: 'wrong_item',
      confidence: 'high',
      reasons: ['customer_reports_wrong_item']
    };
  }
  if (PRODUCT_MISMATCH_PATTERNS.some(pattern => pattern.test(text))) {
    return {
      type: 'product_mismatch',
      confidence: 'high',
      reasons: ['customer_reports_product_mismatch']
    };
  }
  if (SIZE_PATTERNS.some(pattern => pattern.test(text))) {
    return {
      type: 'size_issue',
      confidence: 'high',
      reasons: ['customer_mentions_size_or_fit']
    };
  }
  if (REFUND_PATTERNS.some(pattern => pattern.test(text))) {
    return {
      type: 'refund_request',
      confidence: 'high',
      reasons: ['customer_requests_refund']
    };
  }
  if (RETURN_PATTERNS.some(pattern => pattern.test(text))) {
    return {
      type: 'return_request',
      confidence: 'high',
      reasons: ['customer_requests_return_or_exchange']
    };
  }
  return null;
}

function hasTracking(fulfillment = {}) {
  const trackingNumbers = Array.isArray(fulfillment.tracking_numbers) ? fulfillment.tracking_numbers : [];
  const tracking = Array.isArray(fulfillment.tracking) ? fulfillment.tracking : [];
  return trackingNumbers.some(Boolean) || tracking.some(info => info?.number);
}

function isDelivered(fulfillment = {}) {
  return Boolean(fulfillment.delivered_at) || String(fulfillment.display_status || '').toUpperCase() === 'DELIVERED';
}

function isFulfilled(order = {}, fulfillment = {}) {
  const orderStatus = String(order.fulfillment_status || '').toUpperCase();
  const fulfillmentStatus = String(fulfillment.display_status || '').toUpperCase();
  return Boolean(fulfillment.created_at)
    || orderStatus === 'FULFILLED'
    || fulfillmentStatus === 'FULFILLED'
    || fulfillmentStatus === 'IN_TRANSIT';
}

function trackingText(fulfillment = {}) {
  const tracking = Array.isArray(fulfillment.tracking) ? fulfillment.tracking : [];
  return tracking
    .map(info => [info?.company, info?.number, info?.url].filter(Boolean).join(' '))
    .filter(Boolean)
    .join('\n');
}

function providerTrackingText(providerTrackingContext = {}) {
  if (!providerTrackingContext) return '';
  const events = Array.isArray(providerTrackingContext.latest_events) ? providerTrackingContext.latest_events : [];
  return [
    providerTrackingContext.last_record,
    providerTrackingContext.normalized_status,
    providerTrackingContext.customs_status,
    ...events.map(event => [event?.record, event?.normalized_status].filter(Boolean).join(' '))
  ].filter(Boolean).join('\n');
}

function attachmentAnalysisText(attachmentAnalysis = {}) {
  const analyses = Array.isArray(attachmentAnalysis?.analyses) ? attachmentAnalysis.analyses : [];
  return analyses
    .map(analysis => [
      analysis.summary,
      ...(Array.isArray(analysis.visible_text) ? analysis.visible_text : []),
      ...(Array.isArray(analysis.signals) ? analysis.signals : [])
    ].filter(Boolean).join(' '))
    .join('\n');
}

function issueContextHasOpenIssues(issueContext = {}) {
  const issues = Array.isArray(issueContext?.issues) ? issueContext.issues : [];
  return issues.some(issue => {
    const status = String(issue?.status || '').toLowerCase();
    return !['closed', 'resolved', 'done', 'completed'].includes(status);
  });
}
