import {
  clearSession,
  createStorageKey,
  loadSession,
  saveSession
} from './session-store.js';
import { buildContextView } from './context-summary.js';
import { segmentCommandLinks } from './command-links.js';
import {
  filterCommandOptions,
  getActiveSlashToken,
  replaceActiveSlashToken
} from './commands.js';

const SIDEBAR_SPLIT_STORAGE_KEY = 'kr-copilot-sidebar-split-v1';
const SIDEBAR_SPLIT_LIMITS = {
  contextMin: 180,
  contextMaxRatio: 0.7,
  chatMin: 220
};

const state = {
  appContext: null,
  contextResult: null,
  chatMessages: [],
  lastResult: null,
  pendingIssue: null,
  selectedOrderRef: '',
  commandMenu: {
    activeIndex: 0,
    options: [],
    token: null
  },
  splitResize: null,
  token: new URLSearchParams(window.location.search).get('token') || '',
  storageKey: '',
  contextKey: '',
  contextRequestId: 0,
  chatRequestId: 0
};

const layout = new URLSearchParams(window.location.search).get('layout') || 'default';
const isSidebarLayout = layout === 'sidebar';
document.body.dataset.layout = layout;

const els = {
  shell: document.querySelector('.shell'),
  header: document.querySelector('.header'),
  contextBar: document.querySelector('.contextBar'),
  chatPanel: document.querySelector('.chatPanel'),
  detailsPanel: document.querySelector('.detailsPanel'),
  splitHandle: document.getElementById('splitHandle'),
  status: document.getElementById('status'),
  conversationLabel: document.getElementById('conversationLabel'),
  orderStatus: document.getElementById('orderStatus'),
  chatLog: document.getElementById('chatLog'),
  insertNotice: document.getElementById('insertNotice'),
  insertNoticeText: document.getElementById('insertNoticeText'),
  copyLatestButton: document.getElementById('copyLatestButton'),
  chatForm: document.getElementById('chatForm'),
  commandMenu: document.getElementById('commandMenu'),
  chatInput: document.getElementById('chatInput'),
  newDraftButton: document.getElementById('newDraftButton'),
  sendButton: document.getElementById('sendButton'),
  draft: document.getElementById('draft'),
  confidence: document.getElementById('confidence'),
  prepareButton: document.getElementById('prepareButton'),
  copyButton: document.getElementById('copyButton'),
  noteButton: document.getElementById('noteButton'),
  resetButton: document.getElementById('resetButton'),
  contextSummary: document.getElementById('contextSummary'),
  contextBox: document.getElementById('contextBox')
};

window.addEventListener('message', event => {
  const data = parseMaybeJson(event.data);
  if (!data || data.event !== 'appContext') return;
  state.appContext = data.data;
  hydrateFromContext();
});

window.parent?.postMessage('chatwoot-dashboard-app:fetch-info', '*');

els.chatForm.addEventListener('submit', event => {
  event.preventDefault();
  sendAgentMessage(els.chatInput.value);
});
els.chatInput.addEventListener('input', updateCommandMenu);
els.chatInput.addEventListener('click', updateCommandMenu);
els.chatInput.addEventListener('keyup', event => {
  if (['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(event.key)) return;
  updateCommandMenu();
});
els.chatInput.addEventListener('keydown', handleCommandMenuKeydown);
els.commandMenu.addEventListener('mousedown', event => {
  const option = event.target.closest('[data-command-index]');
  if (!option) return;
  event.preventDefault();
  selectCommandMenuOption(Number(option.dataset.commandIndex));
});
els.chatLog.addEventListener('click', event => {
  const commandButton = event.target.closest('[data-command]');
  if (!commandButton) return;
  insertCommandInInput(commandButton.dataset.command || '');
});

els.newDraftButton.addEventListener('click', () => {
  els.draft.value = '';
  persistSession();
  sendAgentMessage('Generate a reply for this customer.');
});

for (const button of document.querySelectorAll('[data-context-tab]')) {
  button.addEventListener('click', () => setContextTab(button.dataset.contextTab));
}

els.draft.addEventListener('input', () => {
  persistSession();
  updateButtons();
});
els.copyLatestButton.addEventListener('click', copyDraft);
els.contextSummary.addEventListener('click', event => {
  const button = event.target.closest('[data-order-ref]');
  if (button) selectOrderCandidate(button.dataset.orderRef);
});
els.prepareButton.addEventListener('click', insertReply);
els.copyButton.addEventListener('click', copyDraft);
els.noteButton.addEventListener('click', savePrivateNote);
els.resetButton.addEventListener('click', resetChat);

if (isSidebarLayout) {
  initSidebarSplit();
}

function hydrateFromContext() {
  const conversation = state.appContext?.conversation || {};
  const contact = state.appContext?.contact || conversation?.meta?.sender || {};
  const conversationId = conversation.display_id || conversation.id;
  const accountId = conversation.account_id;
  const nextContextKey = createContextKey({ accountId, conversationId, contact });
  const isNewContext = nextContextKey !== state.contextKey;

  state.contextKey = nextContextKey;
  state.storageKey = createStorageKey({ accountId, conversationId });

  if (isNewContext) {
    state.contextRequestId += 1;
    state.chatRequestId += 1;
    state.contextResult = null;
    let session = loadSession(window.localStorage, state.storageKey);
    session = sessionBelongsToContact(session, contact) ? session : clearStoredSession();
    state.chatMessages = session.chatMessages;
    state.lastResult = session.lastResult;
    state.pendingIssue = session.pendingIssue;
    state.selectedOrderRef = session.selectedOrderRef;
    els.draft.value = session.draft;
    els.confidence.textContent = `confidence: ${session.lastResult?.confidence || 'n/a'}`;
    hideInsertNotice();
    clearContextView();
  }

  els.conversationLabel.textContent = conversationId
    ? `#${conversationId} | ${contact.email || contact.name || 'unknown contact'}`
    : 'No Chatwoot conversation context.';

  renderChat();
  updateButtons();
  loadContext();
}

function sessionBelongsToContact(session, contact) {
  const activeEmail = normalizeEmail(contact?.email);
  if (!activeEmail) return true;
  if (!session?.draft && !session?.chatMessages?.length) return true;

  const sessionEmail = normalizeEmail(
    session?.lastResult?.contact_email ||
      session?.lastResult?.context_summary?.customer ||
      session?.lastResult?.shopify_context?.selected_order?.email
  );

  return Boolean(sessionEmail) && sessionEmail === activeEmail;
}

function clearStoredSession() {
  clearSession(window.localStorage, state.storageKey);
  return {
    chatMessages: [],
    draft: '',
    lastResult: null,
    pendingIssue: null,
    selectedOrderRef: '',
    updatedAt: null
  };
}

function normalizeEmail(value = '') {
  return String(value || '').trim().toLowerCase();
}

async function loadContext() {
  const payload = buildBasePayload();
  if (!payload.conversation_id) {
    setStatus('No context');
    return;
  }

  const contextKey = state.contextKey;
  const requestId = state.contextRequestId + 1;
  state.contextRequestId = requestId;
  setStatus('Loading context...');
  try {
    const result = await api('/api/context', payload);
    if (!isCurrentContext({ contextKey, requestId, type: 'context' })) return;
    state.contextResult = result;
    renderContext(result);
    setStatus('Context ready');
  } catch (error) {
    if (!isCurrentContext({ contextKey, requestId, type: 'context' })) return;
    setStatus('Context error');
    els.contextSummary.textContent = error.message;
    els.contextBox.textContent = error.message;
  }
}

async function sendAgentMessage(rawMessage) {
  const content = String(rawMessage || '').trim();
  if (!content) return;

  hideInsertNotice();
  state.chatMessages.push({ role: 'user', content });
  els.chatInput.value = '';
  hideCommandMenu();
  renderChat();
  persistSession();

  const contextKey = state.contextKey;
  const requestId = state.chatRequestId + 1;
  state.chatRequestId = requestId;
  setStatus('Thinking...');
  setBusy(true);
  try {
    const currentDraft = await draftForAgentMessage(content);
    const result = await api('/api/copilot-chat', {
      ...buildBasePayload(),
      chat_messages: state.chatMessages,
      current_draft: currentDraft,
      pending_issue: state.pendingIssue
    });
    if (!isCurrentContext({ contextKey, requestId, type: 'chat' })) return;

    state.lastResult = result;
    state.pendingIssue = result.pending_issue || null;
    state.contextResult = {
      ...(state.contextResult || {}),
      contact_email: result.contact_email || state.contextResult?.contact_email,
      context_summary: result.context_summary || state.contextResult?.context_summary,
      provider_context: result.provider_context || state.contextResult?.provider_context,
      delivery_estimate_context: result.delivery_estimate_context || state.contextResult?.delivery_estimate_context,
      issue_context: result.issue_context || state.contextResult?.issue_context,
      shopify_context: result.shopify_context,
      response_language: result.response_language,
      support_case: result.support_case,
      warnings: result.warnings
    };
    state.chatMessages.push({
      role: 'assistant',
      content: result.assistant_message || 'Draft updated.'
    });
    if (!result.preserve_draft) {
      els.draft.value = result.draft || '';
    }
    els.confidence.textContent = `confidence: ${result.confidence || 'n/a'}`;
    renderChat();
    renderContext(state.contextResult);
    persistSession();
    if (isSidebarLayout && result.draft && !result.skip_insert && !result.preserve_draft) {
      await autoInsertReply(result.draft, {
        policy: isGrammarCommand(content) ? 'manual' : 'auto'
      });
    } else {
      setStatus('Ready');
    }
  } catch (error) {
    if (!isCurrentContext({ contextKey, requestId, type: 'chat' })) return;
    setStatus('Error');
    state.chatMessages.push({ role: 'assistant', content: error.message });
    renderChat();
    persistSession();
  } finally {
    setBusy(false);
    updateButtons();
  }
}

async function draftForAgentMessage(content) {
  if (!isSidebarLayout || !isGrammarCommand(content)) return els.draft.value;

  const composer = await getReplyEditorContentFromChatwoot();
  els.draft.value = composer.content || '';
  persistSession();
  updateButtons();
  return els.draft.value;
}

function isGrammarCommand(content) {
  return String(content || '').trim().toLowerCase() === '/grammar';
}

async function autoInsertReply(draft, { policy = 'auto' } = {}) {
  try {
    await insertReplyInChatwoot(draft, { policy });
    hideInsertNotice();
    setStatus('Reply inserted');
  } catch (error) {
    setStatus('Composer edited');
    showInsertNotice(error.message);
  }
}

function showInsertNotice(message) {
  els.insertNotice.hidden = false;
  els.insertNoticeText.textContent = [
    message || 'Could not insert the latest reply.',
    'Copy it instead, or clear the Chatwoot composer and ask again.'
  ].join(' ');
}

function hideInsertNotice() {
  els.insertNotice.hidden = true;
  els.insertNoticeText.textContent = '';
}

function initSidebarSplit() {
  if (!els.shell || !els.splitHandle || !els.chatPanel || !els.detailsPanel) return;

  const storedHeight = readStoredSidebarSplitHeight();
  const defaultHeight = Math.round(window.innerHeight * 0.42);
  setSidebarContextHeight(storedHeight || defaultHeight, { persist: false });

  els.splitHandle.addEventListener('pointerdown', startSidebarSplitResize);
  els.splitHandle.addEventListener('keydown', handleSidebarSplitKeydown);
  window.addEventListener('resize', () => {
    setSidebarContextHeight(currentSidebarContextHeight(), { persist: false });
  });
}

function startSidebarSplitResize(event) {
  if (event.button && event.button !== 0) return;

  event.preventDefault();
  state.splitResize = {
    startY: event.clientY,
    startHeight: currentSidebarContextHeight(),
    pointerId: event.pointerId
  };
  document.body.classList.add('isResizing');
  els.splitHandle.setPointerCapture?.(event.pointerId);
  window.addEventListener('pointermove', resizeSidebarSplit);
  window.addEventListener('pointerup', stopSidebarSplitResize);
  window.addEventListener('pointercancel', stopSidebarSplitResize);
}

function resizeSidebarSplit(event) {
  if (!state.splitResize) return;

  const deltaY = event.clientY - state.splitResize.startY;
  setSidebarContextHeight(state.splitResize.startHeight - deltaY, { persist: false });
}

function stopSidebarSplitResize(event) {
  if (!state.splitResize) return;

  setSidebarContextHeight(currentSidebarContextHeight(), { persist: true });
  els.splitHandle.releasePointerCapture?.(state.splitResize.pointerId || event.pointerId);
  state.splitResize = null;
  document.body.classList.remove('isResizing');
  window.removeEventListener('pointermove', resizeSidebarSplit);
  window.removeEventListener('pointerup', stopSidebarSplitResize);
  window.removeEventListener('pointercancel', stopSidebarSplitResize);
}

function handleSidebarSplitKeydown(event) {
  const currentHeight = currentSidebarContextHeight();
  const step = event.shiftKey ? 60 : 24;

  if (event.key === 'ArrowUp') {
    event.preventDefault();
    setSidebarContextHeight(currentHeight + step, { persist: true });
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    setSidebarContextHeight(currentHeight - step, { persist: true });
  } else if (event.key === 'Home') {
    event.preventDefault();
    setSidebarContextHeight(SIDEBAR_SPLIT_LIMITS.contextMin, { persist: true });
  } else if (event.key === 'End') {
    event.preventDefault();
    setSidebarContextHeight(sidebarSplitBounds().max, { persist: true });
  }
}

function currentSidebarContextHeight() {
  const variableValue = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--context-panel-height')
  );
  if (Number.isFinite(variableValue)) return variableValue;
  return els.detailsPanel?.getBoundingClientRect().height || Math.round(window.innerHeight * 0.42);
}

function setSidebarContextHeight(height, { persist = true } = {}) {
  const nextHeight = clampSidebarContextHeight(height);
  const { min, max } = sidebarSplitBounds();
  document.documentElement.style.setProperty('--context-panel-height', `${nextHeight}px`);
  els.splitHandle?.setAttribute('aria-valuemin', String(Math.round(min)));
  els.splitHandle?.setAttribute('aria-valuemax', String(Math.round(max)));
  els.splitHandle?.setAttribute('aria-valuenow', String(Math.round(nextHeight)));

  if (persist) writeStoredSidebarSplitHeight(nextHeight);
}

function clampSidebarContextHeight(height) {
  const { min, max } = sidebarSplitBounds();
  return Math.min(Math.max(Math.round(Number(height) || min), min), max);
}

function sidebarSplitBounds() {
  const availableHeight = sidebarResizableHeight();
  const min = SIDEBAR_SPLIT_LIMITS.contextMin;
  const maxByRatio = Math.floor(availableHeight * SIDEBAR_SPLIT_LIMITS.contextMaxRatio);
  const maxByChat = availableHeight - SIDEBAR_SPLIT_LIMITS.chatMin;
  const max = Math.max(min, Math.min(maxByRatio, maxByChat));

  return { min, max };
}

function sidebarResizableHeight() {
  if (!els.shell) return window.innerHeight;

  const shellStyle = getComputedStyle(els.shell);
  const rowGap = parseFloat(shellStyle.rowGap || shellStyle.gap || '0') || 0;
  const visibleRows = [...els.shell.children].filter(child => {
    return getComputedStyle(child).display !== 'none';
  });
  const reservedHeight = visibleRows
    .filter(child => child !== els.chatPanel && child !== els.detailsPanel)
    .reduce((sum, child) => sum + child.getBoundingClientRect().height, 0);
  const gapsHeight = rowGap * Math.max(0, visibleRows.length - 1);
  const availableHeight = els.shell.getBoundingClientRect().height - reservedHeight - gapsHeight;

  return Math.max(availableHeight, SIDEBAR_SPLIT_LIMITS.contextMin + 120);
}

function readStoredSidebarSplitHeight() {
  try {
    const value = Number(window.localStorage.getItem(SIDEBAR_SPLIT_STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeStoredSidebarSplitHeight(height) {
  try {
    window.localStorage.setItem(SIDEBAR_SPLIT_STORAGE_KEY, String(Math.round(height)));
  } catch {
    // Ignore unavailable localStorage; resizing still works for the current session.
  }
}

function clearContextView() {
  els.orderStatus.textContent = 'No order selected';
  els.contextSummary.textContent = 'Loading context...';
  els.contextBox.textContent = '';
}

function createContextKey({ accountId, conversationId, contact }) {
  return [
    accountId || '',
    conversationId || '',
    contact?.id || '',
    contact?.email || ''
  ].map(value => String(value)).join(':');
}

function isCurrentContext({ contextKey, requestId, type }) {
  if (contextKey !== state.contextKey) return false;
  if (type === 'chat') return requestId === state.chatRequestId;
  return requestId === state.contextRequestId;
}

function buildBasePayload() {
  const conversation = state.appContext?.conversation || {};
  const contact = state.appContext?.contact || conversation?.meta?.sender || {};
  return {
    account_id: conversation.account_id,
    conversation_id: conversation.display_id || conversation.id,
    conversation_display_id: conversation.display_id,
    selected_order_ref: state.selectedOrderRef,
    contact_email: contact.email,
    latest_message: latestIncomingMessage(conversation.messages || []),
    agent_email: state.appContext?.currentAgent?.email,
    conversation
  };
}

function renderContext(result = {}) {
  const view = buildContextView(result);

  els.orderStatus.textContent = view.topBar.order;
  state.selectedOrderRef = normalizeOrderRef(result.context_summary?.selected_order_ref || state.selectedOrderRef);
  persistSession();
  renderContextSummary(view);
  els.contextBox.textContent = JSON.stringify(view.rawPayload, null, 2);
}

function renderChat() {
  els.chatLog.textContent = '';
  if (!state.chatMessages.length) {
    const empty = document.createElement('div');
    empty.className = 'emptyState';
    empty.textContent = 'Context ready.';
    els.chatLog.append(empty);
    return;
  }

  for (const message of state.chatMessages) {
    const node = document.createElement('div');
    node.className = `message ${message.role === 'assistant' ? 'assistant' : 'user'}`;
    if (message.role === 'assistant') {
      appendMessageContentWithCommands(node, message.content);
    } else {
      node.textContent = message.content;
    }
    els.chatLog.append(node);
  }
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function appendMessageContentWithCommands(node, content = '') {
  for (const segment of segmentCommandLinks(content)) {
    if (segment.type !== 'command') {
      node.append(document.createTextNode(segment.text));
      continue;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'commandLink';
    button.dataset.command = segment.text;
    button.textContent = segment.text;
    button.setAttribute('aria-label', `Insert ${segment.text}`);
    node.append(button);
  }
}

function insertCommandInInput(command = '') {
  const value = String(command || '').trim();
  if (!value) return;

  const input = els.chatInput;
  const start = Number.isInteger(input.selectionStart) ? input.selectionStart : input.value.length;
  const end = Number.isInteger(input.selectionEnd) ? input.selectionEnd : start;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  const prefix = before && !/\s$/.test(before) ? ' ' : '';
  const suffix = after && !/^\s/.test(after) ? ' ' : '';
  const nextValue = `${before}${prefix}${value}${suffix}${after}`;
  const cursor = before.length + prefix.length + value.length;

  input.value = nextValue;
  input.focus();
  input.setSelectionRange(cursor, cursor);
  hideCommandMenu();
}

function handleCommandMenuKeydown(event) {
  if (!isCommandMenuOpen()) {
    if (event.key !== 'Escape') return;
    hideCommandMenu();
    return;
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    hideCommandMenu();
    return;
  }

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveCommandMenuSelection(1);
    return;
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveCommandMenuSelection(-1);
    return;
  }

  if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault();
    selectCommandMenuOption(state.commandMenu.activeIndex);
  }
}

function updateCommandMenu() {
  if (els.chatInput.disabled) {
    hideCommandMenu();
    return;
  }

  const token = getActiveSlashToken({
    value: els.chatInput.value,
    cursor: els.chatInput.selectionStart
  });

  if (!token) {
    hideCommandMenu();
    return;
  }

  const options = filterCommandOptions(token.query);
  if (!options.length) {
    hideCommandMenu();
    return;
  }

  const previousToken = state.commandMenu.token?.token || '';
  const activeIndex = previousToken === token.token ? Math.min(state.commandMenu.activeIndex, options.length - 1) : 0;
  state.commandMenu = {
    token,
    options,
    activeIndex
  };
  renderCommandMenu();
}

function renderCommandMenu() {
  els.commandMenu.textContent = '';
  els.commandMenu.hidden = false;

  state.commandMenu.options.forEach((option, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `commandMenuOption${index === state.commandMenu.activeIndex ? ' active' : ''}`;
    button.dataset.commandIndex = String(index);
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', index === state.commandMenu.activeIndex ? 'true' : 'false');

    const command = document.createElement('span');
    command.className = 'commandMenuCommand';
    command.textContent = option.command;

    const description = document.createElement('span');
    description.className = 'commandMenuDescription';
    description.textContent = option.description;

    button.append(command, description);
    els.commandMenu.append(button);
  });
}

function moveCommandMenuSelection(delta) {
  const count = state.commandMenu.options.length;
  if (!count) return;
  state.commandMenu.activeIndex = (state.commandMenu.activeIndex + delta + count) % count;
  renderCommandMenu();
}

function selectCommandMenuOption(index) {
  const option = state.commandMenu.options[index];
  if (!option) return;

  const input = els.chatInput;
  const next = replaceActiveSlashToken({
    value: input.value,
    selectionStart: input.selectionStart,
    selectionEnd: input.selectionEnd,
    command: option.command
  });

  input.value = next.value;
  input.focus();
  input.setSelectionRange(next.cursor, next.cursor);
  hideCommandMenu();
}

function hideCommandMenu() {
  state.commandMenu = {
    activeIndex: 0,
    options: [],
    token: null
  };
  els.commandMenu.hidden = true;
  els.commandMenu.textContent = '';
}

function isCommandMenuOpen() {
  return !els.commandMenu.hidden;
}

async function copyDraft() {
  try {
    await copyToClipboard(els.draft.value);
    setStatus('Copied');
  } catch (error) {
    setStatus('Copy failed');
    els.contextBox.textContent = error.message;
  }
}

async function insertReply() {
  const draft = els.draft.value.trim();
  if (!draft) return;

  setStatus('Inserting reply...');
  els.prepareButton.disabled = true;
  try {
    await insertReplyInChatwoot(draft, { policy: 'manual' });
    setStatus('Reply inserted');
  } catch (error) {
    try {
      await copyToClipboard(draft);
      setStatus('Copied fallback');
      els.contextBox.textContent = [
        'Could not insert the reply into Chatwoot.',
        'The draft was copied to the clipboard instead.',
        '',
        error.message
      ].join('\n');
    } catch (copyError) {
      setStatus('Insert failed');
      els.contextBox.textContent = [
        'Could not insert the reply into Chatwoot.',
        'Could not copy the draft automatically.',
        '',
        error.message,
        copyError.message
      ].join('\n');
    }
  } finally {
    updateButtons();
  }
}

function insertReplyInChatwoot(draft, { policy = 'manual' } = {}) {
  if (!window.parent || window.parent === window) {
    return Promise.reject(new Error('Chatwoot parent window is unavailable.'));
  }

  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('Chatwoot did not confirm the insert action.'));
    }, 2000);

    function cleanup() {
      window.clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
    }

    function onMessage(event) {
      const data = parseMaybeJson(event.data);
      if (
        data?.event !== 'kr-copilot:insert-reply-result' ||
        data.data?.requestId !== requestId
      ) {
        return;
      }

      cleanup();
      if (data.data?.ok) {
        resolve();
      } else {
        reject(
          new Error(data.data?.error || 'Chatwoot rejected the insert action.')
        );
      }
    }

    window.addEventListener('message', onMessage);
    window.parent.postMessage(
      JSON.stringify({
        event: 'kr-copilot:insert-reply',
        data: {
          draft,
          requestId,
          policy,
          conversation_id: buildBasePayload().conversation_id
        }
      }),
      '*'
    );
  });
}

function getReplyEditorContentFromChatwoot() {
  if (!window.parent || window.parent === window) {
    return Promise.reject(new Error('Chatwoot parent window is unavailable.'));
  }

  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(
        new Error(
          'KR Copilot could not read the current Chatwoot composer. Grammar was not applied.'
        )
      );
    }, 2000);

    function cleanup() {
      window.clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
    }

    function onMessage(event) {
      const data = parseMaybeJson(event.data);
      if (
        data?.event !== 'kr-copilot:get-reply-editor-content-result' ||
        data.data?.requestId !== requestId
      ) {
        return;
      }

      cleanup();
      if (data.data?.ok) {
        resolve({ content: String(data.data.content || '') });
      } else {
        reject(
          new Error(
            data.data?.error ||
              'KR Copilot could not read the current Chatwoot composer. Grammar was not applied.'
          )
        );
      }
    }

    window.addEventListener('message', onMessage);
    window.parent.postMessage(
      JSON.stringify({
        event: 'kr-copilot:get-reply-editor-content',
        data: {
          requestId,
          conversation_id: buildBasePayload().conversation_id
        }
      }),
      '*'
    );
  });
}

async function copyToClipboard(value) {
  const text = String(value || '');
  if (!text) throw new Error('There is no draft to copy.');

  let clipboardError;
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      clipboardError = error;
    }
  }

  if (copyWithTextareaFallback(text)) return;
  throw clipboardError || new Error('Clipboard permission was denied.');
}

function copyWithTextareaFallback(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '-9999px';
  document.body.append(textarea);
  textarea.focus();
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    textarea.remove();
  }

  return copied;
}

async function savePrivateNote() {
  const draft = els.draft.value.trim();
  if (!draft) return;

  setStatus('Saving note...');
  els.noteButton.disabled = true;
  try {
    await api('/api/private-note', {
      ...buildBasePayload(),
      draft,
      metadata: {
        confidence: state.lastResult?.confidence,
        reasoning_summary: state.lastResult?.reasoning_summary
      }
    });
    setStatus('Private note saved');
  } catch (error) {
    setStatus('Error');
    els.contextBox.textContent = error.message;
  } finally {
    updateButtons();
  }
}

function resetChat() {
  state.chatMessages = [];
  state.lastResult = null;
  state.pendingIssue = null;
  els.draft.value = '';
  els.confidence.textContent = 'confidence: n/a';
  hideInsertNotice();
  persistSession();
  renderChat();
  updateButtons();
  setStatus('Cleared');
}

async function api(path, payload) {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {})
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function persistSession() {
  saveSession(window.localStorage, state.storageKey, {
    chatMessages: state.chatMessages,
    draft: els.draft.value,
    lastResult: state.lastResult,
    pendingIssue: state.pendingIssue,
    selectedOrderRef: state.selectedOrderRef,
    updatedAt: new Date().toISOString()
  });
}

function updateButtons() {
  const hasDraft = Boolean(els.draft.value.trim());
  els.prepareButton.disabled = !hasDraft || !buildBasePayload().conversation_id;
  els.copyButton.disabled = !hasDraft;
  els.noteButton.disabled = !hasDraft || !buildBasePayload().conversation_id;
  els.resetButton.disabled = !hasDraft && !state.chatMessages.length;
}

function setBusy(isBusy) {
  els.sendButton.disabled = isBusy;
  els.newDraftButton.disabled = isBusy;
  els.chatInput.disabled = isBusy;
}

function latestIncomingMessage(messages) {
  const incoming = [...messages].reverse().find(message => {
    return (message.message_type === 0 || message.message_type === 'incoming') && message.content;
  });
  return stripHtml(incoming?.content || '');
}

function stripHtml(value) {
  return String(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function setStatus(text) {
  els.status.textContent = text;
}

function parseMaybeJson(value) {
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function setContextTab(tab) {
  const activeTab = tab === 'raw' ? 'raw' : 'summary';
  for (const button of document.querySelectorAll('[data-context-tab]')) {
    const isActive = button.dataset.contextTab === activeTab;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-selected', String(isActive));
  }
  els.contextSummary.hidden = activeTab !== 'summary';
  els.contextBox.hidden = activeTab !== 'raw';
}

function renderContextSummary(view) {
  els.contextSummary.textContent = '';
  const grid = document.createElement('div');
  grid.className = 'contextSummaryGrid';

  for (const card of view.cards) {
    grid.append(renderContextCard(card));
  }

  els.contextSummary.append(grid);
}

function renderContextCard(card) {
  const node = document.createElement('article');
  node.className = `contextCard${card.emphasis ? ' emphasized' : ''}`;

  const title = document.createElement('h3');
  title.textContent = card.title;
  node.append(title);

  for (const row of card.rows || []) {
    const item = document.createElement('div');
    item.className = 'contextRow';

    const label = document.createElement('span');
    label.textContent = row.label;

    const value = document.createElement('strong');
    if (row.url) {
      const link = document.createElement('a');
      link.className = 'contextLink';
      link.href = row.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = row.value || '-';
      value.append(link);
    } else {
      value.textContent = row.value || '-';
    }

    for (const rowLink of row.links || []) {
      if (!rowLink?.url) continue;
      const link = document.createElement('a');
      link.className = 'contextLink contextInlineLink';
      link.href = rowLink.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = rowLink.label || 'Open';
      value.append(link);
    }

    item.append(label, value);
    node.append(item);
  }

  for (const order of card.orders || []) {
    node.append(renderOrderCandidate(order));
  }

  for (const item of card.items || []) {
    node.append(renderLineItem(item));
  }

  for (const ticket of card.tickets || []) {
    node.append(renderTicket(ticket));
  }

  if (card.action?.url) {
    const link = document.createElement('a');
    link.className = 'contextAction';
    link.href = card.action.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = card.action.label;
    node.append(link);
  }

  return node;
}

function renderTicket(ticket) {
  const item = document.createElement('div');
  item.className = 'ticketItem';

  const title = document.createElement('strong');
  title.textContent = [
    ticket.title || 'Open ticket',
    ticket.type || ''
  ].filter(Boolean).join(' · ');
  item.append(title);

  const metaParts = [
    ticket.provider,
    ticket.status,
    ticket.date ? `created ${ticket.date}` : ''
  ].filter(Boolean);
  if (metaParts.length) {
    const meta = document.createElement('span');
    meta.className = 'ticketMeta';
    meta.textContent = metaParts.join(' | ');
    item.append(meta);
  }

  if (ticket.message) {
    const preview = document.createElement('span');
    preview.className = 'ticketPreview';
    preview.textContent = ticket.message;
    item.append(preview);
  }

  if (ticket.url) {
    const link = document.createElement('a');
    link.className = 'contextAction';
    link.href = ticket.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open ticket';
    item.append(link);
  }

  return item;
}

function renderLineItem(lineItem) {
  const item = document.createElement('div');
  item.className = `lineItem${lineItem.hasPersonalization ? ' personalized' : ''}`;

  const title = document.createElement('strong');
  title.textContent = lineItem.title || 'Unknown item';
  item.append(title);

  if (lineItem.meta) {
    const meta = document.createElement('span');
    meta.className = 'lineItemMeta';
    meta.textContent = lineItem.meta;
    item.append(meta);
  }

  if (lineItem.personalization) {
    const personalization = document.createElement('span');
    personalization.className = 'lineItemPersonalization';
    personalization.textContent = lineItem.personalization;
    item.append(personalization);
  }

  return item;
}

function renderOrderCandidate(order) {
  const item = document.createElement('div');
  item.className = `orderCandidate${order.selected ? ' selected' : ''}`;

  const details = document.createElement('div');
  details.className = 'orderCandidateDetails';

  const title = order.shopify_admin_url
    ? document.createElement('a')
    : document.createElement('strong');
  title.textContent = order.order || 'Unknown order';
  if (order.shopify_admin_url) {
    title.className = 'contextLink';
    title.href = order.shopify_admin_url;
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
  }
  details.append(title);

  const meta = document.createElement('span');
  meta.textContent = [
    order.date,
    order.shopify_status,
    order.provider,
    order.country,
    formatCandidateTracking(order)
  ].filter(Boolean).join(' | ');
  details.append(meta);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary orderSelectButton';
  button.dataset.orderRef = order.order || '';
  button.disabled = Boolean(order.selected);
  button.textContent = order.selected ? 'Selected' : 'Use this order';

  item.append(details, button);
  return item;
}

function formatCandidateTracking(order) {
  const tracking = [order.tracking_carrier, order.tracking_number].filter(Boolean).join(' ');
  return tracking || '';
}

function selectOrderCandidate(orderRef) {
  const normalizedOrderRef = normalizeOrderRef(orderRef);
  if (!normalizedOrderRef || normalizedOrderRef === state.selectedOrderRef) return;

  state.selectedOrderRef = normalizedOrderRef;
  state.chatMessages = [];
  state.lastResult = null;
  state.pendingIssue = null;
  state.chatRequestId += 1;
  els.draft.value = '';
  els.confidence.textContent = 'confidence: n/a';
  hideInsertNotice();
  renderChat();
  persistSession();
  updateButtons();
  setStatus('Order selected');
  loadContext();
}

function normalizeOrderRef(value = '') {
  const clean = String(value || '').trim().replace(/^#?/, '');
  return clean ? `#${clean}` : '';
}
