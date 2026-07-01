const DEFAULT_CACHE_MS = 60_000;

export function createPlaybookKnowledgeProvider({
  config = {},
  fallbackKnowledgeBase = '',
  fetchImpl = globalThis.fetch,
  now = () => Date.now()
} = {}) {
  let cache = null;
  const cacheMs = Number(config.playbookKnowledgeCacheMs || DEFAULT_CACHE_MS);

  return async function getPlaybookKnowledge() {
    if (cache && now() - cache.loadedAt < cacheMs) return cache.markdown;

    const markdown = await fetchPublishedPlaybookKnowledge({
      config,
      fallbackKnowledgeBase,
      fetchImpl,
      now
    });
    cache = { loadedAt: now(), markdown };
    return markdown;
  };
}

export async function fetchPublishedPlaybookKnowledge({
  config = {},
  fallbackKnowledgeBase = '',
  fetchImpl = globalThis.fetch,
  now = () => Date.now()
} = {}) {
  if (!config.kitsAdminBaseUrl || !config.kitsInternalApiToken || typeof fetchImpl !== 'function') {
    return fallbackKnowledge({ fallbackKnowledgeBase, reason: 'admin_api_not_configured', now });
  }

  try {
    const url = new URL('/internal/kits-republic/playbooks/knowledge', config.kitsAdminBaseUrl);
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${config.kitsInternalApiToken}`
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      const message = data.error || `HTTP ${response.status}`;
      return fallbackKnowledge({ fallbackKnowledgeBase, reason: `admin_api_failed: ${message}`, now });
    }

    const knowledgeMarkdown = String(data.knowledge_markdown || '').trim();
    if (!knowledgeMarkdown) {
      return fallbackKnowledge({ fallbackKnowledgeBase, reason: 'admin_api_returned_empty_knowledge', now });
    }

    const playbooks = Array.isArray(data.playbooks) ? data.playbooks : [];
    return [
      '# Knowledge source: Kits Republic Playbooks',
      '',
      `- Source: ${data.source || 'kits_republic_playbooks'}`,
      `- Version: ${data.version || data.updated_at || 'unknown'}`,
      `- Loaded at: ${new Date(now()).toISOString()}`,
      `- Published playbooks: ${playbooks.length}`,
      '',
      knowledgeMarkdown
    ].join('\n');
  } catch (error) {
    return fallbackKnowledge({ fallbackKnowledgeBase, reason: `admin_api_exception: ${error.message}`, now });
  }
}

function fallbackKnowledge({ fallbackKnowledgeBase = '', reason = 'unknown', now = () => Date.now() } = {}) {
  return [
    '# Knowledge source: local fallback markdown',
    '',
    `- Reason: ${reason}`,
    `- Loaded at: ${new Date(now()).toISOString()}`,
    '',
    String(fallbackKnowledgeBase || '').trim()
  ].join('\n').trim();
}
