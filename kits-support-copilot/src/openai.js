export async function generateDraftWithOpenAI({ config, prompt, fallback }) {
  if (!config.openaiApiKey) {
    return {
      ...fallback,
      warnings: [...fallback.warnings, 'OpenAI is not configured, so a rule-based fallback draft was generated.']
    };
  }

  const response = await fetch(`${config.openaiBaseUrl}/v1/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openaiApiKey}`
    },
    body: JSON.stringify(buildResponseBody(config, prompt))
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `OpenAI HTTP ${response.status}`;
    return {
      ...fallback,
      warnings: [...fallback.warnings, `OpenAI request failed: ${message}`]
    };
  }

  const text = extractOutputText(data);
  const parsed = parseJsonObject(text);
  if (!parsed?.draft) {
    return {
      ...fallback,
      draft: text || fallback.draft,
      warnings: [...fallback.warnings, 'OpenAI returned a non-JSON response; using the raw generated text.']
    };
  }

  return {
    draft: String(parsed.draft || ''),
    reasoning_summary: String(parsed.reasoning_summary || fallback.reasoning_summary),
    confidence: normalizeConfidence(parsed.confidence || fallback.confidence),
    warnings: [...fallback.warnings, ...(Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : [])]
  };
}

export async function generateChatWithOpenAI({ config, prompt, fallback }) {
  if (!config.openaiApiKey) {
    return {
      ...fallback,
      warnings: [...fallback.warnings, 'OpenAI is not configured, so a rule-based fallback response was generated.']
    };
  }

  const response = await fetch(`${config.openaiBaseUrl}/v1/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openaiApiKey}`
    },
    body: JSON.stringify(buildResponseBody(config, prompt))
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `OpenAI HTTP ${response.status}`;
    return {
      ...fallback,
      warnings: [...fallback.warnings, `OpenAI request failed: ${message}`]
    };
  }

  const text = extractOutputText(data);
  const parsed = parseJsonObject(text);
  if (!parsed?.assistant_message && !parsed?.draft) {
    return {
      ...fallback,
      assistant_message: text || fallback.assistant_message,
      warnings: [...fallback.warnings, 'OpenAI returned a non-JSON response; using the raw generated text as the assistant message.']
    };
  }

  return {
    assistant_message: String(parsed.assistant_message || fallback.assistant_message || ''),
    draft: String(parsed.draft || fallback.draft || ''),
    agent_briefing: parsed.agent_briefing || fallback.agent_briefing || null,
    reasoning_summary: String(parsed.reasoning_summary || fallback.reasoning_summary || ''),
    confidence: normalizeConfidence(parsed.confidence || fallback.confidence),
    warnings: [...fallback.warnings, ...(Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : [])]
  };
}

function buildResponseBody(config, prompt) {
  return {
    model: config.openaiModel,
    input: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user }
    ],
    ...modelOptions(config.openaiModel)
  };
}

function modelOptions(model) {
  if (String(model || '').startsWith('gpt-5')) return {};
  return { temperature: 0.2 };
}

function extractOutputText(data) {
  if (data.output_text) return data.output_text;
  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' || content.type === 'text') {
        chunks.push(content.text);
      }
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

function normalizeConfidence(value) {
  const normalized = String(value || '').toLowerCase();
  if (['high', 'medium', 'low'].includes(normalized)) return normalized;
  return 'low';
}
