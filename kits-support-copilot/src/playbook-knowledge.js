import { REQUIRED_PLAYBOOK_SLUGS, validatePlaybookCoverage } from './playbook-coverage.js';
import { SUPPORT_CASE_TYPES } from './support-case.js';

const DEFAULT_CACHE_MS = 300_000;
const DEFAULT_TIMEOUT_MS = 5_000;

export function createPlaybookKnowledgeProvider({
  config = {},
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  requiredPlaybookSlugs = REQUIRED_PLAYBOOK_SLUGS,
  requiredCaseTypes = SUPPORT_CASE_TYPES,
  logger = console
} = {}) {
  let cache = null;
  let reportedState = '';
  const cacheMs = Number(config.playbookKnowledgeCacheMs || DEFAULT_CACHE_MS);

  return async function getPlaybookKnowledge() {
    if (cache && now() - cache.loadedAt < cacheMs) return cache;

    const result = await fetchPublishedPlaybookKnowledge({
      config,
      fetchImpl,
      now,
      staleKnowledge: cache,
      requiredPlaybookSlugs,
      requiredCaseTypes
    });
    cache = result;
    const state = `${result.mode}:${result.version}:${result.warnings?.[0] || ''}`;
    if (state !== reportedState) {
      const message = [
        `KR Copilot knowledge mode=${result.mode}`,
        `version=${result.version}`,
        `playbooks=${result.playbook_count}`,
        `coverage=${result.coverage?.complete === true ? 'complete' : 'incomplete'}`
      ].join(' ');
      if (result.mode === 'published') logger?.info?.(message);
      else logger?.warn?.(`${message} warning=${result.warnings?.[0] || 'unknown'}`);
      reportedState = state;
    }
    return result;
  };
}

export async function fetchPublishedPlaybookKnowledge({
  config = {},
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  staleKnowledge = null,
  requiredPlaybookSlugs = REQUIRED_PLAYBOOK_SLUGS,
  requiredCaseTypes = SUPPORT_CASE_TYPES
} = {}) {
  if (!config.kitsAdminBaseUrl || !config.kitsInternalApiToken || typeof fetchImpl !== 'function') {
    return unavailableKnowledge({ reason: 'admin_api_not_configured', now, staleKnowledge, requiredPlaybookSlugs, requiredCaseTypes });
  }

  try {
    const url = new URL('/internal/kits-republic/playbooks/knowledge', config.kitsAdminBaseUrl);
    const timeoutMs = Number(config.playbookKnowledgeTimeoutMs || DEFAULT_TIMEOUT_MS);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${config.kitsInternalApiToken}`
        },
        signal: controller?.signal
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      const message = data.error || `HTTP ${response.status}`;
      return unavailableKnowledge({ reason: `admin_api_failed: ${message}`, now, staleKnowledge, requiredPlaybookSlugs, requiredCaseTypes });
    }

    const knowledgeMarkdown = String(data.knowledge_markdown || '').trim();
    if (!knowledgeMarkdown) {
      return unavailableKnowledge({ reason: 'admin_api_returned_empty_knowledge', now, staleKnowledge, requiredPlaybookSlugs, requiredCaseTypes });
    }

    const playbooks = Array.isArray(data.playbooks) ? data.playbooks : [];
    const coverage = validatePlaybookCoverage(playbooks, requiredPlaybookSlugs, requiredCaseTypes);
    if (!coverage.complete) {
      const missingCoverage = [
        ...coverage.missing_slugs,
        ...coverage.missing_content_slugs.map(slug => `${slug}:content`),
        ...coverage.missing_case_types.map(caseType => `${caseType}:case_type`)
      ];
      return unavailableKnowledge({
        reason: `playbook_coverage_incomplete: ${missingCoverage.join(', ')}`,
        now,
        staleKnowledge,
        coverage,
        requiredPlaybookSlugs,
        requiredCaseTypes
      });
    }
    const markdown = [
      '# Knowledge source: Kits Republic Playbooks',
      '',
      `- Source: ${data.source || 'kits_republic_playbooks'}`,
      `- Version: ${data.version || data.updated_at || 'unknown'}`,
      `- Loaded at: ${new Date(now()).toISOString()}`,
      `- Published playbooks: ${playbooks.length}`,
      '',
      '## Published Playbook Index',
      '',
      ...formatPlaybookIndex(playbooks),
      '',
      knowledgeMarkdown
    ].join('\n');
    return {
      markdown,
      knowledge_markdown: knowledgeMarkdown,
      source: data.source || 'kits_republic_playbooks',
      mode: 'published',
      version: String(data.version || data.updated_at || 'unknown'),
      updated_at: data.updated_at || data.version || null,
      loadedAt: now(),
      loaded_at: new Date(now()).toISOString(),
      playbook_count: playbooks.length,
      playbooks,
      coverage,
      warnings: []
    };
  } catch (error) {
    return unavailableKnowledge({
      reason: `admin_api_exception: ${error.message}`,
      now,
      staleKnowledge,
      requiredPlaybookSlugs,
      requiredCaseTypes
    });
  }
}

export function draftForKnowledgeMode({ knowledgeMode, generatedDraft = '', factsOnlyDraft = '' } = {}) {
  return knowledgeMode === 'facts_only' ? factsOnlyDraft : generatedDraft;
}

function unavailableKnowledge({
  reason = 'unknown',
  now = () => Date.now(),
  staleKnowledge = null,
  coverage = null,
  requiredPlaybookSlugs = REQUIRED_PLAYBOOK_SLUGS,
  requiredCaseTypes = SUPPORT_CASE_TYPES
} = {}) {
  const warning = `Published Playbook knowledge unavailable: ${reason}`;
  if (['published', 'stale_published'].includes(staleKnowledge?.mode) && staleKnowledge?.markdown) {
    return {
      ...staleKnowledge,
      mode: 'stale_published',
      loadedAt: now(),
      loaded_at: new Date(now()).toISOString(),
      warnings: uniqueStrings([...(staleKnowledge.warnings || []), warning, 'Using the last successfully loaded published Playbook knowledge.'])
    };
  }

  const markdown = [
    '# Published Playbook knowledge unavailable',
    '',
    '- Mode: facts_only',
    `- Reason: ${reason}`,
    `- Loaded at: ${new Date(now()).toISOString()}`,
    '',
    'No commercial policy is available for this request.',
    'Use only verified facts from the conversation, Shopify, tracking, attachments, and agent-confirmed completed actions.',
    'Do not state causes, policy timeframes, return conditions, compensation, coupon codes, or other commercial rules.'
  ].join('\n').trim();
  return {
    markdown,
    knowledge_markdown: '',
    source: 'none',
    mode: 'facts_only',
    version: 'unavailable',
    updated_at: null,
    loadedAt: now(),
    loaded_at: new Date(now()).toISOString(),
    playbook_count: 0,
    playbooks: [],
    coverage: coverage || validatePlaybookCoverage([], requiredPlaybookSlugs, requiredCaseTypes),
    warnings: [warning]
  };
}

function formatPlaybookIndex(playbooks = []) {
  const rows = playbooks.map(playbook => {
    const caseTypes = normalizeList(playbook.case_types).join(', ') || 'none';
    const tags = normalizeList(playbook.tags).join(', ') || 'none';
    const title = String(playbook.title || playbook.slug || playbook.id || 'Untitled Playbook').trim();
    const id = String(playbook.slug || playbook.id || '').trim();
    const updated = playbook.updated_at ? `; updated: ${playbook.updated_at}` : '';
    return `- ${title}${id ? ` (${id})` : ''}; case_types: ${caseTypes}; tags: ${tags}${updated}`;
  });
  return rows.length ? rows : ['- No published playbook metadata returned.'];
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item || '').trim()).filter(Boolean);
}

function uniqueStrings(values = []) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}
