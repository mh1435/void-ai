/* =========================================================
   VOID — application logic
   No browser storage APIs (per artifact rules elsewhere too) —
   here we DO have a real backend, so settings persist via
   void_web.py's /api/settings instead of localStorage.
   ========================================================= */

const App = {
  settings: {
    theme: 'frost',
    apiKey: '',
    geminiKey: '',
    groqKey: '',
    model: 'meta-llama/llama-3.2-3b-instruct:free',
    groqModel: 'llama-3.3-70b-versatile',
    geminiModel: 'gemini-2.5-flash',
    providerOrder: ['gemini', 'groq', 'openrouter'],
    activeProvider: '',
    activeModel: '',
    mapProvider: 'google',
    lang: 'auto',
    reducedMotion: false,
    responseMode: 'standard',
    voiceEnabled: true,
    voiceRate: 1.0,
    voicePitch: 1.0,
    voiceName: '',
    floatingAssistantEnabled: false
  },
  stats: {
    totalInteractions: 0,
    conversations: 1,
    messages: 0,
    queries: 0,
    replies: 0
  },
  location: null, // { lat, lon, label }
  modelCatalog: [],
  tasks: [],
  commands: [],
  canvasView: { x: 0, y: 0, scale: 1, panMode: false }
};

/* ============ Boot ============ */

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await loadModelCatalog();
  await loadWidgetLayout();
  applyTheme(App.settings.theme);
  setupNav();
  setupSettingsPanels();
  setupThemePicker();
  setupDashboard();
  setupCanvas();
  setupAssistant();
  setupChat();
  setupModelSheet();
  setupVoicePanel();
  setupCommandsPanel();
  setupTasksPanel();
  setupFloatingAssistantPanel();
  setupLocationPanel();
  await loadTasks();
  await loadCommands();
  refreshDashboard();
});

/* ============ Settings persistence (server-backed) ============ */

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    if (res.ok) {
      const data = await res.json();
      App.settings = { ...App.settings, ...data };
    }
  } catch (e) {
    // server not reachable yet on first paint — defaults are fine
  }
  document.getElementById('lang-select').value = App.settings.lang;
  document.getElementById('toggle-reduced').checked = App.settings.reducedMotion;
  document.getElementById('map-provider-select').value = App.settings.mapProvider;
  document.getElementById('api-model-select').value = App.settings.model;
  document.getElementById('gemini-model-select').value = App.settings.geminiModel;
  document.getElementById('groq-model-select').value = App.settings.groqModel;
  document.body.classList.toggle('reduced-motion', App.settings.reducedMotion);

  document.getElementById('toggle-voice-enabled').checked = App.settings.voiceEnabled;
  document.getElementById('voice-rate-range').value = App.settings.voiceRate;
  document.getElementById('voice-rate-value').textContent = App.settings.voiceRate.toFixed(1) + '×';
  document.getElementById('voice-pitch-range').value = App.settings.voicePitch;
  document.getElementById('voice-pitch-value').textContent = App.settings.voicePitch.toFixed(1);
  document.getElementById('toggle-floating-assistant').checked = App.settings.floatingAssistantEnabled;

  const modeLabels = { standard: 'Standard', concise: 'Concise', detailed: 'Detailed' };
  const modePillLabel = modeLabels[App.settings.responseMode] || 'Standard';
  document.getElementById('mode-pill').firstChild.textContent = modePillLabel + ' ';

  updateModelPillLabel();
}

async function saveSettings() {
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(App.settings)
    });
    if (!res.ok) {
      throw new Error(`Server responded ${res.status}`);
    }
    return true;
  } catch (e) {
    console.error('saveSettings failed:', e);
    return false;
  }
}

async function loadModelCatalog() {
  try {
    const res = await fetch('/api/models');
    if (res.ok) {
      const data = await res.json();
      App.modelCatalog = data.models || [];
    }
  } catch (e) {
    console.error('loadModelCatalog failed:', e);
  }
}

async function loadWidgetLayout() {
  try {
    const res = await fetch('/api/widgets');
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === 'object') widgetPositions = data;
    }
  } catch (e) { /* fresh layout is fine */ }
}

async function loadTasks() {
  try {
    const res = await fetch('/api/tasks');
    if (res.ok) {
      const data = await res.json();
      App.tasks = data.tasks || [];
    }
  } catch (e) { /* keep whatever is in memory */ }
  renderTasks();
}

async function saveTasks() {
  try {
    await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasks: App.tasks })
    });
  } catch (e) {
    console.error('saveTasks failed:', e);
  }
}

async function loadCommands() {
  try {
    const res = await fetch('/api/commands');
    if (res.ok) {
      const data = await res.json();
      App.commands = data.commands || [];
    }
  } catch (e) { /* keep whatever is in memory */ }
  renderCommands();
}

async function saveCommands() {
  try {
    await fetch('/api/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: App.commands })
    });
  } catch (e) {
    console.error('saveCommands failed:', e);
  }
}

/* ============ Theme ============ */

function applyTheme(name) {
  App.settings.theme = name;
  document.documentElement.setAttribute('data-theme', name === 'frost' ? '' : name);
  document.querySelectorAll('.theme-dot').forEach(d => {
    d.classList.toggle('active', d.dataset.theme === name);
  });
}

function setupThemePicker() {
  document.querySelectorAll('.theme-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      applyTheme(dot.dataset.theme);
      saveSettings();
    });
  });
}

/* ============ Navigation ============ */

function setupNav() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
}

function switchView(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === viewId));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === viewId));
  if (viewId === 'view-dashboard') refreshDashboard();
}

/* ============ Settings slide-over panels ============ */

function setupSettingsPanels() {
  const overlay = document.getElementById('panel-overlay');

  document.querySelectorAll('.settings-row').forEach(row => {
    row.addEventListener('click', () => openPanel(row.dataset.panel));
  });

  document.querySelectorAll('[data-close-panel]').forEach(btn => {
    btn.addEventListener('click', closeAllPanels);
  });
  overlay.addEventListener('click', closeAllPanels);

  // General settings
  document.getElementById('lang-select').addEventListener('change', e => {
    App.settings.lang = e.target.value;
    saveSettings();
  });
  document.getElementById('toggle-reduced').addEventListener('change', e => {
    App.settings.reducedMotion = e.target.checked;
    document.body.classList.toggle('reduced-motion', e.target.checked);
    saveSettings();
  });

  // API key panel
  document.getElementById('save-api-key').addEventListener('click', async () => {
    App.settings.geminiKey = document.getElementById('gemini-key-input').value.trim();
    App.settings.geminiModel = document.getElementById('gemini-model-select').value;
    App.settings.groqKey = document.getElementById('groq-key-input').value.trim();
    App.settings.groqModel = document.getElementById('groq-model-select').value;
    App.settings.apiKey = document.getElementById('api-key-input').value.trim();
    App.settings.model = document.getElementById('api-model-select').value;

    const status = document.getElementById('api-key-status');
    status.textContent = 'Saving…';

    const ok = await saveSettings();

    if (!ok) {
      status.textContent = 'Save failed — check the Void server is running and try again.';
      return;
    }

    // Verify by reading settings back from the server rather than trusting local state
    try {
      const verifyRes = await fetch('/api/settings');
      const serverSettings = await verifyRes.json();
      const mismatch =
        (serverSettings.geminiKey || '') !== App.settings.geminiKey ||
        (serverSettings.groqKey || '') !== App.settings.groqKey ||
        (serverSettings.apiKey || '') !== App.settings.apiKey;

      if (mismatch) {
        status.textContent = 'Saved, but server shows different values — try reloading the page.';
        console.warn('Settings mismatch after save:', { sent: App.settings, server: serverSettings });
      } else {
        const anyKey = App.settings.geminiKey || App.settings.groqKey || App.settings.apiKey;
        status.textContent = anyKey ? 'Keys saved and verified.' : 'No keys set.';
      }
    } catch (e) {
      status.textContent = 'Saved, but could not verify — check Termux for errors.';
    }

    updateModelPillLabel();
    refreshDashboard();
  });

  // Chat settings panel
  document.getElementById('clear-history-btn').addEventListener('click', async () => {
    try {
      await fetch('/api/clear', { method: 'POST' });
    } catch (e) { /* proceed regardless */ }
    resetChatView();
    closeAllPanels();
  });
}

function getActiveModelLabel() {
  // Explicit choice from the unified picker wins, if its key is still configured.
  const keyMap = { gemini: App.settings.geminiKey, groq: App.settings.groqKey, openrouter: App.settings.apiKey };

  if (App.settings.activeProvider && keyMap[App.settings.activeProvider] && App.settings.activeModel) {
    const entry = App.modelCatalog.find(m => m.id === App.settings.activeModel && m.provider === App.settings.activeProvider);
    return entry ? entry.label : App.settings.activeModel;
  }

  // Fall back to whichever provider is first in the order AND has a key.
  const order = App.settings.providerOrder || ['gemini', 'groq', 'openrouter'];
  const modelMap = { gemini: App.settings.geminiModel, groq: App.settings.groqModel, openrouter: App.settings.model };
  const active = order.find(p => keyMap[p]);
  if (!active) return null;

  const model = modelMap[active];
  const entry = App.modelCatalog.find(m => m.id === model && m.provider === active);
  return entry ? entry.label : model;
}

function updateModelPillLabel() {
  const label = getActiveModelLabel();
  document.getElementById('model-pill').firstChild.textContent = (label || 'No provider') + ' ';
}

/* ============ Unified model picker sheet ============ */

function setupModelSheet() {
  const overlay = document.getElementById('model-sheet-overlay');
  overlay.addEventListener('click', closeModelSheet);
}

function openModelSheet() {
  renderModelSheet();
  document.getElementById('model-sheet').classList.add('open');
  document.getElementById('model-sheet-overlay').classList.add('open');
}

function closeModelSheet() {
  document.getElementById('model-sheet').classList.remove('open');
  document.getElementById('model-sheet-overlay').classList.remove('open');
}

function renderModelSheet() {
  const list = document.getElementById('model-sheet-list');
  const keyMap = { gemini: App.settings.geminiKey, groq: App.settings.groqKey, openrouter: App.settings.apiKey };
  const providerLabels = { gemini: 'Gemini', groq: 'Groq', openrouter: 'OpenRouter' };

  list.innerHTML = '';

  if (!App.modelCatalog.length) {
    list.innerHTML = '<p class="muted small">No models available — check the Void server is running.</p>';
    return;
  }

  App.modelCatalog.forEach(m => {
    const hasKey = !!keyMap[m.provider];
    const isActive = App.settings.activeProvider === m.provider && App.settings.activeModel === m.id;

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'model-row' + (isActive ? ' active' : '');
    row.innerHTML = `
      <div class="model-row-text">
        <span class="model-row-name">${m.label}</span>
        <span class="model-row-provider">${providerLabels[m.provider]}${hasKey ? '' : ' · no key set'}</span>
      </div>
      <div style="display:flex; align-items:center; gap:10px;">
        <span class="model-row-dot ${hasKey ? 'ready' : ''}"></span>
        <svg class="model-row-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
      </div>
    `;
    row.addEventListener('click', () => selectModel(m));
    list.appendChild(row);
  });
}

async function selectModel(m) {
  const keyMap = { gemini: App.settings.geminiKey, groq: App.settings.groqKey, openrouter: App.settings.apiKey };
  if (!keyMap[m.provider]) {
    closeModelSheet();
    addChatMessage('ai error', `No API key set for ${m.provider}. Add one in Settings → API Keys, then pick this model again.`);
    openPanel('panel-api');
    return;
  }

  App.settings.activeProvider = m.provider;
  App.settings.activeModel = m.id;
  await saveSettings();
  updateModelPillLabel();
  closeModelSheet();
}

function openPanel(panelId) {
  document.getElementById(panelId).classList.add('open');
  document.getElementById('panel-overlay').classList.add('open');
  if (panelId === 'panel-api') {
    if (App.settings.geminiKey) document.getElementById('gemini-key-input').value = App.settings.geminiKey;
    if (App.settings.groqKey) document.getElementById('groq-key-input').value = App.settings.groqKey;
    if (App.settings.apiKey) document.getElementById('api-key-input').value = App.settings.apiKey;
  }
}

function closeAllPanels() {
  document.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('open'));
  document.getElementById('panel-overlay').classList.remove('open');
}

/* ============ Dashboard ============ */

function setupDashboard() {
  const d = new Date();
  const hour = d.getHours();
  document.getElementById('greeting').textContent =
    hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  document.getElementById('today-date').textContent =
    d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function refreshDashboard() {
  const s = App.stats;
  document.getElementById('stat-total').textContent = s.totalInteractions;
  document.getElementById('stat-convos').textContent = s.conversations;
  document.getElementById('stat-trend').textContent = s.totalInteractions > 0 ? '100%' : '—';
  document.getElementById('stat-active-chats').textContent = s.conversations;
  document.getElementById('stat-messages').textContent = s.messages;
  document.getElementById('stat-avg').textContent =
    s.conversations ? `${Math.round(s.messages / s.conversations)} avg/chat` : '0 avg/chat';
  document.getElementById('stat-queries').textContent = s.queries;
  document.getElementById('stat-replies').textContent = s.replies;

  const hasAnyKey = !!(App.settings.geminiKey || App.settings.groqKey || App.settings.apiKey);
  const order = App.settings.providerOrder || ['gemini', 'groq', 'openrouter'];
  const keyMap = { gemini: App.settings.geminiKey, groq: App.settings.groqKey, openrouter: App.settings.apiKey };
  const activeProvider = order.find(p => keyMap[p]);
  const providerLabels = { gemini: 'Gemini', groq: 'Groq', openrouter: 'OpenRouter' };

  document.getElementById('status-model').textContent = hasAnyKey
    ? `${providerLabels[activeProvider]} active`
    : 'No API key set';
  document.getElementById('status-check-icon').classList.toggle('ok', hasAnyKey);

  document.getElementById('status-location').textContent = App.location
    ? App.location.label
    : 'Not requested';
  document.getElementById('status-location-icon').classList.toggle('ok', !!App.location);

  document.getElementById('tip-text').textContent = hasAnyKey
    ? 'Try asking Void about the weather, or say "guide me to the nearest pharmacy."'
    : 'Add a free API key in Settings (Gemini, Groq, or OpenRouter) to start chatting with Void.';
}

/* ============ Canvas widgets (free drag + pan/zoom) ============ */

let widgetSeq = 0;
let widgetPositions = {}; // id -> {x, y}

function setupCanvas() {
  document.getElementById('canvas-add').addEventListener('click', () => addDefaultWidgets());
  document.getElementById('canvas-empty-add').addEventListener('click', () => addDefaultWidgets());
  document.getElementById('canvas-clear').addEventListener('click', () => {
    document.getElementById('canvas-board').innerHTML = '';
    widgetPositions = {};
    persistWidgetLayout();
    updateCanvasEmptyState();
  });

  setupCanvasPanZoom();

  addTimeWidget();
  addWeatherWidget();
}

/* ---- pan & zoom ---- */

function setupCanvasPanZoom() {
  const viewport = document.getElementById('canvas-viewport');
  const board = document.getElementById('canvas-board');
  const panBtn = document.getElementById('canvas-pan-toggle');

  applyCanvasTransform();

  panBtn.addEventListener('click', () => {
    App.canvasView.panMode = !App.canvasView.panMode;
    panBtn.classList.toggle('active', App.canvasView.panMode);
  });

  document.getElementById('canvas-zoom-in').addEventListener('click', () => zoomCanvas(1.2));
  document.getElementById('canvas-zoom-out').addEventListener('click', () => zoomCanvas(1 / 1.2));
  document.getElementById('canvas-fit').addEventListener('click', () => {
    App.canvasView = { x: 0, y: 0, scale: 1, panMode: App.canvasView.panMode };
    applyCanvasTransform();
  });

  let isPanning = false;
  let startX = 0, startY = 0, startViewX = 0, startViewY = 0;

  viewport.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.widget-card')) return; // widget drag handles its own
    isPanning = true;
    viewport.classList.add('panning');
    startX = e.clientX;
    startY = e.clientY;
    startViewX = App.canvasView.x;
    startViewY = App.canvasView.y;
    viewport.setPointerCapture(e.pointerId);
  });

  viewport.addEventListener('pointermove', (e) => {
    if (!isPanning) return;
    App.canvasView.x = startViewX + (e.clientX - startX);
    App.canvasView.y = startViewY + (e.clientY - startY);
    applyCanvasTransform();
  });

  ['pointerup', 'pointercancel'].forEach(evt => {
    viewport.addEventListener(evt, () => {
      isPanning = false;
      viewport.classList.remove('panning');
    });
  });

  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    zoomCanvas(factor);
  }, { passive: false });
}

function zoomCanvas(factor) {
  const next = Math.min(2.5, Math.max(0.4, App.canvasView.scale * factor));
  App.canvasView.scale = next;
  applyCanvasTransform();
}

function applyCanvasTransform() {
  const board = document.getElementById('canvas-board');
  const { x, y, scale } = App.canvasView;
  board.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
}

/* ---- widget persistence ---- */

async function persistWidgetLayout() {
  try {
    await fetch('/api/widgets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(widgetPositions)
    });
  } catch (e) { /* non-critical */ }
}

function placeWidget(card, id, defaultX, defaultY) {
  const pos = widgetPositions[id] || { x: defaultX, y: defaultY };
  widgetPositions[id] = pos;
  card.style.left = pos.x + 'px';
  card.style.top = pos.y + 'px';
  makeWidgetDraggable(card, id);
}

function makeWidgetDraggable(card, id) {
  const handle = card.querySelector('.widget-head');
  if (!handle) return;

  let dragging = false;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0;

  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.widget-close')) return;
    dragging = true;
    card.classList.add('dragging');
    startX = e.clientX;
    startY = e.clientY;
    startLeft = parseFloat(card.style.left) || 0;
    startTop = parseFloat(card.style.top) || 0;
    handle.setPointerCapture(e.pointerId);
    e.stopPropagation();
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const scale = App.canvasView.scale || 1;
    const dx = (e.clientX - startX) / scale;
    const dy = (e.clientY - startY) / scale;
    const newLeft = startLeft + dx;
    const newTop = startTop + dy;
    card.style.left = newLeft + 'px';
    card.style.top = newTop + 'px';
    widgetPositions[id] = { x: newLeft, y: newTop };
  });

  ['pointerup', 'pointercancel'].forEach(evt => {
    handle.addEventListener(evt, () => {
      if (!dragging) return;
      dragging = false;
      card.classList.remove('dragging');
      persistWidgetLayout();
    });
  });
}

function updateCanvasEmptyState() {
  const board = document.getElementById('canvas-board');
  document.getElementById('canvas-empty').classList.toggle('hidden', board.children.length > 0);
}

function addDefaultWidgets() {
  if (!document.getElementById('widget-time')) addTimeWidget();
  if (!document.getElementById('widget-weather')) addWeatherWidget();
  updateCanvasEmptyState();
}

function addTimeWidget() {
  const board = document.getElementById('canvas-board');
  const card = document.createElement('div');
  card.className = 'widget-card';
  card.id = 'widget-time';
  card.innerHTML = `
    <div class="widget-head">
      <span>TIME</span>
      <button class="widget-close" data-remove="widget-time">&times;</button>
    </div>
    <div class="widget-clock-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg></div>
    <div class="widget-time-value" id="widget-time-value">--:--:--</div>
    <div class="widget-time-sub" id="widget-time-sub"></div>
  `;
  board.appendChild(card);
  placeWidget(card, 'widget-time', 60, 60);
  card.querySelector('[data-remove]').addEventListener('click', () => {
    card.remove();
    delete widgetPositions['widget-time'];
    persistWidgetLayout();
    updateCanvasEmptyState();
  });
  tickTimeWidget();
  updateCanvasEmptyState();
}

function tickTimeWidget() {
  const valueEl = document.getElementById('widget-time-value');
  const subEl = document.getElementById('widget-time-sub');
  if (!valueEl) return;
  const now = new Date();
  valueEl.textContent = now.toLocaleTimeString();
  const offsetMin = -now.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  subEl.textContent = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  setTimeout(tickTimeWidget, 1000);
}

async function addWeatherWidget() {
  const board = document.getElementById('canvas-board');
  const card = document.createElement('div');
  card.className = 'widget-card';
  card.id = 'widget-weather';
  card.innerHTML = `
    <div class="widget-head">
      <span>WEATHER</span>
      <button class="widget-close" data-remove="widget-weather">&times;</button>
    </div>
    <div class="widget-weather-loc" id="weather-loc"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg> <span>Allow location to see local weather</span></div>
    <div id="weather-body"></div>
  `;
  board.appendChild(card);
  placeWidget(card, 'widget-weather', 60, 260);
  card.querySelector('[data-remove]').addEventListener('click', () => {
    card.remove();
    delete widgetPositions['widget-weather'];
    persistWidgetLayout();
    updateCanvasEmptyState();
  });
  updateCanvasEmptyState();

  if (App.location) loadWeatherForWidget();
}

async function loadWeatherForWidget() {
  const locEl = document.getElementById('weather-loc');
  const bodyEl = document.getElementById('weather-body');
  if (!locEl || !bodyEl || !App.location) return;

  locEl.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg> <span>${App.location.label}</span>`;
  bodyEl.innerHTML = `<div class="muted small">Loading…</div>`;

  try {
    const res = await fetch(`/api/weather?lat=${App.location.lat}&lon=${App.location.lon}`);
    if (!res.ok) throw new Error('weather fetch failed');
    const w = await res.json();

    bodyEl.innerHTML = `
      <div class="widget-weather-main">
        <div class="widget-weather-icon"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M17.5 19a4.5 4.5 0 1 0-1.41-8.78 6 6 0 0 0-11.59 2.78A4 4 0 0 0 5 21h12.5z"></path></svg></div>
        <div>
          <div class="widget-weather-temp">${w.temp}°C</div>
          <div class="widget-weather-desc">${w.description}</div>
        </div>
      </div>
      <div class="widget-weather-grid">
        <div class="widget-weather-stat"><div class="widget-weather-stat-label">Feels like</div><div class="widget-weather-stat-value">${w.feels_like}°C</div></div>
        <div class="widget-weather-stat"><div class="widget-weather-stat-label">Humidity</div><div class="widget-weather-stat-value">${w.humidity}%</div></div>
        <div class="widget-weather-stat"><div class="widget-weather-stat-label">Wind</div><div class="widget-weather-stat-value">${w.wind_speed} m/s</div></div>
        <div class="widget-weather-stat"><div class="widget-weather-stat-label">Pressure</div><div class="widget-weather-stat-value">${w.pressure} hPa</div></div>
      </div>
    `;
  } catch (e) {
    bodyEl.innerHTML = `<div class="muted small">Couldn't load weather right now.</div>`;
  }
}

/* ============ Assistant (voice) ============ */

let recognizer = null;
let isListening = false;

function setupAssistant() {
  const orb = document.getElementById('orb-btn');
  const hint = document.getElementById('assistant-hint');
  const line = document.getElementById('assistant-line');
  const pillMic = document.getElementById('pill-mic');
  const pillStatus = document.getElementById('pill-status');

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  orb.addEventListener('click', () => {
    if (!SpeechRecognition) {
      line.textContent = 'Voice input isn\'t supported in this browser. Try the Chat tab instead.';
      return;
    }

    if (isListening) {
      recognizer.stop();
      return;
    }

    recognizer = new SpeechRecognition();
    recognizer.lang = App.settings.lang === 'ar' ? 'ar-SA' : 'en-US';
    recognizer.interimResults = false;

    recognizer.onstart = () => {
      isListening = true;
      orb.classList.add('listening');
      hint.textContent = 'Listening…';
      pillMic.classList.add('active');
      pillStatus.classList.add('active');
      pillStatus.querySelector('span:last-child')?.remove();
      pillStatus.lastChild.textContent = ' Listening';
    };

    recognizer.onresult = async (event) => {
      const transcript = event.results[0][0].transcript;
      line.textContent = `"${transcript}"`;
      const reply = await askVoid(transcript);
      line.textContent = reply;
      speak(reply);
    };

    recognizer.onerror = () => {
      line.textContent = 'Didn\'t catch that — try again.';
    };

    recognizer.onend = () => {
      isListening = false;
      orb.classList.remove('listening');
      hint.textContent = 'Tap to activate';
      pillMic.classList.remove('active');
      pillStatus.classList.remove('active');
    };

    recognizer.start();
  });
}

function speak(text) {
  if (!window.speechSynthesis || !App.settings.voiceEnabled) return;
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = App.settings.lang === 'ar' ? 'ar-SA' : 'en-US';
  utter.rate = App.settings.voiceRate || 1.0;
  utter.pitch = App.settings.voicePitch || 1.0;

  if (App.settings.voiceName) {
    const voices = window.speechSynthesis.getVoices();
    const match = voices.find(v => v.name === App.settings.voiceName);
    if (match) utter.voice = match;
  }

  const orb = document.getElementById('orb-btn');
  const hint = document.getElementById('assistant-hint');

  utter.onstart = () => {
    orb?.classList.add('speaking');
    if (hint) hint.textContent = 'Void is speaking…';
  };
  utter.onend = () => {
    orb?.classList.remove('speaking');
    if (hint) hint.textContent = 'Tap to activate';
  };
  utter.onerror = () => {
    orb?.classList.remove('speaking');
  };

  window.speechSynthesis.speak(utter);
}

/* ============ Voice settings panel ============ */

function setupVoicePanel() {
  const enabledToggle = document.getElementById('toggle-voice-enabled');
  const voiceSelect = document.getElementById('voice-name-select');
  const rateRange = document.getElementById('voice-rate-range');
  const rateValue = document.getElementById('voice-rate-value');
  const pitchRange = document.getElementById('voice-pitch-range');
  const pitchValue = document.getElementById('voice-pitch-value');
  const testBtn = document.getElementById('voice-test-btn');

  enabledToggle.addEventListener('change', e => {
    App.settings.voiceEnabled = e.target.checked;
    saveSettings();
  });

  rateRange.addEventListener('input', e => {
    App.settings.voiceRate = parseFloat(e.target.value);
    rateValue.textContent = App.settings.voiceRate.toFixed(1) + '×';
  });
  rateRange.addEventListener('change', () => saveSettings());

  pitchRange.addEventListener('input', e => {
    App.settings.voicePitch = parseFloat(e.target.value);
    pitchValue.textContent = App.settings.voicePitch.toFixed(1);
  });
  pitchRange.addEventListener('change', () => saveSettings());

  function populateVoices() {
    if (!window.speechSynthesis) return;
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return;
    voiceSelect.innerHTML = '<option value="">Default</option>';
    voices.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.name;
      opt.textContent = `${v.name} (${v.lang})`;
      voiceSelect.appendChild(opt);
    });
    voiceSelect.value = App.settings.voiceName || '';
  }

  if (window.speechSynthesis) {
    populateVoices();
    window.speechSynthesis.addEventListener('voiceschanged', populateVoices);
  }

  voiceSelect.addEventListener('change', e => {
    App.settings.voiceName = e.target.value;
    saveSettings();
  });

  testBtn.addEventListener('click', () => {
    const wasEnabled = App.settings.voiceEnabled;
    App.settings.voiceEnabled = true;
    speak('This is what Void sounds like.');
    App.settings.voiceEnabled = wasEnabled;
  });
}

/* ============ Custom commands panel ============ */

function setupCommandsPanel() {
  document.getElementById('add-command-btn').addEventListener('click', async () => {
    const labelInput = document.getElementById('command-label-input');
    const actionInput = document.getElementById('command-action-input');
    const label = labelInput.value.trim();
    const action = actionInput.value.trim();
    if (!label || !action) return;

    App.commands.push({ id: 'cmd_' + Date.now(), label, action });
    labelInput.value = '';
    actionInput.value = '';
    renderCommands();
    await saveCommands();
  });
}

function renderCommands() {
  const list = document.getElementById('commands-list');
  const empty = document.getElementById('commands-empty');
  list.innerHTML = '';

  if (!App.commands.length) {
    list.appendChild(empty);
    empty.classList.remove('hidden');
    return;
  }

  App.commands.forEach(cmd => {
    const row = document.createElement('div');
    row.className = 'command-row';
    row.innerHTML = `
      <div class="command-text">
        <span class="command-label"></span>
        <span class="command-action"></span>
      </div>
      <button class="row-remove" aria-label="Remove">&times;</button>
    `;
    row.querySelector('.command-label').textContent = cmd.label;
    row.querySelector('.command-action').textContent = cmd.action;
    row.querySelector('.row-remove').addEventListener('click', async () => {
      App.commands = App.commands.filter(c => c.id !== cmd.id);
      renderCommands();
      await saveCommands();
    });
    row.addEventListener('click', (e) => {
      if (e.target.closest('.row-remove')) return;
      runCommand(cmd);
    });
    list.appendChild(row);
  });
}

function runCommand(cmd) {
  const action = cmd.action.trim();
  if (/^https?:\/\//i.test(action)) {
    window.open(action, '_blank');
  } else {
    // Not a URL — treat as a quick prompt to Void instead of executing arbitrary system commands.
    switchView('view-chat');
    document.getElementById('user-input').value = action;
  }
}

/* ============ Task management panel ============ */

function setupTasksPanel() {
  const input = document.getElementById('task-input');
  document.getElementById('add-task-btn').addEventListener('click', async () => {
    const text = input.value.trim();
    if (!text) return;
    App.tasks.push({ id: 'task_' + Date.now(), text, done: false });
    input.value = '';
    renderTasks();
    await saveTasks();
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('add-task-btn').click();
    }
  });
}

function renderTasks() {
  const list = document.getElementById('tasks-list');
  const empty = document.getElementById('tasks-empty');
  list.innerHTML = '';

  if (!App.tasks.length) {
    list.appendChild(empty);
    empty.classList.remove('hidden');
    return;
  }

  App.tasks.forEach(task => {
    const row = document.createElement('div');
    row.className = 'task-row';
    row.innerHTML = `
      <button class="task-check ${task.done ? 'done' : ''}" aria-label="Toggle done">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>
      </button>
      <span class="task-text ${task.done ? 'done' : ''}"></span>
      <button class="row-remove" aria-label="Remove">&times;</button>
    `;
    row.querySelector('.task-text').textContent = task.text;
    row.querySelector('.task-check').addEventListener('click', async () => {
      task.done = !task.done;
      renderTasks();
      await saveTasks();
    });
    row.querySelector('.row-remove').addEventListener('click', async () => {
      App.tasks = App.tasks.filter(t => t.id !== task.id);
      renderTasks();
      await saveTasks();
    });
    list.appendChild(row);
  });
}

/* ============ Floating assistant panel ============ */

function setupFloatingAssistantPanel() {
  document.getElementById('toggle-floating-assistant').addEventListener('change', e => {
    App.settings.floatingAssistantEnabled = e.target.checked;
    saveSettings();
  });
}

/* ============ Shared "ask Void" used by both voice + chat ============ */

async function askVoid(message, image) {
  App.stats.queries++;
  App.stats.messages++;
  App.stats.totalInteractions++;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 50000);

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        image_base64: image ? image.base64 : undefined,
        image_mime: image ? image.mime : undefined,
        openrouter_key: App.settings.apiKey,
        model: App.settings.model,
        gemini_key: App.settings.geminiKey,
        gemini_model: App.settings.geminiModel,
        groq_key: App.settings.groqKey,
        groq_model: App.settings.groqModel,
        provider_order: App.settings.providerOrder,
        active_provider: App.settings.activeProvider,
        active_model: App.settings.activeModel,
        lang: App.settings.lang,
        location: App.location,
        response_mode: App.settings.responseMode
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errData = await res.json().catch(() => null);
      throw new Error(errData?.reply || `Request failed: ${res.status}`);
    }
    const data = await res.json();
    App.stats.replies++;
    App.stats.messages++;
    App.stats.totalInteractions++;
    refreshDashboard();
    return data.reply || 'No response received.';
  } catch (err) {
    if (err.name === 'AbortError') {
      return 'No response after 50s. The model may be overloaded — try again.';
    }
    return err.message || 'Connection lost. Check that the Void server is running.';
  }
}

/* ============ Chat ============ */

function setupChat() {
  const composer = document.getElementById('composer');
  const input = document.getElementById('user-input');
  const chatBox = document.getElementById('chat-box');
  const attachBtn = document.getElementById('attach-btn');
  const imageInput = document.getElementById('image-input');
  const previewRow = document.getElementById('image-preview-row');
  const previewThumb = document.getElementById('image-preview-thumb');
  const previewRemove = document.getElementById('image-preview-remove');

  let pendingImage = null; // { base64, mime, dataUrl }

  attachBtn.addEventListener('click', () => imageInput.click());

  imageInput.addEventListener('change', () => {
    const file = imageInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(',')[1];
      pendingImage = { base64, mime: file.type || 'image/jpeg', dataUrl };
      previewThumb.src = dataUrl;
      previewRow.style.display = 'block';
      attachBtn.classList.add('has-image');
    };
    reader.readAsDataURL(file);
    imageInput.value = '';
  });

  previewRemove.addEventListener('click', () => {
    pendingImage = null;
    previewRow.style.display = 'none';
    attachBtn.classList.remove('has-image');
  });

  document.getElementById('model-pill').addEventListener('click', () => openModelSheet());
  document.getElementById('chat-new-btn').addEventListener('click', resetChatView);
  document.getElementById('chat-history-btn').addEventListener('click', () => openPanel('panel-chat'));

  const modePill = document.getElementById('mode-pill');
  const modes = ['standard', 'concise', 'detailed'];
  const modeLabels = { standard: 'Standard', concise: 'Concise', detailed: 'Detailed' };
  modePill.addEventListener('click', () => {
    const i = modes.indexOf(App.settings.responseMode);
    App.settings.responseMode = modes[(i + 1) % modes.length];
    modePill.firstChild.textContent = modeLabels[App.settings.responseMode] + ' ';
    saveSettings();
  });

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      composer.requestSubmit();
    }
  });

  composer.addEventListener('submit', async e => {
    e.preventDefault();
    const text = input.value.trim();
    const image = pendingImage;
    if (!text && !image) return;

    addChatMessage('user', text, image ? image.dataUrl : null);
    input.value = '';
    input.style.height = 'auto';
    pendingImage = null;
    previewRow.style.display = 'none';
    attachBtn.classList.remove('has-image');

    const typingRow = addTypingIndicator();
    const reply = await askVoid(text, image);
    typingRow.remove();
    const isError = /^(ERROR|HTTP \d|No API key|All configured providers failed|Connection lost|The model took too long|Network issue)/i.test(reply);
    addChatMessage(isError ? 'ai error' : 'ai', reply);
  });
}

function addChatMessage(role, text, imageDataUrl) {
  const chatBox = document.getElementById('chat-box');
  const row = document.createElement('div');
  row.className = 'msg ' + role;
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  if (imageDataUrl) {
    const img = document.createElement('img');
    img.src = imageDataUrl;
    img.className = 'msg-image';
    bubble.appendChild(img);
  }
  if (text) {
    const textNode = document.createElement('div');
    textNode.textContent = text;
    bubble.appendChild(textNode);
  }
  row.appendChild(bubble);
  chatBox.appendChild(row);
  chatBox.scrollTop = chatBox.scrollHeight;
  return row;
}

function addTypingIndicator() {
  const chatBox = document.getElementById('chat-box');
  const row = document.createElement('div');
  row.className = 'msg ai';
  row.innerHTML = '<div class="msg-bubble typing"><span></span><span></span><span></span></div>';
  chatBox.appendChild(row);
  chatBox.scrollTop = chatBox.scrollHeight;
  return row;
}

function resetChatView() {
  const chatBox = document.getElementById('chat-box');
  chatBox.innerHTML = '';
  addChatMessage('ai', 'Conversation cleared. What would you like to talk about?');
  App.stats.conversations++;
}

/* ============ Location / GPS ============ */

function setupLocationPanel() {
  document.getElementById('request-location-btn').addEventListener('click', requestLocation);
  document.getElementById('map-provider-select').addEventListener('change', e => {
    App.settings.mapProvider = e.target.value;
    saveSettings();
  });
}

function requestLocation() {
  const statusSub = document.getElementById('location-status-sub');
  if (!navigator.geolocation) {
    statusSub.textContent = 'Not supported in this browser.';
    return;
  }
  statusSub.textContent = 'Requesting…';

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      let label = `${lat.toFixed(3)}, ${lon.toFixed(3)}`;

      try {
        const res = await fetch(`/api/reverse-geocode?lat=${lat}&lon=${lon}`);
        if (res.ok) {
          const data = await res.json();
          if (data.label) label = data.label;
        }
      } catch (e) { /* fall back to coordinates */ }

      App.location = { lat, lon, label };
      statusSub.textContent = `Allowed — ${label}`;
      addMapWidgetIfMissing();
      loadWeatherForWidget();
      refreshDashboard();
    },
    (err) => {
      statusSub.textContent = 'Permission denied or unavailable.';
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

function addMapWidgetIfMissing() {
  if (document.getElementById('widget-map') || !App.location) return;
  const board = document.getElementById('canvas-board');
  const card = document.createElement('div');
  card.className = 'widget-card';
  card.id = 'widget-map';
  const { lat, lon } = App.location;
  card.innerHTML = `
    <div class="widget-head">
      <span>YOUR LOCATION</span>
      <button class="widget-close" data-remove="widget-map">&times;</button>
    </div>
    <div class="widget-map-frame">
      <iframe loading="lazy" src="https://www.openstreetmap.org/export/embed.html?bbox=${lon-0.01}%2C${lat-0.01}%2C${lon+0.01}%2C${lat+0.01}&layer=mapnik&marker=${lat}%2C${lon}"></iframe>
    </div>
  `;
  board.appendChild(card);
  placeWidget(card, 'widget-map', 60, 460);
  card.querySelector('[data-remove]').addEventListener('click', () => {
    card.remove();
    delete widgetPositions['widget-map'];
    persistWidgetLayout();
    updateCanvasEmptyState();
  });
  updateCanvasEmptyState();
}

function openDirections(destinationQuery) {
  if (!App.location) {
    return 'I need your location first — open Settings → Location & GPS and allow access, then ask me again.';
  }
  const { lat, lon } = App.location;
  let url;
  if (App.settings.mapProvider === 'osm') {
    url = `https://www.openstreetmap.org/directions?from=${lat}%2C${lon}&to=${encodeURIComponent(destinationQuery)}`;
  } else {
    url = `https://www.google.com/maps/dir/?api=1&origin=${lat},${lon}&destination=${encodeURIComponent(destinationQuery)}&travelmode=walking`;
  }
  window.open(url, '_blank');
  return `Opening directions to "${destinationQuery}" from your current location.`;
}

// Make available to inline-ish usage if extended later
window.VoidApp = { askVoid, openDirections, requestLocation };


