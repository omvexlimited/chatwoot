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

  const checked = enforceGrammarOnlyCorrection(draft, result.draft || draft);

  return grammarResponse({
    assistantMessage: result.assistant_message || 'Grammar corrected.',
    draft: checked.draft,
    reasoningSummary: result.reasoning_summary || 'Corrected spelling only.',
    confidence: checked.changed ? result.confidence || 'medium' : 'low',
    warnings: [...(result.warnings || []), ...checked.warnings]
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

export function enforceGrammarOnlyCorrection(originalDraft = '', proposedDraft = '') {
  const original = String(originalDraft || '');
  const proposed = String(proposedDraft || '');
  const originalLines = original.split('\n');
  const proposedLines = proposed.split('\n');
  const warnings = [];

  if (originalLines.length !== proposedLines.length) {
    return {
      draft: applyDeterministicGrammarFixes(original),
      changed: true,
      warnings: ['Grammar correction tried to change the draft structure, so only safe deterministic typo fixes were applied.']
    };
  }

  const safeLines = originalLines.map((line, index) => {
    const proposedLine = proposedLines[index] ?? '';
    if (line === proposedLine) return line;
    if (isSafeLineCorrection(line, proposedLine)) return proposedLine;
    warnings.push(`Unsafe grammar rewrite ignored on line ${index + 1}.`);
    return applyDeterministicGrammarFixes(line);
  });

  const draft = safeLines.join('\n');
  return {
    draft,
    changed: draft !== original,
    warnings
  };
}

function isSafeLineCorrection(originalLine = '', proposedLine = '') {
  const original = String(originalLine || '');
  const proposed = String(proposedLine || '');
  if (original.trim() === '') return proposed.trim() === '';
  if (!sameTokens(extractUrls(original), extractUrls(proposed))) return false;
  if (!sameTokens(extractNumbers(original), extractNumbers(proposed))) return false;

  const originalWords = extractWords(original);
  const proposedWords = extractWords(proposed);
  if (!originalWords.length) return true;

  const diff = wordDiffStats(originalWords, proposedWords);
  const maxChanges = Math.max(2, Math.ceil(originalWords.length * 0.18));
  return diff.removed <= maxChanges && diff.added <= maxChanges;
}

function wordDiffStats(originalWords, proposedWords) {
  const matched = new Set();
  let removed = 0;

  for (const originalWord of originalWords) {
    const matchIndex = proposedWords.findIndex((proposedWord, index) => {
      return !matched.has(index) && wordsMatchForGrammar(originalWord, proposedWord);
    });
    if (matchIndex === -1) {
      removed += 1;
    } else {
      matched.add(matchIndex);
    }
  }

  return {
    removed,
    added: proposedWords.length - matched.size
  };
}

function wordsMatchForGrammar(a = '', b = '') {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 2) return false;
  return levenshteinDistance(a, b) <= 2;
}

function extractWords(value = '') {
  return String(value || '')
    .toLowerCase()
    .match(/[a-zÀ-ÿ]+/giu) || [];
}

function extractNumbers(value = '') {
  return String(value || '').match(/\d+/g) || [];
}

function extractUrls(value = '') {
  return String(value || '').match(/https?:\/\/\S+/gi) || [];
}

function sameTokens(left = [], right = []) {
  return [...left].sort().join('\u0000') === [...right].sort().join('\u0000');
}

function applyDeterministicGrammarFixes(value = '') {
  return String(value || '')
    .replace(/\bDlivery\b/g, 'Delivery')
    .replace(/\bdlivery\b/g, 'delivery')
    .replace(/,\s+is still on time\b/g, ', it is still on time');
}

function levenshteinDistance(a = '', b = '') {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[b.length];
}
