import { extractIdentifiers, normalizeOrderRef } from './extract.js';
import { hasShopifyClientCredentials, shopifyAuthMode } from './config.js';

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
      }
      shippingAddress {
        country
        countryCodeV2
      }
      lineItems(first: 10) {
        nodes {
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

export async function getShopifyContext({ config, contactEmail, text, selectedOrderRef }) {
  const warnings = [];
  const identifiers = extractIdentifiers([contactEmail, text].filter(Boolean).join('\n'));

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

  const orders = [...orderMap.values()];
  const selection = selectOrder(orders, identifiers, { contactEmail, selectedOrderRef });
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
    queries.push(`name:${orderRef}`);
  }

  for (const tracking of identifiers.trackingNumbers) {
    queries.push(tracking);
  }

  const email = contactEmail || identifiers.emails[0];
  if (email) {
    queries.push(`email:${email}`);
  }

  return [...new Set(queries)].slice(0, 4);
}

export function selectOrder(orders, identifiers, { contactEmail = '', selectedOrderRef = '' } = {}) {
  if (orders.length === 0) {
    return {
      order: null,
      reason: null,
      warnings: ['No matching Shopify order was found.']
    };
  }

  const eligibleOrders = filterOrdersByContactEmail(orders, contactEmail);
  const normalizedSelectedOrderRef = normalizeOrderRef(selectedOrderRef);
  if (contactEmail && !eligibleOrders.length) {
    return {
      order: null,
      reason: null,
      warnings: [
        `Shopify returned order candidates, but none match the active contact email ${normalizeEmail(contactEmail)}. No order was selected.`
      ]
    };
  }

  if (normalizedSelectedOrderRef) {
    const selectedOrder = eligibleOrders.find(order => order.name === normalizedSelectedOrderRef);
    if (selectedOrder) {
      return {
        order: selectedOrder,
        reason: `Agent selected order ${selectedOrder.name}.`,
        warnings: []
      };
    }

    const existsForAnotherContact = orders.some(order => order.name === normalizedSelectedOrderRef);
    return {
      order: null,
      reason: null,
      warnings: [
        existsForAnotherContact
          ? `Selected order ${normalizedSelectedOrderRef} did not match the active contact email. No order was selected.`
          : `Selected order ${normalizedSelectedOrderRef} was not found in Shopify candidates. No order was selected.`
      ]
    };
  }

  const byOrderRef = eligibleOrders.find(order => identifiers.orderRefs.includes(order.name));
  if (byOrderRef) {
    return { order: byOrderRef, reason: `Matched explicit order ${byOrderRef.name}.`, warnings: [] };
  }
  if (identifiers.orderRefs.length) {
    return {
      order: null,
      reason: null,
      warnings: [
        `Explicit order ${identifiers.orderRefs.join(', ')} did not match the active contact email. No order was selected.`
      ]
    };
  }

  const byTracking = eligibleOrders.find(order => {
    const numbers = order.fulfillments.flatMap(fulfillment => fulfillment.tracking_numbers);
    return identifiers.trackingNumbers.some(value => numbers.includes(value));
  });
  if (byTracking) {
    return { order: byTracking, reason: `Matched tracking number on ${byTracking.name}.`, warnings: [] };
  }
  if (identifiers.trackingNumbers.length) {
    return {
      order: null,
      reason: null,
      warnings: [
        'Explicit tracking number did not match the active contact email. No order was selected.'
      ]
    };
  }

  if (eligibleOrders.length === 1) {
    return { order: eligibleOrders[0], reason: `Only one Shopify order matched.`, warnings: [] };
  }

  return {
    order: null,
    reason: null,
    warnings: ['Multiple Shopify orders matched and no explicit order/tracking reference was found. Ask the customer to confirm the order number.']
  };
}

function filterOrdersByContactEmail(orders, contactEmail) {
  const email = normalizeEmail(contactEmail);
  if (!email) return orders;
  return orders.filter(order => normalizeEmail(order.email || order.customer?.email) === email);
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
    created_at: order.createdAt,
    financial_status: order.displayFinancialStatus,
    fulfillment_status: order.displayFulfillmentStatus,
    total: money(order.currentTotalPriceSet || order.totalPriceSet),
    customer: compactCustomer(order.customer),
    shipping_address: compactShippingAddress(order.shippingAddress),
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
    last_name: customer.lastName
  };
}

function compactShippingAddress(address) {
  if (!address) return null;
  return {
    country: address.country || null,
    country_code: address.countryCodeV2 || null
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
