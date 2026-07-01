const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export async function appendIssueAttachmentsToFormData({ formData, config, attachments = [] }) {
  for (const attachment of attachments.slice(0, 5)) {
    const downloaded = await downloadChatwootAttachment({ config, attachment });
    formData.append('attachments[]', downloaded.blob, downloaded.filename);
  }
}

async function downloadChatwootAttachment({ config, attachment }) {
  const url = absoluteChatwootUrl({ config, url: attachment?.data_url });
  if (!url) {
    throw new Error(`Could not download attachment ${attachmentLabel(attachment)}: missing URL`);
  }

  const response = await fetch(url, {
    method: 'GET',
    headers: config?.chatwootApiToken ? { api_access_token: config.chatwootApiToken } : {}
  });
  if (!response.ok) {
    throw new Error(`Could not download attachment ${attachmentLabel(attachment)}: HTTP ${response.status}`);
  }

  const contentType = cleanContentType(response.headers?.get?.('content-type') || attachment?.content_type);
  if (!contentType.startsWith('image/')) {
    throw new Error(`Attachment ${attachmentLabel(attachment)} is not an image.`);
  }

  const arrayBuffer = await response.arrayBuffer();
  if (!arrayBuffer.byteLength) {
    throw new Error(`Attachment ${attachmentLabel(attachment)} is empty.`);
  }
  if (arrayBuffer.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment ${attachmentLabel(attachment)} is larger than 8 MB.`);
  }

  return {
    filename: safeFilename(attachment?.filename || 'chatwoot-image', contentType),
    blob: new Blob([arrayBuffer], { type: contentType })
  };
}

function absoluteChatwootUrl({ config, url }) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  const baseUrl = String(config?.chatwootBaseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) return '';
  return `${baseUrl}/${value.replace(/^\/+/, '')}`;
}

function cleanContentType(value = '') {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

function safeFilename(filename, contentType) {
  const clean = String(filename || '').trim().split(/[\\/]/).pop()?.replace(/[^A-Za-z0-9._-]+/g, '-') || 'chatwoot-image';
  if (/\.[A-Za-z0-9]{2,5}$/.test(clean)) return clean;
  return `${clean}.${extensionForContentType(contentType) || 'jpg'}`;
}

function extensionForContentType(contentType = '') {
  return {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
    'image/heic': 'heic',
    'image/heif': 'heif'
  }[contentType] || '';
}

function attachmentLabel(attachment = {}) {
  return attachment.filename || attachment.id || 'image';
}
