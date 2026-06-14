import assert from 'node:assert/strict';
import { test } from 'node:test';
import { segmentCommandLinks } from '../public/command-links.js';

test('segments assistant text with clickable newticket approve command', () => {
  const segments = segmentCommandLinks('Reply with changes, or use /newticket approve to create it.');

  assert.deepEqual(segments, [
    { type: 'text', text: 'Reply with changes, or use ' },
    { type: 'command', text: '/newticket approve' },
    { type: 'text', text: ' to create it.' }
  ]);
});

test('segments multiple concrete commands', () => {
  const commands = segmentCommandLinks('Use /newticket cancel, /memories, /forget 12, /grammar, or /help.')
    .filter(segment => segment.type === 'command')
    .map(segment => segment.text);

  assert.deepEqual(commands, ['/newticket cancel', '/memories', '/forget 12', '/grammar', '/help']);
});

test('segments placeholder commands from help text', () => {
  const commands = segmentCommandLinks('Examples: /remember <text>, /forget <id>, /newticket <hint>.')
    .filter(segment => segment.type === 'command')
    .map(segment => segment.text);

  assert.deepEqual(commands, ['/remember <text>', '/forget <id>', '/newticket <hint>']);
});

test('segments remember command names', () => {
  const commands = segmentCommandLinks('Use /remember <text> or /remember to save a memory.')
    .filter(segment => segment.type === 'command')
    .map(segment => segment.text);

  assert.deepEqual(commands, ['/remember <text>', '/remember']);
});
