// Boot: theme, bottom-nav routing, settings wiring, and the initial view load.
// Import order matters a little: player.js must exist before mini-player.js
// attaches its listeners, and views.js must be loaded before search.js since
// search re-uses its render helpers.

import './player.js';
import './mini-player.js';
import {
  loadHome, loadLibrary, loadSync, loadSettingsView,
} from './views.js';
import { loadSearchView } from './search.js';
import { getJamendoKey, setJamendoKey, getTheme, setTheme } from './store.js';
import { toast } from './toast.js';

const VIEWS = ['home', 'library', 'search', 'sync', 'settings'];
const loaders = {
  home: loadHome,
  library: loadLibrary,
  search: loadSearchView,
  sync: loadSync,
  settings: loadSettingsView,
};

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'system' || !theme) {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
}

function showView(name) {
  if (!VIEWS.includes(name)) name = 'home';

  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  const target = document.getElementById(`view-${name}`);
  if (target) target.classList.remove('hidden');

  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === name));

  if (window.location.hash.replace('#', '') !== name) {
    history.replaceState(null, '', `#${name}`);
  }

  const loader = loaders[name];
  if (loader) loader();
}

document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    showView(item.dataset.view);
  });
});

window.addEventListener('nav:go', (e) => showView(e.detail));

window.addEventListener('hashchange', () => {
  showView(window.location.hash.replace('#', '') || 'home');
});

// -- theme ------------------------------------------------------------------

const themeSelect = document.getElementById('theme-select');
themeSelect.value = getTheme();
applyTheme(getTheme());
themeSelect.addEventListener('change', () => {
  setTheme(themeSelect.value);
  applyTheme(themeSelect.value);
});

// -- Jamendo key --------------------------------------------------------

const jamendoInput = document.getElementById('jamendo-key');
jamendoInput.value = getJamendoKey();

document.getElementById('jamendo-save').addEventListener('click', () => {
  const key = jamendoInput.value.trim();
  if (!key) { toast('Paste a client_id first.'); return; }
  setJamendoKey(key);
  toast('Jamendo key saved. Reloading Home…');
  if (!document.getElementById('view-home').classList.contains('hidden')) loadHome();
});

document.getElementById('jamendo-clear').addEventListener('click', () => {
  setJamendoKey('');
  jamendoInput.value = '';
  toast('Jamendo key removed.');
  if (!document.getElementById('view-home').classList.contains('hidden')) loadHome();
});

// -- boot ---------------------------------------------------------------

showView(window.location.hash.replace('#', '') || 'home');

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Offline shell is a nicety, not a requirement — ignore failures
      // (e.g. served over plain http during local development).
    });
  });
}
