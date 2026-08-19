import { h } from './dom.js';

let host = null;

export function toast(message, { duration = 3200 } = {}) {
  if (!message) return;
  if (!host) {
    host = h('div.toast-host');
    document.body.append(host);
  }
  const el = h('div.toast', {}, message);
  host.append(el);
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => {
    el.classList.remove('in');
    setTimeout(() => el.remove(), 250);
  }, duration);
}
