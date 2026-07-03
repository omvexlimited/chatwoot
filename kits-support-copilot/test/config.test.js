import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getConfigStatus, loadConfig } from '../src/config.js';

test('supports Shopify Dev Dashboard client credentials aliases', () => {
  const config = loadConfig({
    SHOPIFY_KITS_REPUBLIC_SHOP_NAME: '"kits-republic"',
    SHOPIFY_KITS_REPUBLIC_CLIENT_ID: 'client-id',
    SHOPIFY_KITS_REPUBLIC_CLIENT_SECRET: 'client-secret'
  });

  assert.equal(config.shopifyStoreDomain, 'kits-republic.myshopify.com');
  assert.equal(config.shopifyClientId, 'client-id');
  assert.equal(config.shopifyClientSecret, 'client-secret');
  assert.deepEqual(getConfigStatus(config), {
    openai: false,
    shopify: true,
    shopify_auth_mode: 'client_credentials',
    delivery_analytics: false,
    provider_lookup: false,
    kits_internal_api: false,
    memory: false,
    chatwoot: false,
    chatwoot_webhook: false,
    api_token_required: false
  });
});

test('defaults OpenAI model to gpt-5.5', () => {
  const config = loadConfig({});

  assert.equal(config.openaiModel, 'gpt-5.5');
});

test('uses a direct Shopify Admin API token when no client credentials are provided', () => {
  const config = loadConfig({
    SHOPIFY_STORE_DOMAIN: 'kits-republic.myshopify.com',
    SHOPIFY_ADMIN_ACCESS_TOKEN: 'direct-token'
  });

  assert.equal(getConfigStatus(config).shopify_auth_mode, 'admin_access_token');
});

test('prefers Shopify client credentials when both auth modes are present', () => {
  const config = loadConfig({
    SHOPIFY_STORE_DOMAIN: 'kits-republic.myshopify.com',
    SHOPIFY_ADMIN_ACCESS_TOKEN: 'direct-token',
    SHOPIFY_KITS_REPUBLIC_CLIENT_ID: 'client-id',
    SHOPIFY_KITS_REPUBLIC_CLIENT_SECRET: 'client-secret'
  });

  assert.equal(getConfigStatus(config).shopify_auth_mode, 'client_credentials');
});

test('supports existing Railway Shopify admin token aliases', () => {
  const config = loadConfig({
    SHOPIFY_SHOP_NAME: 'kits-republic',
    SHOPIFY_ADMIN_API_ACCESS_TOKEN: 'direct-token',
    SHOPIFY_REQUEST_TIMEOUT_MS: '3000',
    SHOPIFY_QUERY_CONCURRENCY: '4'
  });

  assert.equal(config.shopifyStoreDomain, 'kits-republic.myshopify.com');
  assert.equal(config.shopifyAdminAccessToken, 'direct-token');
  assert.equal(config.shopifyRequestTimeoutMs, 3000);
  assert.equal(config.shopifyQueryConcurrency, 4);
  assert.equal(getConfigStatus(config).shopify, true);
  assert.equal(getConfigStatus(config).shopify_auth_mode, 'admin_access_token');
});

test('supports delivery analytics database aliases and thresholds', () => {
  const config = loadConfig({
    KR_ANALYTICS_DATABASE_URL: 'postgres://analytics',
    KR_ANALYTICS_DATABASE_SSL: 'false',
    KR_ANALYTICS_MIN_FULFILLED: '30',
    KR_ANALYTICS_MIN_DELIVERED: '15'
  });

  assert.equal(config.krAnalyticsDatabaseUrl, 'postgres://analytics');
  assert.equal(config.krAnalyticsDatabaseSsl, false);
  assert.equal(config.krAnalyticsMinFulfilled, 30);
  assert.equal(config.krAnalyticsMinDelivered, 15);
  assert.equal(getConfigStatus(config).delivery_analytics, true);
});

test('uses Kits Republic admin database for copilot memory provider lookup and analytics', () => {
  const config = loadConfig({
    KITS_REPUBLIC_DATABASE_URL: 'postgres://kits-admin',
    KITS_REPUBLIC_DATABASE_SSL: 'false'
  });

  assert.equal(config.kitsRepublicDatabaseUrl, 'postgres://kits-admin');
  assert.equal(config.copilotDatabaseUrl, 'postgres://kits-admin');
  assert.equal(config.krProviderDatabaseUrl, 'postgres://kits-admin');
  assert.equal(config.krAnalyticsDatabaseUrl, 'postgres://kits-admin');
  assert.equal(config.copilotDatabaseSsl, false);
  assert.equal(config.krProviderDatabaseSsl, false);
  assert.equal(config.krAnalyticsDatabaseSsl, false);
  assert.equal(getConfigStatus(config).memory, true);
  assert.equal(getConfigStatus(config).provider_lookup, true);
  assert.equal(getConfigStatus(config).delivery_analytics, true);
});

test('does not enable copilot memory from legacy provider database only', () => {
  const config = loadConfig({
    KR_PROVIDER_DATABASE_URL: 'postgres://provider'
  });

  assert.equal(config.copilotDatabaseUrl, '');
  assert.equal(config.krProviderDatabaseUrl, 'postgres://provider');
  assert.equal(config.krAnalyticsDatabaseUrl, 'postgres://provider');
  assert.equal(getConfigStatus(config).memory, false);
  assert.equal(getConfigStatus(config).provider_lookup, true);
  assert.equal(getConfigStatus(config).delivery_analytics, true);
});

test('supports Chatwoot webhook secret', () => {
  const config = loadConfig({
    CHATWOOT_WEBHOOK_SECRET: 'webhook-secret'
  });

  assert.equal(config.chatwootWebhookSecret, 'webhook-secret');
  assert.equal(getConfigStatus(config).chatwoot_webhook, true);
});

test('supports configurable Chatwoot request timeout', () => {
  const config = loadConfig({
    CHATWOOT_REQUEST_TIMEOUT_MS: '2500'
  });

  assert.equal(config.chatwootRequestTimeoutMs, 2500);
  assert.equal(loadConfig({ CHATWOOT_REQUEST_TIMEOUT_MS: '0' }).chatwootRequestTimeoutMs, 8000);
});

test('supports Kits admin base URL override', () => {
  const config = loadConfig({
    KITS_ADMIN_BASE_URL: 'https://admin.example.test/',
    KITS_INTERNAL_API_TOKEN: 'secret',
    KR_PLAYBOOK_KNOWLEDGE_CACHE_MS: '30000',
    PLAYBOOK_KNOWLEDGE_TIMEOUT_MS: '2500'
  });

  assert.equal(config.kitsAdminBaseUrl, 'https://admin.example.test');
  assert.equal(config.kitsInternalApiToken, 'secret');
  assert.equal(config.playbookKnowledgeCacheMs, 30000);
  assert.equal(config.playbookKnowledgeTimeoutMs, 2500);
  assert.equal(getConfigStatus(config).kits_internal_api, true);
});
