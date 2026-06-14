import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGrammarPrompt, enforceGrammarOnlyCorrection, runGrammarCommand } from '../src/grammar.js';
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

test('rejects grammar rewrites that add new support information', async () => {
  const original = [
    'Hi Kamal,',
    '',
    'Thank you for your email.',
    '',
    'Dlivery normally takes 7-15 days from purchase, so since it was purchased on June 4, is still on time.',
    '',
    'Shipping policy:',
    '',
    'https://kitsrepublic.com/policies/shipping-policy'
  ].join('\n');
  const unsafe = [
    'Hi Kamal,',
    '',
    'Thank you for your email.',
    '',
    'Processing time is usually 1-3 days, and delivery normally takes 7-15 days from purchase.',
    '',
    'Shipping policy:',
    '',
    'https://kitsrepublic.com/policies/shipping-policy'
  ].join('\n');

  const result = enforceGrammarOnlyCorrection(original, unsafe);

  assert.equal(
    result.draft,
    [
      'Hi Kamal,',
      '',
      'Thank you for your email.',
      '',
      'Delivery normally takes 7-15 days from purchase, so since it was purchased on June 4, it is still on time.',
      '',
      'Shipping policy:',
      '',
      'https://kitsrepublic.com/policies/shipping-policy'
    ].join('\n')
  );
  assert.deepEqual(result.warnings, ['Unsafe grammar rewrite ignored on line 5.']);
});

test('accepts safe grammar corrections without changing links or numbers', () => {
  const result = enforceGrammarOnlyCorrection(
    'Thnak you for youre email.\n\nOrder #1674 ships in 7-15 days.\n\nhttps://kitsrepublic.com/policies/shipping-policy',
    'Thank you for your email.\n\nOrder #1674 ships in 7-15 days.\n\nhttps://kitsrepublic.com/policies/shipping-policy'
  );

  assert.equal(
    result.draft,
    'Thank you for your email.\n\nOrder #1674 ships in 7-15 days.\n\nhttps://kitsrepublic.com/policies/shipping-policy'
  );
  assert.deepEqual(result.warnings, []);
});
