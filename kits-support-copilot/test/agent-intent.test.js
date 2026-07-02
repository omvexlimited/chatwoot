import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyAgentIntent,
  isAgentQuestionOnly,
  isExplicitNewDraftRequest,
  resolveCopilotInteraction
} from '../src/agent-intent.js';

test('detects short internal agent questions', () => {
  assert.equal(isAgentQuestionOnly('quiere refund de las 2 orders?'), true);
  assert.equal(isAgentQuestionOnly('me confirmas si quiere reembolso de #2605 y #2609?'), true);
  assert.equal(isAgentQuestionOnly('no entiendo, esto es un duplicado?'), true);
  assert.equal(isAgentQuestionOnly('no entiendo esto'), true);
  assert.equal(isAgentQuestionOnly('qué dice el último email?'), true);
  assert.equal(isAgentQuestionOnly('qué hago?'), true);
});

test('does not classify draft commands as internal questions', () => {
  assert.equal(isAgentQuestionOnly('dile que hemos recibido la devolución'), false);
  assert.equal(isAgentQuestionOnly('envíalo'), false);
  assert.equal(isAgentQuestionOnly('aprobado'), false);
  assert.equal(isAgentQuestionOnly('Generate a reply for this customer.'), false);
  assert.equal(isAgentQuestionOnly('qué le respondo?'), false);
});

test('classifies copilot interaction modes deterministically', () => {
  assert.equal(classifyAgentIntent('Generate a reply for this customer.'), 'initial_brief');
  assert.equal(classifyAgentIntent('/brief'), 'brief_command');
  assert.equal(classifyAgentIntent('/grammar'), 'utility_command');
  assert.equal(classifyAgentIntent('respondele en ingles'), 'draft_command');
  assert.equal(classifyAgentIntent('dije que lo escribas en ingles'), 'draft_command');
  assert.equal(classifyAgentIntent('qué le respondo?'), 'draft_command');
  assert.equal(classifyAgentIntent('quiere refund de las 2 orders?'), 'agent_question');
  assert.equal(classifyAgentIntent('hay riesgo de chargeback?'), 'agent_question');
});

test('resolves draft commands with existing drafts as faithful edits by default', () => {
  assert.equal(resolveCopilotInteraction({
    message: 'ofrécele un 20% de descuento para próximas compras',
    currentDraft: 'Hello, thanks for contacting us.\n\nwww.kitsrepublic.com'
  }), 'draft_edit');

  assert.equal(resolveCopilotInteraction({
    message: 'hazlo más corto',
    currentDraft: 'Hello, thanks for contacting us.\n\nwww.kitsrepublic.com'
  }), 'draft_edit');

  assert.equal(resolveCopilotInteraction({
    message: 'respondele en ingles',
    currentDraft: 'Bonjour,\n\nMerci pour votre message.'
  }), 'draft_edit');

  assert.equal(resolveCopilotInteraction({
    message: 'ofrécele un 20% de descuento para próximas compras',
    currentDraft: ''
  }), 'draft_command');
});

test('explicit new draft requests bypass draft edit mode', () => {
  assert.equal(isExplicitNewDraftRequest('haz un nuevo draft desde cero'), true);
  assert.equal(isExplicitNewDraftRequest('regenera desde cero'), true);
  assert.equal(isExplicitNewDraftRequest('ignore previous draft'), true);

  assert.equal(resolveCopilotInteraction({
    message: 'haz un nuevo draft desde cero',
    currentDraft: 'Existing draft'
  }), 'draft_command');

  assert.equal(resolveCopilotInteraction({
    message: 'regenera todo desde cero',
    currentDraft: 'Existing draft'
  }), 'draft_command');
});
