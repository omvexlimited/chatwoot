const PREFIX = 'kr-copilot-session-v1';

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
  storage.setItem(key, JSON.stringify(normalizeSession(session)));
}

export function clearSession(storage, key) {
  if (!storage || !key) return;
  storage.removeItem(key);
}

export function normalizeSession(session = {}) {
  return {
    chatMessages: normalizeMessages(session.chatMessages),
    draft: String(session.draft || ''),
    lastResult: session.lastResult && typeof session.lastResult === 'object' ? session.lastResult : null,
    selectedOrderRef: normalizeOrderRef(session.selectedOrderRef),
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
    pendingIssue: null,
    updatedAt: null
  };
}

function normalizeOrderRef(value = '') {
  const clean = String(value || '').trim().replace(/^#?/, '');
  return clean ? `#${clean}` : '';
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map(message => ({
      role: message?.role === 'assistant' ? 'assistant' : 'user',
      content: String(message?.content || '').trim()
    }))
    .filter(message => message.content)
    .slice(-40);
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
    admin_order_url: String(value.admin_order_url || '').trim(),
    updated_at: value.updated_at || new Date().toISOString()
  };
}
