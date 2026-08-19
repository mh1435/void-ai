// Unified catalog: merges the always-available Internet Archive source with
// Jamendo once a user has pasted in their own free API key.

import { getArchiveNewReleases, searchArchive } from './archive.js';
import {
  isConfigured as jamendoConfigured,
  getJamendoTracks, searchJamendo, getJamendoAlbums, getJamendoPlaylists,
  normalizeJamendoTrack, normalizeJamendoAlbum, normalizeJamendoPlaylist,
} from './jamendo.js';
import { registerTracks } from './store.js';

function shuffle(arr) {
  return arr
    .map((v) => [Math.random(), v])
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
}

export async function getHomeCatalog() {
  const wantsJamendo = jamendoConfigured();

  const [archiveItems, jamendoTracks] = await Promise.allSettled([
    getArchiveNewReleases(10),
    wantsJamendo ? getJamendoTracks(10) : Promise.resolve([]),
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
      getJamendoAlbums(8),
    ]);
    if (pl.status === 'fulfilled') playlists = pl.value.map(normalizeJamendoPlaylist);
    if (al.status === 'fulfilled') topAlbums = al.value.map(normalizeJamendoAlbum);
  }

  const shuffled = shuffle(newReleases);
  registerTracks(shuffled);

  return { newReleases: shuffled, playlists, topAlbums, jamendoConfigured: wantsJamendo };
}

export async function searchCatalog(query, limit = 15) {
  const wantsJamendo = jamendoConfigured();

  const [archiveResults, jamendoResults] = await Promise.allSettled([
    searchArchive(query, limit),
    wantsJamendo ? searchJamendo(query, limit) : Promise.resolve([]),
  ]);

  const songs = [];
  if (jamendoResults.status === 'fulfilled') songs.push(...jamendoResults.value.map(normalizeJamendoTrack));
  if (archiveResults.status === 'fulfilled') songs.push(...archiveResults.value);

  registerTracks(songs);

  const artists = [...new Set(songs.map((s) => s.artist).filter(Boolean))]
    .slice(0, 8)
    .map((name) => ({ name, image: songs.find((s) => s.artist === name)?.artwork || '' }));

  return { songs, artists };
}
