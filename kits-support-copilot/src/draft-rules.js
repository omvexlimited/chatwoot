import { buildPublicTrackingUrl, firstTrackingNumberFromShopifyContext } from './tracking-url.js';

const POLICY_LINKS = {
  shipping: 'https://kitsrepublic.com/policies/shipping-policy',
  refund: 'https://kitsrepublic.com/policies/refund-policy',
  sizeGuide: 'https://kitsrepublic.com/pages/size-guide'
};

export function enforceDraftRequirements({ draft = '', supportCase, shopifyContext = {}, responseLanguage } = {}) {
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
    /(Best regards,|Kind regards,|Regards,|Un saludo,|Saludos,|Cordialement,|Viele Gruesse,|Viele Grüße,|Grazie,|Obrigado,|Obrigada,|Met vriendelijke groet,)\s*www\.kitsrepublic\.com/gi,
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
      French: 'Politique de livraison:',
      German: 'Versandrichtlinie:',
      Italian: 'Politica di spedizione:',
      Portuguese: 'Politica de envio:',
      Dutch: 'Verzendbeleid:'
    },
    refund: {
      English: 'Refund policy:',
      Spanish: 'Política de devoluciones:',
      French: 'Politique de retour:',
      German: 'Rueckerstattungsrichtlinie:',
      Italian: 'Politica di reso:',
      Portuguese: 'Politica de reembolso:',
      Dutch: 'Retourbeleid:'
    },
    sizeGuide: {
      English: 'Size guide:',
      Spanish: 'Guía de tallas:',
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
