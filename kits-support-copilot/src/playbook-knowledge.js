const DEFAULT_CACHE_MS = 300_000;
const DEFAULT_TIMEOUT_MS = 5_000;

export function createPlaybookKnowledgeProvider({
  config = {},
  fallbackKnowledgeBase = '',
  fetchImpl = globalThis.fetch,
  now = () => Date.now()
} = {}) {
  let cache = null;
  const cacheMs = Number(config.playbookKnowledgeCacheMs || DEFAULT_CACHE_MS);

  return async function getPlaybookKnowledge() {
    if (cache && now() - cache.loadedAt < cacheMs) return cache;

    const result = await fetchPublishedPlaybookKnowledge({
      config,
      fallbackKnowledgeBase,
      fetchImpl,
      now,
      staleKnowledge: cache
    });
    cache = result;
    return result;
  };
}

export async function fetchPublishedPlaybookKnowledge({
  config = {},
  fallbackKnowledgeBase = '',
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  staleKnowledge = null
} = {}) {
  if (!config.kitsAdminBaseUrl || !config.kitsInternalApiToken || typeof fetchImpl !== 'function') {
    return fallbackKnowledge({ fallbackKnowledgeBase, reason: 'admin_api_not_configured', now });
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
      return fallbackKnowledge({ fallbackKnowledgeBase, reason: `admin_api_failed: ${message}`, now, staleKnowledge });
    }

    const knowledgeMarkdown = String(data.knowledge_markdown || '').trim();
    if (!knowledgeMarkdown) {
      return fallbackKnowledge({ fallbackKnowledgeBase, reason: 'admin_api_returned_empty_knowledge', now, staleKnowledge });
    }

    const playbooks = Array.isArray(data.playbooks) ? data.playbooks : [];
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
      source: data.source || 'kits_republic_playbooks',
      version: String(data.version || data.updated_at || 'unknown'),
      updated_at: data.updated_at || data.version || null,
      loadedAt: now(),
      loaded_at: new Date(now()).toISOString(),
      playbook_count: playbooks.length,
      warnings: []
    };
  } catch (error) {
    return fallbackKnowledge({ fallbackKnowledgeBase, reason: `admin_api_exception: ${error.message}`, now, staleKnowledge });
  }
}

function fallbackKnowledge({
  fallbackKnowledgeBase = '',
  reason = 'unknown',
  now = () => Date.now(),
  staleKnowledge = null
} = {}) {
  const warning = `Playbook knowledge fallback used: ${reason}`;
  if (staleKnowledge?.markdown) {
    return {
      ...staleKnowledge,
      loadedAt: now(),
      loaded_at: new Date(now()).toISOString(),
      warnings: uniqueStrings([...(staleKnowledge.warnings || []), warning, 'Using the last successfully loaded Playbooks knowledge.'])
    };
  }

  const markdown = [
    '# Knowledge source: local fallback markdown',
    '',
    `- Reason: ${reason}`,
    `- Loaded at: ${new Date(now()).toISOString()}`,
    '',
    String(fallbackKnowledgeBase || '').trim()
  ].join('\n').trim();
  return {
    markdown,
    source: 'local_fallback_markdown',
    version: 'local',
    updated_at: null,
    loadedAt: now(),
    loaded_at: new Date(now()).toISOString(),
    playbook_count: 0,
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
