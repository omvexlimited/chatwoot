export async function fetchConversationMessages({ config, accountId, conversationId }) {
  if (!config.chatwootBaseUrl || !config.chatwootApiToken) {
    return { available: false, messages: [], warnings: ['Chatwoot API is not fully configured.'] };
  }
  if (!accountId || !conversationId) {
    return { available: false, messages: [], warnings: ['Chatwoot conversation context is missing, so the dashboard payload was used.'] };
  }

  const url = `${config.chatwootBaseUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
  const data = await chatwootRequest(config, url, { method: 'GET' });
  const messages = Array.isArray(data) ? data : data.payload || data.messages || [];
  return { available: true, messages, warnings: [] };
}

export async function createPrivateNote({ config, accountId, conversationId, content }) {
  if (!config.chatwootBaseUrl || !config.chatwootApiToken) {
    throw new Error('Chatwoot API is not configured.');
  }
  if (!accountId || !conversationId) {
    throw new Error('account_id and conversation_id are required.');
  }

  const url = `${config.chatwootBaseUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
  return chatwootRequest(config, url, {
    method: 'POST',
    body: JSON.stringify({
      content,
      message_type: 'outgoing',
      private: true
    })
  });
}

export async function getDraftReply({ config, accountId, conversationId }) {
  if (!config.chatwootBaseUrl || !config.chatwootApiToken) {
    throw new Error('Chatwoot API is not configured.');
  }
  if (!accountId || !conversationId) {
    throw new Error('account_id and conversation_id are required.');
  }

  const url = `${config.chatwootBaseUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}/draft_messages`;
  const data = await chatwootRequest(config, url, { method: 'GET' });
  return {
    has_draft: Boolean(data?.has_draft),
    message: String(data?.message || '')
  };
}

export async function prepareDraftReply({ config, accountId, conversationId, content }) {
  if (!config.chatwootBaseUrl || !config.chatwootApiToken) {
    throw new Error('Chatwoot API is not configured.');
  }
  if (!accountId || !conversationId) {
    throw new Error('account_id and conversation_id are required.');
  }

  const url = `${config.chatwootBaseUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}/draft_messages`;
  await chatwootRequest(config, url, {
    method: 'PATCH',
    body: JSON.stringify({
      draft_message: {
        message: content
      }
    })
  });
  return { ok: true };
}

export async function listConversations({ config, accountId, status = 'open', page = 1 }) {
  if (!config.chatwootBaseUrl || !config.chatwootApiToken) {
    throw new Error('Chatwoot API is not configured.');
  }
  if (!accountId) {
    throw new Error('account_id is required.');
  }

  const url = new URL(`${config.chatwootBaseUrl}/api/v1/accounts/${accountId}/conversations`);
  url.searchParams.set('status', status);
  url.searchParams.set('page', String(page));
  return chatwootRequest(config, url.toString(), { method: 'GET' });
}

async function chatwootRequest(config, url, options) {
  const controller = new AbortController();
  const timeoutMs = positiveNumber(config.chatwootRequestTimeoutMs, 8000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: options.signal || controller.signal,
      headers: {
        'Content-Type': 'application/json',
        api_access_token: config.chatwootApiToken,
        ...(options.headers || {})
      }
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Chatwoot request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `Chatwoot HTTP ${response.status}`);
  }
  return data;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
