const COUNTRY_LANGUAGE = {
  GB: 'English',
  UK: 'English',
  US: 'English',
  CA: 'English',
  AU: 'English',
  NZ: 'English',
  IE: 'English',
  ES: 'Spanish',
  MX: 'Spanish',
  AR: 'Spanish',
  CL: 'Spanish',
  CO: 'Spanish',
  PE: 'Spanish',
  UY: 'Spanish',
  PY: 'Spanish',
  EC: 'Spanish',
  VE: 'Spanish',
  BO: 'Spanish',
  CR: 'Spanish',
  PA: 'Spanish',
  DO: 'Spanish',
  GT: 'Spanish',
  HN: 'Spanish',
  SV: 'Spanish',
  NI: 'Spanish',
  PR: 'Spanish',
  FR: 'French',
  MC: 'French',
  DE: 'German',
  AT: 'German',
  CH: 'German',
  IT: 'Italian',
  PT: 'Portuguese',
  BR: 'Portuguese',
  NL: 'Dutch',
  BE: 'French'
};

const LANGUAGE_PATTERNS = [
  {
    language: 'Catalan',
    strongPattern: /[àèòïç]/i,
    pattern: /\b(catala|catal[aà]|catalan|comanda|samarreta|seguiment|enviament|gr[aà]cies|digali|diga-li)\b/gi
  },
  {
    language: 'Spanish',
    strongPattern: /[¿¡ñáéíóú]/i,
    pattern: /\b(hola|dile|hemos|cliente|pedido|camiseta|talla|devoluci[oó]n|reembolso|reembolsa|reemplazo|cambio|tramitado|reportado|enviado|env[ií]o|gracias|problema|molestias|arreglamos|d[oó]nde|cuando|cu[aá]ndo)\b/gi
  },
  {
    language: 'English',
    pattern: /\b(hello|hi|order|jersey|shirt|size|refund|return|shipping|tracking|delivered|received|where|when|thanks|thank you)\b/gi
  },
  {
    language: 'French',
    strongPattern: /[àâçéèêëîïôùûüÿ]/i,
    pattern: /\b(bonjour|commande|maillot|taille|remboursement|retour|livraison|suivi|merci)\b/gi
  },
  {
    language: 'German',
    strongPattern: /[äöüß]/i,
    pattern: /\b(hallo|ich|habe|meine|mein|keine|bitte|bestellung|trikot|gr[oö]ße|ruckgabe|r[üu]ckerstattung|versand|sendung|paket|angekommen|erhalten|danke)\b/gi
  },
  {
    language: 'Italian',
    pattern: /\b(ciao|ordine|maglia|taglia|rimborso|reso|spedizione|tracciamento|grazie)\b/gi
  },
  {
    language: 'Portuguese',
    strongPattern: /[ãõç]/i,
    pattern: /\b(ol[aá]|pedido|camisola|tamanho|reembolso|devolu[cç][aã]o|envio|rastreamento|obrigado|obrigada)\b/gi
  },
  {
    language: 'Dutch',
    pattern: /\b(hallo|bestelling|shirt|maat|terugbetaling|retour|verzending|tracking|bedankt)\b/gi
  }
];

const EXPLICIT_LANGUAGE_REQUESTS = [
  {
    language: 'Catalan',
    aliases: ['catala', 'catalan', 'català']
  },
  {
    language: 'Spanish',
    aliases: ['espanol', 'español', 'spanish', 'castellano']
  },
  {
    language: 'English',
    aliases: ['ingles', 'inglés', 'english']
  },
  {
    language: 'French',
    aliases: ['frances', 'francés', 'french']
  },
  {
    language: 'German',
    aliases: ['aleman', 'alemán', 'german', 'deutsch']
  },
  {
    language: 'Italian',
    aliases: ['italiano', 'italian']
  },
  {
    language: 'Portuguese',
    aliases: ['portugues', 'portugués', 'portuguese']
  },
  {
    language: 'Dutch',
    aliases: ['holandes', 'holandés', 'dutch', 'nederlands']
  }
];

export function inferResponseLanguage({ latestMessage = '', shopifyContext = {} } = {}) {
  const detected = detectLanguageFromText(latestMessage);
  const countryCode = shippingCountryCode(shopifyContext);
  if (detected) {
    return {
      language: detected,
      source: 'latest_customer_message',
      country_code: countryCode || null
    };
  }

  const countryLanguage = countryCode ? COUNTRY_LANGUAGE[countryCode] : null;
  if (countryLanguage) {
    return {
      language: countryLanguage,
      source: 'shipping_country',
      country_code: countryCode
    };
  }

  return {
    language: 'English',
    source: 'default',
    country_code: countryCode || null
  };
}

export function applyAgentDraftLanguageOverride(responseLanguage, chatMessages = []) {
  const requestedLanguage = inferExplicitDraftLanguageRequest(chatMessages);
  if (!requestedLanguage) return responseLanguage;

  return {
    ...(responseLanguage || {}),
    language: requestedLanguage,
    source: 'agent_explicit_language_request'
  };
}

export function inferExplicitDraftLanguageRequest(chatMessages = []) {
  if (!Array.isArray(chatMessages)) return null;

  for (const message of chatMessages.slice(-12).reverse()) {
    if (message?.role === 'assistant') continue;

    const content = String(message?.content || '').trim();
    if (!content) continue;

    const requested = explicitLanguageFromText(content);
    if (requested) return requested;
  }

  return null;
}

export function formatResponseLanguageHint(responseLanguage) {
  const language = responseLanguage?.language || 'English';
  const source = responseLanguage?.source || 'default';
  const country = responseLanguage?.country_code ? `, country ${responseLanguage.country_code}` : '';
  return `${language} (source: ${source}${country})`;
}

export function detectLanguageFromText(text) {
  const value = normalizeLanguageSample(text);
  if (value.length < 8) return null;

  const scores = LANGUAGE_PATTERNS
    .map(({ language, pattern, strongPattern }) => ({
      language,
      score: countMatches(value, pattern) + (strongPattern?.test(value) ? 3 : 0)
    }))
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score);

  if (!scores.length) return null;
  if (scores[1] && scores[0].score === scores[1].score) return null;
  if (scores[0].language === 'English' && scores[0].score < 2) return null;
  return scores[0].language;
}

function normalizeLanguageSample(text) {
  return String(text || '')
    .replace(/(^|\n)\s*>.*$/gm, ' ')
    .replace(/\bOn\s.+?\bwrote:\s.+$/is, ' ')
    .replace(/\bAm\s.+?\bschrieb\s.+?:\s.+$/is, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countMatches(value, pattern) {
  return [...value.matchAll(new RegExp(pattern.source, pattern.flags))].length;
}

function shippingCountryCode(shopifyContext) {
  const address = shopifyContext?.selected_order?.shipping_address;
  const code = address?.country_code || address?.countryCode || address?.countryCodeV2;
  return code ? String(code).toUpperCase() : null;
}

function explicitLanguageFromText(text) {
  const normalized = normalizeForLanguageRequest(text);

  for (const { language, aliases } of EXPLICIT_LANGUAGE_REQUESTS) {
    if (aliases.some(alias => hasExplicitLanguageRequest(normalized, normalizeForLanguageRequest(alias)))) {
      return language;
    }
  }

  return null;
}

function hasExplicitLanguageRequest(text, alias) {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const directCommand = new RegExp(
    `\\b(?:contesta|responde|respond|reply|write|redacta|escribe|fes-ho|hazlo|dilo|digali|dile)\\b.{0,40}\\b(?:en|in)?\\s*${escaped}\\b`,
    'i'
  );
  const shortCorrection = new RegExp(`\\b${escaped}\\b`, 'i');

  return directCommand.test(text)
    || (/^en\s+\w+[!\s.]*$/i.test(text) && shortCorrection.test(text))
    || (text.length <= 90 && /\bspanish\s+is\s+not\b/i.test(text) && shortCorrection.test(text))
    || (text.length <= 80 && /[!]{2,}/.test(text) && shortCorrection.test(text));
}

function normalizeForLanguageRequest(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
