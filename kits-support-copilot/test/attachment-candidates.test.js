import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractAttachmentCandidates } from '../src/attachment-candidates.js';

test('extracts image attachments from latest incoming customer message', () => {
  const result = extractAttachmentCandidates([
    {
      id: 1,
      message_type: 0,
      created_at: '2026-06-20T10:00:00Z',
      content: 'Older photo',
      attachments: [
        {
          id: 11,
          file_type: 'image',
          content_type: 'image/png',
          filename: 'old.png',
          file_size: 120000,
          width: 800,
          height: 600,
          data_url: '/rails/active_storage/old'
        }
      ]
    },
    {
      id: 2,
      message_type: 'incoming',
      created_at: '2026-06-21T10:00:00Z',
      content: 'Latest photo',
      attachments: [
        {
          id: 22,
          file_type: 'image',
          content_type: 'image/jpeg',
          filename: 'proof.jpg',
          file_size: 240000,
          width: 1200,
          height: 900,
          data_url: '/rails/active_storage/proof'
        },
        {
          id: 23,
          file_type: 'image',
          content_type: 'image/png',
          filename: 'logo.png',
          file_size: 900,
          width: 40,
          height: 40,
          data_url: '/rails/active_storage/logo'
        }
      ]
    },
    {
      id: 3,
      message_type: 'outgoing',
      created_at: '2026-06-22T10:00:00Z',
      attachments: [
        {
          id: 33,
          file_type: 'image',
          content_type: 'image/jpeg',
          file_size: 120000,
          width: 800,
          height: 600,
          data_url: '/rails/active_storage/outgoing'
        }
      ]
    }
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].id, '22');
  assert.equal(result[0].filename, 'proof.jpg');
  assert.equal(result[0].message_id, 2);
  assert.match(result[0].source_message_preview, /Latest photo/);
});

test('ignores outgoing images and caps candidates to five', () => {
  const attachments = Array.from({ length: 7 }, (_, index) => ({
    id: index + 1,
    file_type: 'image',
    content_type: 'image/png',
    file_size: 90000,
    width: 600,
    height: 600,
    data_url: `/files/${index + 1}`
  }));

  const result = extractAttachmentCandidates([
    { id: 1, message_type: 1, created_at: '2026-06-21T10:00:00Z', attachments },
    { id: 2, message_type: 0, created_at: '2026-06-21T11:00:00Z', attachments }
  ]);

  assert.equal(result.length, 5);
  assert.equal(result[0].id, '1');
});

test('keeps image candidates that only have thumbnail urls', () => {
  const result = extractAttachmentCandidates([
    {
      id: 1,
      message_type: 'incoming',
      created_at: '2026-06-21T10:00:00Z',
      attachments: [
        {
          id: 44,
          file_type: 'image',
          content_type: 'image/jpeg',
          file_size: 120000,
          width: 700,
          height: 700,
          thumb_url: '/rails/active_storage/thumb'
        }
      ]
    }
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].id, '44');
  assert.equal(result[0].data_url, '');
  assert.equal(result[0].thumb_url, '/rails/active_storage/thumb');
});
