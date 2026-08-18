/* Bridge to the Android wrapper.
 *
 * The web app is the source of truth for playback; the native side only needs
 * to know whether audio is running so it can hold a foreground service and keep
 * the OS from suspending us in the background.
 *
 * Every call is optional. In a plain browser `window.VoidNative` is undefined
 * and all of this quietly does nothing. */

import { player, state } from './player.js';

const bridge = typeof window !== 'undefined' ? window.VoidNative : undefined;

/** True when running inside the packaged Android app rather than a browser. */
export const isNativeApp = (() => {
  try {
    return Boolean(bridge?.isNativeApp?.());
  } catch {
    return false;
  }
})();

/** Also true for a PWA launched from the home screen. */
export const isStandalone = (() => {
  try {
    return isNativeApp
      || matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
  } catch {
    return isNativeApp;
  }
})();

/* ── Folder import ─────────────────────────────────────────────────── */

/**
 * A WebView has no equivalent of <input webkitdirectory>, so on Android the
 * folder is picked natively instead. True means "ask me, not the file input".
 */
export const canPickFolder = (() => {
  try {
    return Boolean(bridge?.canPickFolder?.());
  } catch {
    return false;
  }
})();

/**
 * Open the system folder picker and resolve with what is inside it:
 * `[{ id, name, path, size, mime, url }]`, empty if the user backed out.
 *
 * The bytes are not in that list. Each entry carries a URL on the app's own
 * origin that streams the file when fetched, so a folder of several hundred
 * songs costs nothing until each one is actually read.
 */
export function pickFolder() {
  if (!canPickFolder) return Promise.resolve([]);

  return new Promise((resolve) => {
    let settled = false;
    const done = (list) => {
      if (settled) return;
      settled = true;
      delete window.__voidFolderPicked;
      resolve(Array.isArray(list) ? list.map(withUrl) : []);
    };

    window.__voidFolderPicked = done;
    try {
      bridge.pickFolder();
    } catch {
      done([]);
    }
  });
}

function withUrl(entry) {
  return { ...entry, url: `${location.origin}/localfile/${encodeURIComponent(entry.id)}` };
}

let lastSignature = null;

function report() {
  if (!bridge) return;

  // Collapse repeats: this runs on every status tick, and the service only
  // cares about transitions.
  const signature = state.playing ? `${state.track?.id}|playing` : 'stopped';
  if (signature === lastSignature) return;
  lastSignature = signature;

  try {
    if (state.playing && state.track) {
      bridge.playbackStarted?.(state.track.title || 'Void Music', state.track.artist || '');
    } else {
      bridge.playbackStopped?.();
    }
  } catch {
    // A wrapper without these methods must never break playback.
  }
}

export function initNative() {
  if (!bridge) return;
  player.addEventListener('status', report);
  player.addEventListener('track', report);
  player.addEventListener('ended', report);
  addEventListener('pagehide', () => {
    try { bridge.playbackStopped?.(); } catch { /* going away anyway */ }
  });
}
