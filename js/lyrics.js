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

/* Lyrics, from LRCLIB.
 *
 * Open, keyless, CORS-enabled and not geo-restricted — the same reasoning that
 * picked the Cover Art Archive for artwork. Results are cached permanently,
 * misses included, so a song with no lyrics anywhere is asked about once.
 *
 * Synced lyrics come back as LRC ("[01:23.45] line"), which gives a current
 * line to show under the transport. When only plain text exists the same view
 * shows it unhighlighted. */

import { covers } from './store.js';
import { diag } from './net.js';

const API = 'https://lrclib.net/api';
const TIMEOUT_MS = 8000;

const memory = new Map();
const inFlight = new Map();
let disabled = false;
let failures = 0;

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip video-rip noise, the same problem artwork lookup has. */
function cleanTitle(title, artist) {
  let t = String(title || '');
  t = t.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
  t = t.replace(
    /\b(clip\s+officiel|official\s+(music\s+)?(video|audio)|lyrics?\s*video|lyric|visualizer|mv|hd|4k|topic)\b/gi,
    ' ',
  );
  const a = norm(artist);
  if (a) {
    const n = norm(t);
    if (n.startsWith(`${a} `)) t = t.slice(t.toLowerCase().indexOf(a) + a.length);
  }
  return t.replace(/[\s\-–—_|]+/g, ' ').trim();
}

/**
 * Parse LRC into timed lines. Returns [] for plain text, which the caller
 * treats as "show it, but don't try to follow along".
 */
export function parseLrc(lrc) {
  if (!lrc) return [];
  const out = [];
  for (const raw of String(lrc).split('\n')) {
    // A line can carry several stamps: "[00:12.00][01:30.00] chorus"
    const stamps = [...raw.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of stamps) {
      const frac = m[3] ? Number(`0.${m[3]}`) : 0;
      out.push({ time: Number(m[1]) * 60 + Number(m[2]) + frac, text });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

async function fetchJSON(url, signal) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  signal?.addEventListener('abort', () => ctl.abort(), { once: true });
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (res.status === 404) return null;          // simply has no lyrics
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Lyrics for a track: { synced: [{time,text}], plain: string } or null.
 * Never throws — lyrics are a bonus, not a requirement.
 */
export async function getLyrics(track, { signal } = {}) {
  if (disabled || !navigator.onLine || !track) return null;

  const artist = String(track.artist || '').replace(/\([^)]*\)/g, ' ').trim();
  const title = cleanTitle(track.title, artist);
  if (!artist || !title || /^(unknown|various)/i.test(artist)) return null;

  const key = `lrc|${norm(artist)}|${norm(title)}`;
  if (memory.has(key)) return memory.get(key);
  if (inFlight.has(key)) return inFlight.get(key);

  const stored = await covers.get(key);
  if (stored !== undefined) {
    const parsed = stored ? JSON.parse(stored) : null;
    memory.set(key, parsed);
    return parsed;
  }

  const job = (async () => {
    let result = null;
    try {
      const params = new URLSearchParams({ artist_name: artist, track_name: title });
      if (track.album) params.set('album_name', track.album);
      if (track.duration) params.set('duration', String(Math.round(track.duration)));

      let data = await fetchJSON(`${API}/get?${params}`, signal);

      // The exact-match endpoint is strict about duration and album; a search
      // still finds the song when those differ from the Archive's metadata.
      if (!data) {
        const list = await fetchJSON(
          `${API}/search?${new URLSearchParams({ artist_name: artist, track_name: title })}`, signal);
        data = Array.isArray(list) ? list.find((x) => x.syncedLyrics || x.plainLyrics) : null;
      }

      if (data && !data.instrumental && (data.syncedLyrics || data.plainLyrics)) {
        result = {
          synced: parseLrc(data.syncedLyrics),
          plain: String(data.plainLyrics || '').trim(),
        };
      }
      failures = 0;
    } catch {
      if (++failures >= 5) {
        disabled = true;
        diag.log('warn', 'lyrics lookup unavailable');
      }
      result = null;
    }

    memory.set(key, result);
    await covers.set(key, result ? JSON.stringify(result) : '');
    return result;
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, job);
  return job;
}

/** Index of the line that should be highlighted at `time`. */
export function lineAt(lines, time) {
  if (!lines?.length) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= time) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return found;
}
