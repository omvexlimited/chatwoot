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

export function detectSupportCase({ latestMessage = '', conversationText = '', shopifyContext = {} } = {}) {
  const order = shopifyContext?.selected_order;
  if (!order) return null;

  const fulfillments = Array.isArray(order.fulfillments) ? order.fulfillments : [];
  const fulfillment = fulfillments.find(item => hasTracking(item)) || fulfillments[0];
  if (!fulfillment || !hasTracking(fulfillment)) return null;
  if (isDelivered(fulfillment)) return null;

  const text = [
    latestMessage,
    conversationText,
    order.fulfillment_status,
    fulfillment.display_status,
    trackingText(fulfillment)
  ].filter(Boolean).join('\n');

  const reasons = [];
  const carrier = fulfillment.tracking?.find(info => info?.company)?.company || '';

  if (isFulfilled(order, fulfillment)) reasons.push('order_fulfilled_or_fulfillment_created');
  reasons.push('tracking_present');
  if (!fulfillment.in_transit_at) reasons.push('no_in_transit_timestamp');
  if (carrier && LOCAL_HANDOFF_CARRIER_PATTERN.test(carrier)) reasons.push(`local_handoff_carrier:${carrier}`);
  if (CUSTOMS_TRACKING_PATTERNS.some(pattern => pattern.test(text))) reasons.push('customs_tracking_phrase');
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
