export function buildPublicTrackingUrl(trackingNumber) {
  const normalized = normalizeTrackingNumber(trackingNumber);
  if (!normalized) return null;
  return `https://kitsrepublic.com/apps/17TRACK?nums=${encodeURIComponent(normalized)}`;
}

export function firstTrackingNumberFromShopifyContext(shopifyContext = {}) {
  const order = shopifyContext.selected_order;
  const fulfillments = Array.isArray(order?.fulfillments) ? order.fulfillments : [];

  for (const fulfillment of fulfillments) {
    const numbers = Array.isArray(fulfillment.tracking_numbers) ? fulfillment.tracking_numbers : [];
    const fromNumbers = numbers.find(Boolean);
    if (fromNumbers) return normalizeTrackingNumber(fromNumbers);

    const tracking = Array.isArray(fulfillment.tracking) ? fulfillment.tracking : [];
    const fromTracking = tracking.find(item => item?.number)?.number;
    if (fromTracking) return normalizeTrackingNumber(fromTracking);
  }

  return null;
}

function normalizeTrackingNumber(value) {
  return String(value || '').trim().replace(/\s+/g, '');
}
