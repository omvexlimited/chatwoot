import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildSelectedKnowledge,
  selectPlaybooksForCase,
  validatePlaybookCoverage
} from '../src/playbook-coverage.js';

const playbooks = [
  playbook('support-tone', [], ['shared']),
  playbook('official-links', [], ['shared']),
  playbook('returns', ['return_request'], ['returns']),
  playbook('customs', ['customs_pending'], ['tracking']),
  playbook('tag-match', [], ['size_issue']),
  {
    ...playbook('address-change', ['address_change'], ['order-edit']),
    title: 'Address Change',
    summary: 'Update a delivery address before supplier processing.'
  },
  {
    ...playbook('compensation-policy', ['compensation'], ['coupon']),
    title: 'Compensation Policy',
    summary: 'Approved compensation options.'
  }
];

test('requires every configured playbook and its compiled content', () => {
  assert.deepEqual(validatePlaybookCoverage(playbooks, ['returns', 'customs'], ['return_request', 'customs_pending']), {
    complete: true,
    required_count: 2,
    published_count: 7,
    missing_slugs: [],
    missing_content_slugs: [],
    missing_case_types: []
  });

  const incomplete = validatePlaybookCoverage(
    [{ ...playbook('returns', ['return_request']), knowledge_markdown: '' }],
    ['returns', 'customs'],
    ['return_request', 'customs_pending']
  );
  assert.equal(incomplete.complete, false);
  assert.deepEqual(incomplete.missing_slugs, ['customs']);
  assert.deepEqual(incomplete.missing_content_slugs, ['returns']);
  assert.deepEqual(incomplete.missing_case_types, ['customs_pending']);
});

test('selects shared playbooks and case matches from published metadata', () => {
  const selected = selectPlaybooksForCase(playbooks, 'customs_pending');
  assert.deepEqual(selected.map(item => item.slug), ['support-tone', 'official-links', 'customs']);

  const tagSelected = selectPlaybooksForCase(playbooks, 'size_issue');
  assert.deepEqual(tagSelected.map(item => item.slug), ['support-tone', 'official-links', 'tag-match']);
});

test('builds model knowledge from selected playbooks only', () => {
  const selected = selectPlaybooksForCase(playbooks, 'customs_pending');
  const markdown = buildSelectedKnowledge({
    knowledge: { mode: 'published', source: 'kits_republic_playbooks', version: 'v4' },
    selectedPlaybooks: selected
  });

  assert.match(markdown, /support-tone policy/);
  assert.match(markdown, /customs policy/);
  assert.doesNotMatch(markdown, /returns policy|tag-match policy/);
});

test('selects unclassified cases from published title summary and tags', () => {
  const address = selectPlaybooksForCase(playbooks, '', 'Please change my delivery address.');
  assert.ok(address.some(item => item.slug === 'address-change'));

  const compensation = selectPlaybooksForCase(
    playbooks,
    'customs_pending',
    'Offer the customer an approved compensation coupon.'
  );
  assert.ok(compensation.some(item => item.slug === 'customs'));
  assert.ok(compensation.some(item => item.slug === 'compensation-policy'));
});

test('does not duplicate compiled policy content in selected metadata', () => {
  const selected = selectPlaybooksForCase(playbooks, 'customs_pending');
  const promptMetadata = selected.map(({ knowledge_markdown: _knowledgeMarkdown, ...metadata }) => metadata);
  assert.doesNotMatch(JSON.stringify(promptMetadata), /customs policy/);
});

test('keeps the facts-only boundary when knowledge is unavailable', () => {
  const markdown = buildSelectedKnowledge({
    knowledge: { mode: 'facts_only', markdown: 'Verified facts only.' },
    selectedPlaybooks: playbooks
  });
  assert.equal(markdown, 'Verified facts only.');
});

function playbook(slug, caseTypes = [], tags = []) {
  return {
    slug,
    title: slug,
    case_types: caseTypes,
    tags,
    knowledge_markdown: `## ${slug}\n\n${slug} policy`
  };
}
