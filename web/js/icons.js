// Inline SVG so the app renders with zero extra requests — matters on a slow
// or lossy link, which is the normal case for the people this is built for.

const svg = (paths, { fill = 'none', width = 24 } = {}) =>
  `<svg viewBox="0 0 24 24" width="${width}" height="${width}" fill="${fill}"
        stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
        stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const icons = {
  home: svg('<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'),
  homeFilled: svg('<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    { fill: 'currentColor' }),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  searchFilled: svg('<circle cx="11" cy="11" r="7" fill="currentColor"/><path d="m20 20-3.5-3.5"/>'),
  reels: svg('<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M3 8h18M9 3l3 5M15 3l3 5"/><path d="m11 12 4 2.5-4 2.5z"/>'),
  reelsFilled: svg('<rect x="3" y="3" width="18" height="18" rx="4" fill="currentColor" stroke="none"/><path d="M3 8h18M9 3l3 5M15 3l3 5" stroke="var(--bg)"/><path d="m11 12 4 2.5-4 2.5z" fill="var(--bg)" stroke="var(--bg)"/>'),
  heart: svg('<path d="M12 20.5s-7.5-4.7-7.5-10A4.5 4.5 0 0 1 12 7.6a4.5 4.5 0 0 1 7.5 2.9c0 5.3-7.5 10-7.5 10z"/>'),
  heartFilled: svg('<path d="M12 20.5s-7.5-4.7-7.5-10A4.5 4.5 0 0 1 12 7.6a4.5 4.5 0 0 1 7.5 2.9c0 5.3-7.5 10-7.5 10z"/>',
    { fill: 'currentColor' }),
  comment: svg('<path d="M21 11.5a8.4 8.4 0 0 1-9 8.5 9.5 9.5 0 0 1-3.4-.6L3 21l1.7-4.9A8.3 8.3 0 0 1 3.6 11.5 8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"/>'),
  share: svg('<path d="M22 3 11 14"/><path d="M22 3 15 21l-4-7-7-4z"/>'),
  bookmark: svg('<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.5L5 21V4a1 1 0 0 1 1-1z"/>'),
  bookmarkFilled: svg('<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.5L5 21V4a1 1 0 0 1 1-1z"/>',
    { fill: 'currentColor' }),
  back: svg('<path d="M15 5 8 12l7 7"/>'),
  close: svg('<path d="M6 6 18 18M18 6 6 18"/>'),
  more: svg('<circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/>'),
  verified: `<svg viewBox="0 0 24 24" width="14" height="14" aria-label="Verified"><path fill="#3797f0" d="m12 1.6 2.6 2.2 3.4-.3.9 3.3 2.9 1.8-1.3 3.2 1.3 3.2-2.9 1.8-.9 3.3-3.4-.3L12 22.4l-2.6-2.2-3.4.3-.9-3.3-2.9-1.8 1.3-3.2-1.3-3.2 2.9-1.8.9-3.3 3.4.3z"/><path fill="#fff" d="m10.9 15.4-3-3 1.3-1.3 1.7 1.7 4.1-4.1 1.3 1.3z"/></svg>`,
  lock: svg('<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>'),
  grid: svg('<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/>'),
  mute: svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M17 9.5 22 14.5M22 9.5 17 14.5"/>'),
  unmute: svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M16 8.5a5 5 0 0 1 0 7M19 6a9 9 0 0 1 0 12"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.9 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 13.9H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 7.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10.1 3V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.3z"/>'),
  globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/>'),
  refresh: svg('<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/>'),
};

export function icon(name, className = '') {
  const span = document.createElement('span');
  span.className = `icon ${className}`.trim();
  span.innerHTML = icons[name] || '';
  return span;
}
