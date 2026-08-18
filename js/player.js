/* Playback engine.
 *
 * Owns one <audio> element, the queue, and the failover logic that makes a
 * track keep playing when a mirror dies mid-request. A second, hidden element
 * pre-buffers the next track so transitions don't stall on a slow link. */

import { offline, local, getSetting, setSetting } from './store.js';
import { diag } from './net.js';

export const player = new EventTarget();

const audio = new Audio();
audio.preload = 'auto';
// Deliberately no crossOrigin: we never read the samples or draw them to a
// canvas, and requesting CORS would make playback fail outright on any mirror
// that doesn't send the headers. Plain media loads have no such requirement.

const preloader = new Audio();
preloader.preload = 'auto';
preloader.muted = true;

/** Object URLs we minted and must revoke. */
let currentObjectUrl = null;
let preloadObjectUrl = null;

export const state = {
  queue: [],
  order: [],          // indices into queue, in play order
  pos: -1,            // index into `order`
  track: null,
  playing: false,
  loading: false,
  shuffle: false,
  repeat: 'off',      // off | all | one
  duration: 0,
  time: 0,
  volume: 1,
  muted: false,
  urlIndex: 0,        // which mirror of the current track we're on
  context: null,      // where the queue came from, for the UI
};

function emit(type, detail) {
  player.dispatchEvent(new CustomEvent(type, { detail }));
}

/* ── Queue shaping ─────────────────────────────────────────────────── */

function buildOrder(startIndex = 0) {
  const idx = state.queue.map((_, i) => i);
  if (!state.shuffle) {
    state.order = idx;
    state.pos = startIndex;
    return;
  }
  // Fisher–Yates over everything except the starting track, which goes first
  // so pressing shuffle doesn't change what you just clicked on.
  const rest = idx.filter((i) => i !== startIndex);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  state.order = startIndex >= 0 ? [startIndex, ...rest] : rest;
  state.pos = 0;
}

export function setQueue(tracks, startIndex = 0, context = null) {
  state.queue = tracks.slice();
  state.context = context;
  buildOrder(Math.max(0, Math.min(startIndex, tracks.length - 1)));
  emit('queue', { queue: state.queue });
}

export function enqueue(tracks) {
  const list = Array.isArray(tracks) ? tracks : [tracks];
  const wasEmpty = state.queue.length === 0;
  const base = state.queue.length;
  state.queue.push(...list);
  state.order.push(...list.map((_, i) => base + i));
  emit('queue', { queue: state.queue });
  if (wasEmpty) {
    state.pos = 0;
    return playCurrent();
  }
  return Promise.resolve();
}

export function playNextUp(track) {
  const base = state.queue.length;
  state.queue.push(track);
  state.order.splice(state.pos + 1, 0, base);
  emit('queue', { queue: state.queue });
}

export function removeFromQueue(orderPos) {
  if (orderPos < 0 || orderPos >= state.order.length) return;
  if (orderPos === state.pos) return; // don't yank the playing track
  state.order.splice(orderPos, 1);
  if (orderPos < state.pos) state.pos--;
  emit('queue', { queue: state.queue });
}

export function clearQueue() {
  const keep = state.track;
  state.queue = keep ? [keep] : [];
  state.order = keep ? [0] : [];
  state.pos = keep ? 0 : -1;
  emit('queue', { queue: state.queue });
}

export function queueView() {
  return state.order.map((qi, orderPos) => ({
    track: state.queue[qi],
    orderPos,
    current: orderPos === state.pos,
  }));
}

/* ── Source resolution ─────────────────────────────────────────────── */

/** Hooks that can supply bytes for a track (used by demo mode). */
const blobProviders = [];
export function registerBlobProvider(fn) {
  blobProviders.push(fn);
}

/**
 * Work out what URL to feed the audio element.
 * Locally-held bytes always win: they're instant and work with no network.
 */
async function resolveSource(track, urlIndex) {
  for (const provide of blobProviders) {
    const blob = await provide(track).catch(() => null);
    if (blob) return { url: URL.createObjectURL(blob), isObjectUrl: true, label: 'generated' };
  }

  if (track.source === 'local') {
    const blob = await local.blob(track.id);
    if (!blob) throw new Error('Imported file is missing from this device');
    return { url: URL.createObjectURL(blob), isObjectUrl: true, label: 'imported file' };
  }

  const saved = await offline.blob(track.id).catch(() => null);
  if (saved) {
    return { url: URL.createObjectURL(saved), isObjectUrl: true, label: 'offline copy' };
  }

  const urls = track.urls || [];
  if (!urls.length) throw new Error('No playable source for this track');
  if (urlIndex >= urls.length) throw new Error('All sources failed');
  return { url: urls[urlIndex], isObjectUrl: false, label: hostOf(urls[urlIndex]) };
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

function releaseCurrentUrl() {
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
}

function releasePreloadUrl() {
  if (preloadObjectUrl) {
    URL.revokeObjectURL(preloadObjectUrl);
    preloadObjectUrl = null;
  }
}

/* ── Transport ─────────────────────────────────────────────────────── */

let loadToken = 0;

async function playCurrent(startAt = 0) {
  const qi = state.order[state.pos];
  const track = state.queue[qi];
  if (!track) return;

  const token = ++loadToken;
  state.track = track;
  state.urlIndex = 0;
  state.loading = true;
  state.time = 0;
  state.duration = track.duration || 0;
  emit('track', { track });
  emit('status', { ...state });

  await loadAndPlay(track, token, startAt);
}

async function loadAndPlay(track, token, startAt = 0) {
  let src;
  try {
    src = await resolveSource(track, state.urlIndex);
  } catch (err) {
    if (token === loadToken) failTrack(track, err);
    return;
  }
  if (token !== loadToken) {
    if (src.isObjectUrl) URL.revokeObjectURL(src.url);
    return;
  }

  releaseCurrentUrl();
  if (src.isObjectUrl) currentObjectUrl = src.url;

  audio.src = src.url;

  try {
    audio.load();
    if (startAt > 0) {
      audio.currentTime = startAt;
    }
    await audio.play();
    if (token !== loadToken) return;
    state.playing = true;
    state.loading = false;
    emit('status', { ...state });
    updateMediaSession(track);
    schedulePreload();
  } catch (err) {
    if (token !== loadToken) return;
    if (err?.name === 'NotAllowedError') {
      // Autoplay policy: the element is ready, the user just has to press play.
      state.playing = false;
      state.loading = false;
      emit('status', { ...state });
      emit('blocked', {});
      return;
    }
    tryNextSource(track, token, err);
  }
}

function tryNextSource(track, token, err) {
  if (token !== loadToken) return;
  const urls = track.urls || [];
  const isRemote = track.source !== 'local' && !currentObjectUrl;

  if (isRemote && state.urlIndex + 1 < urls.length) {
    state.urlIndex++;
    diag.log('warn', `source failed for "${track.title}", trying mirror ${state.urlIndex + 1}/${urls.length}`);
    loadAndPlay(track, token, 0);
    return;
  }
  failTrack(track, err);
}

function failTrack(track, err) {
  state.playing = false;
  state.loading = false;
  diag.log('err', `cannot play "${track.title}": ${err?.message || 'unknown error'}`);
  emit('status', { ...state });
  emit('error', { track, error: err });

  // Move on so one bad file doesn't stall the whole queue.
  if (state.order.length > 1) setTimeout(() => next(true), 700);
}

export async function playTrack(track, queue = null, context = null) {
  if (queue && queue.length) {
    const idx = Math.max(0, queue.findIndex((t) => t.id === track.id));
    setQueue(queue, idx, context);
  } else if (!state.queue.some((t) => t.id === track.id)) {
    setQueue([track], 0, context);
  } else {
    const qi = state.queue.findIndex((t) => t.id === track.id);
    const at = state.order.indexOf(qi);
    state.pos = at >= 0 ? at : state.pos;
  }
  await playCurrent();
}

export async function playAll(tracks, startIndex = 0, context = null) {
  if (!tracks.length) return;
  setQueue(tracks, startIndex, context);
  await playCurrent();
}

export async function toggle() {
  if (!state.track) return;
  if (audio.paused) {
    try {
      await audio.play();
      state.playing = true;
    } catch (err) {
      if (err?.name !== 'NotAllowedError') tryNextSource(state.track, loadToken, err);
    }
  } else {
    audio.pause();
    state.playing = false;
  }
  emit('status', { ...state });
}

export function pause() {
  audio.pause();
  state.playing = false;
  emit('status', { ...state });
}

export async function next(auto = false) {
  if (!state.order.length) return;

  if (state.repeat === 'one' && auto) {
    audio.currentTime = 0;
    await audio.play().catch(() => {});
    return;
  }
  if (state.pos + 1 < state.order.length) {
    state.pos++;
  } else if (state.repeat === 'all' || !auto) {
    state.pos = 0;
  } else {
    // End of queue with repeat off: stop cleanly.
    state.playing = false;
    audio.pause();
    emit('status', { ...state });
    emit('ended', {});
    return;
  }
  await playCurrent();
}

export async function prev() {
  if (!state.order.length) return;
  // Standard behaviour: restart the track unless you hit it twice quickly.
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  state.pos = state.pos > 0 ? state.pos - 1 : state.order.length - 1;
  await playCurrent();
}

export function seek(seconds) {
  if (!state.track || !Number.isFinite(seconds)) return;
  const dur = audio.duration || state.duration;
  if (!dur) return;
  audio.currentTime = Math.max(0, Math.min(seconds, dur - 0.25));
}

export function seekFraction(f) {
  const dur = audio.duration || state.duration;
  if (dur) seek(dur * f);
}

export function setVolume(v) {
  state.volume = Math.max(0, Math.min(1, v));
  audio.volume = state.volume;
  if (state.volume > 0 && state.muted) setMuted(false);
  setSetting('volume', state.volume);
  emit('status', { ...state });
}

export function setMuted(m) {
  state.muted = m;
  audio.muted = m;
  setSetting('muted', m);
  emit('status', { ...state });
}

export function toggleShuffle() {
  state.shuffle = !state.shuffle;
  setSetting('shuffle', state.shuffle);
  const currentQi = state.order[state.pos];
  buildOrder(currentQi ?? 0);
  emit('status', { ...state });
  emit('queue', { queue: state.queue });
  return state.shuffle;
}

export function cycleRepeat() {
  state.repeat = { off: 'all', all: 'one', one: 'off' }[state.repeat];
  setSetting('repeat', state.repeat);
  emit('status', { ...state });
  return state.repeat;
}

/* ── Pre-buffering ─────────────────────────────────────────────────── */

let preloadedId = null;

async function schedulePreload() {
  const nextPos = state.pos + 1;
  if (nextPos >= state.order.length) return;
  const track = state.queue[state.order[nextPos]];
  if (!track || track.id === preloadedId) return;

  preloadedId = track.id;
  try {
    const src = await resolveSource(track, 0);
    releasePreloadUrl();
    if (src.isObjectUrl) preloadObjectUrl = src.url;
    preloader.src = src.url;
    preloader.load();
  } catch {
    // Pre-buffering is best-effort; the real load will report any problem.
  }
}

/* ── Media Session (lock screen / headset buttons) ─────────────────── */

function updateMediaSession(track) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album || 'Void Music',
      artwork: track.cover
        ? [96, 192, 512].map((s) => ({ src: track.cover, sizes: `${s}x${s}`, type: 'image/jpeg' }))
        : [{ src: 'assets/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
    navigator.mediaSession.playbackState = state.playing ? 'playing' : 'paused';
  } catch { /* metadata is cosmetic */ }
}

if ('mediaSession' in navigator) {
  const handlers = {
    play: () => toggle(),
    pause: () => pause(),
    previoustrack: () => prev(),
    nexttrack: () => next(false),
    seekbackward: (d) => seek(audio.currentTime - (d?.seekOffset || 10)),
    seekforward: (d) => seek(audio.currentTime + (d?.seekOffset || 10)),
    seekto: (d) => { if (d?.seekTime != null) seek(d.seekTime); },
    stop: () => pause(),
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* unsupported action */ }
  }
}

/* ── Element wiring ────────────────────────────────────────────────── */

audio.addEventListener('timeupdate', () => {
  state.time = audio.currentTime;
  if (audio.duration && Number.isFinite(audio.duration)) state.duration = audio.duration;
  emit('time', { time: state.time, duration: state.duration });

  if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && state.duration) {
    try {
      navigator.mediaSession.setPositionState({
        duration: state.duration,
        position: Math.min(state.time, state.duration),
        playbackRate: audio.playbackRate || 1,
      });
    } catch { /* Safari throws on odd values */ }
  }
});

audio.addEventListener('loadedmetadata', () => {
  if (Number.isFinite(audio.duration)) {
    state.duration = audio.duration;
    emit('time', { time: state.time, duration: state.duration });
  }
});

audio.addEventListener('ended', () => {
  // "Sleep at end of track" means this track, so honour it before advancing.
  if (sleepAfterTrack) {
    clearSleepTimer();
    state.playing = false;
    emit('status', { ...state });
    emit('ended', {});
    return;
  }
  next(true);
});

audio.addEventListener('error', () => {
  if (!state.track) return;
  const err = audio.error;
  // MEDIA_ELEMENT_ERROR with no src set fires spuriously on some browsers.
  if (!audio.src) return;
  tryNextSource(state.track, loadToken, new Error(mediaErrorText(err)));
});

audio.addEventListener('stalled', () => {
  if (state.playing) diag.log('warn', 'playback stalled — waiting for data');
});

audio.addEventListener('waiting', () => {
  state.loading = true;
  emit('status', { ...state });
});

audio.addEventListener('playing', () => {
  state.playing = true;
  state.loading = false;
  emit('status', { ...state });
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
});

audio.addEventListener('pause', () => {
  state.playing = false;
  emit('status', { ...state });
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
});

function mediaErrorText(err) {
  switch (err?.code) {
    case 1: return 'load aborted';
    case 2: return 'network error';
    case 3: return 'decode error';
    case 4: return 'format not supported';
    default: return 'playback error';
  }
}

/* ── Sleep timer ───────────────────────────────────────────────────── */

let sleepTimer = null;
let sleepEndsAt = 0;
let sleepAfterTrack = false;

/**
 * Stop playback later. `minutes` counts down; `endOfTrack` waits for the
 * current song to finish instead. Fades out rather than cutting, so falling
 * asleep to it isn't punctuated by a hard stop.
 */
export function setSleepTimer({ minutes = 0, endOfTrack = false } = {}) {
  clearSleepTimer();
  if (endOfTrack) {
    sleepAfterTrack = true;
  } else if (minutes > 0) {
    sleepEndsAt = Date.now() + minutes * 60000;
    sleepTimer = setTimeout(fadeToSleep, minutes * 60000);
  }
  emit('sleep', sleepState());
  return sleepState();
}

export function clearSleepTimer() {
  clearTimeout(sleepTimer);
  sleepTimer = null;
  sleepEndsAt = 0;
  sleepAfterTrack = false;
  emit('sleep', sleepState());
}

export function sleepState() {
  return {
    active: Boolean(sleepTimer || sleepAfterTrack),
    endOfTrack: sleepAfterTrack,
    remainingMs: sleepEndsAt ? Math.max(0, sleepEndsAt - Date.now()) : 0,
  };
}

async function fadeToSleep() {
  const from = audio.volume;
  const steps = 24;
  for (let i = steps; i >= 0; i--) {
    audio.volume = (from * i) / steps;
    await new Promise((r) => setTimeout(r, 125));
  }
  pause();
  audio.volume = from;      // restore, so the next play is not silent
  clearSleepTimer();
}

/** Restore persisted transport settings on boot. */
export function hydrate() {
  state.volume = Number(getSetting('volume') ?? 1);
  state.muted = Boolean(getSetting('muted'));
  state.repeat = getSetting('repeat') || 'off';
  state.shuffle = Boolean(getSetting('shuffle'));
  audio.volume = state.volume;
  audio.muted = state.muted;
  emit('status', { ...state });
}

export { audio };
