/* Local persistence.
 *
 * Everything lives on the device: playlists, likes, imported files, and the
 * bytes of anything saved for offline. There is no server, no account, and
 * nothing to sign in to — which is also why nobody can region-lock it. */

const DB_NAME = 'void-music';
const DB_VERSION = 3;

const STORES = {
  playlists: { keyPath: 'id' },
  likes:     { keyPath: 'id' },
  offline:   { keyPath: 'id' },   // { id, track, blob, savedAt, bytes }
  local:     { keyPath: 'id' },   // imported files: { id, track, blob }
  settings:  { keyPath: 'key' },
  recent:    { keyPath: 'id' },   // recently played items
  covers:    { keyPath: 'key' },  // resolved artwork: { key, url, at }
  listens:   { keyPath: 'id' },   // scrobbles waiting to be submitted
};

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, opts] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, opts);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked by another tab'));
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const get     = (store, key)  => tx(store, 'readonly',  (s) => s.get(key));
const getAll  = (store)       => tx(store, 'readonly',  (s) => s.getAll());
const put     = (store, val)  => tx(store, 'readwrite', (s) => s.put(val));
const del     = (store, key)  => tx(store, 'readwrite', (s) => s.delete(key));
const clear   = (store)       => tx(store, 'readwrite', (s) => s.clear());
const count   = (store)       => tx(store, 'readonly',  (s) => s.count());

/* ── Settings ──────────────────────────────────────────────────────── */

const DEFAULTS = {
  volume: 1,
  muted: false,
  repeat: 'off',
  shuffle: false,
  preferLowBitrate: false,
  autoOfflineLiked: false,
  mirrors: '',
  theme: 'system',
  amoled: false,
  crossfade: 0,
  scrobbleToken: '',
  scrobbleEnabled: false,
  lastRoute: '#/home',
};

let settingsCache = null;

export async function loadSettings() {
  if (settingsCache) return settingsCache;
  settingsCache = { ...DEFAULTS };
  try {
    for (const row of await getAll('settings')) {
      if (row && row.key in DEFAULTS) settingsCache[row.key] = row.value;
    }
  } catch {
    // Private-browsing modes can refuse IndexedDB entirely; defaults still work.
  }
  return settingsCache;
}

export async function setSetting(key, value) {
  if (settingsCache) settingsCache[key] = value;
  try {
    await put('settings', { key, value });
  } catch { /* non-fatal */ }
}

export function getSetting(key) {
  return (settingsCache ?? DEFAULTS)[key];
}

/* ── Likes ─────────────────────────────────────────────────────────── */

export const likes = {
  async all() {
    const rows = await getAll('likes').catch(() => []);
    return rows.sort((a, b) => b.likedAt - a.likedAt).map((r) => r.track);
  },
  async has(id) {
    return Boolean(await get('likes', id).catch(() => null));
  },
  async add(track) {
    await put('likes', { id: track.id, track, likedAt: Date.now() });
  },
  remove(id) {
    return del('likes', id);
  },
  async toggle(track) {
    if (await this.has(track.id)) {
      await this.remove(track.id);
      return false;
    }
    await this.add(track);
    return true;
  },
  count: () => count('likes').catch(() => 0),
};

/* ── Playlists ─────────────────────────────────────────────────────── */

const newId = () => `pl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export const playlists = {
  async all() {
    const rows = await getAll('playlists').catch(() => []);
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  },
  get: (id) => get('playlists', id),
  async create(name) {
    const pl = { id: newId(), name: name.trim() || 'New playlist', tracks: [], createdAt: Date.now(), updatedAt: Date.now() };
    await put('playlists', pl);
    return pl;
  },
  async rename(id, name) {
    const pl = await get('playlists', id);
    if (!pl) return null;
    pl.name = name.trim() || pl.name;
    pl.updatedAt = Date.now();
    await put('playlists', pl);
    return pl;
  },
  async addTrack(id, track) {
    const pl = await get('playlists', id);
    if (!pl) return null;
    if (!pl.tracks.some((t) => t.id === track.id)) pl.tracks.push(track);
    pl.updatedAt = Date.now();
    await put('playlists', pl);
    return pl;
  },
  async addTracks(id, tracks) {
    const pl = await get('playlists', id);
    if (!pl) return null;
    for (const track of tracks) {
      if (!pl.tracks.some((t) => t.id === track.id)) pl.tracks.push(track);
    }
    pl.updatedAt = Date.now();
    await put('playlists', pl);
    return pl;
  },
  async removeTrack(id, trackId) {
    const pl = await get('playlists', id);
    if (!pl) return null;
    pl.tracks = pl.tracks.filter((t) => t.id !== trackId);
    pl.updatedAt = Date.now();
    await put('playlists', pl);
    return pl;
  },
  remove: (id) => del('playlists', id),
};

/* ── Offline copies ────────────────────────────────────────────────── */

export const offline = {
  async has(id) {
    return Boolean(await get('offline', id).catch(() => null));
  },
  async ids() {
    const rows = await getAll('offline').catch(() => []);
    return new Set(rows.map((r) => r.id));
  },
  async all() {
    const rows = await getAll('offline').catch(() => []);
    return rows.sort((a, b) => b.savedAt - a.savedAt).map((r) => r.track);
  },
  async save(track, blob) {
    await put('offline', { id: track.id, track, blob, bytes: blob.size, savedAt: Date.now() });
  },
  async blob(id) {
    const row = await get('offline', id).catch(() => null);
    return row?.blob ?? null;
  },
  remove: (id) => del('offline', id),
  clear: () => clear('offline'),
  async bytes() {
    const rows = await getAll('offline').catch(() => []);
    return rows.reduce((n, r) => n + (r.bytes || 0), 0);
  },
  count: () => count('offline').catch(() => 0),
};

/* ── Imported local files ──────────────────────────────────────────── */

/**
 * Embedded artwork is kept as a blob, not a data URL: a 400-song import would
 * otherwise carry tens of megabytes of base64 around in memory. Object URLs
 * are minted once per track and reused for the life of the page.
 */
const coverUrls = new Map();

function coverUrlFor(id, blob) {
  if (!coverUrls.has(id)) coverUrls.set(id, URL.createObjectURL(blob));
  return coverUrls.get(id);
}

function dropCoverUrl(id) {
  const url = coverUrls.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    coverUrls.delete(id);
  }
}

export const local = {
  async all() {
    const rows = await getAll('local').catch(() => []);
    rows.sort((a, b) => {
      const artist = (a.track.artist || '').localeCompare(b.track.artist || '');
      if (artist) return artist;
      const album = (a.track.album || '').localeCompare(b.track.album || '');
      if (album) return album;
      const no = (a.track.trackNo || 0) - (b.track.trackNo || 0);
      return no || (a.track.title || '').localeCompare(b.track.title || '');
    });
    return rows.map((r) => (r.cover
      ? { ...r.track, cover: coverUrlFor(r.id, r.cover) }
      : r.track));
  },
  async has(id) {
    return Boolean(await get('local', id).catch(() => null));
  },
  async ids() {
    const rows = await getAll('local').catch(() => []);
    return new Set(rows.map((r) => r.id));
  },
  async add(track, blob, cover = null) {
    await put('local', { id: track.id, track, blob, cover, addedAt: Date.now() });
  },
  async blob(id) {
    const row = await get('local', id).catch(() => null);
    return row?.blob ?? null;
  },
  async remove(id) {
    dropCoverUrl(id);
    return del('local', id);
  },
  async clear() {
    for (const id of [...coverUrls.keys()]) dropCoverUrl(id);
    return clear('local');
  },
  count: () => count('local').catch(() => 0),
};

/* ── Recently played ───────────────────────────────────────────────── */

export const recent = {
  async all(limit = 12) {
    const rows = await getAll('recent').catch(() => []);
    return rows.sort((a, b) => b.at - a.at).slice(0, limit);
  },
  async push(item) {
    await put('recent', { id: item.id, title: item.title, creator: item.creator, cover: item.cover, at: Date.now() });
    // Keep the list from growing without bound.
    const rows = await getAll('recent').catch(() => []);
    if (rows.length > 40) {
      const stale = rows.sort((a, b) => b.at - a.at).slice(40);
      await Promise.all(stale.map((r) => del('recent', r.id)));
    }
  },
  clear: () => clear('recent'),
};

/* ── Resolved cover art ────────────────────────────────────────────── */

/**
 * Artwork looked up from outside the Archive. Misses are cached too — a
 * recording with no art anywhere must not be re-queried on every scroll.
 */
export const covers = {
  async get(key) {
    const row = await get('covers', key).catch(() => null);
    if (!row) return undefined;             // never looked up
    return row.url || null;                 // null = looked up, nothing found
  },
  async set(key, url) {
    await put('covers', { key, url: url || '', at: Date.now() }).catch(() => {});
  },
  count: () => count('covers').catch(() => 0),
  clear: () => clear('covers'),
};

/* ── Pending scrobbles ─────────────────────────────────────────────── */

/**
 * Listens that could not be submitted yet. Being offline is the normal case
 * for this app, not the exception, so a listen is written down first and sent
 * when the network comes back.
 */
export const listens = {
  async all() {
    const rows = await getAll('listens').catch(() => []);
    return rows.sort((a, b) => a.listened_at - b.listened_at);
  },
  async add(entry) {
    await put('listens', entry).catch(() => {});
  },
  remove: (id) => del('listens', id).catch(() => {}),
  count: () => count('listens').catch(() => 0),
  clear: () => clear('listens'),
};

/** Storage pressure, for the Settings panel. */
export async function usage() {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage: used, quota } = await navigator.storage.estimate();
    return { used: used || 0, quota: quota || 0 };
  } catch {
    return null;
  }
}

/** Ask the browser not to evict us under pressure. */
export async function persist() {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function wipeAll() {
  await Promise.all(Object.keys(STORES).map((s) => clear(s).catch(() => {})));
  settingsCache = null;
}
