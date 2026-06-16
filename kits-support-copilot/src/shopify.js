import { extractIdentifiers, normalizeOrderRef, normalizePhoneCandidates } from './extract.js';
import { hasShopifyClientCredentials, shopifyAuthMode } from './config.js';

const ORDER_STATUS_QUERY_SUFFIXES = ['', ' status:open', ' status:closed', ' status:cancelled'];

const ORDER_QUERY = `
query SearchOrders($query: String!) {
  orders(first: 10, query: $query, sortKey: CREATED_AT, reverse: true) {
    nodes {
      id
      name
      email
      createdAt
      displayFinancialStatus
      displayFulfillmentStatus
      totalPriceSet {
        shopMoney { amount currencyCode }
      }
      currentTotalPriceSet {
        shopMoney { amount currencyCode }
      }
      customer {
        email
        firstName
        lastName
        phone
      }
      phone
      shippingAddress {
        country
        countryCodeV2
        phone
      }
      billingAddress {
        country
        countryCodeV2
        phone
      }
      lineItems(first: 10) {
        nodes {
          id
          name
          quantity
          sku
          fulfillmentStatus
          customAttributes {
            key
            value
          }
        }
      }
      fulfillments(first: 10) {
        id
        name
        createdAt
        deliveredAt
        displayStatus
        inTransitAt
      trackingInfo {
          company
          number
          url
        }
      }
    }
  }
}`;

let tokenCache = null;

export async function getShopifyContext({ config, contactEmail, contactPhone, contactCountryCode, text, selectedOrderRef }) {
  const warnings = [];
  const identifiers = extractIdentifiers([
    contactEmail,
    contactPhone ? `Phone: ${contactPhone}` : '',
    contactCountryCode ? `Country Code: ${contactCountryCode}` : '',
    text
  ].filter(Boolean).join('\n'));

  if (!config.shopifyStoreDomain || (!config.shopifyAdminAccessToken && !hasShopifyClientCredentials(config))) {
    return {
      available: false,
      identifiers,
      queries: [],
      orders: [],
      selected_order: null,
      selection_reason: null,
      warnings: ['Shopify is not configured, so no order lookup was performed. Configure SHOPIFY_STORE_DOMAIN plus either SHOPIFY_ADMIN_ACCESS_TOKEN or client credentials.']
    };
  }

  const queries = buildShopifyQueries({ contactEmail, identifiers });
  if (queries.length === 0) {
    return {
      available: true,
      identifiers,
      queries,
      orders: [],
      selected_order: null,
      selection_reason: null,
      warnings: ['No email, order number, or tracking number was available for Shopify lookup.']
    };
  }

  let accessToken;
  try {
    accessToken = await getShopifyAccessToken(config);
  } catch (error) {
    return {
      available: true,
      identifiers,
      queries,
      orders: [],
      selected_order: null,
      selection_reason: null,
      warnings: [`Shopify token request failed: ${error.message}`]
    };
  }

  const orderMap = new Map();
  const trustedOrderRefs = new Set();
  for (const query of queries) {
    try {
      const orders = await searchOrders({ config, accessToken, query });
      for (const order of orders) {
        orderMap.set(order.id, compactOrder(order));
      }
    } catch (error) {
      warnings.push(`Shopify query failed for "${query}": ${error.message}`);
    }
  }

  const email = normalizeEmail(contactEmail || identifiers.emails[0]);
  if (shouldRunInternalEmailFallback({ orders: [...orderMap.values()], email })) {
    try {
      const internalOrderRefs = await lookupInternalOrderRefsByEmail({ config, email });
      for (const orderRef of internalOrderRefs) {
        trustedOrderRefs.add(orderRef);
        const fallbackQueries = withOrderStatusQueries(`name:${orderRef}`).filter(query => !queries.includes(query));

        for (const query of fallbackQueries) {
          queries.push(query);

          const orders = await searchOrders({ config, accessToken, query });
          for (const order of orders) {
            orderMap.set(order.id, compactOrder(order));
          }
        }
      }
    } catch (error) {
      warnings.push(`Kits Republic email fallback lookup failed: ${error.message}`);
    }
  }

  const orders = [...orderMap.values()];
  const selection = selectOrder(
    orders,
    identifiers,
    { contactEmail, selectedOrderRef, trustedOrderRefs: [...trustedOrderRefs] }
  );
  warnings.push(...selection.warnings);

  return {
    available: true,
    identifiers,
    queries,
    orders,
    selected_order: selection.order,
    selection_reason: selection.reason,
    warnings
  };
}

export function buildShopifyQueries({ contactEmail, identifiers }) {
  const queries = [];

  for (const orderRef of identifiers.orderRefs) {
    queries.push(...withOrderStatusQueries(`name:${orderRef}`));
  }

  for (const tracking of identifiers.trackingNumbers) {
    queries.push(...withOrderStatusQueries(tracking));
  }

  const email = contactEmail || identifiers.emails[0];
  if (email) {
    queries.push(...withOrderStatusQueries(`email:${email}`));
  }

  for (const phone of identifiers.phoneNumbers || []) {
    queries.push(...withOrderStatusQueries(phone));
  }

  return [...new Set(queries)].slice(0, 32);
}

function withOrderStatusQueries(baseQuery) {
  return ORDER_STATUS_QUERY_SUFFIXES.map(suffix => `${baseQuery}${suffix}`);
}

export function selectOrder(orders, identifiers, {
  contactEmail = '',
  selectedOrderRef = '',
  trustedOrderRefs = []
} = {}) {
  if (orders.length === 0) {
    return {
      order: null,
      reason: null,
      warnings: ['No matching Shopify order was found.']
    };
  }

  const normalizedTrustedOrderRefs = new Set(trustedOrderRefs.map(normalizeOrderRef).filter(Boolean));
  const emailMatchedOrders = filterOrdersByContactEmail(orders, contactEmail);
  const phoneMatchedOrders = filterOrdersByPhone(orders, identifiers.phoneNumbers);
  const trustedOrders = orders.filter(order => normalizedTrustedOrderRefs.has(order.name));
  const eligibleOrders = uniqueOrders([...emailMatchedOrders, ...trustedOrders]);
  const normalizedSelectedOrderRef = normalizeOrderRef(selectedOrderRef);

  if (normalizedSelectedOrderRef) {
    const selectedOrder = orders.find(order => order.name === normalizedSelectedOrderRef);
    if (selectedOrder) {
      return {
        order: selectedOrder,
        reason: `Agent selected order ${selectedOrder.name}.`,
        warnings: emailMismatchWarnings({ order: selectedOrder, contactEmail, matchType: 'selected order' })
      };
    }

    return {
      order: null,
      reason: null,
      warnings: [
        `Selected order ${normalizedSelectedOrderRef} was not found in Shopify candidates. No order was selected.`
      ]
    };
  }

  const byOrderRef = orders.find(order => identifiers.orderRefs.includes(order.name));
  if (byOrderRef) {
    return {
      order: byOrderRef,
      reason: `Matched explicit order ${byOrderRef.name}.`,
      warnings: emailMismatchWarnings({ order: byOrderRef, contactEmail, matchType: 'explicit order number' })
    };
  }
  if (identifiers.orderRefs.length) {
    return {
      order: null,
      reason: null,
      warnings: [
        `Explicit order ${identifiers.orderRefs.join(', ')} was not found in Shopify candidates. No order was selected.`
      ]
    };
  }

  const byTracking = orders.find(order => {
    const numbers = order.fulfillments.flatMap(fulfillment => fulfillment.tracking_numbers);
    return identifiers.trackingNumbers.some(value => numbers.includes(value));
  });
  if (byTracking) {
    return {
      order: byTracking,
      reason: `Matched tracking number on ${byTracking.name}.`,
      warnings: emailMismatchWarnings({ order: byTracking, contactEmail, matchType: 'explicit tracking number' })
    };
  }
  if (identifiers.trackingNumbers.length) {
    if (eligibleOrders.length === 1) {
      const order = eligibleOrders[0];
      return {
        order,
        reason: `Only one Shopify order matched; ignored unverified tracking reference.`,
        warnings: []
      };
    }

    return {
      order: null,
      reason: null,
      warnings: [
        'Explicit tracking number did not match the active contact email. No order was selected.'
      ]
    };
  }

  if (eligibleOrders.length === 1) {
    const order = eligibleOrders[0];
    const reason = normalizedTrustedOrderRefs.has(order.name) && !emailMatchedOrders.some(match => match.id === order.id)
      ? `Matched Kits Republic email fallback order ${order.name}.`
      : `Only one Shopify order matched.`;
    return { order, reason, warnings: [] };
  }

  if (phoneMatchedOrders.length === 1) {
    const order = phoneMatchedOrders[0];
    return {
      order,
      reason: `Matched phone number on ${order.name}.`,
      warnings: emailMismatchWarnings({ order, contactEmail, matchType: 'phone number' })
    };
  }

  if (phoneMatchedOrders.length > 1) {
    return {
      order: null,
      reason: null,
      warnings: [
        'Multiple Shopify orders matched the phone number and no explicit order/tracking reference was found. Ask the customer to confirm the order number.'
      ]
    };
  }

  if (contactEmail && !eligibleOrders.length) {
    return {
      order: null,
      reason: null,
      warnings: [
        `Shopify returned order candidates, but none match the active contact email ${normalizeEmail(contactEmail)}. No order was selected.`
      ]
    };
  }

  return {
    order: null,
    reason: null,
    warnings: ['Multiple Shopify orders matched and no explicit order/tracking reference was found. Ask the customer to confirm the order number.']
  };
}

function emailMismatchWarnings({ order, contactEmail, matchType }) {
  if (!contactEmail) return [];
  if (orderMatchesContactEmail(order, contactEmail)) return [];
  return [
    `Order matched by ${matchType}, but the Chatwoot contact email differs from the Shopify order email.`
  ];
}

function filterOrdersByContactEmail(orders, contactEmail) {
  const email = normalizeEmail(contactEmail);
  if (!email) return orders;
  return orders.filter(order => orderMatchesContactEmail(order, email));
}

function filterOrdersByPhone(orders, phoneNumbers = []) {
  const expectedPhones = new Set(phoneNumbers || []);
  if (!expectedPhones.size) return [];
  return orders.filter(order => orderMatchesPhone(order, expectedPhones));
}

function orderMatchesContactEmail(order, contactEmail) {
  const email = normalizeEmail(contactEmail);
  if (!email) return true;
  return normalizeEmail(order.email || order.customer?.email) === email;
}

function orderMatchesPhone(order, expectedPhones) {
  const countryCode = order.shipping_address?.country_code || order.billing_address?.country_code || '';
  for (const phone of orderPhoneValues(order)) {
    const candidates = normalizePhoneCandidates(phone, countryCode);
    if (candidates.some(candidate => expectedPhones.has(candidate))) return true;
  }
  return false;
}

function orderPhoneValues(order = {}) {
  return [
    order.phone,
    order.customer?.phone,
    order.shipping_address?.phone,
    order.billing_address?.phone
  ].filter(Boolean);
}

function shouldRunInternalEmailFallback({ orders = [], email = '' }) {
  if (!email) return false;
  return !orders.some(order => orderMatchesContactEmail(order, email));
}

async function lookupInternalOrderRefsByEmail({ config, email }) {
  if (!config.krProviderDatabaseUrl) return [];

  const { Client } = await import('pg');
  const client = new Client({
    connectionString: config.krProviderDatabaseUrl,
    ssl: config.krProviderDatabaseSsl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 3000,
    query_timeout: 5000
  });

  try {
    await client.connect();
    const result = await client.query(
      `
      SELECT order_number
      FROM kits_republic_orders
      WHERE store_id = $1
        AND LOWER(TRIM(COALESCE(customer_email, ''))) = $2
        AND COALESCE(order_number, '') <> ''
      ORDER BY shopify_created_at DESC NULLS LAST, id DESC
      LIMIT 10
      `,
      [config.krProviderStoreId || 'kits_republic', normalizeEmail(email)]
    );

    return [...new Set(result.rows.map(row => normalizeOrderRef(row.order_number)).filter(Boolean))];
  } finally {
    await client.end().catch(() => {});
  }
}

function uniqueOrders(orders = []) {
  const seen = new Set();
  return orders.filter(order => {
    const key = order.id || order.name;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function searchOrders({ config, accessToken, query }) {
  const url = `https://${config.shopifyStoreDomain}/admin/api/${config.shopifyApiVersion}/graphql.json`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken
    },
    body: JSON.stringify({
      query: ORDER_QUERY,
      variables: { query }
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.errors?.[0]?.message || `HTTP ${response.status}`);
  }
  if (data.errors?.length) {
    throw new Error(data.errors.map(error => error.message).join('; '));
  }

  return data?.data?.orders?.nodes || [];
}

async function getShopifyAccessToken(config) {
  if (shopifyAuthMode(config) === 'admin_access_token') return config.shopifyAdminAccessToken;

  const cacheKey = `${config.shopifyStoreDomain}:${config.shopifyClientId}`;
  const now = Date.now();
  if (tokenCache?.cacheKey === cacheKey && tokenCache.expiresAt > now + 60_000) {
    return tokenCache.accessToken;
  }

  const url = `https://${config.shopifyStoreDomain}/admin/oauth/access_token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.shopifyClientId,
    client_secret: config.shopifyClientSecret
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error_description || data?.error || `Shopify token HTTP ${response.status}`);
  }
  if (!data.access_token) {
    throw new Error('Shopify token response did not include access_token.');
  }

  const expiresInSeconds = Number(data.expires_in || 3600);
  tokenCache = {
    cacheKey,
    accessToken: data.access_token,
    expiresAt: now + Math.max(expiresInSeconds - 300, 60) * 1000
  };

  return tokenCache.accessToken;
}

function compactOrder(order) {
  const lineItems = (order.lineItems?.nodes || []).map(item => ({
    id: item.id,
    shopify_line_item_id: item.id,
    name: item.name,
    quantity: item.quantity,
    sku: item.sku,
    fulfillment_status: item.fulfillmentStatus,
    custom_attributes: compactCustomAttributes(item.customAttributes)
  }));

  return {
    id: order.id,
    name: order.name,
    email: order.email || order.customer?.email || null,
    phone: order.phone || order.customer?.phone || null,
    created_at: order.createdAt,
    financial_status: order.displayFinancialStatus,
    fulfillment_status: order.displayFulfillmentStatus,
    total: money(order.currentTotalPriceSet || order.totalPriceSet),
    customer: compactCustomer(order.customer),
    shipping_address: compactShippingAddress(order.shippingAddress),
    billing_address: compactAddress(order.billingAddress),
    line_items: lineItems,
    fulfillments: (order.fulfillments || []).map(fulfillment => ({
      name: fulfillment.name,
      created_at: fulfillment.createdAt,
      delivered_at: fulfillment.deliveredAt,
      display_status: fulfillment.displayStatus,
      in_transit_at: fulfillment.inTransitAt,
      tracking_numbers: (fulfillment.trackingInfo || []).map(info => normalizeTracking(info.number)).filter(Boolean),
      tracking: (fulfillment.trackingInfo || []).map(info => ({
        company: info.company,
        number: normalizeTracking(info.number),
        url: info.url
      }))
    }))
  };
}

function compactCustomAttributes(attributes = []) {
  return (attributes || [])
    .map(attribute => ({
      key: String(attribute?.key || '').trim(),
      value: String(attribute?.value || '').trim()
    }))
    .filter(attribute => attribute.key || attribute.value);
}

function compactCustomer(customer) {
  if (!customer) return null;
  return {
    email: customer.email,
    first_name: customer.firstName,
    last_name: customer.lastName,
    phone: customer.phone || null
  };
}

function compactShippingAddress(address) {
  return compactAddress(address);
}

function compactAddress(address) {
  if (!address) return null;
  return {
    country: address.country || null,
    country_code: address.countryCodeV2 || null,
    phone: address.phone || null
  };
}

function money(priceSet) {
  const moneyValue = priceSet?.shopMoney;
  if (!moneyValue) return null;
  return `${moneyValue.amount} ${moneyValue.currencyCode}`;
}

function normalizeEmail(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeTracking(value = '') {
  return String(value).replace(/-/g, '').toUpperCase();
}
