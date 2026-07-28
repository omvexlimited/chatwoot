import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveStatusPresentation } from '../public/status-label.js';

test('keeps combined status text in the full layout', () => {
  assert.deepEqual(
    resolveStatusPresentation({
      statusText: 'Context ready',
      draftStatusText: 'Draft preparing'
    }),
    {
      label: 'Context ready | Draft preparing',
      fullLabel: 'Context ready | Draft preparing',
      tone: 'neutral'
    }
  );
});

test('shows only drafting when context is ready in the sidebar', () => {
  assert.deepEqual(
    resolveStatusPresentation({
      statusText: 'Context ready',
      draftStatusText: 'Draft preparing',
      compact: true
    }),
    {
      label: 'Drafting...',
      fullLabel: 'Context ready | Draft preparing',
      tone: 'busy'
    }
  );
});

test('prioritizes errors over active and ready states', () => {
  assert.equal(
    resolveStatusPresentation({
      statusText: 'Context error',
      draftStatusText: 'Draft preparing',
      compact: true
    }).label,
    'Context error'
  );
  assert.deepEqual(
    resolveStatusPresentation({
      statusText: 'Context ready',
      draftStatusText: 'Draft error',
      compact: true
    }),
    {
      label: 'Draft error',
      fullLabel: 'Context ready | Draft error',
      tone: 'error'
    }
  );
});

test('prioritizes active operations over drafting', () => {
  const activeOperations = [
    ['Thinking...', 'Thinking...'],
    ['Linking #5480...', 'Linking...'],
    ['Forcing size_issue...', 'Forcing...'],
    ['Inserting reply...', 'Inserting...'],
    ['Saving note...', 'Saving...']
  ];

  activeOperations.forEach(([statusText, label]) => {
    assert.deepEqual(
      resolveStatusPresentation({
        statusText,
        draftStatusText: 'Draft preparing',
        compact: true
      }),
      {
        label,
        fullLabel: `${statusText} | Draft preparing`,
        tone: 'busy'
      }
    );
  });
});

test('shows drafting over completed operation feedback', () => {
  assert.equal(
    resolveStatusPresentation({
      statusText: 'Order linked',
      draftStatusText: 'Draft preparing',
      compact: true
    }).label,
    'Drafting...'
  );
});

test('compacts passive context and completed states', () => {
  assert.equal(
    resolveStatusPresentation({ statusText: 'Loading context...', compact: true }).label,
    'Loading...'
  );
  assert.equal(
    resolveStatusPresentation({ statusText: 'Context partially ready', compact: true }).label,
    'Partial'
  );
  assert.deepEqual(
    resolveStatusPresentation({
      statusText: 'Context ready',
      draftStatusText: 'Draft ready',
      compact: true
    }),
    {
      label: 'Ready',
      fullLabel: 'Context ready | Draft ready',
      tone: 'ready'
    }
  );
  assert.deepEqual(
    resolveStatusPresentation({ statusText: 'Private note saved', compact: true }),
    {
      label: 'Ready',
      fullLabel: 'Private note saved',
      tone: 'ready'
    }
  );
});
