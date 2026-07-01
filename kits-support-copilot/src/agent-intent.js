const DRAFT_INTENT_PATTERNS = [
  /\b(dile|responde|responder|envia|envía|envialo|envíalo|prepara|preparame|prepárame|genera|redacta|escribe|reescribe|cambia|añade|agrega|quita|pon)\b/i,
  /\b(hazlo|adelante|aprobado|aprovado|send it|send|reply|respond|write|draft|prepare|generate|tell (him|her|them|the customer))\b/i,
  /\b(que le digo|qué le digo|que le dices|qué le dices|que le respondo|qué le respondo|que respondemos|qué respondemos)\b/i
];

const QUESTION_SIGNAL_PATTERNS = [
  /[¿?]/,
  /\b(me confirmas|confirmame|confírmame|puedes confirmar|can you confirm)\b/i,
  /\b(no entiendo|what does|qué dice|que dice|qué significa|que significa)\b/i,
  /\b(esto es|este es|esta es|es este|es esta|is this|is it|does this mean)\b/i
];

const FACTUAL_QUESTION_PATTERNS = [
  /\b(quiere|quieren|pide|piden|pidio|pidió|solicita|solicitan|acepta|aceptan)\b/i,
  /\b(refund|reembolso|devolucion|devolución|return|chargeback|disputa|dispute)\b/i,
  /\b(order|orders|orden|ordenes|órdenes|pedido|pedidos|hilo|duplicado|caso)\b/i,
  /\b(tracking|entrega|entregado|recibido|devuelto|devolvio|devolvió|carrier|proveedor)\b/i,
  /\b(talla|size|factura|invoice|review|trustpilot|shopify)\b/i
];

export function isAgentQuestionOnly(value = '') {
  const text = normalize(value);
  if (!text || text.startsWith('/')) return false;
  if (DRAFT_INTENT_PATTERNS.some(pattern => pattern.test(text))) return false;

  const hasQuestionSignal = QUESTION_SIGNAL_PATTERNS.some(pattern => pattern.test(text));
  if (!hasQuestionSignal) return false;

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
