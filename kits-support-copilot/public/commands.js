export const COPILOT_COMMANDS = [
  {
    command: '/remember <text>',
    description: 'Save a global support memory.',
    keywords: ['memory', 'save', 'learn'],
    linkVariants: ['/remember']
  },
  {
    command: '/memories',
    description: 'Show the latest saved active memories.',
    keywords: ['memory', 'list']
  },
  {
    command: '/forget <id>',
    description: 'Disable a saved memory by ID.',
    keywords: ['memory', 'delete', 'remove']
  },
  {
    command: '/newticket',
    description: 'Prepare an issue proposal from the current context.',
    keywords: ['issue', 'ticket', 'proposal']
  },
  {
    command: '/newticket <hint>',
    description: 'Prepare an issue proposal with an optional hint.',
    keywords: ['issue', 'ticket', 'proposal']
  },
  {
    command: '/newticket approve',
    description: 'Create the pending issue proposal.',
    keywords: ['issue', 'ticket', 'create']
  },
  {
    command: '/newticket cancel',
    description: 'Cancel the pending issue proposal.',
    keywords: ['issue', 'ticket', 'cancel']
  },
  {
    command: '/linkorder <order>',
    description: 'Link this conversation to a Shopify order.',
    keywords: ['order', 'shopify', 'context'],
    linkVariants: ['/linkorder']
  },
  {
    command: '/unlinkorder',
    description: 'Remove the manual order override.',
    keywords: ['order', 'shopify', 'context']
  },
  {
    command: '/grammar',
    description: 'Fix spelling and grammar only.',
    keywords: ['spelling', 'correction']
  },
  {
    command: '/brief',
    description: 'Show a concise internal case brief.',
    keywords: ['brief', 'case', 'sop', 'summary']
  },
  {
    command: '/help',
    description: 'Show the command list.',
    keywords: ['commands']
  }
];

export function filterCommandOptions(query = '') {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) return COPILOT_COMMANDS;

  return COPILOT_COMMANDS.filter(option => {
    const command = normalizeQuery(option.command);
    const description = String(option.description || '').toLowerCase();
    const keywords = (option.keywords || []).join(' ').toLowerCase();
    return (
      command.startsWith(normalizedQuery) ||
      description.includes(normalizedQuery) ||
      keywords.includes(normalizedQuery)
    );
  });
}

export function getActiveSlashToken({ value = '', cursor = 0 } = {}) {
  const text = String(value || '');
  const position = clamp(Number(cursor) || 0, 0, text.length);
  const start = findTokenStart(text, position);
  const end = findTokenEnd(text, position);
  const token = text.slice(start, end);

  if (!token.startsWith('/')) return null;
  return {
    start,
    end,
    token,
    query: token.slice(1)
  };
}

export function replaceActiveSlashToken({ value = '', selectionStart = 0, selectionEnd = selectionStart, command = '' } = {}) {
  const text = String(value || '');
  const replacement = String(command || '').trim();
  const cursor = clamp(Number(selectionStart) || 0, 0, text.length);
  const token = getActiveSlashToken({ value: text, cursor });

  if (!token || !replacement) {
    return { value: text, cursor };
  }

  const end = Math.max(token.end, clamp(Number(selectionEnd) || token.end, token.end, text.length));
  const before = text.slice(0, token.start);
  const after = text.slice(end);
  const spacer = after && !/^\s/.test(after) ? ' ' : '';
  const nextValue = `${before}${replacement}${spacer}${after}`;
  const nextCursor = before.length + replacement.length;

  return { value: nextValue, cursor: nextCursor };
}

export function parseOrderLinkCommand(value = '') {
  const content = String(value || '').trim();
  const match = content.match(/^\/(un)?linkorder(?:\s+(.+))?$/i);
  if (!match) return null;

  if (match[1]) return { name: 'unlinkorder', orderRef: '' };

  const orderMatch = String(match[2] || '').match(/#?\d{2,}/);
  return {
    name: 'linkorder',
    orderRef: orderMatch ? normalizeOrderRef(orderMatch[0]) : ''
  };
}

export function shouldReadComposerForAgentMessage(value = '') {
  const content = String(value || '').trim();
  if (!content) return false;

  const normalized = normalizeText(content);
  if (normalized === '/grammar') return true;
  if (content.startsWith('/')) return false;
  if (isDraftLikeInstruction(normalized)) return true;
  if (isInternalAgentQuestion(normalized)) return false;

  return true;
}

export function linkableCommandTexts() {
  const commands = [];
  const seen = new Set();

  for (const option of COPILOT_COMMANDS) {
    for (const command of [option.command, ...(option.linkVariants || [])]) {
      if (seen.has(command)) continue;
      seen.add(command);
      commands.push(command);
    }
  }

  return commands.sort((a, b) => b.length - a.length);
}

function normalizeQuery(value = '') {
  return String(value || '').trim().replace(/^\/+/, '').toLowerCase();
}

function normalizeOrderRef(value = '') {
  const clean = String(value || '').trim().replace(/^#?/, '');
  return clean ? `#${clean}` : '';
}

function isDraftLikeInstruction(value = '') {
  return [
    /\b(dile|di le|responde|responder|respondele|resp[oó]ndele|contesta|contestale|cont[eé]stale|escribe|redacta|prepara|prep[aá]rale)\b/i,
    /\b(reescribe|cambia|a[nñ]ade|agrega|quita|pon|incluye|ofrece|ofrecele|ofr[eé]cele|ofrecer|offer|add|change|remove|rewrite|rephrase)\b/i,
    /\b(hazlo|haz la respuesta|m[aá]s corto|mas corto|shorter|more concise|less info|menos info)\b/i,
    /\b(en ingl[eé]s|en ingles|in english|en franc[eé]s|en frances|in french|en alem[aá]n|en aleman|in german|en italiano|in italian|en portugu[eé]s|en portugues|in portuguese|en catal[aá]n|en catalan|in catalan)\b/i,
    /\b(que le digo|qu[eé] le digo|que le dices|qu[eé] le dices|que le respondo|qu[eé] le respondo|que respondemos|qu[eé] respondemos)\b/i,
    /\b(dije que|te dije que|i said|i told you)\b.*\b(escrib|write|english|ingl[eé]s|ingles|franc[eé]s|frances)\b/i
  ].some(pattern => pattern.test(value));
}

function isInternalAgentQuestion(value = '') {
  return [
    /\b(no entiendo|me confirmas|confirmame|conf[ií]rmame|puedes confirmar|can you confirm)\b/i,
    /\b(que dice|qu[eé] dice|what does|qu[eé] significa|que significa)\b/i,
    /\b(que hago|qu[eé] hago|que hacemos|qu[eé] hacemos|deberiamos|deber[ií]amos|should we|what should we do)\b/i,
    /\b(esto es|este es|esta es|es este|es esta|is this|is it|does this mean)\b/i,
    /\b(quiere|quieren|pide|piden|pidio|pidi[oó]|solicita|solicitan|acepta|aceptan)\b/i
  ].some(pattern => pattern.test(value)) || /[¿?]/.test(value);
}

function normalizeText(value = '') {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function findTokenStart(text, cursor) {
  let start = cursor;
  while (start > 0 && !/\s/.test(text[start - 1])) start -= 1;
  return start;
}

function findTokenEnd(text, cursor) {
  let end = cursor;
  while (end < text.length && !/\s/.test(text[end])) end += 1;
  return end;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
