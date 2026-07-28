import { createHash } from 'node:crypto';

export function createContextFingerprint({
  accountId,
  conversationId,
  latestMessageId,
  selectedOrderRef = '',
  forcedSupportCase = ''
}) {
  return createHash('sha256')
    .update([
      accountId,
      conversationId,
      latestMessageId,
      selectedOrderRef,
      forcedSupportCase
    ].map(value => String(value || '').trim()).join(':'))
    .digest('hex');
}

export function createContextJobStore({
  ttlMs = 300000,
  maxEntries = 200,
  now = () => Date.now()
} = {}) {
  const entries = new Map();

  function start(key, producer) {
    prune();
    const existing = entries.get(key);
    if (existing) return existing;

    const entry = {
      key,
      status: 'pending',
      value: null,
      error: null,
      createdAt: now(),
      updatedAt: now(),
      promise: null
    };
    entry.promise = Promise.resolve()
      .then(producer)
      .then(value => {
        entry.status = 'ready';
        entry.value = value;
        entry.updatedAt = now();
        return value;
      })
      .catch(error => {
        entry.status = 'failed';
        entry.error = error;
        entry.updatedAt = now();
        return null;
      });
    entries.set(key, entry);
    enforceLimit();
    return entry;
  }

  function setReady(key, value) {
    prune();
    const entry = {
      key,
      status: 'ready',
      value,
      error: null,
      createdAt: now(),
      updatedAt: now(),
      promise: Promise.resolve(value)
    };
    entries.set(key, entry);
    enforceLimit();
    return entry;
  }

  function get(key) {
    prune();
    return entries.get(key) || null;
  }

  function remove(key) {
    entries.delete(key);
  }

  function prune() {
    const cutoff = now() - positiveNumber(ttlMs, 300000);
    for (const [key, entry] of entries) {
      if (entry.updatedAt < cutoff) entries.delete(key);
    }
  }

  function enforceLimit() {
    const limit = positiveNumber(maxEntries, 200);
    while (entries.size > limit) {
      const oldestKey = entries.keys().next().value;
      entries.delete(oldestKey);
    }
  }

  return {
    start,
    setReady,
    get,
    remove,
    size: () => entries.size
  };
}

function positiveNumber(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
