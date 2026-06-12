import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatProvider } from '../src/provider-lookup.js';

test('formats assigned Kits Republic provider label from provider table fields', () => {
  const provider = formatProvider({
    provider_id: 1,
    provider_name: 'Mign Jin (1)',
    provider_code: '194939',
    provider_is_active: true,
    provider_is_default: true,
    provider_priority: 100,
    provider_assigned_at: '2026-06-11T10:00:00Z',
    provider_assignment_source: 'manual'
  });

  assert.deepEqual(provider, {
    id: 1,
    name: 'Mign Jin (1)',
    code: '194939',
    label: 'Mign Jin (1) · 194939',
    is_active: true,
    is_default: true,
    priority: 100,
    assigned_at: '2026-06-11T10:00:00Z',
    assignment_source: 'manual',
    assignment_note: null
  });
});

test('does not duplicate code when provider name already equals code', () => {
  const provider = formatProvider({
    provider_id: 1,
    provider_name: '194939',
    provider_code: '194939'
  });

  assert.equal(provider.label, '194939');
});
