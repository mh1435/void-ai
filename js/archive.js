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

/* Internet Archive client.
 *
 * Everything the app streams comes from archive.org's open collections:
 * public-domain recordings, Creative Commons netlabels, and artist-authorised
 * live-music trading (etree). No login, no ads, no subscription — because the
 * material is genuinely free to stream, not because we routed around a paywall.
 *
 * archive.org itself is reachable from most networks, but if a user's ISP
 * blocks it they can point `mirrors` at their own reverse proxy in Settings and
 * every request follows. */

import { raceHosts, requestJSON, request, diag } from './net.js';
import * as B from './backend.js';

const DEFAULT_BASE = 'https://archive.org';

/** Extra bases tried in parallel with the default; set from Settings. */
export const config = {
  mirrors: [],
  /** Prefer smaller files on metered/slow links. */
  preferLowBitrate: false,
};

/**
 * Every host this module will ask for metadata, best first.
 *
 * A self-hosted backend is not just another mirror: in exclusive mode it
 * replaces the direct route entirely, so a device on a filtered network never
 * emits a request to a host that network is filtering.
 */
function bases() {
  const direct = [...config.mirrors.filter(Boolean), DEFAULT_BASE];
  if (!B.active()) return direct;
  const proxied = B.origin('archive.org');
  return B.backend.only ? [proxied] : [proxied, ...direct];
}

function urlsFor(path) {
  return bases().map((b) => B.sign(b.replace(/\/+$/, '') + path));
}

/* ── Curated entry points ──────────────────────────────────────────── */

export const COLLECTIONS = [
  {
    id: 'netlabels',
    name: 'Netlabels',
    blurb: 'Creative Commons electronic, ambient and indie releases',
    glyph: '◈',
    c1: '#4b2a7a', c2: '#1e2a52',
  },
  {
    id: 'etree',
    name: 'Live Concerts',
    blurb: 'Artist-authorised live recordings, taped and traded legally',
    glyph: '♬',
    c1: '#7a3a52', c2: '#2a1e46',
  },
  {
    id: 'georgeblood',
    name: '78 RPM Archive',
    blurb: 'Digitised 78s — jazz, blues and early pop, public domain',
    glyph: '◎',
    c1: '#6a4a24', c2: '#2e2418',
  },
  {
    id: 'audio_music',
    name: 'Open Music',
    blurb: 'The Archive‑wide music pool, freely licensed',
    glyph: '♫',
    c1: '#2a5a6a', c2: '#182838',
  },
  {
    id: 'classicalmusicarchive',
    name: 'Classical',
    blurb: 'Orchestral and chamber recordings in the public domain',
    glyph: '𝄞',
    c1: '#3a4a7a', c2: '#1c2036',
  },
  {
    id: 'audio_field_recordings',
    name: 'Field Recordings',
    blurb: 'Folk, traditional and location recordings from around the world',
    glyph: '◍',
    c1: '#2e6a4a', c2: '#182e26',
  },
];

/* ── Search ────────────────────────────────────────────────────────── */

/** Escape Lucene syntax so a user's punctuation can't break the query. */
function escapeLucene(s) {
  return String(s).replace(/([+\-!(){}[\]^"~*?:\\/]|&&|\|\|)/g, '\\$1').trim();
}

/**
 * Audio on the Archive is far more than music: audiobooks, sermons, lectures,
 * scanner traffic and news all carry mediatype:audio. Without this list a
 * search for a song title returns mostly talking.
 */
const NON_MUSIC_COLLECTIONS = [
  'librivoxaudio', 'oldtimeradio', 'audio_bookspoetry', 'audio_news',
  'audio_religion', 'audio_political', 'radioprograms', 'podcasts',
  'samples_only', 'audio_tech', 'gratefuldead_covers_only', 'gdlivetapes',
];

function buildQuery({ query, collection, creator, musicOnly = true }) {
  const parts = ['mediatype:(audio)'];
  if (collection) parts.push(`collection:(${escapeLucene(collection)})`);

  // An artist page wants only that artist's records, not everything mentioning
  // them, so creator is matched on its own rather than OR'd with the title.
  if (creator) parts.push(`creator:("${escapeLucene(creator)}")`);

  if (query) {
    const q = escapeLucene(query);
    // Title and creator are what people actually search for; description
    // matches drag in anything that merely name-drops the artist.
    parts.push(`(title:(${q}) OR creator:(${q}))`);
  }

  if (musicOnly) {
    // Require a browser-playable derivative. This alone removes most of the
    // junk: text-only items, video rips and lossless-only uploads.
    parts.push('format:(MP3)');
    for (const c of NON_MUSIC_COLLECTIONS) parts.push(`-collection:(${c})`);
  }
  return parts.join(' AND ');
}

/**
 * Search the Archive. Returns { total, items:[{id,title,creator,year,downloads}] }.
 */
export async function search({ query = '', collection = '', creator = '', page = 1, rows = 48, signal } = {}) {
  const params = new URLSearchParams();
  params.set('q', buildQuery({ query, collection, creator }));
  for (const f of ['identifier', 'title', 'creator', 'year', 'downloads', 'item_size']) {
    params.append('fl[]', f);
  }
  params.set('sort[]', query ? 'downloads desc' : 'week desc');
  params.set('rows', String(rows));
  params.set('page', String(page));
  params.set('output', 'json');

  const path = `/advancedsearch.php?${params}`;

  let data;
  try {
    data = await raceHosts(urlsFor(path), { timeout: 14000, signal, label: `search "${query || collection}"` });
  } catch (err) {
    // advancedsearch.php is occasionally rate-limited; the scrape service is a
    // separate code path on the same host and often still answers.
    diag.log('warn', `advancedsearch failed (${err.message}); trying scrape API`);
    return searchViaScrape({ query, collection, rows, signal });
  }

  const docs = data?.response?.docs;
  if (!Array.isArray(docs)) throw new Error('Unexpected search response shape');

  return {
    total: Number(data.response.numFound) || docs.length,
    page,
    items: docs.map(normaliseDoc),
  };
}

async function searchViaScrape({ query, collection, rows, signal }) {
  const params = new URLSearchParams({
    q: buildQuery({ query, collection }),
    fields: 'identifier,title,creator,year,downloads',
    count: String(Math.min(rows, 100)),
  });
  const data = await raceHosts(urlsFor(`/services/search/v1/scrape?${params}`), {
    timeout: 14000, signal, label: 'search (scrape)',
  });
  const items = data?.items;
  if (!Array.isArray(items)) throw new Error('Unexpected scrape response shape');
  return { total: Number(data.total) || items.length, page: 1, items: items.map(normaliseDoc) };
}

function normaliseDoc(d) {
  return {
    id: d.identifier,
    title: cleanText(firstOf(d.title)) || d.identifier,
    creator: cleanText(firstOf(d.creator)) || 'Unknown artist',
    year: firstOf(d.year) || '',
    downloads: Number(d.downloads) || 0,
    // No cover from the search index on purpose. The only artwork available
    // for an identifier alone is __ia_thumb.jpg, which for an audio item is
    // rendered from its waveform — so it is never the record's cover. Leaving
    // this null hands the job to the artwork lookup, which finds the real one.
    cover: null,
  };
}

/* ── Item metadata → playable tracks ───────────────────────────────── */

/** Formats a browser can realistically play, best first. */
const AUDIO_FORMATS = [
  { match: /^VBR MP3$/i,              ext: 'mp3',  rank: 1,  mime: 'audio/mpeg' },
  { match: /^(\d+)Kbps MP3$/i,        ext: 'mp3',  rank: 2,  mime: 'audio/mpeg' },
  { match: /^MP3$/i,                  ext: 'mp3',  rank: 3,  mime: 'audio/mpeg' },
  { match: /^Ogg Vorbis$/i,           ext: 'ogg',  rank: 4,  mime: 'audio/ogg' },
  { match: /^(MPEG-4 Audio|M4A|AAC)$/i, ext: 'm4a', rank: 5, mime: 'audio/mp4' },
  { match: /^(Flac|24bit Flac)$/i,    ext: 'flac', rank: 8,  mime: 'audio/flac' },
  { match: /^(WAVE|AIFF)$/i,          ext: 'wav',  rank: 9,  mime: 'audio/wav' },
];

function formatInfo(fmt) {
  if (!fmt) return null;
  for (const f of AUDIO_FORMATS) {
    const m = String(fmt).match(f.match);
    if (m) {
      // Rank bitrate variants against each other: prefer higher unless the
      // user asked to save data.
      let rank = f.rank;
      if (m[1] && /Kbps/i.test(fmt)) {
        const kbps = Number(m[1]);
        rank = config.preferLowBitrate ? f.rank + kbps / 1000 : f.rank + (320 - Math.min(kbps, 320)) / 1000;
      }
      return { ...f, rank };
    }
  }
  return null;
}

/** IA's `length` is either seconds ("245.67") or clock time ("4:05"). */
export function parseDuration(len) {
  if (len == null) return 0;
  const s = String(len).trim();
  if (!s) return 0;
  if (s.includes(':')) {
    return s.split(':').reduce((acc, p) => acc * 60 + (parseFloat(p) || 0), 0);
  }
  return parseFloat(s) || 0;
}

function firstOf(v) {
  return Array.isArray(v) ? v[0] : v;
}

function cleanText(s) {
  if (s == null) return '';
  return String(s).replace(/\s+/g, ' ').trim();
}

function baseName(name) {
  return String(name).replace(/\.[^./]+$/, '');
}

function trackNumber(t) {
  if (t == null) return null;
  // Values look like "7", "07", or "7/12".
  const m = String(t).match(/^\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

const IMAGE_RE = /\.(jpe?g|png|webp|gif)$/i;

/**
 * Is this image a picture of the sound rather than a picture of the record?
 *
 * The Archive renders a waveform PNG and a spectrogram for every audio upload,
 * and derives __ia_thumb.jpg from them. They are images, they sit in the file
 * list next to real artwork, and they look like grey static — so treating any
 * image as a cover fills the app with identical squiggles AND suppresses the
 * fallback lookup, because the code thinks it already found a cover.
 */
function isGeneratedImage(file) {
  const name = String(file.name).toLowerCase();
  if (/(spectrogram|waveform|__ia_thumb|_thumb\.)/.test(name)) return true;

  // A derivative produced *from* an audio file is a visualisation of it.
  if (file.original && /\.(mp3|flac|ogg|wav|m4a|aiff?|shn|ape)$/i.test(file.original)) return true;

  // Real artwork is uploaded, not generated — unless it names itself a cover.
  if (file.source === 'derivative' && !/(cover|front|folder|album|artwork|sleeve)/.test(name)) {
    return true;
  }
  return false;
}

/** Rank an item's image files so the front cover wins over a disc scan. */
function coverScore(file) {
  const name = String(file.name).toLowerCase();
  let score = 0;
  if (/(cover|front|folder|album|artwork|sleeve)/.test(name)) score += 40;
  if (/(back|disc|cd\d|label|inside|tray|booklet|liner|spine)/.test(name)) score -= 25;
  if (file.format === 'Item Tile') score += 30;
  if (name.includes('__ia_thumb')) score += 5;
  // Thumbnails are tiny; prefer something worth looking at full-screen.
  const size = Number(file.size) || 0;
  if (size > 40000) score += 8;
  else if (size < 6000) score -= 8;
  return score;
}

/**
 * Real artwork embedded in the item, if any. Many Archive audio items — live
 * concert tapes especially — genuinely have none, and saying so is better than
 * showing a placeholder that looks like a broken image.
 */
function pickCover(meta) {
  const files = Array.isArray(meta.files) ? meta.files : [];
  const images = files.filter((f) =>
    f?.name && f.source !== 'metadata' && IMAGE_RE.test(f.name) && !isGeneratedImage(f));
  if (!images.length) return null;   // null lets the artwork lookup take over
  images.sort((a, b) => coverScore(b) - coverScore(a));
  return streamUrls(meta, images[0].name)[0] || null;
}

/**
 * Build every URL that can serve a given file, fastest first.
 *
 * `d1`/`d2` are the two datanodes holding the item; hitting them directly
 * skips archive.org's redirect hop, and having both means a dead node costs
 * one failed request instead of the whole track.
 */
function streamUrls(meta, fileName) {
  const enc = String(fileName).split('/').map(encodeURIComponent).join('/');
  const dir = (meta.dir || '').replace(/^\/+|\/+$/g, '');
  const urls = [];
  for (const host of [meta.server, meta.d1, meta.d2]) {
    if (host && dir) urls.push(`https://${host}/${dir}/${enc}`);
  }
  for (const b of bases()) {
    urls.push(`${b.replace(/\/+$/, '')}/download/${encodeURIComponent(meta.identifier)}/${enc}`);
  }
  // The datanodes above are archive.org hosts too, so they are blocked
  // wherever it is; B.route() sends them through the server as well.
  return [...new Set(B.route([...new Set(urls)]).map(B.sign))];
}

/**
 * Fetch an item and turn its file list into playable tracks.
 */
export async function getItem(identifier, { signal } = {}) {
  const meta = await raceHosts(urlsFor(`/metadata/${encodeURIComponent(identifier)}`), {
    timeout: 15000, signal, label: `metadata ${identifier}`,
  });

  if (!meta || typeof meta !== 'object') throw new Error('Empty metadata response');
  if (meta.is_dark) throw new Error('This item is no longer publicly available');

  const files = Array.isArray(meta.files) ? meta.files : [];
  const md = meta.metadata || {};
  meta.identifier = md.identifier || identifier;

  // One logical track can exist in several formats; keep the best of each.
  const groups = new Map();
  for (const f of files) {
    if (!f?.name || f.source === 'metadata') continue;
    const info = formatInfo(f.format);
    if (!info) continue;

    const key = baseName(f.original || f.name).toLowerCase();
    const existing = groups.get(key);
    if (!existing || info.rank < existing.info.rank) {
      groups.set(key, { file: f, info });
    }
  }

  const albumArtist = cleanText(firstOf(md.creator)) || 'Unknown artist';
  const albumTitle = cleanText(firstOf(md.title)) || identifier;
  // null when the item genuinely ships no artwork, so the UI can draw its own
  // tile instead of the Archive's generic waveform placeholder.
  const cover = pickCover(meta);

  const tracks = [...groups.values()].map(({ file, info }, i) => {
    const num = trackNumber(file.track);
    return {
      id: `${meta.identifier}::${file.name}`,
      itemId: meta.identifier,
      file: file.name,
      title: cleanText(file.title) || baseName(file.name).replace(/[_-]+/g, ' '),
      artist: cleanText(file.artist || file.creator) || albumArtist,
      album: cleanText(file.album) || albumTitle,
      duration: parseDuration(file.length),
      size: Number(file.size) || 0,
      mime: info.mime,
      ext: info.ext,
      trackNo: num ?? i + 1,
      cover,
      urls: streamUrls(meta, file.name),
      source: 'archive',
    };
  });

  tracks.sort((a, b) => a.trackNo - b.trackNo || a.file.localeCompare(b.file));
  tracks.forEach((t, i) => { t.index = i; });

  if (!tracks.length) {
    throw new Error('No streamable audio in this item');
  }

  return {
    id: meta.identifier,
    title: albumTitle,
    creator: albumArtist,
    year: cleanText(firstOf(md.year || md.date)) || '',
    description: stripHtml(firstOf(md.description) || ''),
    licence: cleanText(firstOf(md.licenseurl) || ''),
    collections: [].concat(md.collection || []).filter(Boolean),
    cover,
    pageUrl: `${DEFAULT_BASE}/details/${encodeURIComponent(meta.identifier)}`,
    tracks,
  };
}

/* ── Song-level search ─────────────────────────────────────────────── */

/** Strip punctuation and case so "Roi" matches "roi." and "ROI". */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** How well a track answers the query. Higher is better; 0 means "not this". */
function scoreTrack(track, qNorm, qTerms) {
  const title = norm(track.title);
  const artist = norm(track.artist);
  if (!title) return 0;

  let score = 0;
  if (title === qNorm) score += 100;
  else if (title.startsWith(qNorm)) score += 70;
  else if (title.includes(qNorm)) score += 55;

  // Searching an artist must surface that artist's songs, so a full name match
  // on its own has to clear the relevance floor by itself.
  if (artist === qNorm) score += 60;
  else if (artist.includes(qNorm)) score += 40;

  const inTitle = qTerms.filter((w) => title.includes(w)).length;
  const inArtist = qTerms.filter((w) => artist.includes(w)).length;
  score += (inTitle / qTerms.length) * 30;
  score += (inArtist / qTerms.length) * 12;

  // A song is usually minutes, not seconds or an hour-long concert file.
  if (track.duration > 45 && track.duration < 900) score += 8;
  else if (track.duration > 2400) score -= 10;

  return score;
}

/** Run `fn` over `list` with bounded concurrency. */
async function mapLimit(list, limit, fn) {
  const queue = [...list];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Search for individual songs.
 *
 * The Archive's index only describes items (albums, concerts, compilations),
 * not the tracks inside them — which is why a plain search hands back a wall of
 * collections rather than the song someone asked for. So: find the most likely
 * items, read their file lists, and rank the actual tracks.
 *
 * `onPartial` is called as results firm up, so the list fills in instead of
 * making the user stare at a spinner until every item has been read.
 */
export async function searchSongs({ query, signal, itemLimit = 12, limit = 40, onPartial } = {}) {
  if (!query?.trim()) return [];

  const { items } = await search({ query, rows: itemLimit, signal });
  const qNorm = norm(query);
  const qTerms = qNorm.split(' ').filter(Boolean);
  if (!qTerms.length) return [];

  const found = [];
  const seen = new Set();

  await mapLimit(items, 4, async (item) => {
    if (signal?.aborted) return;

    let full;
    try {
      full = await getItem(item.id, { signal });
    } catch {
      return; // one unreadable item must not sink the whole search
    }

    // Live concert tapes dominate the Archive and rarely carry artwork, so
    // nudge them below studio releases. They still show up, just not first.
    const isLiveTape = full.collections?.some((c) => /^(etree|gdlive|stream_only)/.test(c));

    const best = full.tracks
      .map((track) => ({ track, score: scoreTrack(track, qNorm, qTerms) - (isLiveTape ? 12 : 0) }))
      .filter((x) => x.score >= 25)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4); // don't let one album flood the results

    for (const { track, score } of best) {
      // The same recording appears across many compilations.
      const key = `${norm(track.title)}|${norm(track.artist)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ ...track, score, albumTitle: full.title });
    }

    found.sort((a, b) => b.score - a.score);
    if (!signal?.aborted) onPartial?.(found.slice(0, limit));
  });

  return found.slice(0, limit);
}

/* ── Artists ───────────────────────────────────────────────────────── */

/** Items with only a handful of tracks read as a single or EP, not an album. */
const EP_MAX_TRACKS = 4;

/**
 * Everything an artist page needs: their records split into albums and
 * singles/EPs, their most-played songs, and a blurb.
 *
 * The Archive has no artist entity — only items with a `creator` field — so an
 * "artist" here is assembled from their items. Track counts require reading
 * each item, which is why this is capped rather than unbounded.
 */
export async function getArtist(name, { signal, max = 14 } = {}) {
  const { items } = await search({ creator: name, rows: max * 3, signal });

  // The index matches creator by token, so asking for "Videoclub" also returns
  // "closed videoclub" and "TOKYO-3 VIDEOCLUB" — different acts that merely
  // share a word. An artist page must be one artist, so keep exact names only.
  const wanted = norm(name);
  const exact = items.filter((i) => norm(i.creator) === wanted);
  const pool = exact.length ? exact : items;

  if (!pool.length) throw new Error(`Nothing found for ${name}`);

  const top = pool.slice(0, max);
  const loaded = [];

  await mapLimit(top, 4, async (item) => {
    if (signal?.aborted) return;
    try {
      loaded.push(await getItem(item.id, { signal }));
    } catch { /* skip unreadable items */ }
  });

  // Preserve the relevance order the search gave us.
  const rank = new Map(top.map((i, idx) => [i.id, idx]));
  loaded.sort((a, b) => (rank.get(a.id) ?? 99) - (rank.get(b.id) ?? 99));

  const albums = loaded.filter((i) => i.tracks.length > EP_MAX_TRACKS);
  const singles = loaded.filter((i) => i.tracks.length <= EP_MAX_TRACKS);

  // "Top songs" = the first tracks of their most prominent releases, so the
  // list opens with recognisable material rather than track 9 of a B-sides set.
  const songs = [];
  const seen = new Set();
  for (const item of loaded) {
    for (const track of item.tracks.slice(0, 3)) {
      const key = `${track.title.toLowerCase()}|${track.artist.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      songs.push(track);
    }
  }

  const withArt = loaded.find((i) => i.cover);
  const withText = loaded.find((i) => i.description && i.description.length > 60);

  return {
    name,
    cover: withArt?.cover || null,
    about: withText?.description || '',
    releaseCount: loaded.length,
    songs: songs.slice(0, 12),
    albums,
    singles,
  };
}

/**
 * Distinct artists among a set of search results, most prominent first.
 * Used for the "Artists" row and the top-result card.
 */
export function artistsFrom(items) {
  const byName = new Map();
  for (const item of items) {
    const name = (item.creator || '').trim();
    if (!name || /^(various|unknown)/i.test(name)) continue;
    const entry = byName.get(name.toLowerCase());
    if (entry) {
      entry.releases++;
      entry.downloads += item.downloads || 0;
      if (!entry.cover) entry.cover = item.cover;
    } else {
      byName.set(name.toLowerCase(), {
        name, releases: 1, downloads: item.downloads || 0, cover: item.cover,
      });
    }
  }
  return [...byName.values()].sort((a, b) => b.releases - a.releases || b.downloads - a.downloads);
}

function stripHtml(html) {
  const el = document.createElement('div');
  el.innerHTML = String(html);
  return cleanText(el.textContent).slice(0, 600);
}

/** Cheap reachability check used by the connection chip. */
export async function ping({ signal } = {}) {
  const started = performance.now();
  await requestJSON(`${bases()[0].replace(/\/+$/, '')}/metadata/nasa`, {
    timeout: 8000, attempts: 1, signal, cache: 'no-store', label: 'ping',
  });
  return Math.round(performance.now() - started);
}

/** Download a track's bytes for offline use, trying each mirror in turn. */
export async function fetchTrackBlob(track, { signal, onProgress } = {}) {
  let lastErr;
  for (const url of track.urls) {
    try {
      const res = await request(url, { attempts: 1, timeout: 45000, signal, label: `download ${track.title}` });
      const total = Number(res.headers.get('content-length')) || track.size || 0;

      if (!res.body || !onProgress) return await res.blob();

      // Stream so the UI can show real progress on a slow link.
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (total) onProgress(received / total);
      }
      return new Blob(chunks, { type: track.mime });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      lastErr = err;
      diag.log('warn', `mirror failed for "${track.title}": ${new URL(url).host}`);
    }
  }
  throw lastErr ?? new Error('All mirrors failed');
}
