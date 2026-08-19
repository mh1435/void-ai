/* Bridge to the Android wrapper.
 *
 * The web app is the source of truth for playback; the native side only needs
 * to know whether audio is running so it can hold a foreground service and keep
 * the OS from suspending us in the background.
 *
 * Every call is optional. In a plain browser `window.VoidNative` is undefined
 * and all of this quietly does nothing. */

import * as P from './player.js';
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

/**
 * Open a link outside the app.
 *
 * window.open does nothing inside the wrapper — the WebView has multiple
 * windows disabled, and there is no browser for it to open. The bridge hands
 * the URL to Android instead.
 */
export function openExternal(url) {
  if (!url) return;
  try {
    if (bridge?.openExternal) {
      bridge.openExternal(String(url));
      return;
    }
  } catch { /* fall through to the browser behaviour */ }
  window.open(url, '_blank', 'noopener');
}

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

/* ── Media session metadata ────────────────────────────────────────── */

/**
 * Re-encode a cover into something the native side can decode.
 *
 * The page's artwork can be a blob it holds in memory, so there is no URL for
 * Android to fetch — the bytes have to go across. 512px JPEG keeps that
 * transfer small while still looking right on a lock screen.
 */
async function artworkDataUrl(url) {
  if (!url) return '';
  try {
    const res = await fetch(url);
    if (!res.ok) return '';
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);

    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    // Cover-fit, so a non-square image is cropped rather than squashed.
    const scale = Math.max(size / bitmap.width, size / bitmap.height);
    const w = bitmap.width * scale;
    const h = bitmap.height * scale;
    ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h);
    bitmap.close?.();

    return canvas.toDataURL('image/jpeg', 0.85);
  } catch {
    // Cross-origin artwork we are not allowed to read: the notification simply
    // shows the app icon instead.
    return '';
  }
}

let metadataToken = 0;

async function pushMetadata(track) {
  if (!bridge?.nowPlaying) return;
  const token = ++metadataToken;
  const artwork = await artworkDataUrl(track.cover);
  if (token !== metadataToken) return;

  try {
    bridge.nowPlaying(JSON.stringify({
      title: track.title || 'Void Music',
      artist: track.artist || '',
      album: track.album || '',
      duration: state.duration || track.duration || 0,
      position: state.time || 0,
      playing: state.playing,
      artwork,
    }));
  } catch { /* older wrapper */ }
}

let lastTick = 0;

function pushState() {
  if (!bridge?.playbackState) return;
  const now = Date.now();
  // One update a second is enough for a progress bar nobody is staring at.
  if (now - lastTick < 1000) return;
  lastTick = now;
  try {
    bridge.playbackState(state.playing, state.time || 0);
  } catch { /* older wrapper */ }
}

/**
 * Commands coming the other way: lock screen, notification buttons, headset,
 * Bluetooth, or the island. The page stays the single source of truth.
 */
function installCommandHandler() {
  window.__voidCommand = (command, value) => {
    switch (command) {
      case 'play': if (!state.playing) P.toggle(); break;
      case 'pause': if (state.playing) P.pause(); break;
      case 'toggle': P.toggle(); break;
      case 'next': P.next(false); break;
      case 'prev': P.prev(); break;
      case 'seek': P.seek(Number(value) || 0); break;
      default: break;
    }
  };
}

export function initNative() {
  if (!bridge) return;
  installCommandHandler();

  player.addEventListener('status', report);
  player.addEventListener('track', report);
  player.addEventListener('ended', report);

  // Metadata on every track change, position on the clock.
  player.addEventListener('track', (e) => pushMetadata(e.detail.track));
  player.addEventListener('status', () => {
    lastTick = 0;                       // a play/pause flip should show at once
    pushState();
  });
  player.addEventListener('time', pushState);
  addEventListener('pagehide', () => {
    try { bridge.playbackStopped?.(); } catch { /* going away anyway */ }
  });
}
