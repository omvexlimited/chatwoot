import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  filterCommandOptions,
  getActiveSlashToken,
  parseOrderLinkCommand,
  replaceActiveSlashToken
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
  assert.ok(commands.includes('/grammar'));
  assert.ok(commands.includes('/help'));
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
