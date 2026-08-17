/* Rendering helpers and shared UI pieces. */

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k in node && k !== 'list' && k !== 'form') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function svg(pathData, size = 22) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.style.width = `${size}px`;
  s.style.height = `${size}px`;
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', pathData);
  s.append(p);
  return s;
}

export const ICONS = {
  play:    'M8 5.1v13.8L19 12z',
  pause:   'M7 5h3.2v14H7zm6.8 0H17v14h-3.2z',
  heart:   'M12 21s-7.5-4.9-9.6-9.1C.6 8.3 2.6 4.5 6.2 4.5c2 0 3.3 1.1 4 2.1l1.8 2.3 1.8-2.3c.7-1 2-2.1 4-2.1 3.6 0 5.6 3.8 3.8 7.4C19.5 16.1 12 21 12 21',
  plus:    'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z',
  download:'M11 3h2v9.2l3.1-3.1 1.4 1.4-5.5 5.5-5.5-5.5 1.4-1.4L11 12.2zM5 19h14v2H5z',
  check:   'M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6 12-12-1.4-1.4z',
  trash:   'M9 3h6l1 2h4v2H4V5h4zM6 8h12l-1 13H7z',
  more:    'M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4m0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4m0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4',
  queueAdd:'M3 6h12v2H3zm0 5h12v2H3zm0 5h8v2H3zm14-6h2v3h3v2h-3v3h-2v-3h-3v-2h3z',
  external:'M14 3h7v7h-2V6.4l-8.3 8.3-1.4-1.4L17.6 5H14zM5 5h5v2H7v10h10v-3h2v5H5z',
  x:       'M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z',
  search:  'M10.5 3a7.5 7.5 0 1 0 4.55 13.46l4.24 4.25 1.42-1.42-4.25-4.24A7.5 7.5 0 0 0 10.5 3m0 2a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11',
  wifi:    'M12 18.5a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5m0-4.5a5.5 5.5 0 0 0-3.9 1.6l1.5 1.5a3.4 3.4 0 0 1 4.8 0l1.5-1.5A5.5 5.5 0 0 0 12 14m0-4.6a10 10 0 0 0-7.1 2.9l1.5 1.5a7.9 7.9 0 0 1 11.2 0l1.5-1.5A10 10 0 0 0 12 9.4m0-4.6A14.5 14.5 0 0 0 1.7 9l1.5 1.5a12.4 12.4 0 0 1 17.6 0L22.3 9A14.5 14.5 0 0 0 12 4.8',
  chevron: 'M9.3 6.7 14.6 12l-5.3 5.3 1.4 1.4L17.4 12l-6.7-6.7z',
};

/* ── Formatting ────────────────────────────────────────────────────── */

export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
           : `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function fmtCount(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/* ── Toasts ────────────────────────────────────────────────────────── */

let toastTimer = new WeakMap();

export function toast(message, kind = '', ms = 3200) {
  const host = $('#toasts');
  if (!host) return;
  const node = el('div', { class: `toast ${kind}`.trim() }, message);
  host.append(node);
  const t = setTimeout(() => dismiss(node), ms);
  toastTimer.set(node, t);
  node.addEventListener('click', () => dismiss(node));
  return node;
}

function dismiss(node) {
  clearTimeout(toastTimer.get(node));
  node.classList.add('leaving');
  node.addEventListener('animationend', () => node.remove(), { once: true });
  setTimeout(() => node.remove(), 400);
}

/* ── Images that degrade gracefully ────────────────────────────────── */

/**
 * Cover art is the one thing we happily do without: a blocked or slow image
 * host must never hold up the UI, so failures fall back to a glyph silently.
 */
export function artNode(src, fallback = '♪', className = 'art') {
  const box = el('div', { class: className });
  const glyph = el('i', { class: 'art-glyph' }, fallback);
  box.append(glyph);
  if (!src) return box;

  const img = el('img', { alt: '', loading: 'lazy', decoding: 'async', src });
  img.addEventListener('load', () => glyph.remove(), { once: true });
  img.addEventListener('error', () => img.remove(), { once: true });
  box.append(img);
  return box;
}

/**
 * Give a string a stable colour, so artwork-less items still look deliberate
 * rather than like a row of identical grey squares.
 */
export function tintFor(seed) {
  // FNV-1a: neighbouring ids ("item-1" / "item-2") must land on visibly
  // different hues, which a plain sum-of-chars hash does not do.
  const s = String(seed);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = (h >>> 0) % 360;
  return {
    c1: `hsl(${hue} 42% 30%)`,
    c2: `hsl(${(hue + 40) % 360} 38% 16%)`,
    solid: `hsl(${hue} 45% 34%)`,
  };
}

/** artNode plus a generated tint, for tiles and rows without cover art. */
export function tintedArt(src, seed, className, fallback = '♪') {
  const node = artNode(src, fallback, className);
  const { c1, c2 } = tintFor(seed || 'void');
  node.style.setProperty('--c1', c1);
  node.style.setProperty('--c2', c2);
  node.style.background = `linear-gradient(140deg, ${c1}, ${c2})`;
  return node;
}

/* ── Common blocks ─────────────────────────────────────────────────── */

export function skeletonGrid(n = 12) {
  return el('div', { class: 'grid' },
    Array.from({ length: n }, () => el('div', { class: 'card' },
      el('div', { class: 'skeleton sk-card' }),
      el('div', { class: 'skeleton sk-line' }),
      el('div', { class: 'skeleton sk-line short' }),
    )));
}

export function loadingRow(text = 'Loading…') {
  return el('div', { class: 'loading-row' }, el('div', { class: 'spinner' }), text);
}

export function emptyState({ emoji = '◌', title, body, action }) {
  return el('div', { class: 'empty' },
    el('span', { class: 'emoji' }, emoji),
    el('h3', {}, title),
    body ? el('p', {}, body) : null,
    action || null,
  );
}

export function errorBox({ title, body, hint, onRetry }) {
  return el('div', { class: 'error-box' },
    el('h3', {}, title),
    el('p', {}, body),
    hint ? el('p', { html: hint }) : null,
    onRetry ? el('button', { class: 'btn secondary', type: 'button', onclick: onRetry }, 'Try again') : null,
  );
}

export function sectionHead(title, sub, moreLabel, onMore) {
  return el('div', { class: 'section-head' },
    el('h2', {}, title),
    sub ? el('span', { class: 'sub' }, sub) : null,
    moreLabel ? el('button', { class: 'more', type: 'button', onclick: onMore }, moreLabel) : null,
  );
}
