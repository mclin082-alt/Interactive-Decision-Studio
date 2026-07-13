const state = {
  user: null,
  templates: [],
  selectedTemplateId: null,
  activeDeck: null,
  recentDecks: [],
  selectedArtifactTypeId: 'product-launch',
  currentPage: 1,
  totalPages: 1,
  annotate: false,
  isGenerating: false,
  isEditing: false,
  deliveryStartedAt: 0,
  deliveryPollTimer: null,
  deliveryElapsedTimer: null,
  taskCollapsed: false,
  taskAutoCollapsed: false,
  pendingAnnotation: null,
  errors: [],
  quota: null,
  verificationLink: '',
  verificationEmail: null,
  pendingSignupToken: '',
  pendingSignupEmail: ''
};

const artifactTypes = [
  {
    id: 'product-launch',
    name: 'Product launch',
    description: 'Demo flow, proof, rollout story'
  },
  {
    id: 'fundraising-pitch',
    name: 'Fundraising pitch',
    description: 'Market, traction, model, ask'
  },
  {
    id: 'sales-demo',
    name: 'Sales demo',
    description: 'Pain, ROI, proof, rollout'
  },
  {
    id: 'strategy-review',
    name: 'Strategy review',
    description: 'Choices, tradeoffs, roadmap'
  },
  {
    id: 'ai-project-showcase',
    name: 'AI project showcase',
    description: 'Workflow, architecture, evals, outcomes'
  },
  {
    id: 'portfolio-case-study',
    name: 'Portfolio case study',
    description: 'Problem, process, outcome, demo'
  },
  {
    id: 'data-story',
    name: 'Data story',
    description: 'Metrics, comparisons, interactive charts'
  },
  {
    id: 'sales-narrative',
    name: 'Sales narrative',
    description: 'Pain, proof, demo, close plan'
  }
];

const $ = (selector) => document.querySelector(selector);
let railMode = 'thumb';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getDeviceId() {
  const key = 'slideStudioDeviceId';
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem(key, id);
  }
  return id;
}

function clientLog(level, message, meta = {}) {
  fetch('/api/logs', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level, message, meta })
  }).catch((error) => console.warn('Could not send client log', error));
}

function renderErrors() {
  const panel = $('#errorPanel');
  const list = $('#errorList');
  if (!panel || !list) return;
  panel.classList.toggle('hidden', state.errors.length === 0);
  list.innerHTML = state.errors.map((item) => `
    <div class="error-item">
      <strong>${item.message}</strong>
      <small>${item.context} · ${item.time}</small>
    </div>
  `).join('');
}

function reportIssue(message, context = 'App', meta = {}) {
  const item = {
    message: String(message || 'Something went wrong.'),
    context,
    time: new Date().toLocaleTimeString()
  };
  state.errors.unshift(item);
  state.errors = state.errors.slice(0, 5);
  renderErrors();
  toast(item.message);
  clientLog('error', item.message, { context, ...meta });
}

function toast(message) {
  const node = $('#toast');
  if (!node) {
    console.warn(message);
    return;
  }
  node.textContent = message;
  node.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.add('hidden'), 3600);
}

async function api(path, options = {}) {
  try {
    const response = await fetch(path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': getDeviceId(), ...(options.headers || {}) },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch (error) {
      data = { error: text || response.statusText };
    }
    if (!response.ok) {
      const error = new Error(data.error || `Request failed (${response.status})`);
      error.data = data;
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error instanceof TypeError && /Failed to fetch/i.test(error.message || '')) {
      error.message = 'Local server is not reachable. Start it with npm run dev, then reload this page.';
      error.code = 'LOCAL_SERVER_UNREACHABLE';
    }
    if (path !== '/api/logs') clientLog('error', `API failed: ${path}`, { message: error.message });
    throw error;
  }
}

function show(view) {
  ['authView', 'homeView', 'workspaceView'].forEach((id) => {
    document.getElementById(id).classList.toggle('hidden', id !== view);
  });
}

function setUser(user) {
  state.user = user;
  if (!user) {
    state.recentDecks = [];
    state.activeDeck = null;
    renderDeckList();
    $('#accountName').textContent = 'Guest trial';
    $('#sidebarAvatar').textContent = '?';
    $('#sidebarAccountName').textContent = 'Guest trial';
    $('#sidebarAccountEmail').textContent = 'Local workspace';
    $('#logoutBtn').textContent = 'Sign in';
    renderQuota();
    renderEmailVerificationPanel();
    show('homeView');
    return;
  }
  $('#accountName').textContent = user.isGuest ? 'Guest trial' : user.name;
  $('#sidebarAvatar').textContent = user.isGuest ? '?' : user.name.slice(0, 1).toUpperCase();
  $('#sidebarAccountName').textContent = user.isGuest ? 'Guest trial' : user.name;
  $('#sidebarAccountEmail').textContent = user.email || 'Local workspace';
  $('#logoutBtn').textContent = user.isGuest ? 'Sign in' : 'Logout';
  renderQuota();
  renderEmailVerificationPanel();
  show('homeView');
  loadDecks();
}

function setQuota(quota) {
  state.quota = quota || null;
  renderQuota();
  renderEmailVerificationPanel();
}

function renderQuota() {
  const node = $('#quotaStatus');
  if (!node) return;
  const quota = state.quota;
  if (!state.user || state.user.isGuest) {
    const remaining = quota?.remaining ?? 3;
    node.innerHTML = `<strong>Free trial</strong><span>${remaining} basic generations left today. Register and verify email for 10 credits.</span>`;
    return;
  }
  if (!state.user.emailVerified) {
    node.innerHTML = `<strong>Email verification needed</strong><span>Verify your email to unlock ${state.user.credits || 0} + 10 official credits.</span>`;
    return;
  }
  node.innerHTML = `<strong>${state.user.plan === 'paid' ? 'Paid plan' : 'Free credits'}</strong><span>${state.user.plan === 'paid' ? 'Higher limits enabled.' : `${state.user.credits} generations remaining.`}</span>`;
}

function rememberVerificationPayload(payload = {}) {
  state.verificationLink = payload.verificationLink || state.verificationLink || '';
  state.verificationEmail = payload.verificationEmail || (state.verificationLink ? {
    to: state.user?.email || $('#emailInput')?.value || '',
    gmailUrl: 'https://mail.google.com/mail/u/0/#inbox',
    verificationLink: state.verificationLink
  } : state.verificationEmail);
  renderEmailVerificationPanel();
}

function renderEmailVerificationPanel() {
  const panel = $('#emailVerificationPanel');
  if (!panel) return;
  if (!state.user || state.user.isGuest || state.user.emailVerified) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }

  const email = state.verificationEmail?.to || state.user.email || 'your Gmail inbox';
  const gmailUrl = state.verificationEmail?.gmailUrl || 'https://mail.google.com/mail/u/0/#inbox';
  const verificationLink = state.verificationEmail?.verificationLink || state.verificationLink;
  panel.classList.remove('hidden');
  panel.innerHTML = `
    <div class="email-steps">
      <div class="email-step active"><span>1</span><strong>Enter Gmail</strong></div>
      <div class="email-step active"><span>2</span><strong>Check inbox</strong></div>
      <div class="email-step"><span>3</span><strong>Confirm credits</strong></div>
    </div>
    <div class="email-copy">
      <strong>Verification email sent</strong>
      <span>Open Gmail for ${escapeHtml(email)}, click the Slide Studio verification email, then come back here to confirm your credits.</span>
    </div>
    <div class="email-actions">
      <a class="email-primary" href="${escapeHtml(gmailUrl)}" target="_blank" rel="noreferrer">Open Gmail</a>
      <button type="button" id="refreshVerificationBtn">I clicked verify</button>
      <button type="button" id="resendVerificationBtn">Resend</button>
    </div>
    ${verificationLink ? `<div class="email-dev-note">Local preview: <a href="${escapeHtml(verificationLink)}" target="_blank" rel="noreferrer">open verification email</a></div>` : ''}
  `;
}

async function refreshVerificationStatus() {
  try {
    const { user, quota } = await api('/api/me');
    setUser(user);
    setQuota(quota);
    if (user?.emailVerified) {
      state.verificationLink = '';
      state.verificationEmail = null;
      renderEmailVerificationPanel();
      toast('Email verified. Credits are ready.');
    } else {
      toast('Still waiting for verification. Check Gmail and click the email button first.');
    }
  } catch (error) {
    reportIssue(error.message || 'Could not refresh verification status.', 'Email verification');
  }
}

async function resendVerificationEmail() {
  try {
    const payload = await api('/api/resend-verification', { method: 'POST' });
    setUser(payload.user);
    rememberVerificationPayload(payload);
    toast(payload.alreadyVerified ? 'Email is already verified.' : 'Verification email sent again.');
  } catch (error) {
    reportIssue(error.message || 'Could not resend verification email.', 'Email verification');
  }
}

function setRailActive(action) {
  document.querySelectorAll('.sidebar-action[data-rail-action]').forEach((button) => {
    button.classList.toggle('active', button.dataset.railAction === action);
  });
}

function cacheBust(path, updatedAt = '') {
  if (!path || path === 'about:blank') return path || 'about:blank';
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}v=${encodeURIComponent(updatedAt || Date.now())}`;
}

function renderDeckList() {
  const lists = [$('#deckList'), $('#sidebarDeckList')].filter(Boolean);
  if (!lists.length) return;
  if (!state.recentDecks.length) {
    lists.forEach((list) => {
      list.innerHTML = '<div class="deck-empty">Generated decks will appear here.</div>';
    });
    return;
  }
  const html = state.recentDecks.map((deck) => `
    <button class="deck-list-item ${state.activeDeck?.id === deck.id ? 'active' : ''}" data-deck-id="${deck.id}">
      <strong>${deck.title || 'Untitled deck'}</strong>
      <span>${deck.status || 'draft'} · ${new Date(deck.updatedAt || deck.createdAt).toLocaleString()}</span>
    </button>
  `).join('');
  lists.forEach((list) => {
    list.innerHTML = html;
    list.querySelectorAll('.deck-list-item').forEach((item) => {
      item.addEventListener('click', () => openThreadById(item.dataset.deckId));
    });
  });
}

function renderArtifactTypes() {
  const node = $('#artifactOptions');
  if (!node) return;
  node.innerHTML = artifactTypes.map((type) => `
    <button class="artifact-option ${state.selectedArtifactTypeId === type.id ? 'active' : ''}" type="button" data-artifact-type="${type.id}">
      <strong>${type.name}</strong>
      <span>${type.description}</span>
    </button>
  `).join('');
  node.querySelectorAll('[data-artifact-type]').forEach((button) => {
    button.addEventListener('click', () => selectArtifactType(button.dataset.artifactType));
  });
}

function selectArtifactType(id) {
  if (!artifactTypes.some((type) => type.id === id)) return;
  state.selectedArtifactTypeId = id;
  renderArtifactTypes();
  const selected = artifactTypes.find((type) => type.id === id);
  toast(`${selected.name} artifact selected.`);
}

async function loadDecks() {
  if (!state.user) return;
  try {
    const { decks } = await api('/api/decks');
    state.recentDecks = decks;
    renderDeckList();
  } catch (error) {
    reportIssue(error.message || 'Could not load deck history.', 'Deck history');
  }
}

function renderTemplates(category = 'All templates') {
  const grid = $('#templateGrid');
  const visible = category === 'All templates'
    ? state.templates
    : state.templates.filter((template) => template.category === category);
  if (!visible.length) {
    grid.innerHTML = '<div class="empty-state">No templates in this category yet.</div>';
    return;
  }
  grid.innerHTML = visible.map((template) => `
    <button class="template-card ${state.selectedTemplateId === template.id ? 'selected' : ''}" data-template="${template.id}">
      <div class="template-thumb" style="--template-accent:${template.accent}">
        <div class="template-preview-grid">
          <span class="mini-slide mini-slide-primary">
            <i></i><b></b><em></em>
          </span>
          <span class="mini-slide mini-slide-data">
            <i></i><i></i><i></i><i></i>
          </span>
          <span class="mini-slide mini-slide-text">
            <b></b><em></em><em></em>
          </span>
        </div>
        <span class="use-badge">Use</span>
      </div>
      <div class="template-body">
        <div>
          <div class="template-name">${template.name}</div>
          <div class="template-category">${template.category}</div>
        </div>
        <div class="template-meta"><span class="template-tag">HTML Artifact</span><span>${template.uses.toLocaleString()} uses</span></div>
      </div>
    </button>
  `).join('');

  grid.querySelectorAll('.template-card').forEach((card) => {
    card.addEventListener('click', () => selectTemplate(card.dataset.template));
  });
}

function selectTemplate(id) {
  state.selectedTemplateId = id;
  const template = state.templates.find((item) => item.id === id);
  if (!template) {
    toast('Template not found. Try another template.');
    return;
  }
  $('#selectedTemplate').innerHTML = `
    <span class="selected-dot" style="--template-accent:${template.accent}"></span>
    <span>Selected template</span>
    <strong>${template.name}</strong>
  `;
  $('#generateBtn').classList.add('ready');
  renderTemplates($('#templateTabs button.active')?.dataset.category || 'All templates');
  document.querySelector('.composer').scrollIntoView({ behavior: 'smooth', block: 'center' });
  toast(`${template.name} selected. Add a prompt, then generate.`);
}

function setGenerateState(active) {
  state.isGenerating = active;
  $('#generateBtn').disabled = active;
  $('#generateBtn').textContent = active ? '...' : '↑';
  $('#generateBtn').title = active ? 'Generating real HTML deck' : 'Generate';
  $('#generateBtn').setAttribute('aria-busy', String(active));
  if (active) {
    $('#retryGenerateBtn').classList.add('hidden');
    $('#generationStatus').classList.remove('hidden');
    $('#generationStatus').classList.remove('failed');
    $('#generationStatusTitle').textContent = 'Designing interactive presentation';
    $('#generationStatusDetail').textContent = 'Planning modules, composing narrative, and rendering a browser-native HTML experience.';
  } else if (!$('#generationStatus').classList.contains('failed')) {
    $('#generationStatus').classList.add('hidden');
  }
}

function setGenerationFailure(message, deck = null) {
  $('#generationStatus').classList.remove('hidden');
  $('#generationStatus').classList.add('failed');
  $('#generationStatusTitle').textContent = 'Generation failed';
  $('#generationStatusDetail').textContent = message || 'Please retry in a moment.';
  $('#retryGenerateBtn').classList.toggle('hidden', !deck?.id);
  $('#retryGenerateBtn').dataset.deckId = deck?.id || '';
}

function parseProgressMessage(message) {
  try {
    const parsed = JSON.parse(message.text || '{}');
    return {
      id: message.id,
      title: parsed.title || message.text || 'Working',
      detail: parsed.detail || '',
      status: parsed.status || 'done',
      type: parsed.type || 'step',
      tool: parsed.tool || '',
      createdAt: message.createdAt
    };
  } catch (error) {
    return {
      id: message.id,
      title: message.text || 'Working',
      detail: '',
      status: 'done',
      type: 'step',
      tool: '',
      createdAt: message.createdAt
    };
  }
}

function progressMessages(deck) {
  return (deck?.messages || [])
    .filter((message) => message.role === 'progress')
    .map(parseProgressMessage);
}

function renderWorkingSteps(deck) {
  const events = progressMessages(deck);
  if (!events.length) {
    $('#workingSteps').innerHTML = `
      <div class="working-step active">
        <div>
          <strong>Starting generation</strong>
          <span>Waiting for the server worker to report its first real step.</span>
        </div>
      </div>
    `;
    return;
  }
  $('#workingSteps').innerHTML = events.map((step, index) => {
    const isLast = index === events.length - 1;
    const active = deck?.status === 'generating' && isLast && step.status !== 'failed';
    const failed = step.status === 'failed';
    const typeLabel = step.type ? step.type.replace(/[-_]/g, ' ') : 'step';
    return `
      <div class="working-step ${active ? 'active' : 'done'} ${failed ? 'failed' : ''}">
        <div>
          <small class="run-event-type">${escapeHtml(typeLabel)}${step.tool ? ` · ${escapeHtml(step.tool)}` : ''}</small>
          <strong>${escapeHtml(step.title)}</strong>
          <span>${escapeHtml(step.detail)}</span>
        </div>
      </div>
    `;
  }).join('');
}

function updateDeliveryElapsed() {
  if (!state.deliveryStartedAt) return;
  const seconds = Math.max(0, Math.floor((Date.now() - state.deliveryStartedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  const label = minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
  const summary = $('#taskSummary');
  if (summary && state.activeDeck?.status === 'generating') summary.textContent = `Working for ${label}`;
}

function stopDeliveryTimers() {
  clearInterval(state.deliveryPollTimer);
  clearInterval(state.deliveryElapsedTimer);
  state.deliveryPollTimer = null;
  state.deliveryElapsedTimer = null;
}

function toggleTaskCard(force) {
  state.taskCollapsed = typeof force === 'boolean' ? force : !state.taskCollapsed;
  $('#taskCard')?.classList.toggle('collapsed', state.taskCollapsed);
  $('#taskCardHead')?.setAttribute('aria-expanded', String(!state.taskCollapsed));
}

function renderTaskCard(deck) {
  const card = $('#taskCard');
  if (!card || !deck) return;
  card.classList.remove('hidden');
  $('#taskPrompt').textContent = deck.prompt || 'Create a presentation artifact.';
  renderWorkingSteps(deck);

  const pill = $('#taskStatusPill');
  const failed = deck.status === 'failed';
  const complete = deck.status === 'complete';
  pill.textContent = complete ? 'Ready' : failed ? 'Failed' : 'Generating';
  pill.classList.toggle('failed', failed);
  pill.classList.toggle('ready', complete);

  const seconds = state.deliveryStartedAt ? Math.max(0, Math.floor((Date.now() - state.deliveryStartedAt) / 1000)) : 0;
  const minutes = Math.floor(seconds / 60);
  const label = minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
  $('#taskSummary').textContent = complete ? `Generated in ${label}` : failed ? 'Generation failed' : `Working for ${label}`;

  $('#taskFailure').classList.toggle('hidden', !failed);
  $('#taskFailureText').textContent = deck.error || 'Please retry in a moment.';

  // Auto-collapse the build steps the first time a deck finishes, without
  // fighting a manual expand/collapse the person already did.
  if (complete && !state.taskAutoCollapsed) {
    state.taskAutoCollapsed = true;
    toggleTaskCard(true);
  }
  if (failed) toggleTaskCard(false);
}

async function pollThread(deckId) {
  try {
    const { deck } = await api(`/api/decks/${deckId}`);
    if (state.activeDeck?.id !== deckId) return;
    state.activeDeck = deck;
    renderTaskCard(deck);
    if (deck.status === 'complete') {
      stopDeliveryTimers();
      $('#slideFrame').src = cacheBust(deck.deckPath, deck.updatedAt);
      const template = state.templates.find((item) => item.id === deck.templateId);
      $('#deckMeta').textContent = `${template?.name || 'Template'} · ${deck.shareUrl ? 'Private link ready' : 'HTML Artifact'}`;
      $('#shareBtn').textContent = deck.shareUrl ? 'Copy link' : 'Share';
      renderMessages(deck);
      renderDeckList();
      loadDecks();
    } else if (deck.status === 'failed') {
      stopDeliveryTimers();
    }
  } catch (error) {
    reportIssue(error.message || 'Could not refresh generation status.', 'Generation', { deckId });
  }
}

async function copyText(value) {
  const text = String(value || '');
  if (!text) return false;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const input = document.createElement('textarea');
  input.value = text;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  const ok = document.execCommand('copy');
  input.remove();
  return ok;
}

async function shareDeck(deck = state.activeDeck) {
  if (!deck?.id) {
    toast('Generate an artifact before sharing.');
    return null;
  }
  try {
    const existingUrl = deck.shareUrl;
    const payload = existingUrl ? { deck, shareUrl: existingUrl } : await api(`/api/decks/${deck.id}/share`, { method: 'POST' });
    const nextDeck = payload.deck || deck;
    if (state.activeDeck?.id === nextDeck.id) {
      state.activeDeck = nextDeck;
      $('#shareBtn').textContent = 'Copy link';
      const template = state.templates.find((item) => item.id === nextDeck.templateId);
      $('#deckMeta').textContent = `${template?.name || 'Template'} · ${nextDeck.status || 'complete'} · Private link ready`;
    }
    await copyText(payload.shareUrl || nextDeck.shareUrl);
    toast('Private link copied.');
    return payload.shareUrl || nextDeck.shareUrl;
  } catch (error) {
    reportIssue(error.message || 'Could not create share link.', 'Share', { deckId: deck.id });
    return null;
  }
}

function addMessage(role, text) {
  const node = document.createElement('div');
  node.className = `message ${role}`;
  node.textContent = text;
  $('#chatLog').appendChild(node);
  $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
}

function renderMessages(deck) {
  $('#chatLog').innerHTML = '';
  const messages = deck.messages?.length
    ? deck.messages.filter((message) => message.role !== 'progress')
    : [
        { role: 'user', text: deck.prompt },
        { role: 'assistant', text: `Ready to edit ${deck.title || 'this deck'}.` }
      ];
  messages.forEach((message) => addMessage(message.role, message.text));
}

function setChatBusy(active) {
  state.isEditing = active;
  $('#sendChatBtn').disabled = active;
  $('#editCurrentBtn').disabled = active;
  $('#undoBtn').disabled = active;
  $('#regenerateBtn').disabled = active;
  $('#shareBtn').disabled = active;
  $('#exportBtn').disabled = active;
  $('#exportPdfBtn').disabled = active;
  $('#chatInput').disabled = active;
  $('#sendChatBtn').textContent = active ? 'Editing...' : 'Send';
  $('#editOverlay').classList.toggle('hidden', !active);
  $('#editOverlayTitle').textContent = active ? 'Applying edit and refreshing preview' : '';
}

function renderAnnotations(deck = state.activeDeck) {
  const panel = $('#annotationPanel');
  const list = $('#annotationList');
  if (!panel || !list) return;
  const comments = deck?.comments || [];
  panel.classList.toggle('hidden', !comments.length && !state.annotate);
  if (!comments.length) {
    list.innerHTML = '<div class="annotation-empty">Click the preview while Annotate is on.</div>';
    return;
  }
  list.innerHTML = comments.map((comment, index) => `
    <article class="annotation-item ${comment.status === 'resolved' ? 'resolved' : ''}">
      <div class="annotation-item-head">
        <strong>#${index + 1} · Slide ${comment.page || 1}</strong>
        <span>${comment.status || 'open'}</span>
      </div>
      <p>${comment.note}</p>
      ${comment.elementText ? `<small>${comment.elementTag || 'element'} · ${comment.elementText.slice(0, 90)}</small>` : ''}
      <div class="annotation-actions">
        <button type="button" data-apply-annotation="${comment.id}" ${comment.status === 'resolved' ? 'disabled' : ''}>Apply</button>
      </div>
    </article>
  `).join('');
  list.querySelectorAll('[data-apply-annotation]').forEach((button) => {
    button.addEventListener('click', () => applyAnnotation(button.dataset.applyAnnotation));
  });
}

function updatePageIndicator(page = state.currentPage, total = state.totalPages) {
  state.currentPage = Math.max(1, Number(page) || 1);
  state.totalPages = Math.max(1, Number(total) || 1);
  $('#pageIndicator').textContent = `Slide ${state.currentPage} / ${state.totalPages}`;
  const fullscreenIndicator = $('#fullscreenPageIndicator');
  if (fullscreenIndicator) fullscreenIndicator.textContent = `${state.currentPage} / ${state.totalPages}`;
}

let cachedDeckHtml = null;

async function getDeckHtml(deckPath) {
  if (cachedDeckHtml) return cachedDeckHtml;
  if (!deckPath || deckPath === 'about:blank') return null;
  try {
    const response = await fetch(deckPath);
    const html = await response.text();
    cachedDeckHtml = html;
    return html;
  } catch (error) {
    return null;
  }
}

function invalidateDeckCache() {
  cachedDeckHtml = null;
}

function extractSlideOutline(frame) {
  if (!frame?.contentDocument) return [];
  try {
    const slides = [...frame.contentDocument.querySelectorAll('.slide')];
    return slides.map((slide, index) => ({
      index: index + 1,
      title: slide.querySelector('h1, h2, h3')?.innerText?.trim().slice(0, 60) || `Slide ${index + 1}`
    }));
  } catch (error) {
    return [];
  }
}

function renderSlideRail(frame) {
  const items = $('#railItems');
  if (!items) return;
  const outline = extractSlideOutline(frame);

  if (!outline.length) {
    items.innerHTML = '<div class="rail-empty">No slides yet.</div>';
    return;
  }

  if (railMode === 'list') {
    items.innerHTML = outline.map((slide) => `
      <button class="rail-item rail-item-list ${slide.index === state.currentPage ? 'active' : ''}" data-page="${slide.index}">
        <span class="rail-num">${slide.index}</span>
        <span class="rail-title">${escapeHtml(slide.title)}</span>
      </button>
    `).join('');
  } else {
    items.innerHTML = outline.map((slide) => `
      <button class="rail-item rail-item-thumb ${slide.index === state.currentPage ? 'active' : ''}" data-page="${slide.index}">
        <span class="rail-thumb-box">
          <span class="rail-thumb-num">${slide.index}</span>
          <iframe class="rail-thumb-inner" srcdoc="" sandbox="allow-scripts" tabindex="-1" loading="lazy" data-page="${slide.index}"></iframe>
        </span>
        <span class="rail-title">${escapeHtml(slide.title)}</span>
      </button>
    `).join('');
  }

  // If thumb mode, load full deck HTML into each thumb iframe, then call __gotoSlide
  if (railMode === 'thumb') {
    const thumbIframes = items.querySelectorAll('.rail-thumb-inner');
    const deckHtml = state.activeDeck?.deckPath ? getDeckHtml(state.activeDeck.deckPath) : null;
    if (deckHtml) {
      deckHtml.then((html) => {
        if (!html) return;
        thumbIframes.forEach((iframe) => {
          const page = Number(iframe.dataset.page);
          iframe.srcdoc = html;
          iframe.addEventListener('load', function onLoad() {
            iframe.removeEventListener('load', onLoad);
            try {
              if (iframe.contentWindow.__gotoSlide) {
                iframe.contentWindow.__gotoSlide(page - 1);
              }
            } catch (e) {
              // cross-origin or not ready
            }
          }, { once: true });
        });
      });
    }
  }

  items.querySelectorAll('[data-page]').forEach((button) => {
    button.addEventListener('click', () => {
      const page = Number(button.dataset.page);
      // In fullscreen mode, jump the fullscreen frame; in preview mode, jump the slide frame
      const targetFrame = $('#fullscreenView')?.classList.contains('hidden') ? $('#slideFrame') : $('#fullscreenFrame');
      showFrameSlide(targetFrame, page);
      renderSlideRail(targetFrame);
    });
  });
}

function setRailMode(mode) {
  railMode = mode;
  $('#railThumbTab').classList.toggle('active', mode === 'thumb');
  $('#railListTab').classList.toggle('active', mode === 'list');
  const targetFrame = $('#fullscreenView')?.classList.contains('hidden') ? $('#slideFrame') : $('#fullscreenFrame');
  renderSlideRail(targetFrame);
}

async function generateDeck() {
  if (state.isGenerating) return;
  const userPrompt = $('#promptInput').value.trim();
  if (!userPrompt) {
    $('#promptInput').focus();
    toast('先输入你想做什么 artifact，例如：做一个 AI 产品 walkthrough，包含流程、数据和 demo。');
    return;
  }
  if (!state.selectedTemplateId && state.templates[0]) {
    selectTemplate(state.templates[0].id);
  }
  setGenerateState(true);
  try {
    const { deck, user, quota } = await api('/api/generate', {
      method: 'POST',
      body: {
        prompt: userPrompt,
        templateId: state.selectedTemplateId,
        artifactTypeId: state.selectedArtifactTypeId,
        async: true
      }
    });
    if (user) setUser(user);
    setQuota(quota);
    openThread(deck);
    await loadDecks();
  } catch (error) {
    const failedDeck = error.data?.deck || null;
    setGenerationFailure(error.message || 'Generate failed. Please try again.', failedDeck);
    reportIssue(error.message || 'Generate failed. Please try again.', 'Generate', { templateId: state.selectedTemplateId, deckId: failedDeck?.id });
  } finally {
    setGenerateState(false);
  }
}

async function retryGeneration(deckId) {
  if (!deckId || state.isGenerating) return;
  setGenerateState(true);
  try {
    const { deck, quota } = await api(`/api/generate/${deckId}/retry`, { method: 'POST', body: { async: true } });
    setQuota(quota);
    $('#generationStatus').classList.add('hidden');
    openThread(deck);
    await loadDecks();
  } catch (error) {
    const failedDeck = error.data?.deck || { id: deckId };
    setGenerationFailure(error.message || 'Retry failed.', failedDeck);
    reportIssue(error.message || 'Retry failed.', 'Generate retry', { deckId });
  } finally {
    setGenerateState(false);
  }
}

// A single canonical view for a deck: whether it's still generating, mid-edit,
// or complete, it always renders the same chat + preview split at the same
// URL (#/p/:id). Closing the preview, reopening the private link, or clicking
// it from the sidebar all land here — nothing is view-specific anymore.
function openThread(deck, replace = false) {
  stopDeliveryTimers();
  state.activeDeck = deck;
  state.taskAutoCollapsed = deck.status !== 'generating';
  state.taskCollapsed = deck.status !== 'generating';
  invalidateDeckCache();
  $('#workspaceView').classList.remove('preview-closed');
  const template = state.templates.find((item) => item.id === deck.templateId);
  $('#deckTitle').textContent = deck.title || 'Generated deck';
  $('#deckMeta').textContent = `${template?.name || 'Template'} · ${deck.status || 'complete'} · ${deck.shareUrl ? 'Private link ready' : 'HTML Artifact'}`;
  $('#shareBtn').textContent = deck.shareUrl ? 'Copy link' : 'Share';
  $('#slideFrame').src = deck.deckPath ? cacheBust(deck.deckPath, deck.updatedAt) : 'about:blank';
  renderTaskCard(deck);
  toggleTaskCard(state.taskCollapsed);
  renderMessages(deck);
  renderAnnotations(deck);
  renderDeckList();
  updatePageIndicator(deck.currentPage || 1, 1);
  clientLog('info', 'Thread opened', { deckId: deck.id, templateId: deck.templateId, status: deck.status });
  setRailActive('');
  show('workspaceView');
  const url = `#/p/${deck.id}`;
  if (replace) history.replaceState({ deckId: deck.id }, '', url);
  else history.pushState({ deckId: deck.id }, '', url);

  if (deck.status === 'generating') {
    state.deliveryStartedAt = Date.parse(deck.createdAt || '') || Date.now();
    state.deliveryElapsedTimer = setInterval(updateDeliveryElapsed, 1000);
    state.deliveryPollTimer = setInterval(() => pollThread(deck.id), 2200);
    updateDeliveryElapsed();
    pollThread(deck.id);
  }
}

async function openThreadById(deckId, replace = false) {
  try {
    const { deck } = await api(`/api/decks/${deckId}`);
    openThread(deck, replace);
  } catch (error) {
    reportIssue(error.message || 'Could not open this link.', 'Thread', { deckId });
  }
}

function routeFromHash() {
  // #/p/:id is canonical. #/deck/:id and #/deliver/:id are accepted as
  // aliases so old links/bookmarks from before the redesign still resolve.
  const [, , id] = window.location.hash.match(/^#\/(p|deck|deliver)\/([^/]+)/) || [];
  return { id };
}

async function restoreRoute() {
  if (!state.user) return;
  const { id } = routeFromHash();
  if (id) await openThreadById(id, true);
}

function handleVerificationReturn() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('verified') !== '1') return;
  const migrated = Number(params.get('migrated') || 0);
  toast(migrated > 0
    ? `Email verified. ${migrated} trial project${migrated === 1 ? '' : 's'} saved to this account.`
    : 'Email verified. Credits are ready.');
  history.replaceState(history.state, '', `${window.location.pathname}${window.location.hash}`);
}

function enterSignupCompletion({ token, email, name }) {
  state.pendingSignupToken = token;
  state.pendingSignupEmail = email;
  show('authView');
  $('#emailInput').value = email || '';
  $('#nameInput').value = name || '';
  $('#passwordInput').value = '';
  $('#passwordInput').focus();
  $('#signupBtn').textContent = 'Finish account';
  $('#verificationLink').innerHTML = `Email verified for ${escapeHtml(email)}. Set a password to finish creating your account.`;
  $('#verificationLink').classList.remove('hidden');
  toast('Email verified. Set a password to finish signup.');
}

function resetSignupCompletion() {
  state.pendingSignupToken = '';
  state.pendingSignupEmail = '';
  $('#signupBtn').textContent = 'Create account';
}

async function handleSignupVerificationReturn() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('signup_token');
  if (!token) return;
  try {
    const payload = await api(`/api/signup-token?token=${encodeURIComponent(token)}`);
    enterSignupCompletion({ token, ...payload });
    history.replaceState(history.state, '', `${window.location.pathname}${window.location.hash}`);
  } catch (error) {
    show('authView');
    $('#verificationLink').innerHTML = escapeHtml(error.message || 'Signup verification link could not be used.');
    $('#verificationLink').classList.remove('hidden');
    reportIssue(error.message || 'Signup verification link could not be used.', 'Signup');
  }
}

function syncPreviewPage() {
  const frame = $('#slideFrame');
  if (!frame?.contentDocument) return;
  syncFramePage(frame);
}

function syncFramePage(frame) {
  try {
    const slides = [...frame.contentDocument.querySelectorAll('.slide')];
    const activeIndex = slides.findIndex((slide) => slide.classList.contains('active') || slide.classList.contains('visible'));
    updatePageIndicator(activeIndex >= 0 ? activeIndex + 1 : 1, slides.length || 1);
  } catch (error) {
    updatePageIndicator(1, 1);
  }
}

function showFrameSlide(frame, page) {
  if (!frame?.contentDocument) return;
  try {
    const doc = frame.contentDocument;
    const slides = [...doc.querySelectorAll('.slide')];
    if (!slides.length) return;
    const targetIndex = Math.max(0, Math.min(slides.length - 1, (Number(page) || 1) - 1));
    slides.forEach((slide, index) => {
      const active = index === targetIndex;
      slide.classList.toggle('active', active);
      slide.classList.toggle('visible', active);
    });
    const counter = doc.querySelector('#slideCounter, .slide-counter, [data-slide-counter]');
    if (counter) counter.textContent = `${targetIndex + 1} / ${slides.length}`;
    const progress = doc.querySelector('#progressBar, .progress-bar, [data-progress-bar]');
    if (progress) progress.style.width = `${((targetIndex + 1) / slides.length) * 100}%`;
    updatePageIndicator(targetIndex + 1, slides.length);
  } catch (error) {
    reportIssue('Could not control the slide frame.', 'Presentation controls', { message: error.message });
  }
}

function moveFrameSlide(frame, delta) {
  if (!frame?.contentDocument) return;
  const slides = [...frame.contentDocument.querySelectorAll('.slide')];
  const activeIndex = slides.findIndex((slide) => slide.classList.contains('active') || slide.classList.contains('visible'));
  const current = activeIndex >= 0 ? activeIndex + 1 : state.currentPage;
  showFrameSlide(frame, current + delta);
}

function openDownload(url) {
  const link = document.createElement('a');
  link.href = url;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function activeElementIsTyping() {
  const element = document.activeElement;
  if (!element) return false;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable;
}

async function openFullscreenPresentation() {
  if (!state.activeDeck) return;
  const view = $('#fullscreenView');
  const frame = $('#fullscreenFrame');
  frame.src = cacheBust(state.activeDeck.deckPath, state.activeDeck.updatedAt);
  view.classList.remove('hidden');
  $('#fullscreenChatInput').value = '';
  try {
    if (view.requestFullscreen && !document.fullscreenElement) await view.requestFullscreen();
  } catch (error) {
    clientLog('error', 'Browser fullscreen request was blocked', { message: error.message });
  }
  toast('Full screen presentation opened.');
}

async function closeFullscreenPresentation() {
  $('#fullscreenView').classList.add('hidden');
  if (document.fullscreenElement) {
    try {
      await document.exitFullscreen();
    } catch (error) {
      clientLog('error', 'Could not exit browser fullscreen', { message: error.message });
    }
  }
}

function selectorForElement(element) {
  if (!element || element.nodeType !== 1) return '';
  if (element.id) return `#${CSS.escape(element.id)}`;
  const parts = [];
  let node = element;
  while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'html' && parts.length < 5) {
    let part = node.tagName.toLowerCase();
    if (node.classList.length) part += `.${[...node.classList].slice(0, 2).map((name) => CSS.escape(name)).join('.')}`;
    const parent = node.parentElement;
    if (parent) {
      const sameTag = [...parent.children].filter((child) => child.tagName === node.tagName);
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(' > ');
}

function getAnnotationTarget(event) {
  const frame = $('#slideFrame');
  try {
    const frameRect = frame.getBoundingClientRect();
    const frameDoc = frame.contentDocument;
    const frameWindow = frame.contentWindow;
    const scaleX = frameWindow.innerWidth / frameRect.width;
    const scaleY = frameWindow.innerHeight / frameRect.height;
    const frameX = (event.clientX - frameRect.left) * scaleX;
    const frameY = (event.clientY - frameRect.top) * scaleY;
    const element = frameDoc.elementFromPoint(frameX, frameY);
    if (!element) return {};
    const rect = element.getBoundingClientRect();
    return {
      selector: selectorForElement(element),
      elementText: (element.innerText || element.textContent || '').trim().slice(0, 300),
      elementTag: element.tagName.toLowerCase(),
      elementRect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  } catch (error) {
    return {};
  }
}

async function submitDeckEdit(text) {
  if (!state.activeDeck || state.isEditing) return;
  const instruction = text.trim();
  if (!instruction) return;
  $('#chatInput').value = '';
  addMessage('user', instruction);
  addMessage('assistant', 'Working on it. I am editing the HTML and will refresh the preview when it is done.');
  setChatBusy(true);
  try {
    const { deck } = await api(`/api/decks/${state.activeDeck.id}/messages`, {
      method: 'POST',
      body: { text: instruction, currentPage: state.currentPage }
    });
    state.activeDeck = deck;
    $('#deckMeta').textContent = `${state.templates.find((item) => item.id === deck.templateId)?.name || 'Template'} · ${deck.status || 'complete'} · HTML Artifact`;
    renderMessages(deck);
    $('#slideFrame').src = cacheBust(deck.deckPath, deck.updatedAt);
    await loadDecks();
    toast('Preview refreshed with the latest edit.');
  } catch (error) {
    const deck = error.data?.deck;
    if (deck) {
      state.activeDeck = deck;
      renderMessages(deck);
      renderAnnotations(deck);
    } else {
      addMessage('assistant', `Edit failed: ${error.message}`);
    }
    reportIssue(error.message || 'Could not edit this deck.', 'Chat edit', { deckId: state.activeDeck?.id });
  } finally {
    setChatBusy(false);
  }
}

function toggleAnnotate() {
  state.annotate = !state.annotate;
  $('#annotationLayer').classList.toggle('hidden', !state.annotate);
  $('#annotateBtn').classList.toggle('active', state.annotate);
}

async function addAnnotation(event) {
  if (!state.activeDeck) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const x = Math.round(event.clientX - rect.left);
  const y = Math.round(event.clientY - rect.top);
  const target = getAnnotationTarget(event);
  const note = prompt('Annotate this spot');
  if (!note) return;

  const pin = document.createElement('div');
  pin.className = 'annotation-pin';
  pin.style.left = `${x}px`;
  pin.style.top = `${y}px`;
  pin.textContent = '1';
  $('#annotationLayer').appendChild(pin);

  try {
    const { deck } = await api('/api/comment', {
      method: 'POST',
      body: { deckId: state.activeDeck.id, page: state.currentPage, note, x, y, ...target }
    });
    state.activeDeck = deck;
    renderMessages(deck);
    renderAnnotations(deck);
    toast('Annotation saved. Applying it now...');
    const created = (deck.comments || []).find((comment) => comment.x === x && comment.y === y && comment.note === note && comment.status !== 'resolved');
    if (created) applyAnnotation(created.id);
  } catch (error) {
    reportIssue(error.message || 'Could not save annotation.', 'Annotate', { deckId: state.activeDeck.id });
  }
}

async function applyAnnotation(commentId) {
  if (!state.activeDeck || state.isEditing) return;
  const comment = (state.activeDeck.comments || []).find((item) => item.id === commentId);
  if (!comment) return;
  setChatBusy(true);
  addMessage('user', `Apply annotation on slide ${comment.page}: ${comment.note}`);
  addMessage('assistant', 'Working on the annotated area. I will refresh the preview when it is done.');
  try {
    const { deck } = await api(`/api/decks/${state.activeDeck.id}/comments/${commentId}/apply`, {
      method: 'POST',
      body: { text: comment.note }
    });
    state.activeDeck = deck;
    renderMessages(deck);
    renderAnnotations(deck);
    $('#slideFrame').src = cacheBust(deck.deckPath, deck.updatedAt);
    await loadDecks();
    toast('Annotation applied and marked resolved.');
  } catch (error) {
    const deck = error.data?.deck;
    if (deck) {
      state.activeDeck = deck;
      renderMessages(deck);
      renderAnnotations(deck);
    }
    reportIssue(error.message || 'Could not apply annotation.', 'Annotation apply', { deckId: state.activeDeck?.id, commentId });
  } finally {
    setChatBusy(false);
  }
}

async function undoDeck() {
  if (!state.activeDeck || state.isEditing) return;
  setChatBusy(true);
  try {
    const { deck } = await api(`/api/decks/${state.activeDeck.id}/undo`, { method: 'POST' });
    state.activeDeck = deck;
    renderMessages(deck);
    renderAnnotations(deck);
    $('#slideFrame').src = cacheBust(deck.deckPath, deck.updatedAt);
    await loadDecks();
    toast('Undone. Preview restored to the previous version.');
  } catch (error) {
    reportIssue(error.message || 'No previous version available.', 'Undo', { deckId: state.activeDeck?.id });
  } finally {
    setChatBusy(false);
  }
}

async function init() {
  $('#clearErrorsBtn').addEventListener('click', () => {
    state.errors = [];
    renderErrors();
  });

  $('#authForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    resetSignupCompletion();
    $('#authError').textContent = '';
    $('#verificationLink').classList.add('hidden');
    try {
      const payload = await api('/api/login', {
        method: 'POST',
        body: { email: $('#emailInput').value, password: $('#passwordInput').value }
      });
      const { user, verificationLink } = payload;
      setUser(user);
      if (verificationLink) {
        rememberVerificationPayload(payload);
        $('#verificationLink').innerHTML = `Verification email sent. Open Gmail, click the confirmation button, then return here.`;
        $('#verificationLink').classList.remove('hidden');
        toast('Verification email sent. Open Gmail to confirm.');
      } else if (payload.migratedDecks) {
        toast(`${payload.migratedDecks} trial project${payload.migratedDecks === 1 ? '' : 's'} saved to this account.`);
      }
    } catch (error) {
      $('#authError').textContent = error.message;
      reportIssue(error.message, 'Login');
    }
  });

  $('#signupBtn').addEventListener('click', async () => {
    $('#authError').textContent = '';
    $('#verificationLink').classList.add('hidden');
    try {
      if (state.pendingSignupToken) {
        const payload = await api('/api/signup/complete', {
          method: 'POST',
          body: {
            token: state.pendingSignupToken,
            name: $('#nameInput').value,
            password: $('#passwordInput').value
          }
        });
        resetSignupCompletion();
        setUser(payload.user);
        setQuota(payload.quota);
        await loadDecks();
        toast(payload.migratedDecks
          ? `Account created. ${payload.migratedDecks} trial project${payload.migratedDecks === 1 ? '' : 's'} saved.`
          : 'Account created. You are signed in.');
        return;
      }

      const payload = await api('/api/signup', {
        method: 'POST',
        body: { name: $('#nameInput').value, email: $('#emailInput').value }
      });
      if (payload.verificationLink) {
        rememberVerificationPayload(payload);
        $('#verificationLink').innerHTML = `Verification email sent. Open your inbox, click the confirmation link, then set your password here.`;
        $('#verificationLink').classList.remove('hidden');
        toast('Check your email to verify before creating the account.');
      }
    } catch (error) {
      $('#authError').textContent = error.message;
      reportIssue(error.message, 'Signup');
    }
  });

  $('#logoutBtn').addEventListener('click', async () => {
    if (!state.user || state.user.isGuest) {
      show('authView');
      return;
    }
    try {
      await api('/api/logout', { method: 'POST' });
      setUser(null);
      toast('Logged out.');
    } catch (error) {
      reportIssue(error.message || 'Logout failed.', 'Logout');
    }
  });

  $('#userButton').addEventListener('click', () => {
    if (state.user && !state.user.isGuest) {
      toast(`${state.user.name} is signed in.`);
    } else {
      show('authView');
    }
  });

  $('#settingsButton').addEventListener('click', () => {
    if (state.user && !state.user.isGuest) {
      toast(`Signed in as ${state.user.email || state.user.name}.`);
    } else {
      show('authView');
    }
  });

  $('#emailVerificationPanel').addEventListener('click', (event) => {
    if (event.target.closest('#refreshVerificationBtn')) refreshVerificationStatus();
    if (event.target.closest('#resendVerificationBtn')) resendVerificationEmail();
  });

  let suppressSidebarPeek = false;
  $('#sidebarToggle').addEventListener('mouseenter', () => {
    if (!document.body.classList.contains('sidebar-pinned') && !suppressSidebarPeek) {
      document.body.classList.add('sidebar-peek');
    }
  });
  $('#sidebarToggle').addEventListener('mouseleave', () => {
    suppressSidebarPeek = false;
    if (!document.body.classList.contains('sidebar-pinned')) {
      setTimeout(() => {
        if (!$('#sidebar')?.matches(':hover')) document.body.classList.remove('sidebar-peek');
      }, 90);
    }
  });
  $('#sidebar').addEventListener('mouseenter', () => {
    if (!document.body.classList.contains('sidebar-pinned')) document.body.classList.add('sidebar-peek');
  });
  $('#sidebar').addEventListener('mouseleave', () => {
    if (!document.body.classList.contains('sidebar-pinned')) document.body.classList.remove('sidebar-peek');
  });
  $('#sidebarToggle').addEventListener('click', () => {
    const pinned = document.body.classList.toggle('sidebar-pinned');
    if (!pinned) {
      suppressSidebarPeek = true;
      document.body.classList.remove('sidebar-peek');
    }
    $('#sidebarToggle').setAttribute('aria-expanded', String(pinned));
  });

  document.querySelectorAll('.sidebar-action[data-rail-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.railAction;
      setRailActive(action);
      if (action === 'home') {
        document.body.classList.remove('sidebar-pinned');
        document.body.classList.remove('sidebar-peek');
        $('#sidebarToggle').setAttribute('aria-expanded', 'false');
        show(state.user ? 'homeView' : 'authView');
        return;
      }
      if (action === 'templates') {
        show(state.user ? 'homeView' : 'authView');
        document.querySelector('.templates-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      toast('This section is queued for the next milestone.');
    });
  });

  $('#templateTabs').addEventListener('click', (event) => {
    if (!event.target.matches('button')) return;
    $('#templateTabs button.active').classList.remove('active');
    event.target.classList.add('active');
    renderTemplates(event.target.dataset.category);
  });

  document.querySelectorAll('.quick-card').forEach((card) => {
    card.addEventListener('click', () => {
      $('#promptInput').value = card.dataset.fill;
      $('#generateBtn').classList.add('ready');
      $('#promptInput').focus();
      toast('Prompt added. Choose a template or click generate.');
    });
  });

  $('#blankDeckBtn').addEventListener('click', () => {
    $('#promptInput').value = 'Create a clean starter HTML presentation artifact for a product strategy narrative, with a clickable workflow, comparison data, and delivery-ready structure.';
    $('#generateBtn').classList.add('ready');
    toast('Starter artifact prompt added.');
    $('#promptInput').focus();
  });

  $('#retryGenerateBtn').addEventListener('click', () => {
    retryGeneration($('#retryGenerateBtn').dataset.deckId);
  });

  document.querySelectorAll('.mode-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.mode-chip').forEach((item) => item.classList.remove('active'));
      chip.classList.add('active');
      toast(`${chip.textContent.trim()} mode selected.`);
    });
  });

  document.querySelectorAll('.composer-tools .icon-btn').forEach((button) => {
    button.addEventListener('click', () => {
      toast(`${button.title || 'Tool'} is queued for the next milestone.`);
    });
  });

  $('#generateBtn').addEventListener('click', generateDeck);
  $('#promptInput').addEventListener('input', () => {
    $('#generateBtn').classList.toggle('ready', Boolean($('#promptInput').value.trim()));
  });
  $('#workspaceBackBtn').addEventListener('click', () => {
    stopDeliveryTimers();
    setRailActive('home');
    show('homeView');
    history.pushState({}, '', '#/');
    loadDecks();
  });
  $('#taskCardHead').addEventListener('click', () => toggleTaskCard());
  $('#taskRetryBtn').addEventListener('click', () => {
    if (state.activeDeck) retryGeneration(state.activeDeck.id);
  });
  $('#annotateBtn').addEventListener('click', () => {
    toggleAnnotate();
    renderAnnotations();
    toast(state.annotate ? 'Annotate mode on. Click the preview to add a note.' : 'Annotate mode off.');
  });
  $('#railThumbTab').addEventListener('click', () => setRailMode('thumb'));
  $('#railListTab').addEventListener('click', () => setRailMode('list'));
  $('#annotationLayer').addEventListener('click', addAnnotation);
  $('#slideFrame').addEventListener('load', () => {
    syncPreviewPage();
    renderSlideRail($('#slideFrame'));
    clearInterval(syncPreviewPage.timer);
    syncPreviewPage.timer = setInterval(() => {
      syncPreviewPage();
      renderSlideRail($('#slideFrame'));
    }, 800);
  });
  $('#closePreviewBtn').addEventListener('click', () => {
    state.annotate = false;
    $('#annotationLayer').classList.add('hidden');
    $('#annotateBtn').classList.remove('active');
    $('#annotationPanel').classList.add('hidden');
    $('#workspaceView').classList.add('preview-closed');
  });
  $('#reopenPreviewBtn').addEventListener('click', () => {
    $('#workspaceView').classList.remove('preview-closed');
  });
  $('#fullscreenFrame').addEventListener('load', () => {
    showFrameSlide($('#fullscreenFrame'), state.currentPage);
    clearInterval(syncFramePage.fullscreenTimer);
    syncFramePage.fullscreenTimer = setInterval(() => {
      if (!$('#fullscreenView').classList.contains('hidden')) syncFramePage($('#fullscreenFrame'));
    }, 500);
  });
  $('#refreshHomeDecksBtn').addEventListener('click', loadDecks);
  $('#regenerateBtn').addEventListener('click', () => {
    if (!state.activeDeck) return;
    retryGeneration(state.activeDeck.id, true);
  });
  $('#undoBtn').addEventListener('click', undoDeck);
  $('#closeAnnotationPanelBtn').addEventListener('click', () => {
    state.annotate = false;
    $('#annotationLayer').classList.add('hidden');
    $('#annotateBtn').classList.remove('active');
    $('#annotationPanel').classList.add('hidden');
  });
  $('#editCurrentBtn').addEventListener('click', () => {
    $('#chatInput').value = `On slide ${state.currentPage}, `;
    $('#chatInput').focus();
  });
  $('#railCloseBtn').addEventListener('click', () => {
    $('#fullscreenRail').classList.add('hidden');
  });
  document.addEventListener('keydown', (event) => {
    if (!$('#fullscreenView')?.classList.contains('hidden') && event.key === 'r' && !activeElementIsTyping()) {
      $('#fullscreenRail').classList.toggle('hidden');
    }
  });
  $('#expandBtn').addEventListener('click', openFullscreenPresentation);
  $('#closeFullscreenBtn').addEventListener('click', closeFullscreenPresentation);
  $('#fullscreenPrevBtn').addEventListener('click', () => moveFrameSlide($('#fullscreenFrame'), -1));
  $('#fullscreenNextBtn').addEventListener('click', () => moveFrameSlide($('#fullscreenFrame'), 1));
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) $('#fullscreenView').classList.add('hidden');
  });
  document.addEventListener('keydown', (event) => {
    if ($('#fullscreenView').classList.contains('hidden') || activeElementIsTyping()) return;
    if (['ArrowRight', 'PageDown', ' '].includes(event.key)) {
      event.preventDefault();
      moveFrameSlide($('#fullscreenFrame'), 1);
    }
    if (['ArrowLeft', 'PageUp'].includes(event.key)) {
      event.preventDefault();
      moveFrameSlide($('#fullscreenFrame'), -1);
    }
    if (event.key === 'Home') {
      event.preventDefault();
      showFrameSlide($('#fullscreenFrame'), 1);
    }
    if (event.key === 'End') {
      event.preventDefault();
      showFrameSlide($('#fullscreenFrame'), state.totalPages);
    }
    if (event.key === 'Escape') closeFullscreenPresentation();
  });

  $('#exportBtn').addEventListener('click', () => {
    if (!state.activeDeck) {
      toast('Generate a deck before exporting.');
      return;
    }
    openDownload(`/api/decks/${state.activeDeck.id}/download/html`);
    toast('Downloading HTML deck.');
  });

  $('#shareBtn').addEventListener('click', () => {
    shareDeck(state.activeDeck);
  });

  $('#exportPdfBtn').addEventListener('click', () => {
    if (!state.activeDeck) {
      toast('Generate a deck before exporting.');
      return;
    }
    openDownload(`/api/decks/${state.activeDeck.id}/export/pdf`);
    toast('Preparing PDF export.');
  });

  $('#chatForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = $('#chatInput').value.trim();
    if (!text) return;
    submitDeckEdit(text);
    clientLog('info', 'Workspace chat submitted', { deckId: state.activeDeck?.id });
  });

  $('#fullscreenChatForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = $('#fullscreenChatInput').value.trim();
    if (!text) return;
    $('#fullscreenChatInput').value = '';
    closeFullscreenPresentation();
    show('workspaceView');
    submitDeckEdit(text);
    clientLog('info', 'Fullscreen chat submitted', { deckId: state.activeDeck?.id });
  });

  const [{ user, quota }, templateData] = await Promise.all([
    api('/api/me'),
    api('/api/templates')
  ]);
  state.templates = templateData.templates;
  renderArtifactTypes();
  renderTemplates();
  setQuota(quota);
  setUser(user);
  handleVerificationReturn();
  await handleSignupVerificationReturn();
  await restoreRoute();
  window.addEventListener('popstate', restoreRoute);
}

init().catch((error) => {
  console.error(error);
  reportIssue(`App failed to initialize: ${error.message}`, 'Initialization');
  setUser(null);
});

window.addEventListener('error', (event) => {
  reportIssue(`Page error: ${event.message}`, 'Window error', { filename: event.filename, lineno: event.lineno });
});

window.addEventListener('unhandledrejection', (event) => {
  reportIssue(`Action failed: ${event.reason?.message || event.reason || 'Unknown error'}`, 'Promise rejection');
});