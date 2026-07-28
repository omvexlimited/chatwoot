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

test('downloads attachment images concurrently before vision analysis', async t => {
  const originalFetch = globalThis.fetch;
  let activeDownloads = 0;
  let maxActiveDownloads = 0;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/v1/responses')) {
      const request = JSON.parse(options.body);
      const imageIds = request.input[0].content
        .filter(item => item.type === 'input_text' && item.text.startsWith('Attachment id:'))
        .map(item => item.text.split(':').at(-1).trim());
      return {
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({
            analyses: imageIds.map(id => ({
              id,
              evidence_type: 'other',
              summary: `Image ${id}`,
              visible_text: [],
              signals: [],
              confidence: 'high'
            }))
          })
        })
      };
    }

    activeDownloads += 1;
    maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads);
    await new Promise(resolve => setTimeout(resolve, 20));
    activeDownloads -= 1;
    return {
      ok: true,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer
    };
  };

  const result = await analyzeAttachmentCandidates({
    config: {
      openaiApiKey: 'test-key',
      openaiBaseUrl: 'https://api.openai.test',
      openaiModel: 'gpt-5.5',
      chatwootBaseUrl: 'https://chatwoot.example.com',
      attachmentDownloadTimeoutMs: 1000
    },
    attachments: ['one', 'two', 'three'].map(id => ({
      id,
      file_type: 'image',
      content_type: 'image/jpeg',
      data_url: `/images/${id}.jpg`
    }))
  });

  assert.equal(result.available, true);
  assert.equal(result.analyzed_count, 3);
  assert.ok(maxActiveDownloads > 1);
});
