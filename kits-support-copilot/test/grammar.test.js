import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGrammarPrompt, runGrammarCommand } from '../src/grammar.js';
import { parseCopilotCommand } from '../src/memory.js';

test('builds strict spelling-only grammar prompt', () => {
  const prompt = buildGrammarPrompt('Hi,\n\nThnak you for youre email.');

  assert.match(prompt.system, /Correct only spelling/);
  assert.match(prompt.system, /Do not rewrite/);
  assert.match(prompt.system, /Do not change meaning, tone, structure/);
  assert.match(prompt.system, /Do not add new information/);
  assert.match(prompt.user, /Thnak you for youre email/);
});

test('runs /grammar and returns corrected draft without preserving old draft', async () => {
  const result = await runGrammarCommand({
    command: parseCopilotCommand('/grammar'),
    currentDraft: 'Hi,\n\nThnak you for youre email.',
    generate: async ({ prompt }) => {
      assert.match(prompt.system, /Do not rewrite/);
      return {
        assistant_message: 'Spelling corrected only.',
        draft: 'Hi,\n\nThank you for your email.',
        reasoning_summary: 'Corrected spelling only.',
        confidence: 'high',
        warnings: []
      };
    }
  });

  assert.equal(result.handled, true);
  assert.equal(result.draft, 'Hi,\n\nThank you for your email.');
  assert.equal(result.preserve_draft, false);
  assert.equal(result.skip_insert, false);
  assert.match(result.assistant_message, /Spelling corrected only/);
});

test('runs /grammar without a draft without modifying anything', async () => {
  const result = await runGrammarCommand({
    command: parseCopilotCommand('/grammar'),
    currentDraft: '',
    generate: async () => {
      throw new Error('generate should not be called without draft');
    }
  });

  assert.equal(result.handled, true);
  assert.equal(result.draft, '');
  assert.equal(result.preserve_draft, true);
  assert.equal(result.skip_insert, true);
  assert.match(result.assistant_message, /no draft/i);
});
