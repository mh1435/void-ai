/*
 * Void Music — a music player for open catalogues.
 * Copyright (C) 2026 Void Music contributors
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version. It is distributed WITHOUT ANY WARRANTY; see the GNU
 * General Public License in LICENSE for details.
 */

/* Playback engine.
 *
 * Two <audio> decks, not one. Only one is audible at a time; the other holds
 * whatever plays next. That single decision buys three things:
 *
 *   - crossfade, because both decks can sound at once while their volumes
 *     cross over;
 *   - near-gapless advance with crossfade off, because the next track is
 *     already decoded and just gets promoted;
 *   - failover, because a dead mirror can be retried on a deck that isn't
 *     the one currently making noise.
 *
 * The rule that keeps it honest: exactly one deck is "active" at any moment,
 * and every event handler ignores the deck that isn't. */

import { offline, local, getSetting, setSetting } from './store.js';
import { diag } from './net.js';

export const player = new EventTarget();

function makeDeck() {
  const a = new Audio();
  a.preload = 'auto';
  // Deliberately no crossOrigin: we never read the samples or draw them to a
  // canvas, and requesting CORS would make playback fail outright on any
  // mirror that doesn't send the headers.
  return a;
}

const decks = [makeDeck(), makeDeck()];
let active = 0;

/** Per-deck fade multiplier; the user's volume is applied on top. */
const gain = [1, 1];

/** What each deck currently holds: { trackId, url, isObjectUrl }. */
const held = [null, null];

/** The audible element. Reassigned on every swap; the export is a live binding. */
export let audio = decks[0];

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
  crossfade: 0,       // seconds; 0 = off
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
  invalidatePreload();
  emit('queue', { queue: state.queue });
}

export function removeFromQueue(orderPos) {
  if (orderPos < 0 || orderPos >= state.order.length) return;
  if (orderPos === state.pos) return; // don't yank the playing track
  state.order.splice(orderPos, 1);
  if (orderPos < state.pos) state.pos--;
  invalidatePreload();
  emit('queue', { queue: state.queue });
}

/** Move a queue entry to a different position, keeping playback where it is. */
export function moveInQueue(from, to) {
  const n = state.order.length;
  if (from === to || from < 0 || from >= n || to < 0 || to >= n) return;

  const playing = state.order[state.pos];
  const [moved] = state.order.splice(from, 1);
  state.order.splice(to, 0, moved);
  // The current track may have shifted; follow it rather than the index.
  state.pos = state.order.indexOf(playing);
  invalidatePreload();
  emit('queue', { queue: state.queue });
}

export function clearQueue() {
  const keep = state.track;
  state.queue = keep ? [keep] : [];
  state.order = keep ? [0] : [];
  state.pos = keep ? 0 : -1;
  invalidatePreload();
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
 * Work out what URL to feed a deck.
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

/** Point a deck at a source, releasing whatever it held before. */
function attach(deckIndex, track, src) {
  const prev = held[deckIndex];
  if (prev?.isObjectUrl) URL.revokeObjectURL(prev.url);
  held[deckIndex] = { trackId: track.id, url: src.url, isObjectUrl: src.isObjectUrl };
  decks[deckIndex].src = src.url;
  decks[deckIndex].load();
}

function release(deckIndex) {
  const prev = held[deckIndex];
  if (prev?.isObjectUrl) URL.revokeObjectURL(prev.url);
  held[deckIndex] = null;
}

const holds = (deckIndex, track) => held[deckIndex]?.trackId === track?.id;

/* ── Volume ────────────────────────────────────────────────────────── */

function applyVolume() {
  for (let i = 0; i < decks.length; i++) {
    decks[i].volume = Math.max(0, Math.min(1, state.volume * gain[i]));
    decks[i].muted = state.muted;
  }
}

/* ── Transport ─────────────────────────────────────────────────────── */

let loadToken = 0;

function currentTrack() {
  const qi = state.order[state.pos];
  return state.queue[qi] || null;
}

async function playCurrent(startAt = 0) {
  const track = currentTrack();
  if (!track) return;

  cancelFade();
  const token = ++loadToken;
  state.track = track;
  state.urlIndex = 0;
  state.loading = true;
  state.time = 0;
  state.duration = track.duration || 0;
  emit('track', { track });
  emit('status', { ...state });

  // If the standby deck already holds this track, promote it instead of
  // re-fetching: that is what makes "next" feel instant.
  if (startAt === 0 && holds(1 - active, track)) {
    const from = active;
    decks[from].pause();
    swapTo(1 - active);
    decks[active].currentTime = 0;
    try {
      await decks[active].play();
      if (token !== loadToken) return;
      onStarted(track, token);
      return;
    } catch (err) {
      if (token !== loadToken) return;
      if (!handleAutoplayBlock(err)) tryNextSource(track, token, err);
      return;
    }
  }

  await loadAndPlay(track, token, startAt);
}

/** Load onto the active deck and start it. */
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

  attach(active, track, src);
  gain[active] = 1;
  applyVolume();

  try {
    if (startAt > 0) decks[active].currentTime = startAt;
    await decks[active].play();
    if (token !== loadToken) return;
    onStarted(track, token);
  } catch (err) {
    if (token !== loadToken) return;
    if (handleAutoplayBlock(err)) return;
    tryNextSource(track, token, err);
  }
}

function onStarted(track, token) {
  if (token !== loadToken) return;
  state.playing = true;
  state.loading = false;
  emit('status', { ...state });
  updateMediaSession(track);
  schedulePreload();
}

function handleAutoplayBlock(err) {
  if (err?.name !== 'NotAllowedError') return false;
  // Autoplay policy: the element is ready, the user just has to press play.
  state.playing = false;
  state.loading = false;
  emit('status', { ...state });
  emit('blocked', {});
  return true;
}

function tryNextSource(track, token, err) {
  if (token !== loadToken) return;
  const urls = track.urls || [];
  const remote = track.source !== 'local' && !held[active]?.isObjectUrl;

  if (remote && state.urlIndex + 1 < urls.length) {
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
  const deck = decks[active];
  if (deck.paused) {
    try {
      await deck.play();
      state.playing = true;
    } catch (err) {
      if (err?.name !== 'NotAllowedError') tryNextSource(state.track, loadToken, err);
    }
  } else {
    deck.pause();
    state.playing = false;
  }
  emit('status', { ...state });
}

export function pause() {
  cancelFade();
  decks[active].pause();
  state.playing = false;
  emit('status', { ...state });
}

/** Where the queue goes after the current position, or -1 if nowhere. */
function nextPos(auto) {
  if (state.pos + 1 < state.order.length) return state.pos + 1;
  if (state.repeat === 'all' || !auto) return 0;
  return -1;
}

export async function next(auto = false) {
  if (!state.order.length) return;

  if (state.repeat === 'one' && auto) {
    decks[active].currentTime = 0;
    await decks[active].play().catch(() => {});
    return;
  }

  const to = nextPos(auto);
  if (to < 0) {
    // End of queue with repeat off: stop cleanly.
    state.playing = false;
    decks[active].pause();
    emit('status', { ...state });
    emit('ended', {});
    return;
  }
  state.pos = to;
  await playCurrent();
}

export async function prev() {
  if (!state.order.length) return;
  // Standard behaviour: restart the track unless you hit it twice quickly.
  if (decks[active].currentTime > 3) {
    decks[active].currentTime = 0;
    return;
  }
  state.pos = state.pos > 0 ? state.pos - 1 : state.order.length - 1;
  await playCurrent();
}

/** Jump straight to a position in the play order (used by the queue drawer). */
export async function playAt(orderPos) {
  if (orderPos < 0 || orderPos >= state.order.length) return;
  state.pos = orderPos;
  await playCurrent();
}

export function seek(seconds) {
  if (!state.track || !Number.isFinite(seconds)) return;
  const deck = decks[active];
  const dur = deck.duration || state.duration;
  if (!dur) return;
  deck.currentTime = Math.max(0, Math.min(seconds, dur - 0.25));
}

export function seekFraction(f) {
  const dur = decks[active].duration || state.duration;
  if (dur) seek(dur * f);
}

export function setVolume(v) {
  state.volume = Math.max(0, Math.min(1, v));
  applyVolume();
  if (state.volume > 0 && state.muted) setMuted(false);
  setSetting('volume', state.volume);
  emit('status', { ...state });
}

export function setMuted(m) {
  state.muted = m;
  applyVolume();
  setSetting('muted', m);
  emit('status', { ...state });
}

export function toggleShuffle() {
  state.shuffle = !state.shuffle;
  setSetting('shuffle', state.shuffle);
  const currentQi = state.order[state.pos];
  buildOrder(currentQi ?? 0);
  invalidatePreload();
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

/* ── Crossfade ─────────────────────────────────────────────────────── */

/**
 * Seconds of overlap between tracks. Zero keeps the old behaviour, where the
 * next track simply starts the moment this one ends — which is already close
 * to gapless because the standby deck is pre-buffered.
 */
export function setCrossfade(seconds) {
  state.crossfade = Math.max(0, Math.min(12, Number(seconds) || 0));
  setSetting('crossfade', state.crossfade);
  emit('status', { ...state });
  return state.crossfade;
}

let fadeTimer = null;
let fading = false;
/* timeupdate fires several times a second, and preparing a fade is async.
 * Without this, every tick would start another attempt and they would cancel
 * each other, so the fade kept slipping later and later. One at a time. */
let preparingFade = false;

function swapTo(index) {
  active = index;
  audio = decks[index];
  gain[index] = 1;
  gain[1 - index] = 0;
  applyVolume();
}

function cancelFade() {
  loadToken++;                 // abandons any fade still being prepared
  if (fadeTimer) clearInterval(fadeTimer);
  fadeTimer = null;
  if (fading) {
    // Whichever deck was on its way out stops now.
    decks[1 - active].pause();
    fading = false;
  }
  gain[active] = 1;
  gain[1 - active] = 0;
  applyVolume();
}

/**
 * Bring the standby deck up while the active one goes down, on an equal-power
 * curve so the middle of the fade doesn't sound like a dip in volume.
 */
function runFade(outIndex, inIndex, seconds) {
  const started = performance.now();
  const ms = seconds * 1000;
  fading = true;

  if (fadeTimer) clearInterval(fadeTimer);
  fadeTimer = setInterval(() => {
    const t = Math.min(1, (performance.now() - started) / ms);
    gain[outIndex] = Math.cos((t * Math.PI) / 2);
    gain[inIndex] = Math.sin((t * Math.PI) / 2);
    applyVolume();
    if (t >= 1) {
      clearInterval(fadeTimer);
      fadeTimer = null;
      fading = false;
      decks[outIndex].pause();
      release(outIndex);
      gain[outIndex] = 0;
      applyVolume();
      schedulePreload();
    }
  }, 50);
}

/** Called from timeupdate: decide whether it is time to start overlapping. */
async function maybeCrossfade() {
  if (fading || preparingFade || !state.playing || state.crossfade <= 0) return;
  if (state.repeat === 'one') return;

  const deck = decks[active];
  const dur = deck.duration;
  if (!Number.isFinite(dur) || dur <= 0) return;
  // Never fade a clip shorter than twice the fade: it would be all fade.
  if (dur < state.crossfade * 2 + 1) return;
  if (dur - deck.currentTime > state.crossfade) return;

  const to = nextPos(true);
  if (to < 0 || to === state.pos) return;

  const track = state.queue[state.order[to]];
  if (!track) return;

  preparingFade = true;
  const token = ++loadToken;
  const inIndex = 1 - active;

  try {
    if (!holds(inIndex, track)) {
      let src;
      try {
        src = await resolveSource(track, 0);
      } catch {
        return;               // let the plain `ended` path handle it instead
      }
      if (token !== loadToken) {
        if (src.isObjectUrl) URL.revokeObjectURL(src.url);
        return;
      }
      attach(inIndex, track, src);
    }
    if (token !== loadToken) return;

    gain[inIndex] = 0;
    applyVolume();

    try {
      decks[inIndex].currentTime = 0;
      await decks[inIndex].play();
    } catch {
      // Autoplay refusal or a dead source: fall back to a hard cut on `ended`.
      return;
    }
    if (token !== loadToken) { decks[inIndex].pause(); return; }

    // The incoming track is the current one from here on.
    const outIndex = active;
    state.pos = to;
    state.track = track;
    state.urlIndex = 0;
    active = inIndex;
    audio = decks[inIndex];
    emit('track', { track });
    emit('status', { ...state });
    updateMediaSession(track);

    runFade(outIndex, inIndex, state.crossfade);
  } finally {
    preparingFade = false;
  }
}

/* ── Pre-buffering ─────────────────────────────────────────────────── */

function invalidatePreload() {
  if (fading) return;
  const idle = 1 - active;
  if (held[idle]) {
    decks[idle].pause();
    decks[idle].removeAttribute('src');
    release(idle);
  }
}

async function schedulePreload() {
  if (fading) return;
  const to = nextPos(true);
  if (to < 0 || to === state.pos) return;

  const track = state.queue[state.order[to]];
  const idle = 1 - active;
  if (!track || holds(idle, track)) return;

  try {
    const src = await resolveSource(track, 0);
    if (fading || idle === active) {
      if (src.isObjectUrl) URL.revokeObjectURL(src.url);
      return;
    }
    attach(idle, track, src);
    gain[idle] = 0;
    applyVolume();
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
    seekbackward: (d) => seek(state.time - (d?.seekOffset || 10)),
    seekforward: (d) => seek(state.time + (d?.seekOffset || 10)),
    seekto: (d) => { if (d?.seekTime != null) seek(d.seekTime); },
    stop: () => pause(),
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* unsupported action */ }
  }
}

/* ── Element wiring ────────────────────────────────────────────────── */

/* Both decks are wired identically; handlers drop anything from the deck that
 * isn't currently audible, so a fading-out track can't drive the UI. */
decks.forEach((deck, index) => {
  const isActive = () => index === active;

  deck.addEventListener('timeupdate', () => {
    if (!isActive()) return;
    state.time = deck.currentTime;
    if (deck.duration && Number.isFinite(deck.duration)) state.duration = deck.duration;
    emit('time', { time: state.time, duration: state.duration });

    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && state.duration) {
      try {
        navigator.mediaSession.setPositionState({
          duration: state.duration,
          position: Math.min(state.time, state.duration),
          playbackRate: deck.playbackRate || 1,
        });
      } catch { /* Safari throws on odd values */ }
    }

    maybeCrossfade();
  });

  deck.addEventListener('loadedmetadata', () => {
    if (!isActive() || !Number.isFinite(deck.duration)) return;
    state.duration = deck.duration;
    emit('time', { time: state.time, duration: state.duration });
  });

  deck.addEventListener('ended', () => {
    if (!isActive()) return;   // the outgoing half of a crossfade
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

  deck.addEventListener('error', () => {
    if (!isActive() || !state.track) return;
    // MEDIA_ELEMENT_ERROR with no src set fires spuriously on some browsers.
    if (!deck.getAttribute('src')) return;
    tryNextSource(state.track, loadToken, new Error(mediaErrorText(deck.error)));
  });

  deck.addEventListener('stalled', () => {
    if (isActive() && state.playing) diag.log('warn', 'playback stalled — waiting for data');
  });

  deck.addEventListener('waiting', () => {
    if (!isActive()) return;
    state.loading = true;
    emit('status', { ...state });
  });

  deck.addEventListener('playing', () => {
    if (!isActive()) return;
    state.playing = true;
    state.loading = false;
    emit('status', { ...state });
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  });

  deck.addEventListener('pause', () => {
    if (!isActive() || fading) return;
    state.playing = false;
    emit('status', { ...state });
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  });
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
  const deck = decks[active];
  const from = state.volume;
  const steps = 24;
  for (let i = steps; i >= 0; i--) {
    deck.volume = (from * i) / steps;
    await new Promise((r) => setTimeout(r, 125));
  }
  pause();
  applyVolume();          // restore, so the next play is not silent
  clearSleepTimer();
}

/** Restore persisted transport settings on boot. */
export function hydrate() {
  state.volume = Number(getSetting('volume') ?? 1);
  state.muted = Boolean(getSetting('muted'));
  state.repeat = getSetting('repeat') || 'off';
  state.shuffle = Boolean(getSetting('shuffle'));
  state.crossfade = Number(getSetting('crossfade') ?? 0);
  gain[active] = 1;
  gain[1 - active] = 0;
  applyVolume();
  emit('status', { ...state });
}
