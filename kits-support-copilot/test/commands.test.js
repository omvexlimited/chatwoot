import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  filterCommandOptions,
  getActiveSlashToken,
  parseCaseOverrideCommand,
  parseOrderLinkCommand,
  replaceActiveSlashToken,
  shouldReadComposerForAgentMessage
} from '../public/commands.js';

test('filters commands by slash query', () => {
  const commands = filterCommandOptions('/new').map(option => option.command);

  assert.deepEqual(commands, ['/newticket', '/newticket <hint>', '/newticket approve', '/newticket cancel']);
});

test('returns all commands for empty slash query', () => {
  const commands = filterCommandOptions('').map(option => option.command);

  assert.ok(commands.includes('/remember <text>'));
  assert.ok(commands.includes('/linkorder <order>'));
  assert.ok(commands.includes('/unlinkorder'));
  assert.ok(commands.includes('/case <case_type>'));
  assert.ok(commands.includes('/case return_request'));
  assert.ok(commands.includes('/case clear'));
  assert.ok(commands.includes('/grammar'));
  assert.ok(commands.includes('/brief'));
  assert.ok(commands.includes('/help'));
});

test('filters case override commands by slash query', () => {
  const commands = filterCommandOptions('/case return').map(option => option.command);

  assert.deepEqual(commands, ['/case return_request']);
});

test('filters order link commands by slash query', () => {
  const linkCommands = filterCommandOptions('/link').map(option => option.command);
  const unlinkCommands = filterCommandOptions('/unlink').map(option => option.command);

  assert.deepEqual(linkCommands, ['/linkorder <order>']);
  assert.deepEqual(unlinkCommands, ['/unlinkorder']);
});

test('detects the active slash token under the cursor', () => {
  const value = 'please /new now';
  const token = getActiveSlashToken({ value, cursor: 'please /new'.length });

  assert.deepEqual(token, {
    start: 7,
    end: 11,
    token: '/new',
    query: 'new'
  });
});

test('does not detect normal text as a slash token', () => {
  const token = getActiveSlashToken({ value: 'please help', cursor: 6 });

  assert.equal(token, null);
});

test('replaces only the current slash token', () => {
  const result = replaceActiveSlashToken({
    value: 'please /new now',
    selectionStart: 'please /new'.length,
    command: '/newticket approve'
  });

  assert.deepEqual(result, {
    value: 'please /newticket approve now',
    cursor: 'please /newticket approve'.length
  });
});

test('inserts placeholder commands for editing', () => {
  const result = replaceActiveSlashToken({
    value: '/rem',
    selectionStart: 4,
    command: '/remember <text>'
  });

  assert.deepEqual(result, {
    value: '/remember <text>',
    cursor: '/remember <text>'.length
  });
});

test('parses local order link commands', () => {
  assert.deepEqual(parseOrderLinkCommand('/linkorder #2280'), {
    name: 'linkorder',
    orderRef: '#2280'
  });
  assert.deepEqual(parseOrderLinkCommand('/linkorder 2280'), {
    name: 'linkorder',
    orderRef: '#2280'
  });
  assert.deepEqual(parseOrderLinkCommand('/unlinkorder'), {
    name: 'unlinkorder',
    orderRef: ''
  });
});

test('parses missing order in local order link command', () => {
  assert.deepEqual(parseOrderLinkCommand('/linkorder'), {
    name: 'linkorder',
    orderRef: ''
  });
});

test('parses local case override commands', () => {
  assert.deepEqual(parseCaseOverrideCommand('/case return_request'), {
    name: 'case',
    action: 'set',
    caseType: 'return_request',
    validTypes: parseCaseOverrideCommand('/case').validTypes
  });
  assert.deepEqual(parseCaseOverrideCommand('/case refund request'), {
    name: 'case',
    action: 'set',
    caseType: 'refund_request',
    validTypes: parseCaseOverrideCommand('/case').validTypes
  });
  assert.deepEqual(parseCaseOverrideCommand('/case clear'), {
    name: 'case',
    action: 'clear',
    caseType: '',
    validTypes: parseCaseOverrideCommand('/case').validTypes
  });
  assert.deepEqual(parseCaseOverrideCommand('/case auto'), {
    name: 'case',
    action: 'clear',
    caseType: '',
    validTypes: parseCaseOverrideCommand('/case').validTypes
  });
  assert.equal(parseCaseOverrideCommand('/help'), null);
});

test('rejects unknown local case override commands', () => {
  const result = parseCaseOverrideCommand('/case nonsense');

  assert.equal(result.action, 'invalid');
  assert.equal(result.caseType, 'nonsense');
  assert.ok(result.validTypes.includes('return_request'));
});

test('reads Chatwoot composer for draft-like agent instructions', () => {
  assert.equal(shouldReadComposerForAgentMessage('/grammar'), true);
  assert.equal(shouldReadComposerForAgentMessage('ofrécele un 20% de descuento para próximas compras'), true);
  assert.equal(shouldReadComposerForAgentMessage('hazlo más corto'), true);
  assert.equal(shouldReadComposerForAgentMessage('respondele en ingles'), true);
  assert.equal(shouldReadComposerForAgentMessage('dije que lo escribas en inglés'), true);
});

test('does not read Chatwoot composer for utility commands or internal questions', () => {
  assert.equal(shouldReadComposerForAgentMessage('/brief'), false);
  assert.equal(shouldReadComposerForAgentMessage('/case return_request'), false);
  assert.equal(shouldReadComposerForAgentMessage('/newticket'), false);
  assert.equal(shouldReadComposerForAgentMessage('/remember test'), false);
  assert.equal(shouldReadComposerForAgentMessage('quiere refund de las 2 orders?'), false);
  assert.equal(shouldReadComposerForAgentMessage('qué hago?'), false);
  assert.equal(shouldReadComposerForAgentMessage('no entiendo esto'), false);
});
