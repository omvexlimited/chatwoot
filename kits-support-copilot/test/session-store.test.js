import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearSession,
  createStorageKey,
  loadSession,
  saveSession
} from '../public/session-store.js';

test('creates stable local storage keys per account and conversation', () => {
  assert.equal(
    createStorageKey({ accountId: 1, conversationId: 42 }),
    'kr-copilot-session-v1:1:42'
  );
  assert.equal(createStorageKey({ accountId: 1, conversationId: '' }), '');
});

test('persists normalized chat session data', () => {
  const storage = new MemoryStorage();
  const key = createStorageKey({ accountId: 1, conversationId: 42 });

  saveSession(storage, key, {
    chatMessages: [
      { role: 'user', content: 'hazlo mas corto' },
      { role: 'invalid', content: 'kept as user' },
      { role: 'assistant', content: 'ok' },
      { role: 'assistant', content: '' }
    ],
    draft: 'Draft text',
    lastResult: { confidence: 'medium' },
    selectedOrderRef: '2222'
  });

  assert.deepEqual(loadSession(storage, key), {
    chatMessages: [
      { role: 'user', content: 'hazlo mas corto' },
      { role: 'user', content: 'kept as user' },
      { role: 'assistant', content: 'ok' }
    ],
    draft: 'Draft text',
    lastResult: { confidence: 'medium' },
    selectedOrderRef: '#2222',
    updatedAt: loadSession(storage, key).updatedAt
  });

  clearSession(storage, key);
  assert.equal(loadSession(storage, key).draft, '');
  assert.equal(loadSession(storage, key).selectedOrderRef, '');
});

class MemoryStorage {
  data = new Map();

  getItem(key) {
    return this.data.get(key) || null;
  }

  setItem(key, value) {
    this.data.set(key, String(value));
  }

  removeItem(key) {
    this.data.delete(key);
  }
}
