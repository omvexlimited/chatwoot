import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeAttachmentCandidates } from '../src/attachment-analysis.js';

test('skips image analysis with warning when OpenAI is not configured', async () => {
  const result = await analyzeAttachmentCandidates({
    config: {
      openaiApiKey: '',
      openaiBaseUrl: 'https://api.openai.com',
      chatwootBaseUrl: 'https://chatwoot.example.com'
    },
    attachments: [
      {
        id: 'att-1',
        file_type: 'image',
        content_type: 'image/jpeg',
        data_url: '/rails/active_storage/image.jpg'
      }
    ]
  });

  assert.equal(result.available, false);
  assert.equal(result.reason, 'openai_not_configured');
  assert.deepEqual(result.analyses, []);
  assert.match(result.warnings[0], /image analysis was skipped/i);
});

test('returns empty non-warning result when there are no image attachments', async () => {
  const result = await analyzeAttachmentCandidates({
    config: {
      openaiApiKey: '',
      openaiBaseUrl: 'https://api.openai.com'
    },
    attachments: []
  });

  assert.equal(result.available, false);
  assert.equal(result.reason, 'no_image_attachments');
  assert.deepEqual(result.warnings, []);
});
