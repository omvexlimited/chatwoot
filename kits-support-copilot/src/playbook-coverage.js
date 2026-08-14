import { SUPPORT_CASE_TYPES } from './support-case.js';

export const REQUIRED_PLAYBOOK_SLUGS = [
  'address-change',
  'ai-support-operating-rules',
  'apple-pay-missing-confirmation',
  'compensation-policy',
  'customs-local-handoff',
  'delivered-not-received',
  'delivery-delays',
  'duplicate-conversation',
  'escalate-to-marc',
  'front-personalization',
  'invoice-request',
  'kids-football-shirts-availability',
  'multiple-orders-found',
  'name-number-change',
  'newly-purchased-order',
  'no-order-found',
  'official-delivery-timeframes',
  'official-links',
  'out-of-stock',
  'payment-dispute-chargeback-risk',
  'positive-feedback-trustpilot',
  'pre-reply-checklist',
  'pre-shipment-cancellation',
  'pre-shipment-size-change',
  'printing-error',
  'product-mismatch-different-advertised',
  'quality-defect',
  'quality-reputation-escalation',
  'refund-authority-matrix',
  'replacements',
  'response-language',
  'returns-and-refunds-general',
  'shipping-tracking-general',
  'size-fit-complaints',
  'size-return-exchange',
  'supplier-issue-open',
  'supplier-message-format',
  'support-tone',
  'tracking-not-recognized',
  'wrong-item',
  'wrong-size-received'
];

const SHARED_PLAYBOOK_SLUGS = new Set([
  'ai-support-operating-rules',
  'official-links',
  'pre-reply-checklist',
  'response-language',
  'support-tone'
]);

const SELECTION_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'customer', 'customers',
  'for', 'from', 'general', 'in', 'is', 'kits', 'of', 'on', 'or', 'playbook',
  'policy', 'republic', 'support', 'that', 'the', 'this', 'to', 'with'
]);

export function validatePlaybookCoverage(
  playbooks = [],
  requiredSlugs = REQUIRED_PLAYBOOK_SLUGS,
  requiredCaseTypes = SUPPORT_CASE_TYPES
) {
  const publishedSlugs = new Set(playbooks.map(playbook => playbookSlug(playbook)).filter(Boolean));
  const missingSlugs = requiredSlugs.filter(slug => !publishedSlugs.has(slug));
  const missingContentSlugs = playbooks
    .filter(playbook => requiredSlugs.includes(playbookSlug(playbook)))
    .filter(playbook => !String(playbook.knowledge_markdown || '').trim())
    .map(playbook => playbookSlug(playbook));
  const missingCaseTypes = requiredCaseTypes.filter(caseType => {
    return !playbooks.some(playbook => metadataValues(playbook).includes(caseType));
  });
  return {
    complete: missingSlugs.length === 0 && missingContentSlugs.length === 0 && missingCaseTypes.length === 0,
    required_count: requiredSlugs.length,
    published_count: publishedSlugs.size,
    missing_slugs: missingSlugs,
    missing_content_slugs: missingContentSlugs,
    missing_case_types: missingCaseTypes
  };
}

export function selectPlaybooksForCase(playbooks = [], caseType = '', contextText = '') {
  const normalizedCaseType = String(caseType || '').trim().toLowerCase();
  const normalizedContext = normalizeSearchText(contextText);
  return playbooks.filter(playbook => {
    const slug = playbookSlug(playbook);
    if (SHARED_PLAYBOOK_SLUGS.has(slug)) return true;
    if (normalizedCaseType && metadataValues(playbook).includes(normalizedCaseType)) return true;
    return normalizedContext && playbookMatchesContext(playbook, normalizedContext);
  }).map(playbook => ({
    slug: playbookSlug(playbook),
    title: String(playbook.title || '').trim(),
    summary: String(playbook.summary || '').trim(),
    category: String(playbook.category || '').trim(),
    case_types: normalizeList(playbook.case_types),
    tags: normalizeList(playbook.tags),
    knowledge_markdown: String(playbook.knowledge_markdown || '').trim()
  }));
}

export function buildSelectedKnowledge({ knowledge = {}, selectedPlaybooks = [] } = {}) {
  if (knowledge.mode === 'facts_only') return String(knowledge.markdown || '').trim();

  const selectedMarkdown = selectedPlaybooks
    .map(playbook => String(playbook.knowledge_markdown || '').trim())
    .filter(Boolean);
  return [
    '# Selected published Playbooks',
    '',
    `- Source: ${knowledge.source || 'kits_republic_playbooks'}`,
    `- Version: ${knowledge.version || 'unknown'}`,
    `- Mode: ${knowledge.mode || 'published'}`,
    '',
    ...(selectedMarkdown.length
      ? selectedMarkdown.join('\n\n---\n\n').split('\n')
      : ['No published Playbook matches this case type. Do not infer a commercial policy.'])
  ].join('\n').trim();
}

function playbookSlug(playbook = {}) {
  return String(playbook.slug || playbook.id || '').trim();
}

function metadataValues(playbook = {}) {
  return [...normalizeList(playbook.case_types), ...normalizeList(playbook.tags)]
    .map(value => value.toLowerCase());
}

function playbookMatchesContext(playbook, normalizedContext) {
  const shortMetadata = [
    playbook.slug,
    playbook.title,
    ...normalizeList(playbook.case_types),
    ...normalizeList(playbook.tags)
  ];
  if (shortMetadata.some(value => phraseMatchesContext(value, normalizedContext, 2))) return true;
  return phraseMatchesContext(playbook.summary, normalizedContext, 3);
}

function phraseMatchesContext(value, normalizedContext, maximumRequiredMatches) {
  const { text: phrase, tokens: phraseTokens } = normalizeSearchText(value);
  if (!phrase) return false;
  if (normalizedContext.text.includes(phrase)) return true;

  const tokens = [...new Set(phraseTokens.filter(token => {
    return token.length >= 3 && !SELECTION_STOP_WORDS.has(token);
  }))];
  if (!tokens.length) return false;

  const matches = tokens.filter(token => {
    return normalizedContext.tokens.some(contextToken => tokenMatches(token, contextToken));
  }).length;
  const requiredMatches = tokens.length === 1 ? 1 : Math.min(maximumRequiredMatches, tokens.length);
  return matches >= requiredMatches;
}

function normalizeSearchText(value = '') {
  const text = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { text, tokens: text ? text.split(' ') : [] };
}

function tokenMatches(left, right) {
  if (left === right) return true;
  return left.length >= 5 && right.length >= 5 && left.slice(0, 5) === right.slice(0, 5);
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item || '').trim()).filter(Boolean);
}
