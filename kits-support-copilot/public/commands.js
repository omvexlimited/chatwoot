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
