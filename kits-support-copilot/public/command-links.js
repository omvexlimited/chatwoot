import { linkableCommandTexts } from './commands.js';

const COMMAND_LINK_RE = new RegExp(
  `(^|[\\s([{'""“”‘’])(${linkableCommandTexts().map(commandToRegExp).join('|')})(?=$|[\\s.,;:!?)}\\]'"“”‘’])`,
  'gi'
);

export function segmentCommandLinks(text = '') {
  const value = String(text || '');
  const segments = [];
  let cursor = 0;

  for (const match of value.matchAll(COMMAND_LINK_RE)) {
    const prefix = match[1] || '';
    const command = match[2] || '';
    const start = Number(match.index) + prefix.length;
    const end = start + command.length;
    if (!command) continue;

    if (start > cursor) segments.push({ type: 'text', text: value.slice(cursor, start) });
    segments.push({ type: 'command', text: command });
    cursor = end;
  }

  if (cursor < value.length) segments.push({ type: 'text', text: value.slice(cursor) });
  return segments.length ? segments : [{ type: 'text', text: value }];
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function commandToRegExp(command = '') {
  if (command === '/forget <id>') return '\\/forget(?:\\s+(?:\\d+|<id>))';
  if (command === '/remember <text>') return '\\/remember(?:\\s+<text>)?';
  if (command === '/linkorder <order>') return '\\/linkorder(?:\\s+(?:#?\\d+|<order>))?';
  return escapeRegExp(command);
}
