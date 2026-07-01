import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAgentQuestionOnly } from '../src/agent-intent.js';

test('detects short internal agent questions', () => {
  assert.equal(isAgentQuestionOnly('quiere refund de las 2 orders?'), true);
  assert.equal(isAgentQuestionOnly('me confirmas si quiere reembolso de #2605 y #2609?'), true);
  assert.equal(isAgentQuestionOnly('no entiendo, esto es un duplicado?'), true);
  assert.equal(isAgentQuestionOnly('qué dice el último email?'), true);
});

test('does not classify draft commands as internal questions', () => {
  assert.equal(isAgentQuestionOnly('dile que hemos recibido la devolución'), false);
  assert.equal(isAgentQuestionOnly('envíalo'), false);
  assert.equal(isAgentQuestionOnly('aprobado'), false);
  assert.equal(isAgentQuestionOnly('Generate a reply for this customer.'), false);
  assert.equal(isAgentQuestionOnly('qué le respondo?'), false);
});
