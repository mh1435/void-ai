// Jamendo API client — Creative Commons licensed music, no auth required
// beyond a free client_id (https://www.jamendo.com/admin/applications).
// The key is never bundled: it lives only in this browser's localStorage,
// pasted in via Settings, so the app functions (on the Internet Archive
// catalog alone) without it.

import { getJamendoKey } from './store.js';

const JAMENDO_BASE = 'https://api.jamendo.com/v3.0';

export function isConfigured() {
  return getJamendoKey().length > 0;
}

export async function jamendoRequest(endpoint, params = {}) {
  const clientId = getJamendoKey();
  if (!clientId) throw new Error('No Jamendo API key configured');

  const url = new URL(`${JAMENDO_BASE}/${endpoint}`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('format', 'json');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Jamendo ${res.status}`);
  const data = await res.json();
  return data.results || [];
}

export async function getJamendoTracks(limit = 20, offset = 0, order = 'popularity_total') {
  return jamendoRequest('tracks', {
    limit, offset, order,
    include: 'musicinfo+stats',
    audioformat: 'mp32',
  });
}

export async function searchJamendo(query, limit = 20) {
  return jamendoRequest('tracks', { search: query, limit, order: 'relevance' });
}

export async function getJamendoAlbums(limit = 20) {
  return jamendoRequest('albums', { limit, order: 'popularity_total' });
}

export async function getJamendoPlaylists(limit = 20) {
  return jamendoRequest('playlists', { limit, order: 'popularity_total' });
}

export async function getJamendoArtists(query, limit = 6) {
  return jamendoRequest('artists', { namesearch: query, limit });
}

// Jamendo dates come back as "YYYY-MM-DD"; pull the year out, or null if the
// field is missing rather than guessing.
function parseYear(dateStr) {
  const m = /^(\d{4})/.exec(dateStr || '');
  return m ? parseInt(m[1], 10) : null;
}

// Convert a Jamendo track into Void's internal track shape.
export function normalizeJamendoTrack(t) {
  return {
    id: `jamendo-${t.id}`,
    kind: 'track',
    title: t.name,
    artist: t.artist_name,
    album: t.album_name || 'Single',
    duration: t.duration,
    url: t.audio,
    artwork: t.image || t.album_image || '',
    source: 'jamendo',
    license: t.license_ccurl || 'CC-BY',
    flac: false,
    year: parseYear(t.releasedate),
  };
}

export function normalizeJamendoAlbum(a) {
  return {
    id: `album-${a.id}`,
    kind: 'album',
    title: a.name,
    artist: a.artist_name,
    artwork: a.image || '',
    year: parseYear(a.releasedate),
  };
}

export function normalizeJamendoPlaylist(p) {
  return {
    id: `playlist-${p.id}`,
    kind: 'playlist',
    title: p.name,
    artist: 'Playlist',
    artwork: p.image || p.user_image || '',
  };
}

export function normalizeJamendoArtist(a) {
  return {
    id: `artist-${a.id}`,
    name: a.name,
    image: a.image || '',
  };
}
