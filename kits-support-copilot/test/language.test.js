import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatResponseLanguageHint, inferResponseLanguage } from '../src/language.js';

test('uses latest customer message language before shipping country', () => {
  const responseLanguage = inferResponseLanguage({
    latestMessage: 'Hi, where is my order?',
    shopifyContext: {
      selected_order: {
        shipping_address: {
          country: 'Germany',
          country_code: 'DE'
        }
      }
    }
  });

  assert.deepEqual(responseLanguage, {
    language: 'English',
    source: 'latest_customer_message',
    country_code: 'DE'
  });
  assert.equal(formatResponseLanguageHint(responseLanguage), 'English (source: latest_customer_message, country DE)');
});

test('falls back to shipping country when latest customer message language is unclear', () => {
  const responseLanguage = inferResponseLanguage({
    latestMessage: 'genera respuesta',
    shopifyContext: {
      selected_order: {
        shipping_address: {
          country: 'United Kingdom',
          country_code: 'GB'
        }
      }
    }
  });

  assert.deepEqual(responseLanguage, {
    language: 'English',
    source: 'shipping_country',
    country_code: 'GB'
  });
});

test('falls back to the latest customer message language when shipping country is missing', () => {
  const responseLanguage = inferResponseLanguage({
    latestMessage: 'Hola, quiero saber donde esta mi pedido.',
    shopifyContext: { selected_order: null }
  });

  assert.equal(responseLanguage.language, 'Spanish');
  assert.equal(responseLanguage.source, 'latest_customer_message');
});

test('does not infer language from unselected Shopify order candidates', () => {
  const responseLanguage = inferResponseLanguage({
    latestMessage: 'Hola, quiero saber cuando llega mi pedido.',
    shopifyContext: {
      selected_order: null,
      orders: [
        {
          shipping_address: {
            country: 'Netherlands',
            country_code: 'NL'
          }
        }
      ]
    }
  });

  assert.equal(responseLanguage.language, 'Spanish');
  assert.equal(responseLanguage.source, 'latest_customer_message');
});
