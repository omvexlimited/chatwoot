import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getIssueContext } from '../src/issue-lookup.js';

test('loads open issues for selected order from internal admin API', async t => {
  const calls = mockFetch(t, async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      total: 1,
      issues: [
        {
          issue_id: 22,
          order_ref: '#2590',
          provider: 'Mign Jin (1)',
          issue_type: 'shipping',
          status: 'open',
          message_preview: 'Supplier needs to confirm handoff.',
          created_at: '2026-06-12T10:00:00Z',
          updated_at: '2026-06-12T11:00:00Z',
          url: 'https://admin.example.com/kits-republic/issues/22'
        }
      ]
    })
  }));

  const result = await getIssueContext({
    config: {
      kitsAdminBaseUrl: 'https://admin.example.com',
      kitsInternalApiToken: 'secret'
    },
    order: { name: '#2590' }
  });

  assert.equal(calls[0].url, 'https://admin.example.com/internal/kits-republic/issues?order_ref=%232590');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret');
  assert.equal(result.available, true);
  assert.equal(result.reason, 'open_issues_found');
  assert.equal(result.issues[0].issue_id, 22);
  assert.equal(result.issues[0].url, 'https://admin.example.com/kits-republic/issues/22');
});

test('returns warning when internal issue lookup is not configured', async () => {
  const result = await getIssueContext({
    config: { kitsAdminBaseUrl: 'https://admin.example.com' },
    order: { name: '#2590' }
  });

  assert.equal(result.available, false);
  assert.equal(result.reason, 'not_configured');
  assert.deepEqual(result.warnings, ['Kits internal issue lookup is not configured.']);
});

function mockFetch(t, handler) {
  const calls = [];
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return handler(url, options);
  };
  return calls;
}
