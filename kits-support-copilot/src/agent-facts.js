const FACT_DEFINITIONS = [
  {
    type: 'customs_cleared',
    label: 'Agent confirmed customs have cleared.',
    matches: text => has(text, 'aduana') && hasAny(text, ['pasad', 'pasdo', 'paso', 'liberad', 'clear', 'release'])
  },
  {
    type: 'local_carrier_has_parcel',
    label: 'Agent confirmed the local carrier already has the parcel.',
    matches: text => {
      const carrier = hasAny(text, [
        'agencia',
        'transportista',
        'carrier',
        'local carrier',
        'royal mail',
        'ctt',
        'colissimo',
        'dhl',
        'evri'
      ]);
      const possession = hasAny(text, [
        'ya lo tiene',
        'lo tiene',
        'tiene el paquete',
        'already has',
        'has the parcel',
        'has it',
        'received the parcel',
        'handoff',
        'handed over',
        'with the carrier',
        'with local carrier'
      ]);
      return carrier && possession;
    }
  },
  {
    type: 'carrier_will_deliver_soon',
    label: 'Agent confirmed the carrier will deliver soon.',
    matches: text => {
      return /(?:mandar|enviar|entregar|deliver|send|arrive).{0,40}(?:pronto|soon|shortly)/i.test(text)
        || /(?:pronto|soon|shortly|en breve).{0,40}(?:entrega|deliver|arrive)/i.test(text)
        || /(?:list[oa]|ready).{0,40}(?:entreg|deliver)/i.test(text)
        || /(?:entregad|delivered).{0,40}(?:en breve|soon|shortly|pronto)/i.test(text);
    }
  },
  {
    type: 'parcel_ready_for_delivery',
    label: 'Agent confirmed the parcel is ready for delivery soon.',
    matches: text => {
      return /(?:list[oa]|ready).{0,50}(?:entreg|delivery)/i.test(text)
        || /(?:ready for delivery|ready to be delivered)/i.test(text);
    }
  },
  {
    type: 'customer_email_was_missing',
    label: 'Agent confirmed the order/customer email was missing before.',
    matches: text => {
      return has(text, 'email')
        && hasAny(text, ['no habia sido introducido', 'no estaba introducido', 'no estaba anadido', 'no estaba añadido', 'was missing', 'was not added', 'wasn\'t added']);
    }
  },
  {
    type: 'customer_email_added',
    label: 'Agent confirmed the customer email has now been added.',
    matches: text => {
      return has(text, 'email')
        && hasAny(text, ['ya se le hemos anadido', 'ya se lo hemos anadido', 'ya lo hemos anadido', 'ya esta anadido', 'ya se le hemos añadido', 'ya se lo hemos añadido', 'ya lo hemos añadido', 'ya esta añadido', 'has now been added', 'email added']);
    }
  },
  {
    type: 'future_updates_enabled',
    label: 'Agent confirmed future updates will be sent to the customer email.',
    matches: text => {
      return hasAny(text, ['proximas actualizaciones', 'próximas actualizaciones', 'future updates', 'next updates'])
        && hasAny(text, ['recibira', 'recibirá', 'will receive', 'sent there', 'sent to that email']);
    }
  },
  {
    type: 'order_access_link_provided',
    label: 'Agent provided a customer order access link.',
    matches: text => /https?:\/\/account\.kitsrepublic\.com\/orders\/\S+/i.test(text),
    details: text => ({
      url: text.match(/https?:\/\/account\.kitsrepublic\.com\/orders\/\S+/i)?.[0] || ''
    })
  },
  {
    type: 'replacement_processed',
    label: 'Agent confirmed the replacement has been processed.',
    matches: text => {
      return hasAny(text, ['reemplazo', 'replacement', 'camiseta nueva', 'nueva camiseta', 'replace'])
        && hasAny(text, ['tramitad', 'procesad', 'gestionad', 'confirmad', 'authorized', 'supplier', 'suplier', 'proveedor']);
    }
  },
  {
    type: 'supplier_confirmed',
    label: 'Agent confirmed the supplier has confirmed the action.',
    matches: text => hasAny(text, ['supplier', 'suplier', 'proveedor']) && hasAny(text, ['confirm', 'acept', 'approved', 'autor'])
  },
  {
    type: 'refund_processed',
    label: 'Agent confirmed the refund has been processed.',
    matches: text => hasAny(text, ['refund', 'reembolso', 'devolucion']) && hasAny(text, ['procesad', 'tramitad', 'emitid', 'issued', 'processed', 'done', 'hecho', 'realizad'])
  }
];

const SPECULATIVE_PATTERNS = [
  /\b(seguramente|probablemente|quizas|quiza|creo que|parece que|supongo|diria que|puede que|posiblemente)\b/i,
  /\b(maybe|probably|possibly|i think|it seems|i guess|should have)\b/i
];

export function extractAgentConfirmedFacts(chatMessages = []) {
  if (!Array.isArray(chatMessages)) return [];

  const facts = [];
  const seen = new Set();

  for (const message of chatMessages.slice(-12)) {
    if (message?.role === 'assistant') continue;

    const original = String(message?.content || '').trim();
    if (!original) continue;

    const text = normalizeText(original);
    const speculative = isSpeculative(text);

    for (const definition of FACT_DEFINITIONS) {
      if (seen.has(definition.type) || speculative || !definition.matches(text)) continue;
      seen.add(definition.type);
      facts.push({
        type: definition.type,
        confidence: 'confirmed_by_agent',
        source: 'agent_chat',
        summary: definition.label,
        source_excerpt: sourceExcerpt(original),
        ...(definition.details ? definition.details(original) : {})
      });
    }
  }

  return facts;
}

function isSpeculative(text) {
  return SPECULATIVE_PATTERNS.some(pattern => pattern.test(text));
}

function normalizeText(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function sourceExcerpt(value = '') {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= 240) return normalized;
  return `${normalized.slice(0, 237)}...`;
}

function has(text, needle) {
  return text.includes(needle);
}

function hasAny(text, needles) {
  return needles.some(needle => text.includes(needle));
}
