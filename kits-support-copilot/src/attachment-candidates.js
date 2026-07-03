const MAX_ATTACHMENT_CANDIDATES = 5;
const MIN_SIGNATURE_BYTES = 4096;
const MIN_SIGNATURE_DIMENSION = 120;

export function extractAttachmentCandidates(messages = []) {
  const groups = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isIncomingCustomerMessage(message)) continue;

    const attachments = (Array.isArray(message.attachments) ? message.attachments : [])
      .map((attachment, index) => normalizeAttachmentCandidate({ attachment, message, index }))
      .filter(Boolean)
      .filter(candidate => !isLikelySignatureImage(candidate));

    if (attachments.length) {
      groups.push({
        timestamp: Date.parse(message.created_at || message.createdAt || '') || Number(message.id || 0) || 0,
        attachments
      });
    }
  }

  groups.sort((a, b) => b.timestamp - a.timestamp);
  return (groups[0]?.attachments || []).slice(0, MAX_ATTACHMENT_CANDIDATES);
}

function isIncomingCustomerMessage(message = {}) {
  const type = message.message_type;
  const senderType = String(message.sender?.type || message.sender_type || '').toLowerCase();
  return !message.private
    && (type === 0 || type === 'incoming' || senderType === 'contact' || senderType === 'customer');
}

function normalizeAttachmentCandidate({ attachment = {}, message = {}, index = 0 }) {
  if (!isImageAttachment(attachment)) return null;

  const dataUrl = String(attachment.data_url || '').trim();
  if (!dataUrl) return null;

  const attachmentId = attachment.id ?? attachment.file_id ?? null;
  const messageId = attachment.message_id || message.id || null;
  const contentType = cleanContentType(attachment.content_type);
  const extension = String(attachment.extension || '').replace(/^\./, '').trim().toLowerCase();

  return {
    id: String(attachmentId || `${messageId || 'message'}:${index + 1}`),
    attachment_id: attachmentId,
    message_id: messageId,
    filename: cleanFilename(attachment.filename || attachment.file_name || '', {
      id: attachmentId || `${messageId || 'attachment'}-${index + 1}`,
      extension,
      contentType
    }),
    content_type: contentType,
    file_type: String(attachment.file_type || '').trim(),
    file_size: normalizeNumber(attachment.file_size),
    width: normalizeNumber(attachment.width),
    height: normalizeNumber(attachment.height),
    data_url: dataUrl,
    thumb_url: String(attachment.thumb_url || '').trim(),
    created_at: message.created_at || message.createdAt || null,
    source_message_preview: previewText(message.content || message.processed_message_content || '')
  };
}

function isImageAttachment(attachment = {}) {
  const fileType = String(attachment.file_type || '').toLowerCase();
  const contentType = cleanContentType(attachment.content_type);
  return fileType === 'image' || contentType.startsWith('image/');
}

function isLikelySignatureImage(candidate = {}) {
  const byteSize = Number(candidate.file_size || 0);
  if (byteSize > 0 && byteSize < MIN_SIGNATURE_BYTES) return true;

  const width = Number(candidate.width || 0);
  const height = Number(candidate.height || 0);
  return width > 0 && height > 0 && width <= MIN_SIGNATURE_DIMENSION && height <= MIN_SIGNATURE_DIMENSION;
}

function cleanContentType(value = '') {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

function cleanFilename(filename, { id, extension, contentType }) {
  const raw = String(filename || '').trim().split(/[\\/]/).pop();
  if (raw) return raw;
  const guessedExtension = extension || extensionForContentType(contentType) || 'jpg';
  return `chatwoot-${id}.${guessedExtension}`;
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

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function previewText(value = '') {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  return clean.length > 160 ? `${clean.slice(0, 157)}...` : clean;
}
