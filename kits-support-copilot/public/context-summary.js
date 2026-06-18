export function buildContextView(result = {}) {
  const shopify = result.shopify_context || {};
  const order = shopify.selected_order || null;
  const summary = result.context_summary || {};
  const warnings = Array.isArray(result.warnings) ? result.warnings.map(String).filter(Boolean) : [];
  const supportCase = result.support_case || summary.support_case || null;
  const responseLanguage = result.response_language || summary.response_language || {};
  const orderDate = formatContextDate(summary.order_created_at || order?.created_at);
  const fulfillmentDate = formatContextDate(summary.fulfillment_created_at || orderFulfillment(order)?.created_at);
  const orderName = summary.order || order?.name || null;
  const adminOrderUrl = safeHttpUrl(summary.admin_order_url);
  const shopifyAdminUrl = safeHttpUrl(summary.shopify_admin_url);
  const provider = summary.provider || order?.provider || null;
  const fulfillmentStatus = summary.fulfillment_status || order?.fulfillment_status || null;
  const trackingUrl = safeHttpUrl(summary.tracking_url || orderTracking(order)?.url);
  const trackingNumber = summary.tracking_number || orderTracking(order)?.number || null;
  const trackingCarrier = summary.tracking_carrier || orderTracking(order)?.company || null;
  const deliveryEstimate = result.delivery_estimate_context || summary.delivery_estimate_context || null;
  const providerTracking = result.provider_tracking_context || summary.provider_tracking_context || null;
  const issueContext = result.issue_context || summary.issue_context || null;
  const orderCandidates = normalizeOrderCandidates(summary.order_candidates);
  const lineItems = normalizeLineItems(summary.line_items || order?.line_items);

  return {
    topBar: {
      order: orderName
        ? [orderName, orderDate, fulfillmentStatus].filter(Boolean).join(' | ')
        : 'No order selected',
      case: supportCase?.type || '-',
      warnings: String(warnings.length)
    },
    cards: [
      customerCard({ result, summary, responseLanguage }),
      orderCard({ orderName, orderDate, adminOrderUrl, shopifyAdminUrl, provider, fulfillmentDate, fulfillmentStatus, summary }),
      ticketsCard(issueContext),
      itemsCard(lineItems),
      ordersCard(orderCandidates),
      trackingCard({ trackingCarrier, trackingNumber, trackingUrl, summary, deliveryEstimate, providerTracking }),
      caseCard(supportCase),
      warningsCard(warnings)
    ].filter(Boolean),
    rawPayload: {
      context_summary: summary,
      support_case: supportCase,
      provider_tracking_context: providerTracking,
      delivery_estimate_context: deliveryEstimate,
      issue_context: issueContext,
      warnings,
      shopify_context: shopify
    }
  };
}

function itemsCard(lineItems) {
  if (!lineItems.length) return null;
  return {
    title: 'Items',
    items: lineItems
  };
}

function ticketsCard(issueContext) {
  const tickets = normalizeTickets(issueContext?.issues);
  if (!tickets.length) return null;
  return {
    title: 'Tickets',
    rows: [
      { label: 'Open', value: String(issueContext.total || tickets.length) }
    ],
    tickets,
    emphasis: true
  };
}

export function formatContextDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(date);
}

function formatContextDateTime(value) {
  if (!value) return '';
  const text = String(value);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  const date = match
    ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5])))
    : new Date(text);
  if (Number.isNaN(date.getTime())) return String(value);

  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC'
  }).format(date);
}

function customerCard({ result, summary, responseLanguage }) {
  return {
    title: 'Customer',
    rows: [
      { label: 'Email', value: summary.customer || result.contact_email || '-' },
      { label: 'Country', value: formatCountry(summary.shipping_country, summary.shipping_country_code) },
      { label: 'Reply language', value: formatLanguage(responseLanguage) }
    ]
  };
}

function orderCard({ orderName, orderDate, adminOrderUrl, shopifyAdminUrl, provider, fulfillmentDate, fulfillmentStatus, summary }) {
  return {
    title: 'Order',
    rows: [
      {
        label: 'Order',
        value: orderName || 'No order selected',
        url: adminOrderUrl,
        links: shopifyAdminUrl ? [{ label: 'Shopify', url: shopifyAdminUrl }] : []
      },
      { label: 'Date', value: orderDate || '-' },
      { label: 'Provider', value: provider || '-' },
      { label: 'Fulfillment date', value: fulfillmentDate || '-' },
      { label: 'Shopify status', value: fulfillmentStatus || summary.status || '-' },
      { label: 'Shipment status', value: summary.shipment_status || '-' }
    ]
  };
}

function trackingCard({ trackingCarrier, trackingNumber, trackingUrl, summary, deliveryEstimate, providerTracking }) {
  const hasTracking = Boolean(trackingNumber || trackingUrl);
  const estimateRows = trackingEstimateRows(deliveryEstimate);
  const providerRows = providerTrackingRows(providerTracking);
  return {
    title: 'Tracking',
    rows: [
      { label: 'Carrier', value: trackingCarrier || (hasTracking ? '-' : 'No tracking yet') },
      {
        label: 'Number',
        value: trackingNumber || (hasTracking ? '-' : 'No tracking yet'),
        url: trackingNumber && trackingUrl ? trackingUrl : null
      },
      { label: 'Status', value: summary.shipment_status || '-' },
      ...estimateRows,
      ...providerRows
    ]
  };
}

function providerTrackingRows(providerTracking) {
  if (!providerTracking?.available) return [];

  const rows = [
    { label: 'Provider source', value: providerTracking.provider_name || `Provider ${providerTracking.provider_id || ''}`.trim() || '-' },
    { label: 'Provider update', value: formatContextDateTime(providerTracking.last_update_at) || '-' },
    { label: 'Provider status', value: providerTracking.last_record || providerTracking.normalized_status || '-' },
    { label: 'Customs', value: formatMachineStatus(providerTracking.customs_status) }
  ];

  const events = Array.isArray(providerTracking.latest_events) ? providerTracking.latest_events.slice(0, 3) : [];
  events.forEach((event, index) => {
    rows.push({
      label: `Event ${index + 1}`,
      value: [formatContextDateTime(event.date), event.record].filter(Boolean).join(' - ') || '-'
    });
  });

  return rows;
}

function trackingEstimateRows(estimate) {
  if (!estimate?.available) return [];

  const rows = [
    { label: 'Avg transit', value: formatDays(estimate.avg_transit_days) }
  ];

  if (estimate.delivered_at) {
    rows.push({ label: 'Elapsed since order', value: formatDays(estimate.days_since_order) });
    rows.push({ label: 'Transit time', value: formatDays(estimate.days_since_fulfillment) });
  } else {
    rows.push({ label: 'Elapsed since fulfillment', value: formatDays(estimate.days_since_fulfillment) });
    rows.push({ label: 'Elapsed since order', value: formatDays(estimate.days_since_order) });
    rows.push({ label: 'Estimated remaining', value: formatRemainingDays(estimate.estimated_remaining_days) });
  }

  rows.push({ label: 'Estimate confidence', value: estimate.confidence || '-' });
  return rows;
}

function ordersCard(orderCandidates) {
  if (!orderCandidates.length || orderCandidates.length < 2) return null;
  return {
    title: 'Orders',
    orders: orderCandidates,
    emphasis: !orderCandidates.some(order => order.selected)
  };
}

function caseCard(supportCase) {
  return {
    title: 'Case',
    rows: [
      { label: 'Type', value: supportCase?.type || '-' },
      { label: 'Confidence', value: supportCase?.confidence || '-' },
      { label: 'Reasons', value: formatReasons(supportCase?.reasons) }
    ],
    emphasis: Boolean(supportCase?.type)
  };
}

function normalizeOrderCandidates(candidates) {
  if (!Array.isArray(candidates)) return [];
  return candidates.map(candidate => ({
    ...candidate,
    order: candidate.order || '-',
    date: formatContextDate(candidate.date),
    shopify_status: candidate.shopify_status || '-',
    provider: candidate.provider || '',
    shipment_status: candidate.shipment_status || '-',
    country: formatCountry(candidate.country, candidate.country_code),
    tracking_carrier: candidate.tracking_carrier || '',
    tracking_number: candidate.tracking_number || '',
    admin_order_url: safeHttpUrl(candidate.admin_order_url),
    shopify_admin_url: safeHttpUrl(candidate.shopify_admin_url),
    selected: Boolean(candidate.selected)
  }));
}

function normalizeTickets(issues = []) {
  if (!Array.isArray(issues)) return [];
  return issues.map(issue => ({
    issue_id: issue.issue_id || null,
    title: issue.issue_id ? `#${issue.issue_id}` : 'Open ticket',
    type: issue.issue_type || '-',
    provider: issue.provider || '',
    status: issue.status || '',
    message: issue.message_preview || '',
    date: formatContextDate(issue.created_at),
    updated: formatContextDate(issue.updated_at),
    url: safeHttpUrl(issue.url)
  })).filter(issue => issue.issue_id || issue.message || issue.url);
}

function normalizeLineItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map(item => {
    const customAttributes = normalizeCustomAttributes(item.custom_attributes);
    return {
      title: [formatQuantity(item.quantity), item.name || 'Unknown item'].filter(Boolean).join(' '),
      meta: [item.sku ? `SKU ${item.sku}` : '', item.fulfillment_status || ''].filter(Boolean).join(' | '),
      personalization: formatCustomAttributes(customAttributes),
      hasPersonalization: customAttributes.length > 0
    };
  });
}

function formatQuantity(quantity) {
  const value = Number(quantity);
  if (!Number.isFinite(value) || value <= 0) return '';
  return `${value}x`;
}

function normalizeCustomAttributes(attributes) {
  if (!Array.isArray(attributes)) return [];
  return attributes
    .map(attribute => ({
      key: String(attribute?.key || '').trim(),
      value: String(attribute?.value || '').trim()
    }))
    .filter(attribute => attribute.key || attribute.value);
}

function formatCustomAttributes(attributes) {
  if (!attributes.length) return '';
  return attributes
    .map(attribute => [attribute.key, attribute.value].filter(Boolean).join(': '))
    .join(' | ');
}

function warningsCard(warnings) {
  return {
    title: 'Warnings',
    rows: warnings.length
      ? warnings.map((warning, index) => ({ label: String(index + 1), value: warning }))
      : [{ label: 'Status', value: 'No warnings' }]
  };
}

function orderTracking(order) {
  const fulfillment = orderFulfillment(order);
  return fulfillment?.tracking?.find(item => item?.number || item?.url) || fulfillment?.tracking?.[0] || null;
}

function orderFulfillment(order) {
  const fulfillments = Array.isArray(order?.fulfillments) ? order.fulfillments : [];
  return fulfillments.find(item => {
    return Array.isArray(item.tracking) && item.tracking.some(tracking => tracking?.number || tracking?.url);
  }) || fulfillments[0];
}

function formatCountry(country, code) {
  return [country, code].filter(Boolean).join(' / ') || '-';
}

function formatLanguage(responseLanguage) {
  if (!responseLanguage?.language) return '-';
  return [responseLanguage.language, responseLanguage.source].filter(Boolean).join(' | ');
}

function formatReasons(reasons) {
  if (!Array.isArray(reasons) || !reasons.length) return '-';
  return reasons.slice(0, 4).join(', ');
}

function formatMachineStatus(value) {
  return String(value || '-').replace(/_/g, ' ');
}

function formatDays(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '-';
  return `${number.toFixed(1).replace(/\.0$/, '')} days`;
}

function formatRemainingDays(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '-';
  if (number <= 0) return '~0 days';
  return `~${number.toFixed(1).replace(/\.0$/, '')} days`;
}

function safeHttpUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch {
    return null;
  }
  return null;
}
