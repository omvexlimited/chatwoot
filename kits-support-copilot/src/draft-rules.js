import { buildPublicTrackingUrl, firstTrackingNumberFromShopifyContext } from './tracking-url.js';
import { buildDeliveryTimingGuidance } from './delivery-guidance.js';

const POLICY_LINKS = {
  shipping: 'https://kitsrepublic.com/policies/shipping-policy',
  refund: 'https://kitsrepublic.com/policies/refund-policy',
  sizeGuide: 'https://kitsrepublic.com/pages/size-guide'
};

export function enforceDraftRequirements({
  draft = '',
  supportCase,
  shopifyContext = {},
  responseLanguage,
  deliveryEstimateContext
} = {}) {
  const text = String(draft || '').trim();
  if (!text) return String(draft || '');

  let normalizedText = normalizeDraftFormatting(text);
  const language = responseLanguage?.language || inferLanguageFromDraft(normalizedText);
  const trackingNumber = firstTrackingNumberFromShopifyContext(shopifyContext);
  const trackingUrl = buildPublicTrackingUrl(trackingNumber);

  if (trackingUrl) {
    normalizedText = canonicalizeTrackingLinks(normalizedText, trackingUrl);
    const block = trackingBlock({
      draft: normalizedText,
      trackingNumber,
      trackingUrl,
      language,
      supportCase
    });
    if (block) normalizedText = insertAfterGreeting(normalizedText, block);
    normalizedText = dedupeTrackingLinks(normalizedText, trackingUrl);
    normalizedText = removeRedundantTrackingNumberLines(normalizedText, trackingNumber, trackingUrl);
  }

  normalizedText = enforceDeliveryEstimateClaims(normalizedText, deliveryEstimateContext, language);
  normalizedText = applyRequiredPolicyLinks(normalizedText, language);
  return normalizeDraftFormatting(normalizedText);
}

function canonicalizeTrackingLinks(text, trackingUrl) {
  return text.replace(
    /https?:\/\/(?:www\.)?(?:17track\.net|shopify\.17track\.net|royalmail\.com|ctt\.pt|cttexpress\.com|ctt\.es|colissimo\.fr|laposte\.fr|evri\.com|hermesworld\.com|parcelsapp\.com|aftership\.com|dhl\.[a-z.]+)\/\S+|https?:\/\/(?:www\.)?kitsrepublic\.com\/(?:apps\/17TRACK\?nums=|tracking\/)\S+/gi,
    trackingUrl
  );
}

function normalizeDraftFormatting(text) {
  let value = String(text || '').replace(/\r\n/g, '\n');
  value = normalizeLabelUrlSpacing(value);
  value = normalizeSignatureSpacing(value);
  return normalizeBlankLines(value);
}

function normalizeLabelUrlSpacing(text) {
  return text.replace(/([^\n:]{2,80}:)\s*(https?:\/\/\S+)/g, '$1\n\n$2');
}

function normalizeSignatureSpacing(text) {
  return text.replace(
    /(Best,|Best regards,|Kind regards,|Regards,|Un saludo,|Saludos,|Salutacions,|Cordialment,|Atentament,|Cordialement,|Viele Gruesse,|Viele Grüße,|Grazie,|Obrigado,|Obrigada,|Met vriendelijke groet,)\s*www\.kitsrepublic\.com/gi,
    (_, signoff) => `${signoff}\n\nwww.kitsrepublic.com`
  );
}

function insertAfterGreeting(text, block) {
  const lines = text.split('\n');
  const insertIndex = greetingEndIndex(lines);
  lines.splice(insertIndex, 0, '', block, '');
  return normalizeBlankLines(lines.join('\n'));
}

function trackingBlock({ draft, trackingNumber, trackingUrl, language, supportCase }) {
  if (!shouldIncludeTrackingLink({ draft, trackingNumber, trackingUrl, supportCase })) return '';
  if (supportCase?.type === 'customs_pending') {
    return customsTrackingBlock({ draft, trackingUrl, language });
  }
  return trackingLinkBlock({ draft, trackingUrl, language });
}

function shouldIncludeTrackingLink({ draft, trackingNumber, trackingUrl, supportCase }) {
  if (supportCase?.type === 'customs_pending') {
    return !hasCorrectTrackingPhrase(draft) || !hasPublicTrackingUrl(draft, trackingUrl);
  }
  if (hasPublicTrackingUrl(draft, trackingUrl)) return false;
  if (trackingNumber && draft.includes(trackingNumber)) return true;
  return /\b(tracking|shipment|carrier|delivery progress|seguimiento|env[ií]o|transportista|zending|trackingnummer|spedizione|tracciamento|suivi|sendung)\b/i.test(draft);
}

function hasPublicTrackingUrl(draft, trackingUrl) {
  return draft.includes(trackingUrl) || /kitsrepublic\.com\/apps\/17TRACK\?nums=/i.test(draft);
}

function dedupeTrackingLinks(text, trackingUrl) {
  const lines = text.split('\n');
  let seen = false;
  const remove = new Set();

  lines.forEach((line, index) => {
    if (line.trim() !== trackingUrl) return;
    if (!seen) {
      seen = true;
      return;
    }
    markLinkBlockForRemoval(lines, index, remove, isTrackingLabelLine);
  });

  return normalizeBlankLines(lines.filter((_, index) => !remove.has(index)).join('\n'));
}

function removeRedundantTrackingNumberLines(text, trackingNumber, trackingUrl) {
  if (!trackingNumber || !text.includes(trackingUrl)) return text;

  const pattern = new RegExp(
    `^\\s*(tracking(?:\\s+number)?|tracking\\s+no\\.?|tracking\\s+code|track(?:ing)?\\s+code|n[uú]mero\\s+de\\s+seguimiento|numero\\s+de\\s+seguimiento|num[eé]ro\\s+de\\s+suivi|sendungsnummer|trackingnummer|numero\\s+di\\s+tracking|n[uú]mero\\s+de\\s+rastreamento)\\s*[:#-]?\\s*${escapeRegExp(trackingNumber)}\\s*\\.?\\s*$`,
    'i'
  );

  return normalizeBlankLines(text.split('\n').filter(line => !pattern.test(line.trim())).join('\n'));
}

function enforceDeliveryEstimateClaims(text, deliveryEstimateContext, language) {
  const guidance = buildDeliveryTimingGuidance(deliveryEstimateContext);
  const safeText = removeExactTimingClaims(text, guidance, language);
  if (hasReliableDeliveryEstimate(deliveryEstimateContext)) return safeText;

  const neutralTimeframe = copyForLanguage(language, {
    English: 'Our usual delivery timeframe is 7-15 days from purchase, but it can vary.',
    Spanish: 'Nuestro plazo habitual de entrega es de 7-15 días desde la compra, aunque puede variar.',
    Catalan: 'El nostre termini habitual d entrega és de 7-15 dies des de la compra, tot i que pot variar.',
    French: 'Notre délai de livraison habituel est de 7 à 15 jours à partir de l achat, mais il peut varier.',
    German: 'Unsere übliche Lieferzeit beträgt 7-15 Tage ab Kaufdatum, kann aber variieren.',
    Italian: 'Il nostro tempo di consegna abituale è di 7-15 giorni dall acquisto, ma può variare.',
    Portuguese: 'O nosso prazo habitual de entrega é de 7-15 dias a partir da compra, mas pode variar.',
    Dutch: 'Onze gebruikelijke levertijd is 7-15 dagen vanaf aankoop, maar dit kan varieren.'
  });

  let value = safeText.replace(
    /\b(?:Based on recent shipments with|Based on recent deliveries with|Based on recent carrier data for)\s+[^.\n]+\.?/gi,
    sentence => (/\b7\s*[–-]\s*15\b/i.test(sentence) ? neutralTimeframe : '')
  );

  value = value.replace(
    /\b(?:Seg[uú]n|Basado en|Basandonos en|Basándonos en)\s+(?:env[ií]os|entregas)\s+recientes[^.\n]*\b7\s*[–-]\s*15\s+d[ií]as[^.\n]*\.?/gi,
    neutralTimeframe
  );

  value = value.replace(
    /\b(?:this shipment|it|the shipment|delivery|shipping)\s+is\s+taking\s+longer\s+than\s+the\s+recent\s+carrier\s+average[^.\n]*\.?/gi,
    ''
  );

  value = value.replace(/\bthe\s+recent\s+carrier\s+average[^.\n]*\.?/gi, '');
  return normalizeBlankLines(value);
}

function removeExactTimingClaims(text, guidance, language) {
  let value = text.replace(
    /\b(?:estimated\s+remaining|remaining\s+time|time\s+remaining|remaining)\s*[:\s-]*(?:about|around|approximately|approx\.?|~)?\d+(?:\.\d+)?\s*days?\b[^.\n]*\.?/gi,
    ''
  );

  value = value.replace(
    /\b(?:about|around|approximately|approx\.?|~)?\d+(?:\.\d+)?\s*days?\s+remaining\b[^.\n]*\.?/gi,
    ''
  );

  value = value.replace(
    /\b(?:Based on recent shipments with|Based on recent deliveries with|Based on recent carrier data for)\s+[^.\n]*\b\d+\.\d+\s+days?\b[^.\n]*\.?/gi,
    () => timingGuidanceReplacement(guidance, language)
  );

  value = value.replace(
    /\b(?:it|the shipment|tracking|delivery|the parcel|your parcel)\s+(?:should|will|is expected to|expected to)\s+(?:arrive|be delivered|update)[^.\n]*\b(?:today|tomorrow)\b[^.\n]*\.?/gi,
    ''
  );

  value = value.replace(
    /\b(?:arrive|be delivered|update)\s+(?:today|tomorrow)\b[^.\n]*\.?/gi,
    ''
  );

  return normalizeBlankLines(value);
}

function timingGuidanceReplacement(guidance, language) {
  if (!guidance?.usable || language !== 'English') return '';
  return guidance.customer_guidance || '';
}

function hasReliableDeliveryEstimate(deliveryEstimateContext) {
  return deliveryEstimateContext?.available === true && ['high', 'medium'].includes(deliveryEstimateContext?.confidence);
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function markLinkBlockForRemoval(lines, index, remove, isLabelLine) {
  remove.add(index);

  let cursor = index - 1;
  while (cursor >= 0 && !lines[cursor].trim()) {
    remove.add(cursor);
    cursor -= 1;
  }
  if (cursor >= 0 && isLabelLine(lines[cursor])) remove.add(cursor);
}

function isTrackingLabelLine(line = '') {
  return /\b(follow|track|tracking|shipment|seguimiento|env[ií]o|zending|suivi|sendung|spedizione)\b/i.test(line);
}

function trackingLinkBlock({ draft, trackingUrl, language }) {
  if (hasPublicTrackingUrl(draft, trackingUrl)) return '';
  return [
    copyForLanguage(language, {
      English: 'You can follow the shipment here:',
      Spanish: 'Puedes seguir el envío aquí:',
      Catalan: 'Pots seguir l enviament aquí:',
      French: 'Vous pouvez suivre l envoi ici:',
      German: 'Du kannst die Sendung hier verfolgen:',
      Italian: 'Puoi seguire la spedizione qui:',
      Portuguese: 'Pode acompanhar o envio aqui:',
      Dutch: 'Je kunt de zending hier volgen:'
    }),
    '',
    trackingUrl
  ].join('\n');
}

function customsTrackingBlock({ draft, trackingUrl, language }) {
  const lines = [];

  if (!hasCorrectTrackingPhrase(draft)) {
    lines.push(copyForLanguage(language, {
      English: 'The tracking number is correct.',
      Spanish: 'El número de seguimiento es correcto.',
      Catalan: 'El número de seguiment és correcte.',
      French: 'Le numero de suivi est correct.',
      German: 'Die Sendungsnummer ist korrekt.',
      Italian: 'Il numero di tracking e corretto.',
      Portuguese: 'O numero de seguimento esta correto.',
      Dutch: 'Het trackingnummer is correct.'
    }));
  }

  if (!draft.includes(trackingUrl)) {
    if (lines.length) lines.push('');
    lines.push(copyForLanguage(language, {
      English: 'You can follow the shipment here:',
      Spanish: 'Puedes seguir el envío aquí:',
      Catalan: 'Pots seguir l enviament aquí:',
      French: 'Vous pouvez suivre l envoi ici:',
      German: 'Du kannst die Sendung hier verfolgen:',
      Italian: 'Puoi seguire la spedizione qui:',
      Portuguese: 'Pode acompanhar o envio aqui:',
      Dutch: 'Je kunt de zending hier volgen:'
    }));
    lines.push('', trackingUrl);
  }

  return lines.length ? lines.join('\n') : '';
}

function applyRequiredPolicyLinks(text, language) {
  return [
    ['shipping', needsShippingPolicy],
    ['refund', needsRefundPolicy],
    ['sizeGuide', needsSizeGuide]
  ].reduce((value, [type, predicate]) => {
    const withoutDuplicates = removePolicyLinkBlocks(value, POLICY_LINKS[type]);
    if (!predicate(withoutDuplicates)) return withoutDuplicates;
    return insertPolicyAfterMatchingParagraph(withoutDuplicates, language, type, predicate);
  }, text);
}

function needsShippingPolicy(text) {
  return /\b(7\s*[–-]\s*15|1\s*[–-]\s*3|delivery timeframe|delivery time(?:s)?|shipping time(?:s)?|shipping policy|processing time|usual delivery timeframe|plazo(?:s)? de entrega|tiempos? de env[ií]o|cu[aá]nto tarda|tardan|d[ií]as desde la compra)\b/i.test(text);
}

function needsRefundPolicy(text) {
  return /\b(refund|return|returns|exchange|return shipping|reembolso|devoluci[oó]n|devolver|cambio de talla|gastos de env[ií]o de la devoluci[oó]n|retour|remboursement|r[üu]ckgabe|rimborso|reso)\b/i.test(text);
}

function needsSizeGuide(text) {
  return /\b(size guide|sizing|measurements|what size|which size|gu[ií]a de tallas|tabla de tallas|medidas|qu[eé] talla|taille|guide des tailles|gr[oö][sß]entabelle|guida alle taglie)\b/i.test(text);
}

function removePolicyLinkBlocks(text, url) {
  const lines = text.split('\n');
  const remove = new Set();
  lines.forEach((line, index) => {
    if (line.trim() !== url) return;
    markLinkBlockForRemoval(lines, index, remove, isPolicyLabelLine);
  });
  return normalizeBlankLines(lines.filter((_, index) => !remove.has(index)).join('\n'));
}

function isPolicyLabelLine(line = '') {
  return /\b(policy|pol[ií]tica|politique|richtlinie|beleid|gu[ií]a|guide|maattabel|tabella)\b/i.test(line);
}

function insertPolicyAfterMatchingParagraph(text, language, type, predicate) {
  const paragraphs = splitParagraphs(text);
  const block = policyLinkBlock(language, type);
  const insertIndex = paragraphs.findIndex(paragraph => predicate(paragraph));

  if (insertIndex === -1) return insertBeforeSignature(text, block);

  paragraphs.splice(insertIndex + 1, 0, block);
  return normalizeBlankLines(paragraphs.join('\n\n'));
}

function splitParagraphs(text) {
  return normalizeBlankLines(text).split(/\n{2,}/);
}

function policyLinkBlock(language, type) {
  const labels = {
    shipping: {
      English: 'Shipping policy:',
      Spanish: 'Política de envíos:',
      Catalan: 'Política d enviaments:',
      French: 'Politique de livraison:',
      German: 'Versandrichtlinie:',
      Italian: 'Politica di spedizione:',
      Portuguese: 'Politica de envio:',
      Dutch: 'Verzendbeleid:'
    },
    refund: {
      English: 'Refund policy:',
      Spanish: 'Política de devoluciones:',
      Catalan: 'Política de devolucions:',
      French: 'Politique de retour:',
      German: 'Rueckerstattungsrichtlinie:',
      Italian: 'Politica di reso:',
      Portuguese: 'Politica de reembolso:',
      Dutch: 'Retourbeleid:'
    },
    sizeGuide: {
      English: 'Size guide:',
      Spanish: 'Guía de tallas:',
      Catalan: 'Guia de talles:',
      French: 'Guide des tailles:',
      German: 'Groessentabelle:',
      Italian: 'Guida alle taglie:',
      Portuguese: 'Guia de tamanhos:',
      Dutch: 'Maattabel:'
    }
  };

  return [
    copyForLanguage(language, labels[type]),
    '',
    POLICY_LINKS[type]
  ].join('\n');
}

function insertBeforeSignature(text, block) {
  const lines = text.split('\n');
  const signatureIndex = lines.findIndex(line => line.trim() === 'www.kitsrepublic.com');
  if (signatureIndex === -1) return normalizeBlankLines([text, '', block].join('\n'));

  lines.splice(signatureIndex, 0, '', block, '');
  return normalizeBlankLines(lines.join('\n'));
}

function hasCorrectTrackingPhrase(text) {
  return /tracking (number )?is correct|n[uú]mero de seguimiento es correcto|numero de seguimiento es correcto|num[eé]ro de suivi est correct|sendungsnummer ist korrekt|numero di tracking.*corretto|trackingnummer is correct/i.test(text);
}

function copyForLanguage(language, copy) {
  return copy[language] || copy.English;
}

function inferLanguageFromDraft(text) {
  if (/[¿¡ñáéíóú]|\b(hola|aduanas|seguimiento|env[ií]o)\b/i.test(text)) return 'Spanish';
  if (/[àèòïç]|\b(seguiment|enviament|comanda|samarreta)\b/i.test(text)) return 'Catalan';
  if (/[àâçéèêëîïôùûüÿ]|\b(bonjour|suivi|livraison)\b/i.test(text)) return 'French';
  if (/[äöüß]|\b(hallo|sendung|versand)\b/i.test(text)) return 'German';
  if (/\b(ciao|spedizione|tracciamento)\b/i.test(text)) return 'Italian';
  if (/[ãõç]|\b(ol[aá]|envio|seguimento)\b/i.test(text)) return 'Portuguese';
  if (/\b(hallo|zending|trackingnummer)\b/i.test(text)) return 'Dutch';
  return 'English';
}

function greetingEndIndex(lines) {
  const firstTextIndex = lines.findIndex(line => line.trim());
  if (firstTextIndex === -1) return 0;
  return firstTextIndex + 1;
}

function normalizeBlankLines(text) {
  return text.replace(/\n{3,}/g, '\n\n').trim();
}
