const ISSUE_LOOKUP_TIMEOUT_MS = 10000;

export async function getIssueContext({ config, order } = {}) {
  const orderRef = normalizeOrderRef(order?.name);
  if (!orderRef) {
    return issueContext({
      available: false,
      reason: 'no_order',
      orderRef
    });
  }

  if (!config?.kitsAdminBaseUrl || !config?.kitsInternalApiToken) {
    return issueContext({
      available: false,
      reason: 'not_configured',
      orderRef,
      warnings: ['Kits internal issue lookup is not configured.']
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ISSUE_LOOKUP_TIMEOUT_MS);
  try {
    const url = new URL('/internal/kits-republic/issues', config.kitsAdminBaseUrl);
    url.searchParams.set('order_ref', orderRef);
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.kitsInternalApiToken}`
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      const error = data.error || `HTTP ${response.status}`;
      return issueContext({
        available: false,
        reason: 'request_failed',
        orderRef,
        warnings: [`Issue lookup failed: ${error}`]
      });
    }

    const issues = normalizeIssues(data.issues);
    return issueContext({
      available: true,
      reason: issues.length ? 'open_issues_found' : 'no_open_issues',
      orderRef,
      issues,
      total: Number.isFinite(Number(data.total)) ? Number(data.total) : issues.length,
      warnings: normalizeWarnings(data.warnings)
    });
  } finally {
    clearTimeout(timeout);
  }
}

function issueContext({
  available,
  reason,
  orderRef = null,
  issues = [],
  total = 0,
  warnings = []
}) {
  return {
    available: Boolean(available),
    source: available ? 'kits_internal_api' : null,
    reason,
    order_ref: orderRef || null,
    total: Number(total) || issues.length,
    issues,
    warnings: normalizeWarnings(warnings)
  };
}

function normalizeIssues(issues = []) {
  if (!Array.isArray(issues)) return [];
  return issues.map(issue => ({
    issue_id: normalizeIssueId(issue.issue_id || issue.id),
    order_ref: normalizeOrderRef(issue.order_ref || issue.order_number),
    provider: String(issue.provider || issue.provider_label || issue.provider_name || '').trim(),
    issue_type: String(issue.issue_type || 'other').trim(),
    status: String(issue.status || '').trim(),
    message_preview: String(issue.message_preview || issue.message || '').trim().slice(0, 240),
    affected_items: normalizeAffectedItems(issue.affected_items || issue.affected_line_items || issue.line_items),
    created_at: issue.created_at || null,
    updated_at: issue.updated_at || null,
    url: safeHttpUrl(issue.url)
  })).filter(issue => issue.issue_id);
}

function normalizeAffectedItems(items = []) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 10).map(item => ({
    id: String(item.id || item.line_item_id || item.shopify_line_item_id || '').trim() || null,
    name: String(item.name || item.title || item.product_title || '').trim(),
    sku: String(item.sku || '').trim(),
    variant_title: String(item.variant_title || item.variant || item.size || '').trim(),
    quantity: normalizeNumber(item.quantity)
  })).filter(item => item.id || item.name || item.sku || item.variant_title);
}

function normalizeIssueId(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeOrderRef(value = '') {
  const clean = String(value || '').trim().replace(/^#?/, '');
  return clean ? `#${clean}` : '';
}

function normalizeWarnings(warnings = []) {
  return Array.isArray(warnings) ? warnings.map(String).filter(Boolean) : [];
}

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeHttpUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch {
    return null;
  }
  return null;
}
