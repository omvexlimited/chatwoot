import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchConversationMessages } from '../src/chatwoot.js';

test('times out Chatwoot message lookup instead of hanging context loading', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = (_url, options = {}) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });

  await assert.rejects(
    fetchConversationMessages({
      config: {
        chatwootBaseUrl: 'https://chatwoot.example.test',
        chatwootApiToken: 'token',
        chatwootRequestTimeoutMs: 5
      },
      accountId: '1',
      conversationId: '1452'
    }),
    /Chatwoot request timed out after 5ms/
  );
});
