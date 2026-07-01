const MAX_ATTACHMENT_CANDIDATES = 5;

export function extractAttachmentCandidates(messages = []) {
  const groups = (Array.isArray(messages) ? messages : [])
    .filter(message => normalizeMessageType(message?.message_type) === 'incoming')
    .map(message => {
      const attachments = (Array.isArray(message.attachments) ? message.attachments : [])
        .map((attachment, index) => normalizeAttachmentCandidate({ attachment, message, index }))
        .filter(Boolean);

      return attachments.length
        ? { created_at: message.created_at || message.timestamp || '', attachments }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => messageTime(b.created_at) - messageTime(a.created_at));

  return (groups[0]?.attachments || []).slice(0, MAX_ATTACHMENT_CANDIDATES);
}

function normalizeAttachmentCandidate({ attachment = {}, message = {}, index = 0 }) {
  if (!isImageAttachment(attachment)) return null;

  const dataUrl = String(attachment.data_url || '').trim();
  const thumbUrl = String(attachment.thumb_url || '').trim();
  if (!dataUrl && !thumbUrl) return null;

  const attachmentId = attachment.id ?? attachment.file_id ?? null;
  const messageId = attachment.message_id || message.id || null;
  const contentType = cleanContentType(attachment.content_type);

  return {
    id: String(attachmentId || `${messageId || 'message'}:${index + 1}`),
    attachment_id: attachmentId,
    message_id: messageId,
    filename: cleanFilename(attachment.filename || attachment.file_name || '', {
      id: attachmentId || `${messageId || 'attachment'}-${index + 1}`,
      contentType
    }),
    content_type: contentType,
    file_type: String(attachment.file_type || 'image').trim(),
    file_size: normalizeNumber(attachment.file_size),
    width: normalizeNumber(attachment.width),
    height: normalizeNumber(attachment.height),
    data_url: dataUrl,
    thumb_url: thumbUrl,
    created_at: attachment.created_at || message.created_at || null,
    source_message_preview: String(message.content || '').replace(/\s+/g, ' ').trim().slice(0, 180)
  };
}

function isImageAttachment(attachment = {}) {
  const fileType = String(attachment.file_type || '').toLowerCase();
  const contentType = cleanContentType(attachment.content_type);
  return fileType === 'image' || contentType.startsWith('image/');
}

function normalizeMessageType(value) {
  if (value === 0 || value === '0') return 'incoming';
  if (value === 1 || value === '1') return 'outgoing';
  return String(value || '').toLowerCase();
}

function cleanContentType(value = '') {
  return String(value || '').split(';')[0].trim().toLowerCase();
}

function cleanFilename(value = '', { id = 'attachment', contentType = '' } = {}) {
  const clean = String(value || '').trim().split(/[\\/]/).pop();
  if (clean) return clean;
  return `chatwoot-image-${id}.${extensionForContentType(contentType)}`;
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
  }[contentType] || 'jpg';
}

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function messageTime(value) {
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
