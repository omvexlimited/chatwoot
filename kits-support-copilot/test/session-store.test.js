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
    selectedOrderRef: '2222',
    pendingIssue: {
      order_ref: '2222',
      provider_id: '4',
      provider_label: 'Mign Jin (1)',
      issue_type: 'stock',
      message: 'Stock issue for order #2222: no stock'
    }
  });

  const loaded = loadSession(storage, key);
  assert.deepEqual(loaded, {
    chatMessages: [
      { role: 'user', content: 'hazlo mas corto' },
      { role: 'user', content: 'kept as user' },
      { role: 'assistant', content: 'ok' }
    ],
    draft: 'Draft text',
    lastResult: { confidence: 'medium' },
    selectedOrderRef: '#2222',
    pendingIssue: {
      order_ref: '#2222',
      provider_id: 4,
      provider_label: 'Mign Jin (1)',
      issue_type: 'stock',
      message: 'Stock issue for order #2222: no stock',
      admin_order_url: '',
      updated_at: loaded.pendingIssue.updated_at
    },
    updatedAt: loaded.updatedAt
  });

  clearSession(storage, key);
  assert.equal(loadSession(storage, key).draft, '');
  assert.equal(loadSession(storage, key).selectedOrderRef, '');
  assert.equal(loadSession(storage, key).pendingIssue, null);
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
