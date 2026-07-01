export function loadConfig(env = process.env) {
  const chatwootBaseUrl = trimTrailingSlash(envValue(env, ['CHATWOOT_BASE_URL']));
  const openaiBaseUrl = trimTrailingSlash(envValue(env, ['OPENAI_BASE_URL'], 'https://api.openai.com'));
  const kitsRepublicDatabaseUrl = envValue(env, ['KITS_REPUBLIC_DATABASE_URL']);
  const shopifyStoreDomain = normalizeShopifyDomain(envValue(env, [
    'SHOPIFY_STORE_DOMAIN',
    'SHOPIFY_SHOP_DOMAIN',
    'SHOPIFY_KITS_REPUBLIC_SHOP_NAME',
    'SHOPIFY_SHOP_NAME'
  ]));

  return {
    port: Number(envValue(env, ['PORT'], '3000')),
    nodeEnv: envValue(env, ['NODE_ENV'], 'development'),
    copilotApiToken: envValue(env, ['COPILOT_API_TOKEN']),
    openaiApiKey: envValue(env, ['OPENAI_API_KEY']),
    openaiModel: envValue(env, ['OPENAI_MODEL'], 'gpt-5.5'),
    openaiBaseUrl,
    kitsRepublicDatabaseUrl,
    copilotDatabaseUrl: kitsRepublicDatabaseUrl,
    copilotDatabaseSsl: envValue(env, ['KITS_REPUBLIC_DATABASE_SSL'], 'true').toLowerCase() !== 'false',
    kitsAdminBaseUrl: trimTrailingSlash(envValue(env, ['KITS_ADMIN_BASE_URL'], 'https://web-production-c1320.up.railway.app')),
    shopifyStoreDomain,
    shopifyAdminAccessToken: envValue(env, ['SHOPIFY_ADMIN_ACCESS_TOKEN', 'SHOPIFY_ADMIN_API_ACCESS_TOKEN']),
    shopifyClientId: envValue(env, ['SHOPIFY_CLIENT_ID', 'SHOPIFY_KITS_REPUBLIC_CLIENT_ID']),
    shopifyClientSecret: envValue(env, ['SHOPIFY_CLIENT_SECRET', 'SHOPIFY_KITS_REPUBLIC_CLIENT_SECRET']),
    shopifyAuthModePreference: envValue(env, ['SHOPIFY_AUTH_MODE']).toLowerCase(),
    shopifyApiVersion: envValue(env, ['SHOPIFY_API_VERSION'], '2026-04'),
    krAnalyticsDatabaseUrl: envValue(env, ['KR_ANALYTICS_DATABASE_URL']) || kitsRepublicDatabaseUrl || envValue(env, ['KR_PROVIDER_DATABASE_URL']),
    krAnalyticsStoreId: envValue(env, ['KR_ANALYTICS_STORE_ID', 'KR_PROVIDER_STORE_ID'], 'kits_republic'),
    krAnalyticsDatabaseSsl: envValue(env, ['KR_ANALYTICS_DATABASE_SSL', 'KITS_REPUBLIC_DATABASE_SSL', 'KR_PROVIDER_DATABASE_SSL'], 'true').toLowerCase() !== 'false',
    krAnalyticsMinFulfilled: Number(envValue(env, ['KR_ANALYTICS_MIN_FULFILLED'], '20')),
    krAnalyticsMinDelivered: Number(envValue(env, ['KR_ANALYTICS_MIN_DELIVERED'], '10')),
    krProviderDatabaseUrl: kitsRepublicDatabaseUrl || envValue(env, ['KR_PROVIDER_DATABASE_URL']),
    krProviderStoreId: envValue(env, ['KR_PROVIDER_STORE_ID'], 'kits_republic'),
    krProviderDatabaseSsl: envValue(env, ['KITS_REPUBLIC_DATABASE_SSL', 'KR_PROVIDER_DATABASE_SSL'], 'true').toLowerCase() !== 'false',
    kitsInternalApiToken: envValue(env, ['KITS_INTERNAL_API_TOKEN']),
    playbookKnowledgeCacheMs: Number(envValue(env, ['KR_PLAYBOOK_KNOWLEDGE_CACHE_MS'], '60000')),
    chatwootBaseUrl,
    chatwootAccountId: envValue(env, ['CHATWOOT_ACCOUNT_ID']),
    chatwootApiToken: envValue(env, ['CHATWOOT_API_TOKEN']),
    chatwootWebhookSecret: envValue(env, ['CHATWOOT_WEBHOOK_SECRET'])
  };
}

export function getConfigStatus(config) {
  return {
    openai: Boolean(config.openaiApiKey),
    shopify: Boolean(config.shopifyStoreDomain && (config.shopifyAdminAccessToken || hasShopifyClientCredentials(config))),
    shopify_auth_mode: shopifyAuthMode(config),
    delivery_analytics: Boolean(config.krAnalyticsDatabaseUrl),
    provider_lookup: Boolean(config.krProviderDatabaseUrl),
    kits_internal_api: Boolean(config.kitsAdminBaseUrl && config.kitsInternalApiToken),
    memory: Boolean(config.copilotDatabaseUrl),
    chatwoot: Boolean(config.chatwootBaseUrl && config.chatwootApiToken),
    chatwoot_webhook: Boolean(config.chatwootWebhookSecret),
    api_token_required: Boolean(config.copilotApiToken)
  };
}

export function hasShopifyClientCredentials(config) {
  return Boolean(config.shopifyClientId && config.shopifyClientSecret);
}

export function shopifyAuthMode(config) {
  if (config.shopifyAuthModePreference === 'admin_access_token' && config.shopifyAdminAccessToken) return 'admin_access_token';
  if (config.shopifyAuthModePreference === 'client_credentials' && hasShopifyClientCredentials(config)) return 'client_credentials';
  if (hasShopifyClientCredentials(config)) return 'client_credentials';
  if (config.shopifyAdminAccessToken) return 'admin_access_token';
  return null;
}

function envValue(env, names, fallback = '') {
  for (const name of names) {
    const raw = env[name];
    if (raw === undefined || raw === null) continue;
    const value = stripOptionalQuotes(String(raw).trim());
    if (value) return value;
  }
  return fallback;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function normalizeShopifyDomain(value) {
  const trimmed = value.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.endsWith('.myshopify.com') ? trimmed : `${trimmed}.myshopify.com`;
}

function stripOptionalQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).trim();
  }
  return value;
}
