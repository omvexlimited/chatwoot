const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const HASH_ORDER_RE = /#([0-9]{3,8})\b/g;
const ORDER_WORD_RE = /\b(?:order|pedido|commande|bestellung|ordine)\s*(?:number|num(?:ber)?|n[uú]mero|n[º°o])?\s*#?([0-9]{3,8})\b/gi;
const ORDER_PREFIX_RE = /\b(?:KR|KITS)[-_\s]?#?([0-9]{4,8})\b/gi;
const TRACKING_HINT_RE = /\b(?:tracking|track|seguimiento|numero de seguimiento|tracking number)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{7,34})\b/gi;

export function extractIdentifiers(text = '') {
  const emails = uniqueMatches(text, EMAIL_RE).map(v => v.toLowerCase());
  const orderRefs = new Set();
  const trackingNumbers = new Set();

  for (const match of text.matchAll(HASH_ORDER_RE)) {
    orderRefs.add(normalizeOrderRef(match[1]));
  }

  for (const match of text.matchAll(ORDER_WORD_RE)) {
    orderRefs.add(normalizeOrderRef(match[1]));
  }

  for (const match of text.matchAll(ORDER_PREFIX_RE)) {
    const value = normalizeOrderRef(match[1]);
    orderRefs.add(value);
  }

  for (const match of text.matchAll(TRACKING_HINT_RE)) {
    trackingNumbers.add(match[1].replace(/-/g, '').toUpperCase());
  }

  return {
    emails,
    orderRefs: [...orderRefs],
    trackingNumbers: [...trackingNumbers]
  };
}

export function normalizeOrderRef(value = '') {
  const clean = String(value).trim().replace(/^#?/, '');
  return clean ? `#${clean}` : '';
}

function uniqueMatches(text, regex) {
  return [...new Set([...String(text).matchAll(regex)].map(match => match[0]))];
}
