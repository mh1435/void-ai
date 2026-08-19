// The audio engine. One <audio> element, a small in-memory queue, and
// window-level CustomEvents (`trackchange`, `timeupdate`, `playstate`) so
// the mini-player and any other view can react without a shared framework.

import { addRecentlyPlayed } from './store.js';

const audio = document.getElementById('audio-engine');

let queue = [];
let index = -1;

function current() {
  return index >= 0 && index < queue.length ? queue[index] : null;
}

function emit(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function loadCurrent(autoplay = true) {
  const track = current();
  if (!track) return;
  audio.src = track.url;
  if (autoplay) {
    audio.play().catch(() => {
      // Autoplay can be blocked before a user gesture; the mini-player's
      // play button still works because it *is* the gesture.
    });
  }
  addRecentlyPlayed(track);
  emit('trackchange', track);
}

/** Play a single track immediately, replacing the queue. */
export function playTrack(track, contextQueue) {
  if (!track) return;
  queue = Array.isArray(contextQueue) && contextQueue.length ? contextQueue : [track];
  index = queue.findIndex((t) => t.id === track.id);
  if (index < 0) { queue = [track, ...queue]; index = 0; }
  loadCurrent(true);
}

export function toggle() {
  if (!current()) return;
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

export function next() {
  if (!queue.length) return;
  index = (index + 1) % queue.length;
  loadCurrent(true);
}

export function prev() {
  if (!queue.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  index = (index - 1 + queue.length) % queue.length;
  loadCurrent(true);
}

export function isPlaying() {
  return !audio.paused && !audio.ended;
}

export function getCurrentTrack() {
  return current();
}

// -- wire the <audio> element's own events out to the app -------------------

audio.addEventListener('timeupdate', () => {
  emit('timeupdate', { current: audio.currentTime, duration: audio.duration || 0 });
});
audio.addEventListener('play', () => emit('playstate', { playing: true }));
audio.addEventListener('pause', () => emit('playstate', { playing: false }));
audio.addEventListener('ended', () => next());
audio.addEventListener('error', () => {
  // A dead link (archive.org item pulled, etc.) — skip forward rather than
  // stall silently on a track that will never play.
  if (queue.length > 1) next();
});

// -- respond to control events from the mini-player (or anywhere else) ------

window.addEventListener('player:toggle', toggle);
window.addEventListener('player:next', next);
window.addEventListener('player:prev', prev);
window.addEventListener('player:play', (e) => playTrack(e.detail && e.detail.track, e.detail && e.detail.queue));
