const COMPLETED_STATUSES = new Set([
  'Ready',
  'Order unlinked',
  'Order linked',
  'Case auto',
  'Case forced',
  'Reply inserted',
  'Composer edited',
  'Copied',
  'Copied fallback',
  'Private note saved',
  'Cleared',
  'Order selected'
]);

export function resolveStatusPresentation({
  statusText = '',
  draftStatusText = '',
  compact = false
} = {}) {
  const status = clean(statusText);
  const draftStatus = clean(draftStatusText);
  const fullLabel = [status, draftStatus].filter(Boolean).join(' | ') || 'Idle';

  if (!compact) {
    return {
      label: fullLabel,
      fullLabel,
      tone: 'neutral'
    };
  }

  const error = errorPresentation(status) || errorPresentation(draftStatus);
  if (error) return { ...error, fullLabel };

  const activeAction = activeActionPresentation(status);
  if (activeAction) return { ...activeAction, fullLabel };

  if (draftStatus === 'Draft preparing') {
    return { label: 'Drafting...', fullLabel, tone: 'busy' };
  }

  if (status === 'Loading context...') {
    return { label: 'Loading...', fullLabel, tone: 'busy' };
  }

  if (status === 'Context partially ready') {
    return { label: 'Partial', fullLabel, tone: 'neutral' };
  }

  if (status === 'No context') {
    return { label: 'No context', fullLabel, tone: 'neutral' };
  }

  if (
    status === 'Context ready'
    || draftStatus === 'Draft ready'
    || COMPLETED_STATUSES.has(status)
  ) {
    return { label: 'Ready', fullLabel, tone: 'ready' };
  }

  return {
    label: status || draftStatus || 'Idle',
    fullLabel,
    tone: 'neutral'
  };
}

function errorPresentation(value) {
  if (!value) return null;
  if (
    value === 'Error'
    || value === 'Context error'
    || value === 'Draft error'
    || value === 'Order not found'
    || value.endsWith(' failed')
  ) {
    return { label: value, tone: 'error' };
  }
  return null;
}

function activeActionPresentation(value) {
  if (value === 'Thinking...') return { label: value, tone: 'busy' };
  if (value.startsWith('Linking ')) return { label: 'Linking...', tone: 'busy' };
  if (value.startsWith('Forcing ')) return { label: 'Forcing...', tone: 'busy' };
  if (value === 'Inserting reply...') return { label: 'Inserting...', tone: 'busy' };
  if (value === 'Saving note...') return { label: 'Saving...', tone: 'busy' };
  return null;
}

function clean(value) {
  return String(value || '').trim();
}
