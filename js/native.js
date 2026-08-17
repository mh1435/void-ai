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
