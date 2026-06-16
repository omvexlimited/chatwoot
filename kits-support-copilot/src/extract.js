const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const HASH_ORDER_RE = /#([0-9]{3,8})\b/g;
const ORDER_WORD_RE = /\b(?:order|pedido|commande|bestellung|ordine)\s*(?:number|num(?:ber)?|n[uú]mero|n[º°o])?\s*#?([0-9]{3,8})\b/gi;
const ORDER_PREFIX_RE = /\b(?:KR|KITS)[-_\s]?#?([0-9]{4,8})\b/gi;
const TRACKING_HINT_RE = /\b(?:tracking|track|seguimiento|numero de seguimiento|tracking number)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{7,34})\b/gi;
const NEARBY_TRACKING_VALUE_RE = /\b([A-Z0-9][A-Z0-9-]{7,34})\b/gi;
const COUNTRY_CODE_RE = /\b(?:country\s*code|country)\s*[:#-]?\s*([A-Z]{2})\b/gi;
const PHONE_FIELD_RE = /\b(?:phone|tel(?:ephone)?|tel[eé]fono|mobile|whatsapp)\s*[:#-]?\s*(\+?\d[\d\s().-]{5,}\d)\b/gi;

const COUNTRY_CALLING_CODES = {
  CA: '1',
  DE: '49',
  ES: '34',
  FR: '33',
  GB: '44',
  IE: '353',
  IT: '39',
  NL: '31',
  PT: '351',
  UK: '44',
  US: '1'
};

export function extractIdentifiers(text = '') {
  const emails = uniqueMatches(text, EMAIL_RE).map(v => v.toLowerCase());
  const searchableText = maskEmailAddresses(text);
  const countryCodes = extractCountryCodes(searchableText);
  const orderRefs = new Set();
  const trackingNumbers = new Set();
  const phoneNumbers = extractPhoneNumbers(searchableText, countryCodes[0]);

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
    trackingNumbers: [...trackingNumbers],
    phoneNumbers,
    countryCodes
  };
}

function maskEmailAddresses(text = '') {
  return String(text || '').replace(EMAIL_RE, ' ');
}

export function normalizeOrderRef(value = '') {
  const clean = String(value).trim().replace(/^#?/, '');
  return clean ? `#${clean}` : '';
}

export function normalizePhoneCandidates(value = '', countryCode = '') {
  const cleaned = String(value || '').trim();
  if (!cleaned) return [];

  const candidates = new Set();
  const countryPrefix = COUNTRY_CALLING_CODES[String(countryCode || '').trim().toUpperCase()] || '';
  const plusNormalized = cleaned.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
  const digits = plusNormalized.replace(/\D/g, '');
  if (!isLikelyPhoneDigits(digits)) return [];

  addPhoneCandidate(candidates, plusNormalized.startsWith('00') ? `+${digits.slice(2)}` : plusNormalized);
  addPhoneCandidate(candidates, digits);

  if (countryPrefix) {
    if (digits.startsWith(countryPrefix)) {
      const national = digits.slice(countryPrefix.length);
      addPhoneCandidate(candidates, `+${digits}`);
      addPhoneCandidate(candidates, national);
      addPhoneCandidate(candidates, `0${national}`);
    } else if (digits.startsWith('0')) {
      const national = digits.slice(1);
      addPhoneCandidate(candidates, `+${countryPrefix}${national}`);
      addPhoneCandidate(candidates, `${countryPrefix}${national}`);
      addPhoneCandidate(candidates, national);
    } else {
      addPhoneCandidate(candidates, `+${countryPrefix}${digits}`);
      addPhoneCandidate(candidates, `${countryPrefix}${digits}`);
    }
  } else if (digits.startsWith('0')) {
    addPhoneCandidate(candidates, digits.slice(1));
  }

  return [...candidates];
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

function extractCountryCodes(text = '') {
  return [...new Set([...String(text).matchAll(COUNTRY_CODE_RE)].map(match => match[1].toUpperCase()))];
}

function extractPhoneNumbers(text = '', countryCode = '') {
  const phoneNumbers = new Set();
  for (const match of String(text).matchAll(PHONE_FIELD_RE)) {
    for (const value of normalizePhoneCandidates(match[1], countryCode)) {
      phoneNumbers.add(value);
    }
  }
  return [...phoneNumbers];
}

function addPhoneCandidate(candidates, value = '') {
  const clean = String(value || '').replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
  const digits = clean.replace(/\D/g, '');
  if (!isLikelyPhoneDigits(digits)) return;
  candidates.add(clean.startsWith('+') ? `+${digits}` : digits);
}

function isLikelyPhoneDigits(value = '') {
  return value.length >= 7 && value.length <= 16;
}

function uniqueMatches(text, regex) {
  return [...new Set([...String(text).matchAll(regex)].map(match => match[0]))];
}
