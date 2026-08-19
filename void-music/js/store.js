// Shared, dependency-free state: an in-memory track registry (so rendered
// cards only need to carry an id) plus small localStorage-backed lists.

const registry = new Map();

export function registerTrack(track) {
  if (track && track.id) registry.set(track.id, track);
  return track;
}

export function registerTracks(tracks) {
  (tracks || []).forEach(registerTrack);
  return tracks;
}

export function getTrack(id) {
  return registry.get(id) || null;
}

const KEYS = {
  recentSearches: 'void:recentSearches',
  recentlyPlayed: 'void:recentlyPlayed',
  liked: 'void:liked',
  jamendoKey: 'void:jamendoClientId',
  theme: 'void:theme',
};

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full or unavailable — fail silently, nothing here is critical
  }
}

// -- recent searches --------------------------------------------------------

export function getRecentSearches() {
  return readJson(KEYS.recentSearches, []);
}

export function addRecentSearch(entry) {
  const list = getRecentSearches().filter((r) => r.query !== entry.query);
  list.unshift(entry);
  writeJson(KEYS.recentSearches, list.slice(0, 10));
}

export function removeRecentSearch(query) {
  writeJson(KEYS.recentSearches, getRecentSearches().filter((r) => r.query !== query));
}

export function clearRecentSearches() {
  writeJson(KEYS.recentSearches, []);
}

// -- recently played ----------------------------------------------------

export function getRecentlyPlayed() {
  return readJson(KEYS.recentlyPlayed, []);
}

export function addRecentlyPlayed(track) {
  if (!track) return;
  const list = getRecentlyPlayed().filter((t) => t.id !== track.id);
  list.unshift({
    id: track.id, title: track.title, artist: track.artist,
    artwork: track.artwork, source: track.source,
  });
  writeJson(KEYS.recentlyPlayed, list.slice(0, 50));
}

// -- liked ----------------------------------------------------------------

export function getLiked() {
  return readJson(KEYS.liked, []);
}

export function isLiked(id) {
  return getLiked().some((t) => t.id === id);
}

export function toggleLiked(track) {
  const list = getLiked();
  const idx = list.findIndex((t) => t.id === track.id);
  if (idx >= 0) {
    list.splice(idx, 1);
    writeJson(KEYS.liked, list);
    return false;
  }
  list.unshift({
    id: track.id, title: track.title, artist: track.artist,
    artwork: track.artwork, source: track.source,
  });
  writeJson(KEYS.liked, list);
  return true;
}

// -- jamendo key ------------------------------------------------------------

export function getJamendoKey() {
  return localStorage.getItem(KEYS.jamendoKey) || '';
}

export function setJamendoKey(key) {
  if (key) localStorage.setItem(KEYS.jamendoKey, key);
  else localStorage.removeItem(KEYS.jamendoKey);
}

// -- theme --------------------------------------------------------------

export function getTheme() {
  return localStorage.getItem(KEYS.theme) || 'system';
}

export function setTheme(theme) {
  localStorage.setItem(KEYS.theme, theme);
}

// -- storage footprint (for the Sync/Settings "Storage" figures) -----------

export function localStorageFootprintBytes() {
  let bytes = 0;
  for (const key of Object.values(KEYS)) {
    const v = localStorage.getItem(key);
    if (v) bytes += v.length;
  }
  return bytes;
}

export function clearAllLocalData() {
  Object.values(KEYS).forEach((k) => {
    if (k !== KEYS.jamendoKey) localStorage.removeItem(k);
  });
}

export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}
