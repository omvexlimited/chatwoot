const DRAFT_INTENT_PATTERNS = [
  /\b(dile|responde|responder|contesta|contéstale|contestale|envia|envía|envialo|envíalo|prepara|preparame|prepárame|genera|redacta|escribe|reescribe|cambia|añade|agrega|quita|pon)\b/i,
  /\b(hazlo|adelante|aprobado|aprovado|send it|send|reply|respond|write|draft|prepare|generate|tell (him|her|them|the customer))\b/i,
  /\b(que le digo|qué le digo|que le dices|qué le dices|que le respondo|qué le respondo|que respondemos|qué respondemos)\b/i,
  /\b(m[aá]s corto|mas corto|shorter|more concise|less info|menos info|quita lo|remove|add|change|rewrite|rephrase)\b/i,
  /\b(en ingl[eé]s|en ingles|in english|en franc[eé]s|en frances|in french|en alem[aá]n|en aleman|in german|en italiano|in italian|en portugu[eé]s|en portugues|in portuguese|en catal[aá]n|en catalan|in catalan)\b/i,
  /\b(dije que|te dije que|i said|i told you)\b.*\b(escrib|write|english|ingl[eé]s|ingles|franc[eé]s|frances)\b/i
];

const QUESTION_SIGNAL_PATTERNS = [
  /[¿?]/,
  /\b(me confirmas|confirmame|confírmame|puedes confirmar|can you confirm)\b/i,
  /\b(no entiendo|what does|qué dice|que dice|qué significa|que significa)\b/i,
  /\b(esto es|este es|esta es|es este|es esta|is this|is it|does this mean)\b/i
];

const FACTUAL_QUESTION_PATTERNS = [
  /\b(que hago|qué hago|que hacemos|qué hacemos|deberiamos|deberíamos|should we|what should we do)\b/i,
  /\b(quiere|quieren|pide|piden|pidio|pidió|solicita|solicitan|acepta|aceptan)\b/i,
  /\b(refund|reembolso|devolucion|devolución|return|chargeback|disputa|dispute)\b/i,
  /\b(order|orders|orden|ordenes|órdenes|pedido|pedidos|hilo|duplicado|caso)\b/i,
  /\b(tracking|entrega|entregado|recibido|devuelto|devolvio|devolvió|carrier|proveedor)\b/i,
  /\b(talla|size|factura|invoice|review|trustpilot|shopify)\b/i
];

export function classifyAgentIntent(value = '') {
  const text = normalize(value);
  if (!text) return 'draft_command';
  if (isBriefCommand(text)) return 'brief_command';
  if (/^generate a reply for this customer\.?$/i.test(text)) return 'initial_brief';
  if (text.startsWith('/')) return 'utility_command';
  if (DRAFT_INTENT_PATTERNS.some(pattern => pattern.test(text))) return 'draft_command';
  if (isQuestionOnlyText(text)) return 'agent_question';
  return 'draft_command';
}

export function isAgentQuestionOnly(value = '') {
  return classifyAgentIntent(value) === 'agent_question';
}

export function isBriefCommand(value = '') {
  return /^\/brief(?:\s+.*)?$/i.test(normalize(value));
}

function isQuestionOnlyText(text) {
  if (!text || text.startsWith('/')) return false;
  const hasQuestionSignal = QUESTION_SIGNAL_PATTERNS.some(pattern => pattern.test(text));
  if (!hasQuestionSignal) return false;

  if (/\b(no entiendo|what does|qué dice|que dice|qué significa|que significa)\b/i.test(text)) {
    return true;
  }

  if (/\b(what should i say|what do i tell|qué le digo|que le digo|qué le respondo|que le respondo)\b/i.test(text)) {
    return false;
  }

  if (FACTUAL_QUESTION_PATTERNS.some(pattern => pattern.test(text))) return true;
  if (text.length <= 140 && /[¿?]/.test(text)) return true;

  return false;
}

function normalize(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
