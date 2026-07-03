const PREFIX = 'kr-copilot-session-v1';
const MAX_STORED_MESSAGES = 20;
const MAX_STORED_WARNINGS = 5;
const CONTEXT_SUMMARY_KEYS = [
  'customer',
  'order',
  'status',
  'selected_order_ref',
  'order_created_at',
  'shipment_status',
  'tracking_number',
  'tracking_carrier',
  'tracking_url',
  'response_language',
  'support_case'
];
const SUPPORT_CASE_TYPES = new Set([
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
]);

export function createStorageKey({ accountId, conversationId }) {
  if (!accountId || !conversationId) return '';
  return `${PREFIX}:${accountId}:${conversationId}`;
}

export function loadSession(storage, key) {
  if (!storage || !key) return emptySession();
  try {
    return normalizeSession(JSON.parse(storage.getItem(key) || '{}'));
  } catch {
    return emptySession();
  }
}

export function saveSession(storage, key, session) {
  if (!storage || !key) return;
  const normalized = normalizeSession(session);
  if (trySetSession(storage, key, normalized)) return;

  pruneStoredSessions(storage, key);
  if (trySetSession(storage, key, normalized)) return;

  trySetSession(storage, key, minimalSession(normalized));
}

export function clearSession(storage, key) {
  if (!storage || !key) return;
  storage.removeItem(key);
}

export function normalizeSession(session = {}) {
  return {
    chatMessages: normalizeMessages(session.chatMessages),
    draft: String(session.draft || ''),
    lastResult: normalizeLastResult(session.lastResult),
    selectedOrderRef: normalizeOrderRef(session.selectedOrderRef),
    forcedSupportCase: normalizeSupportCaseType(session.forcedSupportCase),
    pendingIssue: normalizePendingIssue(session.pendingIssue),
    updatedAt: session.updatedAt || new Date().toISOString()
  };
}

function emptySession() {
  return {
    chatMessages: [],
    draft: '',
    lastResult: null,
    selectedOrderRef: '',
    forcedSupportCase: '',
    pendingIssue: null,
    updatedAt: null
  };
}

function normalizeOrderRef(value = '') {
  const clean = String(value || '').trim().replace(/^#?/, '');
  return clean ? `#${clean}` : '';
}

function normalizeSupportCaseType(value = '') {
  const clean = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return SUPPORT_CASE_TYPES.has(clean) ? clean : '';
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map(message => ({
      role: message?.role === 'assistant' ? 'assistant' : 'user',
      content: String(message?.content || '').trim()
    }))
    .filter(message => message.content)
    .slice(-MAX_STORED_MESSAGES);
}

function normalizeLastResult(value) {
  if (!value || typeof value !== 'object') return null;

  const result = {};
  copyString(value, result, 'contact_email');
  copyString(value, result, 'confidence');
  copyString(value, result, 'reasoning_summary');

  const warnings = normalizeStringArray(value.warnings).slice(0, MAX_STORED_WARNINGS);
  if (warnings.length) result.warnings = warnings;

  const contextSummary = normalizeContextSummary(value.context_summary);
  if (contextSummary) result.context_summary = contextSummary;

  return Object.keys(result).length ? result : null;
}

function normalizeContextSummary(value) {
  if (!value || typeof value !== 'object') return null;

  const summary = {};
  for (const key of CONTEXT_SUMMARY_KEYS) {
    const clean = normalizeStoredValue(value[key]);
    if (clean !== undefined) summary[key] = clean;
  }

  return Object.keys(summary).length ? summary : null;
}

function normalizeStoredValue(value) {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const result = value.map(normalizeStoredValue).filter(item => item !== undefined);
    return result.length ? result : undefined;
  }
  if (typeof value === 'object') {
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      const clean = normalizeStoredValue(child);
      if (clean !== undefined) result[key] = clean;
    }
    return Object.keys(result).length ? result : undefined;
  }

  const clean = String(value).trim();
  return clean ? clean : undefined;
}

function copyString(source, target, key) {
  const clean = String(source?.[key] || '').trim();
  if (clean) target[key] = clean;
}

function trySetSession(storage, key, session) {
  try {
    storage.setItem(key, JSON.stringify(session));
    return true;
  } catch {
    return false;
  }
}

function pruneStoredSessions(storage, activeKey) {
  if (!Number.isInteger(storage?.length) || typeof storage.key !== 'function') return;

  const keys = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(`${PREFIX}:`) && key !== activeKey) keys.push(key);
  }

  for (const key of keys) {
    try {
      storage.removeItem(key);
    } catch {
      // Ignore unavailable localStorage entries; the retry path will decide.
    }
  }
}

function minimalSession(session) {
  return {
    chatMessages: [],
    draft: session.draft || '',
    lastResult: null,
    selectedOrderRef: session.selectedOrderRef || '',
    forcedSupportCase: session.forcedSupportCase || '',
    pendingIssue: null,
    updatedAt: session.updatedAt || new Date().toISOString()
  };
}

function normalizePendingIssue(value) {
  if (!value || typeof value !== 'object') return null;
  const orderRef = normalizeOrderRef(value.order_ref);
  const providerId = Number(value.provider_id);
  const message = String(value.message || '').trim();
  if (!orderRef || !Number.isInteger(providerId) || providerId <= 0 || !message) return null;
  return {
    order_ref: orderRef,
    provider_id: providerId,
    provider_label: String(value.provider_label || '').trim(),
    issue_type: String(value.issue_type || 'other').trim(),
    message,
    affected_line_item_ids: normalizeStringArray(value.affected_line_item_ids),
    affected_line_items: normalizeAffectedLineItems(value.affected_line_items),
    admin_order_url: String(value.admin_order_url || '').trim(),
    updated_at: value.updated_at || new Date().toISOString()
  };
}

function normalizeStringArray(value = []) {
  const raw = Array.isArray(value) ? value : [value];
  const result = [];
  const seen = new Set();
  for (const item of raw) {
    const clean = String(item || '').trim();
    if (clean && !seen.has(clean)) {
      result.push(clean);
      seen.add(clean);
    }
  }
  return result;
}

function normalizeAffectedLineItems(value = []) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => ({
      id: String(item?.id || item?.shopify_line_item_id || item?.affected_item_key || '').trim(),
      shopify_line_item_id: String(item?.shopify_line_item_id || item?.id || item?.affected_item_key || '').trim(),
      label: String(item?.label || item?.name || item?.product_title || '').trim(),
      name: String(item?.name || item?.product_title || '').trim(),
      sku: String(item?.sku || '').trim(),
      quantity: item?.quantity || null
    }))
    .filter(item => item.shopify_line_item_id || item.id || item.label);
}
