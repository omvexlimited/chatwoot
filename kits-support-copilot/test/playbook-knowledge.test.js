import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createPlaybookKnowledgeProvider,
  draftForKnowledgeMode,
  fetchPublishedPlaybookKnowledge
} from '../src/playbook-knowledge.js';

test('loads complete published playbook knowledge from Kits admin API', async () => {
  const calls = [];
  const knowledge = await fetchPublishedPlaybookKnowledge({
    config: {
      kitsAdminBaseUrl: 'https://admin.example.test',
      kitsInternalApiToken: 'secret'
    },
    requiredPlaybookSlugs: ['returns'],
    requiredCaseTypes: ['return_request'],
    now: () => Date.parse('2026-07-01T08:00:00Z'),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse(publishedResponse('v1'));
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://admin.example.test/internal/kits-republic/playbooks/knowledge');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret');
  assert.equal(knowledge.mode, 'published');
  assert.equal(knowledge.source, 'kits_republic_playbooks');
  assert.equal(knowledge.version, 'v1');
  assert.equal(knowledge.coverage.complete, true);
  assert.deepEqual(knowledge.warnings, []);
  assert.match(knowledge.markdown, /Knowledge source: Kits Republic Playbooks/);
  assert.match(knowledge.markdown, /Return SOP/);
});

test('uses facts_only when no published knowledge has ever loaded', async () => {
  const notConfigured = await fetchPublishedPlaybookKnowledge({
    config: {},
    requiredPlaybookSlugs: ['returns'],
    requiredCaseTypes: ['return_request']
  });
  assert.equal(notConfigured.mode, 'facts_only');
  assert.equal(notConfigured.source, 'none');
  assert.match(notConfigured.markdown, /No commercial policy is available/);
  assert.doesNotMatch(notConfigured.markdown, /Local guide|fallback markdown/i);

  const failed = await fetchPublishedPlaybookKnowledge({
    config: {
      kitsAdminBaseUrl: 'https://admin.example.test',
      kitsInternalApiToken: 'secret'
    },
    requiredPlaybookSlugs: ['returns'],
    requiredCaseTypes: ['return_request'],
    fetchImpl: async () => jsonResponse({ ok: false, error: 'nope' }, 500)
  });
  assert.equal(failed.mode, 'facts_only');
  assert.match(failed.warnings[0], /admin_api_failed: nope/);

  const empty = await fetchPublishedPlaybookKnowledge({
    config: {
      kitsAdminBaseUrl: 'https://admin.example.test',
      kitsInternalApiToken: 'secret'
    },
    requiredPlaybookSlugs: ['returns'],
    requiredCaseTypes: ['return_request'],
    fetchImpl: async () => jsonResponse({ ok: true, knowledge_markdown: '' })
  });
  assert.equal(empty.mode, 'facts_only');
  assert.match(empty.warnings[0], /admin_api_returned_empty_knowledge/);
});

test('rejects published knowledge with missing playbooks or compiled content', async () => {
  const missingPlaybook = await fetchPublishedPlaybookKnowledge({
    config: configuredAdmin(),
    requiredPlaybookSlugs: ['returns', 'duplicate-conversation'],
    requiredCaseTypes: ['return_request'],
    fetchImpl: async () => jsonResponse(publishedResponse('missing'))
  });
  assert.equal(missingPlaybook.mode, 'facts_only');
  assert.deepEqual(missingPlaybook.coverage.missing_slugs, ['duplicate-conversation']);

  const missingContent = await fetchPublishedPlaybookKnowledge({
    config: configuredAdmin(),
    requiredPlaybookSlugs: ['returns'],
    requiredCaseTypes: ['return_request'],
    fetchImpl: async () => jsonResponse({
      ...publishedResponse('missing-content'),
      playbooks: [{ slug: 'returns', title: 'Returns', case_types: ['return_request'], knowledge_markdown: '' }]
    })
  });
  assert.equal(missingContent.mode, 'facts_only');
  assert.deepEqual(missingContent.coverage.missing_content_slugs, ['returns']);
});

test('caches published knowledge and uses stale_published after a failed refresh', async () => {
  let currentTime = 1000;
  let calls = 0;
  const log = [];
  const getKnowledge = createPlaybookKnowledgeProvider({
    config: {
      ...configuredAdmin(),
      playbookKnowledgeCacheMs: 100
    },
    requiredPlaybookSlugs: ['returns'],
    requiredCaseTypes: ['return_request'],
    logger: {
      info: message => log.push(message),
      warn: message => log.push(message)
    },
    now: () => currentTime,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return jsonResponse(publishedResponse('fresh'));
      throw new Error('network down');
    }
  });

  const fresh = await getKnowledge();
  assert.equal(fresh.mode, 'published');
  currentTime = 1050;
  assert.equal((await getKnowledge()).mode, 'published');
  assert.equal(calls, 1);

  currentTime = 1200;
  const stale = await getKnowledge();
  assert.equal(stale.mode, 'stale_published');
  assert.match(stale.markdown, /Return SOP/);
  assert.match(stale.warnings.join('\n'), /network down/);
  assert.match(stale.warnings.join('\n'), /last successfully loaded published Playbook knowledge/);
  assert.equal(calls, 2);
  assert.equal(log.length, 2);
  assert.match(log[0], /mode=published.*coverage=complete/);
  assert.match(log[1], /mode=stale_published.*network down/);
});

test('forces the verified neutral draft when knowledge is facts_only', () => {
  assert.equal(draftForKnowledgeMode({
    knowledgeMode: 'facts_only',
    generatedDraft: 'Returns are free for 60 days and include a coupon.',
    factsOnlyDraft: 'Order #1001 is currently unfulfilled.'
  }), 'Order #1001 is currently unfulfilled.');

  assert.equal(draftForKnowledgeMode({
    knowledgeMode: 'stale_published',
    generatedDraft: 'Draft backed by the cached published Playbook.',
    factsOnlyDraft: 'Neutral fallback.'
  }), 'Draft backed by the cached published Playbook.');
});

function configuredAdmin() {
  return {
    kitsAdminBaseUrl: 'https://admin.example.test',
    kitsInternalApiToken: 'secret'
  };
}

function publishedResponse(version) {
  return {
    ok: true,
    source: 'kits_republic_playbooks',
    version,
    knowledge_markdown: '## Returns\n\nReturn SOP.',
    playbooks: [
      {
        slug: 'returns',
        title: 'Returns',
        case_types: ['return_request'],
        tags: ['returns'],
        knowledge_markdown: '## Returns\n\nReturn SOP.'
      }
    ]
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    }
  };
}
