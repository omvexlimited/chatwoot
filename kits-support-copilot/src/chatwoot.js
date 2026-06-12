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

async function chatwootRequest(config, url, options) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      api_access_token: config.chatwootApiToken,
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `Chatwoot HTTP ${response.status}`);
  }
  return data;
}
