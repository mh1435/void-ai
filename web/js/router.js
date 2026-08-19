// History-API router. Paths are real URLs so a post can be bookmarked and
// shared, and the server falls back to index.html for anything it does not
// recognise as a file.

import { releaseDetached } from './media.js';

const routes = [];
let outlet = null;
let current = null;
const scrollMemory = new Map();

export function defineRoute(pattern, load) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:([A-Za-z]+)/g, (_, key) => {
    keys.push(key);
    return '([^/]+)';
  }).replace(/\/$/, '') + '/?$');
  routes.push({ regex, keys, load });
}

export function mount(el) {
  outlet = el;

  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-route], a.link, a.username, a.tile, a.user-row');
    if (!link) return;
    const href = link.getAttribute('href');
    if (!href || href.startsWith('http') || link.target === '_blank') return;
    event.preventDefault();
    go(href);
  });

  window.addEventListener('popstate', () => render(location.pathname, { restore: true }));
}

export function go(path, { replace = false } = {}) {
  if (path === location.pathname) return;
  scrollMemory.set(location.pathname, window.scrollY);
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  render(path);
}

export function back(fallback = '/') {
  if (history.length > 1) history.back();
  else go(fallback, { replace: true });
}

export async function render(path = location.pathname, { restore = false } = {}) {
  for (const { regex, keys, load } of routes) {
    const match = regex.exec(path);
    if (!match) continue;

    const params = Object.fromEntries(keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]));

    if (current && current.destroy) {
      try { current.destroy(); } catch { /* a view that fails to clean up must not block navigation */ }
    }
    outlet.replaceChildren();
    releaseDetached();
    current = null;

    const view = await load();
    current = view.default ? view.default(params, outlet) : null;

    document.dispatchEvent(new CustomEvent('loop:navigate', { detail: { path, params } }));
    requestAnimationFrame(() => {
      window.scrollTo(0, restore ? (scrollMemory.get(path) || 0) : 0);
    });
    return;
  }
  outlet.replaceChildren();
  const notFound = document.createElement('div');
  notFound.className = 'empty';
  notFound.innerHTML = '<h2>Nothing here</h2><p>That page does not exist.</p>';
  outlet.append(notFound);
}
