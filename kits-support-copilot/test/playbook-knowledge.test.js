import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createPlaybookKnowledgeProvider,
  fetchPublishedPlaybookKnowledge
} from '../src/playbook-knowledge.js';

test('loads published playbook knowledge from Kits admin API', async () => {
  const calls = [];
  const markdown = await fetchPublishedPlaybookKnowledge({
    config: {
      kitsAdminBaseUrl: 'https://admin.example.test',
      kitsInternalApiToken: 'secret'
    },
    fallbackKnowledgeBase: 'Fallback guide',
    now: () => Date.parse('2026-07-01T08:00:00Z'),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({
        ok: true,
        source: 'kits_republic_playbooks',
        version: '2026-07-01T07:55:00Z',
        knowledge_markdown: '## Returns\n\nReturn SOP.',
        playbooks: [{ id: 'returns', title: 'Returns' }]
      });
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://admin.example.test/internal/kits-republic/playbooks/knowledge');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret');
  assert.match(markdown, /Knowledge source: Kits Republic Playbooks/);
  assert.match(markdown, /Version: 2026-07-01T07:55:00Z/);
  assert.match(markdown, /Published playbooks: 1/);
  assert.match(markdown, /## Returns/);
  assert.doesNotMatch(markdown, /Fallback guide/);
});

test('uses local fallback when Kits admin API is not configured', async () => {
  const markdown = await fetchPublishedPlaybookKnowledge({
    config: {},
    fallbackKnowledgeBase: 'Local guide'
  });

  assert.match(markdown, /Knowledge source: local fallback markdown/);
  assert.match(markdown, /admin_api_not_configured/);
  assert.match(markdown, /Local guide/);
});

test('uses local fallback when Kits admin API fails or returns empty knowledge', async () => {
  const failed = await fetchPublishedPlaybookKnowledge({
    config: {
      kitsAdminBaseUrl: 'https://admin.example.test',
      kitsInternalApiToken: 'secret'
    },
    fallbackKnowledgeBase: 'Local guide',
    fetchImpl: async () => jsonResponse({ ok: false, error: 'nope' }, 500)
  });

  assert.match(failed, /local fallback markdown/);
  assert.match(failed, /admin_api_failed: nope/);
  assert.match(failed, /Local guide/);

  const empty = await fetchPublishedPlaybookKnowledge({
    config: {
      kitsAdminBaseUrl: 'https://admin.example.test',
      kitsInternalApiToken: 'secret'
    },
    fallbackKnowledgeBase: 'Local guide',
    fetchImpl: async () => jsonResponse({ ok: true, knowledge_markdown: '' })
  });

  assert.match(empty, /admin_api_returned_empty_knowledge/);
  assert.match(empty, /Local guide/);
});

test('caches playbook knowledge for a short window', async () => {
  let currentTime = 1000;
  let calls = 0;
  const getKnowledge = createPlaybookKnowledgeProvider({
    config: {
      kitsAdminBaseUrl: 'https://admin.example.test',
      kitsInternalApiToken: 'secret',
      playbookKnowledgeCacheMs: 100
    },
    fallbackKnowledgeBase: 'Local guide',
    now: () => currentTime,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({
        ok: true,
        version: `v${calls}`,
        knowledge_markdown: `## Playbook ${calls}`,
        playbooks: []
      });
    }
  });

  assert.match(await getKnowledge(), /Playbook 1/);
  currentTime = 1050;
  assert.match(await getKnowledge(), /Playbook 1/);
  currentTime = 1150;
  assert.match(await getKnowledge(), /Playbook 2/);
  assert.equal(calls, 2);
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    }
  };
}
