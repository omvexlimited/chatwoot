import { buildPublicTrackingUrl, firstTrackingNumberFromShopifyContext } from './tracking-url.js';

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
  normalizedText = removeObsoleteTournamentClaims(normalizedText);
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
    if (block) normalizedText = insertBeforeSignature(normalizedText, block);
    normalizedText = dedupeTrackingLinks(normalizedText, trackingUrl);
    normalizedText = removeOrphanTrackingLabels(normalizedText, trackingUrl);
    normalizedText = removeRedundantTrackingNumberLines(normalizedText, trackingNumber, trackingUrl);
  }

  normalizedText = enforceDeliveryEstimateClaims(normalizedText, deliveryEstimateContext, language);
  if (trackingUrl) normalizedText = moveTrackingBlockBeforeSignature(normalizedText, trackingUrl, language);
  return normalizeDraftFormatting(normalizedText);
}

function removeObsoleteTournamentClaims(text) {
  const tournamentTerms = '(?:world\\s+cup|mundial|fifa|coupe\\s+du\\s+monde|weltmeisterschaft|coppa\\s+del\\s+mondo|copa\\s+do\\s+mundo|wereldkampioenschap)';
  const sentencePattern = new RegExp(`[^.!?\\n]*${tournamentTerms}[^.!?\\n]*[.!?]?`, 'gi');
  return normalizeBlankLines(
    text.split('\n').map(line => line.replace(sentencePattern, '').trim()).join('\n')
  );
}

function canonicalizeTrackingLinks(text, trackingUrl) {
  return text.replace(
    /https?:\/\/(?:(?:193\.112\.141\.69|119\.91\.41\.88):8082|(?:www\.)?(?:17track\.net|shopify\.17track\.net|royalmail\.com|ctt\.pt|cttexpress\.com|ctt\.es|colissimo\.fr|laposte\.fr|evri\.com|hermesworld\.com|parcelsapp\.com|aftership\.com|dhl\.[a-z.]+))\/\S+|https?:\/\/(?:www\.)?kitsrepublic\.com\/(?:apps\/17TRACK\?nums=|tracking\/)\S+/gi,
    trackingUrl
  );
}

function normalizeDraftFormatting(text) {
  let value = String(text || '').replace(/\r\n/g, '\n');
  value = normalizeDashPunctuation(value);
  value = normalizeLabelUrlSpacing(value);
  value = normalizeSignatureSpacing(value);
  value = normalizeKnownLabelUrlBlockSpacing(value);
  return normalizeBlankLines(value);
}

function normalizeDashPunctuation(text) {
  return text
    .replace(/\s+—\s+/g, ', ')
    .replace(/\s+–\s+/g, ', ')
    .replace(/—/g, '-');
}

function normalizeLabelUrlSpacing(text) {
  return text.replace(/([^\n:]{2,80}:)\s*(https?:\/\/\S+)/g, '$1\n$2');
}

function normalizeSignatureSpacing(text) {
  const spaced = text.replace(
    /(Best,|Best regards,|Kind regards,|Regards,|Un saludo,|Saludos,|Salutacions,|Cordialment,|Atentament,|Cordialement,|Viele Gruesse,|Viele Grüße,|Mit freundlichen Grüßen,?|Grazie,|Obrigado,|Obrigada,|Met vriendelijke groet,?|Vriendelijke groet,?)\s*www\.kitsrepublic\.com/gi,
    (_, signoff) => `${signoff}\n\nwww.kitsrepublic.com`
  );
  return spaced.replace(
    /(Mit freundlichen Grüßen,?|Met vriendelijke groet,?|Vriendelijke groet,?)\n{2,}www\.kitsrepublic\.com/gi,
    (_, signoff) => `${signoff}\nwww.kitsrepublic.com`
  );
}

function normalizeKnownLabelUrlBlockSpacing(text) {
  const lines = text.split('\n');
  const result = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (isStandaloneTrackingLabel(line)) {
      const nextIndex = nextNonBlankLineIndex(lines, index + 1);
      if (nextIndex !== -1 && /^https?:\/\//i.test(lines[nextIndex].trim())) {
        result.push(ensureTrailingColon(line.trim()));
        result.push(lines[nextIndex].trim());
        index = nextIndex;
        continue;
      }
    }
    result.push(line);
  }

  return normalizeBlankLines(result.join('\n'));
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

function moveTrackingBlockBeforeSignature(text, trackingUrl, language) {
  const lines = text.split('\n');
  const linkIndex = lines.findIndex(line => line.trim() === trackingUrl);
  if (linkIndex === -1) return text;

  let startIndex = linkIndex;
  const previousContentIndex = previousNonBlankLineIndex(lines, linkIndex - 1);
  if (previousContentIndex !== -1 && isStandaloneTrackingLabel(lines[previousContentIndex])) {
    startIndex = previousContentIndex;
  }

  const block = startIndex === linkIndex
    ? [trackingLabel(language), trackingUrl].join('\n')
    : normalizeBlankLines(lines.slice(startIndex, linkIndex + 1).join('\n'));

  const remaining = lines.filter((_, index) => index < startIndex || index > linkIndex).join('\n');
  return insertBeforeSignature(normalizeBlankLines(remaining), block);
}

function removeOrphanTrackingLabels(text, trackingUrl) {
  const lines = text.split('\n');
  const remove = new Set();
  let keptTrackingBlock = false;

  lines.forEach((line, index) => {
    if (!isStandaloneTrackingLabel(line)) return;

    const nextContentIndex = nextNonBlankLineIndex(lines, index + 1);
    const hasTrackingLink = nextContentIndex !== -1 && lines[nextContentIndex].trim() === trackingUrl;
    if (hasTrackingLink && !keptTrackingBlock) {
      keptTrackingBlock = true;
      return;
    }

    markLabelOnlyForRemoval(lines, index, remove);
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

function enforceDeliveryEstimateClaims(text, deliveryEstimateContext) {
  const safeText = removeExactTimingClaims(text);
  if (hasReliableDeliveryEstimate(deliveryEstimateContext)) return safeText;

  let value = safeText.replace(
    /\b(?:Based on recent shipments with|Based on recent deliveries with|Based on recent carrier data for)\s+[^.\n]+\.?/gi,
    ''
  );

  value = value.replace(
    /\b(?:Seg[uú]n|Basado en|Basandonos en|Basándonos en)\s+(?:env[ií]os|entregas)\s+recientes[^.\n]*\.?/gi,
    ''
  );

  value = value.replace(
    /\b(?:this shipment|it|the shipment|delivery|shipping)\s+is\s+taking\s+longer\s+than\s+the\s+recent\s+carrier\s+average[^.\n]*\.?/gi,
    ''
  );

  value = value.replace(/\bthe\s+recent\s+carrier\s+average[^.\n]*\.?/gi, '');
  return normalizeBlankLines(value);
}

function removeExactTimingClaims(text) {
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
    ''
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
  return /\b(follow|track|tracking|shipment|seguimiento|env[ií]o|seguiment|enviament|zending|suivi|suivre|colis|sendung|spedizione)\b/i.test(line);
}

function isStandaloneTrackingLabel(line = '') {
  const value = line.trim();
  if (!/:\s*$/.test(value) || value.length > 90) return false;
  return /\b(follow|track|tracking|shipment|parcel|seguimiento|env[ií]o|rastrear|seguiment|enviament|zending|trackingnummer|suivi|suivre|colis|sendung|spedizione|tracciamento|envoi|livraison)\b/i.test(value);
}

function nextNonBlankLineIndex(lines, startIndex) {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (lines[index].trim()) return index;
  }
  return -1;
}

function previousNonBlankLineIndex(lines, startIndex) {
  for (let index = startIndex; index >= 0; index -= 1) {
    if (lines[index].trim()) return index;
  }
  return -1;
}

function markLabelOnlyForRemoval(lines, index, remove) {
  remove.add(index);

  let cursor = index + 1;
  while (cursor < lines.length && !lines[cursor].trim()) {
    remove.add(cursor);
    cursor += 1;
  }
}

function trackingLinkBlock({ draft, trackingUrl, language }) {
  if (hasPublicTrackingUrl(draft, trackingUrl)) return '';
  return [
    trackingLabel(language),
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
    lines.push(trackingLabel(language));
    lines.push(trackingUrl);
  }

  return lines.length ? lines.join('\n') : '';
}

function trackingLabel(language) {
  return copyForLanguage(language, {
    English: 'You can follow the shipment here:',
    Spanish: 'Puedes seguir el envío aquí:',
    Catalan: 'Pots seguir l enviament aquí:',
    French: 'Vous pouvez suivre l envoi ici:',
    German: 'Sie können die Sendung hier verfolgen:',
    Italian: 'Puoi seguire la spedizione qui:',
    Portuguese: 'Pode acompanhar o envio aqui:',
    Dutch: 'Je kunt de zending hier volgen:'
  });
}

function ensureTrailingColon(value = '') {
  return value.trim().endsWith(':') ? value.trim() : `${value.trim()}:`;
}

function insertBeforeSignature(text, block) {
  const lines = text.split('\n');
  const signatureIndex = lines.findIndex(line => line.trim() === 'www.kitsrepublic.com');
  if (signatureIndex === -1) return normalizeBlankLines([text, '', block].join('\n'));

  const previousContentIndex = previousNonBlankLineIndex(lines, signatureIndex - 1);
  const insertIndex = previousContentIndex !== -1 && isSignOffLine(lines[previousContentIndex])
    ? previousContentIndex
    : signatureIndex;

  lines.splice(insertIndex, 0, '', block, '');
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

function isSignOffLine(line = '') {
  return /^(best|best regards|kind regards|regards|un saludo|saludos|salutacions|cordialment|atentament|cordialement|viele gruesse|viele grüße|mit freundlichen grüßen|grazie|obrigado|obrigada|met vriendelijke groet|vriendelijke groet),?$/i.test(line.trim());
}

function normalizeBlankLines(text) {
  return text.replace(/\n{3,}/g, '\n\n').trim();
}
