const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const HASH_ORDER_RE = /#([0-9]{3,8})\b/g;
const ORDER_WORD_RE = /\b(?:order|pedido|commande|bestellung|ordine)\s*(?:number|num(?:ber)?|n[uú]mero|n[º°o])?\s*#?([0-9]{3,8})\b/gi;
const ORDER_PREFIX_RE = /\b(?:KR|KITS)[-_\s]?#?([0-9]{4,8})\b/gi;
const TRACKING_HINT_RE = /\b(?:tracking|track|seguimiento|numero de seguimiento|tracking number)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{7,34})\b/gi;
const NEARBY_TRACKING_VALUE_RE = /\b([A-Z0-9][A-Z0-9-]{7,34})\b/gi;

export function extractIdentifiers(text = '') {
  const emails = uniqueMatches(text, EMAIL_RE).map(v => v.toLowerCase());
  const searchableText = maskEmailAddresses(text);
  const orderRefs = new Set();
  const trackingNumbers = new Set();

  for (const match of searchableText.matchAll(HASH_ORDER_RE)) {
    orderRefs.add(normalizeOrderRef(match[1]));
  }

  for (const match of searchableText.matchAll(ORDER_WORD_RE)) {
    orderRefs.add(normalizeOrderRef(match[1]));
  }

  for (const match of searchableText.matchAll(ORDER_PREFIX_RE)) {
    const value = normalizeOrderRef(match[1]);
    orderRefs.add(value);
  }

  for (const match of searchableText.matchAll(TRACKING_HINT_RE)) {
    const trackingNumber = normalizeTrackingNumber(match[1]);
    if (isLikelyTrackingNumber(trackingNumber)) {
      trackingNumbers.add(trackingNumber);
    } else {
      const nearbyTrackingNumber = findNearbyTrackingNumber(searchableText, match);
      if (nearbyTrackingNumber) {
        trackingNumbers.add(nearbyTrackingNumber);
      }
    }
  }

  return {
    emails,
    orderRefs: [...orderRefs],
    trackingNumbers: [...trackingNumbers]
  };
}

function maskEmailAddresses(text = '') {
  return String(text || '').replace(EMAIL_RE, ' ');
}

export function normalizeOrderRef(value = '') {
  const clean = String(value).trim().replace(/^#?/, '');
  return clean ? `#${clean}` : '';
}

function normalizeTrackingNumber(value = '') {
  return String(value).replace(/-/g, '').toUpperCase();
}

function isLikelyTrackingNumber(value = '') {
  if (value.length < 8 || !/\d/.test(value)) return false;
  if (/^\d+$/.test(value)) return value.length >= 10;
  return true;
}

function findNearbyTrackingNumber(text, match) {
  const lookAheadStart = (match.index || 0) + match[0].length;
  const lookAheadText = String(text).slice(lookAheadStart, lookAheadStart + 80);

  for (const nearbyMatch of lookAheadText.matchAll(NEARBY_TRACKING_VALUE_RE)) {
    const value = normalizeTrackingNumber(nearbyMatch[1]);
    if (isLikelyTrackingNumber(value)) return value;
  }

  return null;
}

function uniqueMatches(text, regex) {
  return [...new Set([...String(text).matchAll(regex)].map(match => match[0]))];
}
