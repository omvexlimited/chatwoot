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
    lastResult: {
      contact_email: 'customer@example.com',
      confidence: 'medium',
      reasoning_summary: 'Used order context',
      context_summary: {
        customer: 'customer@example.com',
        order: '#2222',
        order_candidates: [{ order: '#1111', heavy: 'not stored' }]
      },
      shopify_context: { selected_order: { line_items: new Array(50).fill({ name: 'heavy' }) } },
      provider_tracking_context: { timeline: new Array(50).fill({ event: 'heavy' }) },
      issue_context: { issues: new Array(50).fill({ id: 1 }) },
      warnings: ['first', 'second', 'third', 'fourth', 'fifth', 'sixth']
    },
    selectedOrderRef: '2222',
    forcedSupportCase: 'return_request',
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
    lastResult: {
      contact_email: 'customer@example.com',
      confidence: 'medium',
      reasoning_summary: 'Used order context',
      warnings: ['first', 'second', 'third', 'fourth', 'fifth'],
      context_summary: {
        customer: 'customer@example.com',
        order: '#2222'
      }
    },
    selectedOrderRef: '#2222',
    forcedSupportCase: 'return_request',
    pendingIssue: {
      order_ref: '#2222',
      provider_id: 4,
      provider_label: 'Mign Jin (1)',
      issue_type: 'stock',
      message: 'Stock issue for order #2222: no stock',
      affected_line_item_ids: [],
      affected_line_items: [],
      admin_order_url: '',
      updated_at: loaded.pendingIssue.updated_at
    },
    updatedAt: loaded.updatedAt
  });

  clearSession(storage, key);
  assert.equal(loadSession(storage, key).draft, '');
  assert.equal(loadSession(storage, key).selectedOrderRef, '');
  assert.equal(loadSession(storage, key).forcedSupportCase, '');
  assert.equal(loadSession(storage, key).pendingIssue, null);
});

test('normalizes forced support case in stored sessions', () => {
  const storage = new MemoryStorage();
  const key = createStorageKey({ accountId: 1, conversationId: 42 });

  saveSession(storage, key, {
    forcedSupportCase: 'refund request'
  });
  assert.equal(loadSession(storage, key).forcedSupportCase, 'refund_request');

  saveSession(storage, key, {
    forcedSupportCase: 'unknown_case'
  });
  assert.equal(loadSession(storage, key).forcedSupportCase, '');
});

test('limits stored chat messages to the latest 20', () => {
  const storage = new MemoryStorage();
  const key = createStorageKey({ accountId: 1, conversationId: 42 });

  saveSession(storage, key, {
    chatMessages: Array.from({ length: 25 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: `message ${index + 1}`
    }))
  });

  const loaded = loadSession(storage, key);
  assert.equal(loaded.chatMessages.length, 20);
  assert.equal(loaded.chatMessages[0].content, 'message 6');
  assert.equal(loaded.chatMessages[19].content, 'message 25');
});

test('normalizes legacy heavy sessions into lightweight data', () => {
  const storage = new MemoryStorage();
  const key = createStorageKey({ accountId: 1, conversationId: 42 });
  storage.setItem(
    key,
    JSON.stringify({
      lastResult: {
        contact_email: 'customer@example.com',
        confidence: 'high',
        context_summary: {
          customer: 'customer@example.com',
          order: '#3333',
          order_candidates: [{ order: '#3333', line_items: new Array(20).fill('heavy') }]
        },
        shopify_context: { orders: new Array(20).fill({ line_items: new Array(20).fill('heavy') }) },
        provider_tracking_context: { timeline: new Array(20).fill({ event: 'heavy' }) },
        issue_context: { issues: new Array(20).fill({ id: 1 }) }
      }
    })
  );

  const loaded = loadSession(storage, key);
  assert.deepEqual(loaded.lastResult, {
    contact_email: 'customer@example.com',
    confidence: 'high',
    context_summary: {
      customer: 'customer@example.com',
      order: '#3333'
    }
  });
});

test('does not throw when localStorage quota is exceeded', () => {
  const storage = new FailingStorage();
  const key = createStorageKey({ accountId: 1, conversationId: 42 });

  assert.doesNotThrow(() => {
    saveSession(storage, key, {
      chatMessages: [{ role: 'user', content: 'hello' }],
      draft: 'Draft text',
      selectedOrderRef: '#1234'
    });
  });
});

test('prunes old copilot sessions and retries after quota failure', () => {
  const storage = new QuotaOnceStorage();
  const key = createStorageKey({ accountId: 1, conversationId: 42 });
  const otherKey = createStorageKey({ accountId: 1, conversationId: 41 });
  storage.setItem(otherKey, JSON.stringify({ draft: 'old draft' }));
  storage.setItem('unrelated', 'keep me');

  saveSession(storage, key, {
    chatMessages: [{ role: 'user', content: 'hello' }],
    draft: 'Draft text',
    selectedOrderRef: '#1234'
  });

  assert.equal(storage.getItem(otherKey), null);
  assert.equal(storage.getItem('unrelated'), 'keep me');
  assert.equal(loadSession(storage, key).draft, 'Draft text');
});

class MemoryStorage {
  data = new Map();

  get length() {
    return this.data.size;
  }

  getItem(key) {
    return this.data.get(key) || null;
  }

  key(index) {
    return Array.from(this.data.keys())[index] || null;
  }

  setItem(key, value) {
    this.data.set(key, String(value));
  }

  removeItem(key) {
    this.data.delete(key);
  }
}

class FailingStorage extends MemoryStorage {
  setItem() {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  }
}

class QuotaOnceStorage extends MemoryStorage {
  failed = false;

  setItem(key, value) {
    if (!this.failed && key.includes('42')) {
      this.failed = true;
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    }
    super.setItem(key, value);
  }
}
