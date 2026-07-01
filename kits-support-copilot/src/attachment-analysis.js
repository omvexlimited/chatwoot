const MAX_ANALYZED_ATTACHMENTS = 3;
const MAX_IMAGE_BYTES = 4_000_000;
const OPENAI_TIMEOUT_MS = 20000;

export async function analyzeAttachmentCandidates({ config, attachments = [] } = {}) {
  const candidates = normalizeCandidates(attachments);
  if (!candidates.length) {
    return analysisResult({ available: false, reason: 'no_image_attachments' });
  }

  if (!config?.openaiApiKey) {
    return analysisResult({
      available: false,
      reason: 'openai_not_configured',
      warnings: ['OpenAI is not configured, so image analysis was skipped.']
    });
  }

  const warnings = [];
  const images = [];
  for (const attachment of candidates.slice(0, MAX_ANALYZED_ATTACHMENTS)) {
    try {
      images.push(await downloadAttachmentImage({ config, attachment }));
    } catch (error) {
      warnings.push(`Image ${attachment.id || attachment.filename || 'attachment'} could not be analyzed: ${error.message}`);
    }
  }

  if (!images.length) {
    return analysisResult({
      available: false,
      reason: 'download_failed',
      warnings
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.openaiBaseUrl}/v1/responses`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openaiApiKey}`
      },
      body: JSON.stringify(buildVisionRequestBody({ config, images }))
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.error?.message || `OpenAI HTTP ${response.status}`;
      return analysisResult({
        available: false,
        reason: 'openai_failed',
        warnings: [...warnings, `OpenAI image analysis failed: ${message}`]
      });
    }

    const parsed = parseJsonObject(extractOutputText(data));
    const analyses = normalizeAnalyses(parsed?.analyses, images);
    if (!analyses.length) {
      return analysisResult({
        available: false,
        reason: 'openai_empty_analysis',
        warnings: [...warnings, 'OpenAI image analysis returned no usable image summary.']
      });
    }

    return analysisResult({
      available: true,
      reason: 'analyzed',
      source: 'openai_vision',
      analyzed_count: analyses.length,
      analyses,
      warnings
    });
  } catch (error) {
    return analysisResult({
      available: false,
      reason: error.name === 'AbortError' ? 'openai_timeout' : 'openai_exception',
      warnings: [...warnings, `OpenAI image analysis failed: ${error.message}`]
    });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeCandidates(attachments = []) {
  return (Array.isArray(attachments) ? attachments : [])
    .filter(attachment => attachment?.data_url || attachment?.thumb_url)
    .filter(attachment => String(attachment?.content_type || '').startsWith('image/') || String(attachment?.file_type || '').toLowerCase() === 'image')
    .slice(0, MAX_ANALYZED_ATTACHMENTS);
}

async function downloadAttachmentImage({ config, attachment }) {
  const url = absoluteChatwootUrl({ config, url: attachment.data_url || attachment.thumb_url });
  if (!url) throw new Error('missing image URL');

  const response = await fetch(url, {
    method: 'GET',
    headers: config?.chatwootApiToken ? { api_access_token: config.chatwootApiToken } : {}
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const contentType = cleanContentType(response.headers?.get?.('content-type') || attachment.content_type || 'image/jpeg');
  if (!contentType.startsWith('image/')) throw new Error(`not an image (${contentType || 'unknown content type'})`);

  const arrayBuffer = await response.arrayBuffer();
  if (!arrayBuffer.byteLength) throw new Error('empty image');
  if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) throw new Error('image larger than 4 MB');

  const base64 = Buffer.from(arrayBuffer).toString('base64');
  return {
    id: String(attachment.id || attachment.attachment_id || attachment.filename || 'attachment'),
    filename: attachment.filename || null,
    content_type: contentType,
    file_size: arrayBuffer.byteLength,
    source_message_preview: attachment.source_message_preview || '',
    data_url: `data:${contentType};base64,${base64}`
  };
}

function buildVisionRequestBody({ config, images }) {
  const content = [
    {
      type: 'input_text',
      text: [
        'Analyze the attached customer support images for Kits Republic.',
        'Identify visible tracking numbers, carrier pages, delivery proof, jersey details, size labels, customization, product mismatch, damage, or other useful evidence.',
        'Do not guess. If something is unclear, say unclear.',
        'Return strict JSON only: {"analyses":[{"id":"...","evidence_type":"tracking|delivery_proof|product_photo|size_label|damage|other","summary":"...","visible_text":["..."],"signals":["..."],"confidence":"high|medium|low"}]}',
        '',
        'Attachment metadata:',
        JSON.stringify(images.map(image => ({
          id: image.id,
          filename: image.filename,
          content_type: image.content_type,
          file_size: image.file_size,
          source_message_preview: image.source_message_preview
        })), null, 2)
      ].join('\n')
    },
    ...images.flatMap(image => ([
      { type: 'input_text', text: `Attachment id: ${image.id}` },
      { type: 'input_image', image_url: image.data_url }
    ]))
  ];

  return {
    model: config.openaiModel,
    input: [
      {
        role: 'user',
        content
      }
    ]
  };
}

function analysisResult({
  available,
  reason,
  source = null,
  analyzed_count = 0,
  analyses = [],
  warnings = []
}) {
  return {
    available: Boolean(available),
    source,
    reason,
    analyzed_count: Number(analyzed_count) || analyses.length,
    analyses,
    warnings: normalizeWarnings(warnings)
  };
}

function normalizeAnalyses(value, images) {
  const byId = new Map(images.map(image => [image.id, image]));
  return (Array.isArray(value) ? value : [])
    .map(item => {
      const id = String(item?.id || '').trim();
      const image = byId.get(id);
      if (!image) return null;
      return {
        id,
        filename: image.filename,
        evidence_type: cleanEnum(item.evidence_type, ['tracking', 'delivery_proof', 'product_photo', 'size_label', 'damage', 'other'], 'other'),
        summary: String(item.summary || '').trim().slice(0, 500),
        visible_text: normalizeStringList(item.visible_text).slice(0, 12),
        signals: normalizeStringList(item.signals).slice(0, 12),
        confidence: cleanEnum(item.confidence, ['high', 'medium', 'low'], 'low')
      };
    })
    .filter(item => item?.summary || item?.visible_text.length || item?.signals.length);
}

function absoluteChatwootUrl({ config, url }) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (!config?.chatwootBaseUrl) return '';
  try {
    return new URL(raw, config.chatwootBaseUrl).href;
  } catch {
    return '';
  }
}

function cleanContentType(value = '') {
  return String(value || '').split(';')[0].trim().toLowerCase();
}

function extractOutputText(data) {
  if (data.output_text) return data.output_text;
  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' || content.type === 'text') chunks.push(content.text);
    }
  }
  return chunks.join('\n').trim();
}

function parseJsonObject(text = '') {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function normalizeStringList(value) {
  const raw = Array.isArray(value) ? value : [value];
  return raw.map(item => String(item || '').trim()).filter(Boolean);
}

function normalizeWarnings(warnings = []) {
  return normalizeStringList(warnings);
}

function cleanEnum(value, allowed, fallback) {
  const clean = String(value || '').trim().toLowerCase();
  return allowed.includes(clean) ? clean : fallback;
}
