import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractAttachmentCandidates } from '../src/attachment-candidates.js';

test('extracts image attachments from latest incoming customer message', () => {
  const result = extractAttachmentCandidates([
    {
      id: 1,
      message_type: 'incoming',
      created_at: '2026-06-20T10:00:00Z',
      content: 'Older photo',
      attachments: [
        { id: 10, file_type: 'image', content_type: 'image/jpeg', data_url: '/rails/active_storage/old.jpg' }
      ]
    },
    {
      id: 2,
      message_type: 'incoming',
      created_at: '2026-06-21T10:00:00Z',
      content: 'Latest photo',
      attachments: [
        { id: 20, file_type: 'image', content_type: 'image/png', data_url: '/rails/active_storage/new.png', width: 640 },
        { id: 21, file_type: 'file', content_type: 'application/pdf', data_url: '/invoice.pdf' }
      ]
    },
    {
      id: 3,
      message_type: 'outgoing',
      created_at: '2026-06-22T10:00:00Z',
      attachments: [
        { id: 30, file_type: 'image', content_type: 'image/jpeg', data_url: '/agent.jpg' }
      ]
    }
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].id, '20');
  assert.equal(result[0].message_id, 2);
  assert.equal(result[0].width, 640);
  assert.match(result[0].source_message_preview, /Latest photo/);
});
