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
        || /(?:pronto|soon|shortly).{0,40}(?:entrega|deliver|arrive)/i.test(text);
    }
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
        summary: definition.label
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

function has(text, needle) {
  return text.includes(needle);
}

function hasAny(text, needles) {
  return needles.some(needle => text.includes(needle));
}
