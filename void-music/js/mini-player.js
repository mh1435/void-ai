// Wires the persistent mini-player bar to the player engine's events.

import * as player from './player.js';
import { isLiked, toggleLiked } from './store.js';
import { toast } from './toast.js';

const miniPlayer = document.getElementById('mini-player');
const miniArt = document.getElementById('mini-art');
const miniTitle = document.getElementById('mini-title');
const miniArtist = document.getElementById('mini-artist');
const miniPlay = document.getElementById('mini-play');
const miniNext = document.getElementById('mini-next');
const miniLike = document.getElementById('mini-like');
const miniProgress = document.getElementById('mini-progress-bar');
const miniInfo = document.getElementById('mini-info');

const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

function updateMiniPlayer(track) {
  if (!track) return;
  miniPlayer.classList.remove('hidden');
  miniTitle.textContent = track.title || 'Unknown';
  miniArtist.textContent = track.artist || 'Unknown artist';
  miniArt.src = track.artwork || '/assets/default-art.svg';
  miniArt.onerror = () => { miniArt.onerror = null; miniArt.src = '/assets/default-art.svg'; };
  miniLike.classList.toggle('liked', isLiked(track.id));
}

function updateMiniProgress(current, duration) {
  miniProgress.style.width = duration > 0 ? `${(current / duration) * 100}%` : '0%';
}

function setPlayIcon(playing) {
  miniPlay.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
}

miniPlay.addEventListener('click', () => player.toggle());
miniNext.addEventListener('click', () => player.next());
miniLike.addEventListener('click', () => {
  const track = player.getCurrentTrack();
  if (!track) return;
  const nowLiked = toggleLiked(track);
  miniLike.classList.toggle('liked', nowLiked);
  toast(nowLiked ? 'Added to Liked' : 'Removed from Liked');
});
miniInfo.addEventListener('click', () => {
  // A tap on the title/artist area is a lightweight "now playing" affordance:
  // scroll the mini-player into view (useful once a queue/full-player exists).
  miniPlayer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

window.addEventListener('trackchange', (e) => updateMiniPlayer(e.detail));
window.addEventListener('timeupdate', (e) => updateMiniProgress(e.detail.current, e.detail.duration));
window.addEventListener('playstate', (e) => setPlayIcon(e.detail.playing));

// Restore state if a track is already loaded (e.g. hot module reload in dev).
const existing = player.getCurrentTrack();
if (existing) updateMiniPlayer(existing);
setPlayIcon(player.isPlaying());
