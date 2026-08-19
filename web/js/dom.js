// Minimal DOM helpers. No framework: the whole client is ~2k lines and a
// build step would only get in the way of "clone the repo and deploy it".

export function h(tag, props = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');

  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = [el.className, value].filter(Boolean).join(' ');
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'html') el.innerHTML = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else el.setAttribute(key, value === true ? '' : value);
  }

  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** Compact relative time, the way Instagram shows it. */
export function ago(unixSeconds) {
  if (!unixSeconds) return '';
  const seconds = Math.max(1, Math.floor(Date.now() / 1000 - unixSeconds));
  const steps = [
    [60, 's'], [3600, 'm', 60], [86400, 'h', 3600],
    [604800, 'd', 86400], [2629800, 'w', 604800],
  ];
  for (const [limit, unit, divisor] of steps) {
    if (seconds < limit) return divisor ? `${Math.floor(seconds / divisor)}${unit}` : `${seconds}${unit}`;
  }
  const months = Math.floor(seconds / 2629800);
  return months < 12 ? `${months}mo` : `${Math.floor(months / 12)}y`;
}

/** 1234567 -> "1.2M", matching Instagram's counters. */
export function count(n) {
  n = Number(n) || 0;
  if (n < 1000) return String(n);
  if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '')}K`;
  return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** Captions carry @mentions and #hashtags that should be tappable. */
export function richText(text) {
  const frag = document.createDocumentFragment();
  if (!text) return frag;
  const pattern = /(@[A-Za-z0-9._]+|#[\p{L}0-9_]+)/gu;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) frag.append(text.slice(last, match.index));
    const token = match[0];
    const href = token[0] === '@' ? `/u/${token.slice(1)}` : `/tag/${token.slice(1)}`;
    frag.append(h('a.link', { href, 'data-route': true }, token));
    last = match.index + token.length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

/** Fires `onHit` when the sentinel scrolls into view — used for every feed. */
export function infinite(sentinel, onHit) {
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) onHit();
  }, { rootMargin: '600px 0px' });
  observer.observe(sentinel);
  return () => observer.disconnect();
}

export function spinner(label) {
  return h('div.spinner', {}, h('div.spinner-ring'), label ? h('span', {}, label) : null);
}

export function emptyState(icon, title, body) {
  return h('div.empty', {},
    h('div.empty-icon', { html: icon }),
    h('h2', {}, title),
    body ? h('p', {}, body) : null,
  );
}
