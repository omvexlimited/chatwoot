import { generateChatWithOpenAI } from './openai.js';

export async function runGrammarCommand({
  command,
  config,
  currentDraft = '',
  generate = generateChatWithOpenAI
} = {}) {
  if (!command || command.name !== 'grammar') return null;

  const draft = String(currentDraft || '').trim();
  if (!draft) {
    return grammarResponse({
      assistantMessage: 'There is no draft to correct yet.',
      draft: currentDraft,
      preserveDraft: true,
      skipInsert: true
    });
  }

  const result = await generate({
    config,
    prompt: buildGrammarPrompt(draft),
    fallback: {
      assistant_message: 'OpenAI is unavailable right now, so I kept the current draft unchanged.',
      draft,
      reasoning_summary: 'Grammar command fallback preserved the current draft.',
      confidence: 'low',
      warnings: ['OpenAI is unavailable, so no grammar correction was applied.']
    }
  });

  return grammarResponse({
    assistantMessage: result.assistant_message || 'Grammar corrected.',
    draft: result.draft || draft,
    reasoningSummary: result.reasoning_summary || 'Corrected spelling only.',
    confidence: result.confidence || 'medium',
    warnings: result.warnings || []
  });
}

export function buildGrammarPrompt(draft = '') {
  return {
    system: [
      'You are KR Copilot grammar correction mode.',
      'Correct only spelling, accents, obvious typos, capitalization mistakes, and basic orthographic errors in the provided customer draft.',
      'Do not rewrite the message.',
      'Do not change meaning, tone, structure, order of paragraphs, links, tracking numbers, order numbers, names, policy URLs, signature, or line breaks unless a spelling correction requires it.',
      'Do not add new information, remove information, shorten, expand, rephrase, translate, or improve style.',
      'If the draft is already correct, return it unchanged.',
      'Return strict JSON only with keys: assistant_message, draft, reasoning_summary, confidence, warnings.'
    ].join('\n'),
    user: [
      'Correct spelling only in this draft:',
      '',
      draft
    ].join('\n')
  };
}

function grammarResponse({
  assistantMessage,
  draft,
  reasoningSummary = 'Handled by KR Copilot grammar command.',
  confidence = 'high',
  warnings = [],
  preserveDraft = false,
  skipInsert = false
}) {
  return {
    handled: true,
    assistant_message: assistantMessage,
    draft,
    reasoning_summary: reasoningSummary,
    confidence,
    warnings,
    preserve_draft: preserveDraft,
    skip_insert: skipInsert
  };
}
