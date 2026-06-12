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
  const commands = segmentCommandLinks('Use /newticket cancel, /memories, /forget 12, or /help.')
    .filter(segment => segment.type === 'command')
    .map(segment => segment.text);

  assert.deepEqual(commands, ['/newticket cancel', '/memories', '/forget 12', '/help']);
});

test('does not turn placeholder commands into clickable commands', () => {
  const segments = segmentCommandLinks('Examples: /remember <text>, /forget <id>, /newticket <hint>.');

  assert.deepEqual(segments, [
    { type: 'text', text: 'Examples: /remember <text>, /forget <id>, /newticket <hint>.' }
  ]);
});
