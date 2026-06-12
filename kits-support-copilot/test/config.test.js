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
    chatwoot: false,
    api_token_required: false
  });
});

test('defaults OpenAI model to gpt-5.4-mini', () => {
  const config = loadConfig({});

  assert.equal(config.openaiModel, 'gpt-5.4-mini');
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
    SHOPIFY_ADMIN_API_ACCESS_TOKEN: 'direct-token'
  });

  assert.equal(config.shopifyStoreDomain, 'kits-republic.myshopify.com');
  assert.equal(config.shopifyAdminAccessToken, 'direct-token');
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
