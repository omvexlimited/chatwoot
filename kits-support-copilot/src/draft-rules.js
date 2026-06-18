import { buildPublicTrackingUrl, firstTrackingNumberFromShopifyContext } from './tracking-url.js';
import { buildDeliveryTimingGuidance } from './delivery-guidance.js';

const POLICY_LINKS = {
  shipping: 'https://kitsrepublic.com/policies/shipping-policy',
  refund: 'https://kitsrepublic.com/policies/refund-policy',
  sizeGuide: 'https://kitsrepublic.com/pages/size-guide',
  terms: 'https://kitsrepublic.com/policies/terms-of-service',
  privacy: 'https://kitsrepublic.com/policies/privacy-policy',
  faqHelp: 'https://kitsrepublic.com/pages/faq-help-center'
};

export function enforceDraftRequirements({
  draft = '',
  supportCase,
  shopifyContext = {},
  responseLanguage,
  deliveryEstimateContext,
  latestMessage = ''
} = {}) {
  const text = String(draft || '').trim();
  if (!text) return String(draft || '');

  let normalizedText = normalizeDraftFormatting(text);
  const language = responseLanguage?.language || inferLanguageFromDraft(normalizedText);
  const trackingNumber = firstTrackingNumberFromShopifyContext(shopifyContext);
  const trackingUrl = buildPublicTrackingUrl(trackingNumber);

  normalizedText = ensureWarmOpening(normalizedText, language);

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
  normalizedText = removeProcessingTimeForShippedOrders(normalizedText, language, shopifyContext);
  normalizedText = ensureOrderStatusTimeframes({
    text: normalizedText,
    language,
    latestMessage,
    shopifyContext
  });
  normalizedText = dedupeDeliveryTimeframeParagraphs(normalizedText);
  normalizedText = applyRequiredPolicyLinks(normalizedText, language);
  if (trackingUrl) normalizedText = moveTrackingBlockBeforeSignature(normalizedText, trackingUrl, language);
  return normalizeDraftFormatting(normalizedText);
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
  return normalizeBlankLines(value);
}

function normalizeDashPunctuation(text) {
  return text
    .replace(/\s+—\s+/g, ', ')
    .replace(/\s+–\s+/g, ', ')
    .replace(/—/g, '-');
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

function ensureWarmOpening(text, language) {
  if (hasThanksText(text)) return text;
  return insertAfterGreetingOrAtStart(text, thankYouSentence(language));
}

function hasThanksText(text) {
  return /\b(thank you|thanks|gracias|moltes gr[aà]cies|merci|danke|vielen dank|grazie|obrigad[oa]|bedankt)\b/i.test(text);
}

function thankYouSentence(language) {
  return copyForLanguage(language, {
    English: 'Thank you for your email.',
    Spanish: 'Muchas gracias por tu correo.',
    Catalan: 'Moltes gràcies pel teu missatge.',
    French: 'Merci beaucoup pour votre message.',
    German: 'Vielen Dank fuer deine Nachricht.',
    Italian: 'Grazie mille per il tuo messaggio.',
    Portuguese: 'Muito obrigado pela tua mensagem.',
    Dutch: 'Bedankt voor je bericht.'
  });
}

function insertAfterGreetingOrAtStart(text, block) {
  const lines = text.split('\n');
  const firstTextIndex = lines.findIndex(line => line.trim());
  let insertIndex = firstTextIndex;
  if (firstTextIndex === -1) {
    insertIndex = 0;
  } else if (isGreetingLine(lines[firstTextIndex])) {
    insertIndex = firstTextIndex + 1;
  }
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
    ? [trackingLabel(language), '', trackingUrl].join('\n')
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

function ensureOrderStatusTimeframes({ text, language, latestMessage, shopifyContext }) {
  if (!isOrderStatusQuestion(latestMessage)) return text;
  if (!shopifyContext?.selected_order) return text;
  if (needsShippingPolicy(text)) return text;

  return insertBeforeSignature(
    text,
    orderStatusTimeframeParagraph(language, {
      includeProcessing: !isShippedOrTrackedOrder(shopifyContext.selected_order)
    })
  );
}

function isOrderStatusQuestion(text = '') {
  return /\b(where\s+is\s+my\s+order|where\s+my\s+order\s+is|order\s+update|update\s+on\s+(?:my\s+)?order|status\s+of\s+(?:my\s+)?order|order\s+status|when\s+will\s+(?:my\s+)?order|when\s+will\s+it\s+arrive|how\s+long\s+(?:will|does)|cu[aá]ndo\s+llega|d[oó]nde\s+est[aá]\s+mi\s+pedido|estado\s+de\s+mi\s+pedido|actualizaci[oó]n\s+de\s+mi\s+pedido|quanto\s+tarda|commande|bestellung|ordine)\b/i.test(text);
}

function orderStatusTimeframeParagraph(language, { includeProcessing = true } = {}) {
  if (!includeProcessing) return deliveryOnlyTimeframeParagraph(language);

  return copyForLanguage(language, {
    English: 'Our processing time is 1-3 days, and delivery normally takes 7-15 days from purchase.',
    Spanish: 'Nuestro tiempo de preparación es de 1-3 días, y la entrega normalmente tarda 7-15 días desde la compra.',
    Catalan: 'El nostre temps de preparació és d 1-3 dies, i l entrega normalment triga 7-15 dies des de la compra.',
    French: 'Notre délai de préparation est de 1 à 3 jours, et la livraison prend normalement 7 à 15 jours à partir de l achat.',
    German: 'Unsere Bearbeitungszeit beträgt 1-3 Tage, und die Lieferung dauert normalerweise 7-15 Tage ab Kaufdatum.',
    Italian: 'Il nostro tempo di preparazione è di 1-3 giorni, e la consegna richiede normalmente 7-15 giorni dall acquisto.',
    Portuguese: 'O nosso tempo de preparação é de 1-3 dias, e a entrega normalmente demora 7-15 dias a partir da compra.',
    Dutch: 'Onze verwerkingstijd is 1-3 dagen, en levering duurt normaal 7-15 dagen vanaf aankoop.'
  });
}

function deliveryOnlyTimeframeParagraph(language) {
  return copyForLanguage(language, {
    English: 'Delivery normally takes 7-15 days from purchase.',
    Spanish: 'La entrega normalmente tarda 7-15 días desde la compra.',
    Catalan: 'L entrega normalment triga 7-15 dies des de la compra.',
    French: 'La livraison prend normalement 7 à 15 jours à partir de l achat.',
    German: 'Die Lieferung dauert normalerweise 7-15 Tage ab Kaufdatum.',
    Italian: 'La consegna richiede normalmente 7-15 giorni dall acquisto.',
    Portuguese: 'A entrega normalmente demora 7-15 dias a partir da compra.',
    Dutch: 'Levering duurt normaal 7-15 dagen vanaf aankoop.'
  });
}

function removeProcessingTimeForShippedOrders(text, language, shopifyContext = {}) {
  if (!isShippedOrTrackedOrder(shopifyContext?.selected_order)) return text;

  const deliveryOnly = deliveryOnlyTimeframeParagraph(language);
  let value = String(text || '');
  value = value.replace(
    /\b(?:Our\s+)?processing time is (?:usually\s+)?1-3 days,?\s+and\s+delivery normally takes 7-15 days from purchase\.?/gi,
    deliveryOnly
  );
  value = value.replace(
    /\bProcessing time is usually 1-3 days,?\s+and\s+delivery normally takes 7-15 days from purchase\.?/gi,
    deliveryOnly
  );
  value = value.replace(
    /\bOur processing time is 1-3 days\.\s+Delivery normally takes 7-15 days from purchase\.?/gi,
    deliveryOnly
  );
  value = value.replace(
    /\bOur processing time is 1-3 days\.?/gi,
    ''
  );
  return normalizeBlankLines(value);
}

function dedupeDeliveryTimeframeParagraphs(text) {
  const paragraphs = splitParagraphs(text);
  let hasTimeframe = false;

  const kept = paragraphs.filter(paragraph => {
    if (!isDeliveryTimeframeParagraph(paragraph)) return true;
    if (!hasTimeframe) {
      hasTimeframe = true;
      return true;
    }
    return !isStandaloneDeliveryTimeframeParagraph(paragraph);
  });

  return normalizeBlankLines(kept.join('\n\n'));
}

function isDeliveryTimeframeParagraph(paragraph = '') {
  return /\b7\s*(?:[-–]|à|a|to)\s*15\s+(?:days?|jours?|d[ií]as?|dies|giorni|tage|dagen)\b/i.test(paragraph);
}

function isStandaloneDeliveryTimeframeParagraph(paragraph = '') {
  const value = String(paragraph || '').trim();
  if (value.length > 180) return false;
  if (/\n\s*https?:\/\//i.test(value)) return false;
  return /\b(delivery|livraison|entrega|enviament|consegna|lieferung|levering)\b/i.test(value);
}

function isShippedOrTrackedOrder(order = {}) {
  if (!order) return false;
  const fulfillmentStatus = String(order.fulfillment_status || order.display_fulfillment_status || '').toLowerCase();
  if (['fulfilled', 'partial', 'shipped'].includes(fulfillmentStatus)) return true;

  const fulfillments = Array.isArray(order.fulfillments) ? order.fulfillments : [];
  return fulfillments.some(fulfillment => {
    const displayStatus = String(fulfillment?.display_status || '').toLowerCase();
    if (['fulfilled', 'in_transit', 'delivered', 'confirmed'].includes(displayStatus)) return true;
    const numbers = Array.isArray(fulfillment?.tracking_numbers) ? fulfillment.tracking_numbers : [];
    const tracking = Array.isArray(fulfillment?.tracking) ? fulfillment.tracking : [];
    return numbers.some(Boolean) || tracking.some(item => item?.number);
  });
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
    lines.push(trackingLabel(language));
    lines.push('', trackingUrl);
  }

  return lines.length ? lines.join('\n') : '';
}

function trackingLabel(language) {
  return copyForLanguage(language, {
    English: 'You can follow the shipment here:',
    Spanish: 'Puedes seguir el envío aquí:',
    Catalan: 'Pots seguir l enviament aquí:',
    French: 'Vous pouvez suivre l envoi ici:',
    German: 'Du kannst die Sendung hier verfolgen:',
    Italian: 'Puoi seguire la spedizione qui:',
    Portuguese: 'Pode acompanhar o envio aqui:',
    Dutch: 'Je kunt de zending hier volgen:'
  });
}

function applyRequiredPolicyLinks(text, language) {
  return [
    ['shipping', needsShippingPolicy],
    ['refund', needsRefundPolicy],
    ['sizeGuide', needsSizeGuide],
    ['terms', needsTermsPolicy],
    ['privacy', needsPrivacyPolicy],
    ['faqHelp', needsFaqHelpCenter]
  ].reduce((value, [type, predicate]) => {
    const withoutDuplicates = removePolicyLinkBlocks(value, POLICY_LINKS[type]);
    if (!predicate(withoutDuplicates)) return withoutDuplicates;
    return insertPolicyAfterMatchingParagraph(withoutDuplicates, language, type, predicate);
  }, text);
}

function needsShippingPolicy(text) {
  return /\b(7\s*(?:[–-]|à|a|to)\s*15|1\s*(?:[–-]|à|a|to)\s*3|delivery timeframe|delivery time(?:s)?|shipping time(?:s)?|shipping policy|processing time|usual delivery timeframe|plazo(?:s)? de entrega|tiempos? de env[ií]o|cu[aá]nto tarda|tardan|d[ií]as desde la compra|d[eé]lai de livraison|livraison)\b/i.test(text);
}

function needsRefundPolicy(text) {
  return /\b(refund|return|returns|exchange|return shipping|reembolso|devoluci[oó]n|devolver|cambio de talla|gastos de env[ií]o de la devoluci[oó]n|retour|remboursement|r[üu]ckgabe|rimborso|reso)\b/i.test(text);
}

function needsSizeGuide(text) {
  return /\b(size guide|sizing|measurements|what size|which size|gu[ií]a de tallas|tabla de tallas|medidas|qu[eé] talla|taille|guide des tailles|gr[oö][sß]entabelle|guida alle taglie)\b/i.test(text);
}

function needsTermsPolicy(text) {
  return /\b(terms of service|terms and conditions|checkout terms|purchase conditions|conditions of purchase|t[eé]rminos (?:del servicio|y condiciones)|condiciones de compra|conditions g[eé]n[eé]rales|conditions d'achat|agb|allgemeine gesch[aä]ftsbedingungen|termini e condizioni|termos e condi[cç][oõ]es)\b/i.test(text);
}

function needsPrivacyPolicy(text) {
  return /\b(privacy policy|privacy|personal data|data protection|gdpr|privacidad|datos personales|protecci[oó]n de datos|politique de confidentialit[eé]|donn[eé]es personnelles|datenschutz|personenbezogene daten|privacybeleid|gegevensbescherming|informativa privacy|politica de privacidade)\b/i.test(text);
}

function needsFaqHelpCenter(text) {
  return /\b(faq|help center|help centre|faq help center|help documentation|preguntas frecuentes|centro de ayuda|centre d'aide|foire aux questions|hilfezentrum|centro assistenza|centro de ajuda|veelgestelde vragen)\b/i.test(text);
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
  return /\b(policy|pol[ií]tica|politique|richtlinie|beleid|gu[ií]a|guide|maattabel|tabella|terms|t[eé]rminos|privacy|privacidad|faq|help center|centro de ayuda)\b/i.test(line);
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
    },
    terms: {
      English: 'Terms of service:',
      Spanish: 'Términos del servicio:',
      Catalan: 'Termes del servei:',
      French: 'Conditions de service:',
      German: 'Nutzungsbedingungen:',
      Italian: 'Termini di servizio:',
      Portuguese: 'Termos de serviço:',
      Dutch: 'Servicevoorwaarden:'
    },
    privacy: {
      English: 'Privacy policy:',
      Spanish: 'Política de privacidad:',
      Catalan: 'Política de privacitat:',
      French: 'Politique de confidentialité:',
      German: 'Datenschutzrichtlinie:',
      Italian: 'Informativa sulla privacy:',
      Portuguese: 'Política de privacidade:',
      Dutch: 'Privacybeleid:'
    },
    faqHelp: {
      English: 'FAQ / Help Center:',
      Spanish: 'FAQ / Centro de ayuda:',
      Catalan: 'FAQ / Centre d ajuda:',
      French: 'FAQ / Centre d aide:',
      German: 'FAQ / Hilfezentrum:',
      Italian: 'FAQ / Centro assistenza:',
      Portuguese: 'FAQ / Centro de ajuda:',
      Dutch: 'FAQ / Helpcentrum:'
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

function isGreetingLine(line = '') {
  return /^(hi|hello|hey|hola|bonjour|hallo|ciao|ol[aá]|dear|salut|buenas|bom dia|boa tarde|good morning|good afternoon)[\s\wÀ-ÿ.'-]*,?$/i.test(line.trim());
}

function isSignOffLine(line = '') {
  return /^(best|best regards|kind regards|regards|un saludo|saludos|salutacions|cordialment|atentament|cordialement|viele gruesse|viele grüße|grazie|obrigado|obrigada|met vriendelijke groet),?$/i.test(line.trim());
}

function normalizeBlankLines(text) {
  return text.replace(/\n{3,}/g, '\n\n').trim();
}
