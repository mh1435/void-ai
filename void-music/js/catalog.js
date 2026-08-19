// Unified catalog: merges the always-available Internet Archive source with
// Jamendo once a user has pasted in their own free API key.

import { getArchiveNewReleases, searchArchive } from './archive.js';
import {
  isConfigured as jamendoConfigured,
  getJamendoTracks, searchJamendo, getJamendoAlbums, getJamendoPlaylists,
  normalizeJamendoTrack, normalizeJamendoAlbum, normalizeJamendoPlaylist,
} from './jamendo.js';
import { registerTracks } from './store.js';

// Catalog quality bar: no track/album older than this, and none missing
// cover art — both look broken in a card-based UI, and old, uncovered
// archive uploads are disproportionately mislabeled junk. Playlists are
// curated collections rather than a single era, so they're exempt.
const MIN_YEAR = 2005;

function passesQualityBar(item) {
  if (item.kind === 'playlist') return true;
  if (!item.artwork) return false;
  if (typeof item.year === 'number' && item.year < MIN_YEAR) return false;
  return true;
}

function shuffle(arr) {
  return arr
    .map((v) => [Math.random(), v])
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
}

export async function getHomeCatalog() {
  const wantsJamendo = jamendoConfigured();
  // Over-fetch: the quality bar above drops a chunk of raw results, so
  // asking for exactly what we want to display would leave Home sparse.
  const OVERFETCH = 2;

  const [archiveItems, jamendoTracks] = await Promise.allSettled([
    getArchiveNewReleases(10 * OVERFETCH),
    wantsJamendo ? getJamendoTracks(10 * OVERFETCH) : Promise.resolve([]),
  ]);

  const newReleases = [];
  if (archiveItems.status === 'fulfilled') newReleases.push(...archiveItems.value);
  if (jamendoTracks.status === 'fulfilled') {
    newReleases.push(...jamendoTracks.value.map(normalizeJamendoTrack));
  }

  let playlists = [];
  let topAlbums = [];
  if (wantsJamendo) {
    const [pl, al] = await Promise.allSettled([
      getJamendoPlaylists(10),
      getJamendoAlbums(8 * OVERFETCH),
    ]);
    if (pl.status === 'fulfilled') playlists = pl.value.map(normalizeJamendoPlaylist).filter(passesQualityBar);
    if (al.status === 'fulfilled') {
      topAlbums = al.value.map(normalizeJamendoAlbum).filter(passesQualityBar).slice(0, 8);
    }
  }

  const shuffled = shuffle(newReleases.filter(passesQualityBar)).slice(0, 10);
  registerTracks(shuffled);

  return { newReleases: shuffled, playlists, topAlbums, jamendoConfigured: wantsJamendo };
}

export async function searchCatalog(query, limit = 15) {
  const wantsJamendo = jamendoConfigured();
  const overLimit = limit * 2;

  const [archiveResults, jamendoResults] = await Promise.allSettled([
    searchArchive(query, overLimit),
    wantsJamendo ? searchJamendo(query, overLimit) : Promise.resolve([]),
  ]);

  const songs = [];
  if (jamendoResults.status === 'fulfilled') songs.push(...jamendoResults.value.map(normalizeJamendoTrack));
  if (archiveResults.status === 'fulfilled') songs.push(...archiveResults.value);

  const filtered = songs.filter(passesQualityBar).slice(0, limit);
  registerTracks(filtered);

  const artists = [...new Set(filtered.map((s) => s.artist).filter(Boolean))]
    .slice(0, 8)
    .map((name) => ({ name, image: filtered.find((s) => s.artist === name)?.artwork || '' }));

  return { songs: filtered, artists };
}
