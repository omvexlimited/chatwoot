import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContextFingerprint, createContextJobStore } from '../src/context-cache.js';

test('creates stable context fingerprints from request identity', () => {
  const input = {
    accountId: '1',
    conversationId: '20',
    latestMessageId: '300',
    selectedOrderRef: '#1001',
    forcedSupportCase: 'tracking_update'
  };

  assert.equal(createContextFingerprint(input), createContextFingerprint({ ...input }));
  assert.notEqual(
    createContextFingerprint(input),
    createContextFingerprint({ ...input, latestMessageId: '301' })
  );
  assert.notEqual(
    createContextFingerprint(input),
    createContextFingerprint({ ...input, selectedOrderRef: '#1002' })
  );
});

test('reuses an in-flight context job for the same fingerprint', async () => {
  const store = createContextJobStore();
  let calls = 0;
  let resolveProducer;
  const produced = new Promise(resolve => {
    resolveProducer = resolve;
  });

  const first = store.start('fingerprint', async () => {
    calls += 1;
    return produced;
  });
  const second = store.start('fingerprint', async () => {
    calls += 1;
    return { duplicate: true };
  });

  assert.equal(first, second);
  resolveProducer({ ready: true });
  assert.deepEqual(await first.promise, { ready: true });
  assert.equal(first.status, 'ready');
  assert.equal(calls, 1);
});

test('expires old jobs and enforces the configured cache limit', () => {
  let currentTime = 1000;
  const store = createContextJobStore({
    ttlMs: 100,
    maxEntries: 2,
    now: () => currentTime
  });

  store.setReady('one', 1);
  store.setReady('two', 2);
  store.setReady('three', 3);
  assert.equal(store.get('one'), null);
  assert.equal(store.size(), 2);

  currentTime += 101;
  assert.equal(store.get('two'), null);
  assert.equal(store.size(), 0);
});
