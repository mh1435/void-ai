/* Appearance: light/dark/system, plus a true-black mode for OLED screens.
 *
 * Only CSS custom properties change — every component reads from those, so
 * there is no second stylesheet to keep in sync. */

import { getSetting, setSetting } from './store.js';

const root = document.documentElement;
const media = matchMedia('(prefers-color-scheme: light)');

/** 'dark' | 'light' | 'system' */
export function currentTheme() {
  return getSetting('theme') || 'system';
}

export function amoledOn() {
  return Boolean(getSetting('amoled'));
}

function resolved(theme) {
  if (theme === 'system') return media.matches ? 'light' : 'dark';
  return theme;
}

export function applyTheme() {
  const theme = resolved(currentTheme());
  root.dataset.theme = theme;
  root.dataset.amoled = amoledOn() ? 'on' : 'off';

  // Keep the system UI (status bar, task switcher) in step with the page.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.content = theme === 'light'
      ? '#faf9fe'
      : (amoledOn() ? '#000000' : '#08070f');
  }
}

export async function setTheme(theme) {
  await setSetting('theme', theme);
  applyTheme();
}

export async function setAmoled(on) {
  await setSetting('amoled', on);
  applyTheme();
}

// Following the system means reacting when it changes.
media.addEventListener('change', () => {
  if (currentTheme() === 'system') applyTheme();
});
