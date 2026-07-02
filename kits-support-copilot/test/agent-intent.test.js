import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyAgentIntent, isAgentQuestionOnly } from '../src/agent-intent.js';

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
