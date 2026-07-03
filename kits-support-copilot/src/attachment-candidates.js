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
        timestamp: messageTime(message.created_at || message.createdAt || message.timestamp || message.id),
        attachments
      });
    }
  }

  groups.sort((a, b) => b.timestamp - a.timestamp);
  return (groups[0]?.attachments || []).slice(0, MAX_ATTACHMENT_CANDIDATES);
}

function isIncomingCustomerMessage(message = {}) {
  const type = normalizeMessageType(message.message_type);
  const senderType = String(message.sender?.type || message.sender_type || '').toLowerCase();
  return !message.private
    && (type === 'incoming' || senderType === 'contact' || senderType === 'customer');
}

function normalizeAttachmentCandidate({ attachment = {}, message = {}, index = 0 }) {
  if (!isImageAttachment(attachment)) return null;

  const dataUrl = String(attachment.data_url || '').trim();
  const thumbUrl = String(attachment.thumb_url || '').trim();
  if (!dataUrl && !thumbUrl) return null;

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
    file_type: String(attachment.file_type || 'image').trim(),
    file_size: normalizePositiveNumber(attachment.file_size),
    width: normalizePositiveNumber(attachment.width),
    height: normalizePositiveNumber(attachment.height),
    data_url: dataUrl,
    thumb_url: thumbUrl,
    created_at: attachment.created_at || message.created_at || message.createdAt || null,
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

function normalizeMessageType(value) {
  if (value === 0 || value === '0') return 'incoming';
  if (value === 1 || value === '1') return 'outgoing';
  return String(value || '').toLowerCase();
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

function normalizePositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function messageTime(value) {
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function previewText(value = '') {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  return clean.length > 160 ? `${clean.slice(0, 157)}...` : clean;
}
