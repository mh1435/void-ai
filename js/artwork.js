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

/* Cover art beyond what the Archive itself carries.
 *
 * Plenty of Archive items ship no artwork at all — live tapes and bare uploads
 * especially — so a second source fills the gaps: MusicBrainz to identify the
 * release, then the Cover Art Archive for the image. Both are open, need no API
 * key, and are not geo-restricted, which keeps the app's "works anywhere"
 * property intact.
 *
 * Two rules shape everything here:
 *   1. MusicBrainz asks for about one request per second. We queue, we do not
 *      flood, and a scroll through 40 rows must not become 40 parallel calls.
 *   2. Results are cached forever, misses included. A recording with no art
 *      anywhere should be asked about once, not on every render.
 *
 * This raises coverage a lot. It cannot reach 100%: art that was never
 * published does not exist to be fetched, and for those the UI keeps its own
 * generated tile. */

import { covers } from './store.js';
import { diag } from './net.js';
import * as B from './backend.js';

// Bases, not constants: with a self-hosted server in use these become
// <server>/via/<host>, so artwork keeps working on a network that blocks
// them the same way it blocks the catalogue.
const MB = () => `${B.origin('musicbrainz.org')}/ws/2`;
const CAA = () => B.origin('coverartarchive.org');
const ITUNES = () => `${B.origin('itunes.apple.com')}/search`;

/** Roughly one request per second, as MusicBrainz asks. */
const MIN_GAP_MS = 1100;
/** iTunes has no published courtesy limit, but it does throttle bursts. */
const ITUNES_GAP_MS = 300;
const TIMEOUT_MS = 8000;

let chain = Promise.resolve();
let lastCall = 0;
const inFlight = new Map();

/** Turn each source off after repeated failures, independently: one blocked
 *  host must not take the other down with it. */
const failures = { itunes: 0, mb: 0 };
const dead = { itunes: false, mb: false };

function noteFailure(source) {
  if (++failures[source] >= 5) {
    dead[source] = true;
    diag.log('warn', `${source === 'mb' ? 'Cover Art Archive' : 'iTunes'} artwork lookup unavailable`);
  }
}

function normalise(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')          // "(live)", "(remastered)"
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(feat|ft|featuring)\b.*$/i, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Archive titles are frequently video rips: "VIDEOCLUB Amour Plastique (Clip
 * Officiel)". MusicBrainz will not match that, so strip the production noise
 * and any artist name duplicated into the title before searching.
 */
function cleanTitle(title, artist) {
  let t = String(title || '');

  t = t.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
  t = t.replace(
    /\b(clip\s+officiel|official\s+(music\s+)?(video|audio)|lyrics?\s*video|lyric|visualizer|audio\s+officiel|mv|hd|4k|full\s+album|topic)\b/gi,
    ' ',
  );
  t = t.replace(/\b(feat|ft|featuring|with)\b.*$/i, ' ');

  // "VIDEOCLUB Amour Plastique" → "Amour Plastique"
  const a = normalise(artist);
  if (a) {
    const n = normalise(t);
    if (n.startsWith(`${a} `)) t = t.slice(t.toLowerCase().indexOf(a) + a.length);
  }

  return t.replace(/[\s\-–—_|]+/g, ' ').trim();
}

/** Values that carry no identifying information and cannot be looked up. */
function isUseless(s) {
  const n = normalise(s);
  return !n || n.length < 2 || /^(unknown|various|va|untitled|track \d+)/.test(n);
}

function cacheKey(artist, title) {
  return `${normalise(artist)}|${normalise(title)}`;
}

async function fetchJSON(url, signal) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  signal?.addEventListener('abort', () => ctl.abort(), { once: true });
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Serialise every outbound call, spacing them politely. */
function queued(fn, gap = MIN_GAP_MS) {
  const run = chain.then(async () => {
    const wait = Math.max(0, gap - (Date.now() - lastCall));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  // Keep the chain alive even when one link rejects.
  chain = run.then(() => {}, () => {});
  return run;
}

/** Does the Cover Art Archive actually hold a front image for this release? */
function caaFront(mbid, kind = 'release') {
  return B.sign(`${CAA()}/${kind}/${mbid}/front-500`);
}

/**
 * Apple's search endpoint. It is open, needs no key, answers in one round trip
 * and covers modern releases far better than MusicBrainz does — which is
 * exactly the gap that was leaving songs with a plain coloured tile.
 *
 * The catch is that it always returns *something*, so a result is only used
 * when the artist it names actually matches the artist we asked about.
 */
async function lookupItunes(artist, subject, signal) {
  const term = `${artist} ${subject}`.trim();
  const url = B.sign(`${ITUNES()}?term=${encodeURIComponent(term)}&entity=song&limit=8`);
  const data = await fetchJSON(url, signal);

  const wanted = normalise(artist);
  const wantedSubject = normalise(subject);

  for (const r of data?.results || []) {
    const gotArtist = normalise(r.artistName);
    const gotTitle = normalise(r.trackName);
    const gotAlbum = normalise(r.collectionName);
    if (!r.artworkUrl100) continue;
    if (!gotArtist || !related(gotArtist, wanted)) continue;
    if (!related(gotTitle, wantedSubject) && !related(gotAlbum, wantedSubject)) continue;

    // The 100px thumbnail URL is the same asset at a different size.
    return r.artworkUrl100.replace(/\/\d+x\d+bb\.(jpg|png)/, '/600x600bb.$1');
  }
  return null;
}

/** Loose containment either way: "videoclub" vs "videoclub (fr)". */
function related(a, b) {
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

async function lookupRelease(artist, album, signal) {
  const q = `release:"${album}" AND artist:"${artist}"`;
  const url = B.sign(`${MB()}/release/?query=${encodeURIComponent(q)}&fmt=json&limit=5`);
  const data = await fetchJSON(url, signal);
  const releases = data?.releases || [];
  // Prefer a release the Cover Art Archive is known to have art for.
  const withArt = releases.find((r) => r['cover-art-archive']?.front);
  const pick = withArt || releases[0];
  return pick?.id ? caaFront(pick.id) : null;
}

async function lookupRecording(artist, title, signal) {
  const q = `recording:"${title}" AND artist:"${artist}"`;
  const url = B.sign(`${MB()}/recording/?query=${encodeURIComponent(q)}&fmt=json&limit=5`);
  const data = await fetchJSON(url, signal);
  for (const rec of data?.recordings || []) {
    for (const rel of rec.releases || []) {
      if (rel.id) return caaFront(rel.id);
    }
  }
  return null;
}

/**
 * Confirm the image really exists before handing back a URL, so the UI never
 * swaps a generated tile for a broken image.
 */
function imageLoads(url, signal) {
  return new Promise((resolve) => {
    const img = new Image();
    const done = (ok) => { img.onload = img.onerror = null; resolve(ok); };
    img.onload = () => done(img.naturalWidth > 1);
    img.onerror = () => done(false);
    signal?.addEventListener('abort', () => done(false), { once: true });
    img.src = url;
  });
}

/**
 * Best-effort artwork for a track. Resolves to a URL, or null when nothing
 * exists. Never throws — artwork is decoration, not function.
 */
export async function resolveCover({ artist, title, album }, { signal } = {}) {
  if ((dead.itunes && dead.mb) || !navigator.onLine) return null;
  if (isUseless(artist)) return null;

  // An album lookup covers every track on it, so prefer it when we have one.
  const subject = !isUseless(album) ? album : title;
  if (isUseless(subject)) return null;

  const key = cacheKey(artist, subject);
  const cached = await covers.get(key);
  if (cached !== undefined) return cached;
  if (inFlight.has(key)) return inFlight.get(key);

  const cleanArtist = String(artist).replace(/\([^)]*\)/g, ' ').trim();
  const cleanSubject = cleanTitle(subject, artist) || subject;

  const job = (async () => {
    let url = null;

    // iTunes first: one fast request, and it knows about current music.
    if (!dead.itunes) {
      try {
        url = await queued(() => lookupItunes(cleanArtist, cleanSubject, signal), ITUNES_GAP_MS);
        if (url && !(await imageLoads(url, signal))) url = null;
        failures.itunes = 0;
      } catch {
        noteFailure('itunes');
        url = null;
      }
    }

    // Then MusicBrainz, which is where anything older or more obscure lives.
    if (!url && !dead.mb) {
      try {
        // The release covers a whole record; the recording catches singles
        // and loose uploads.
        url = await queued(() => lookupRelease(cleanArtist, cleanSubject, signal));
        if (url && !(await imageLoads(url, signal))) url = null;

        if (!url) {
          url = await queued(() => lookupRecording(cleanArtist, cleanSubject, signal));
          if (url && !(await imageLoads(url, signal))) url = null;
        }
        failures.mb = 0;
      } catch {
        noteFailure('mb');
        url = null;
      }
    }

    await covers.set(key, url);
    return url;
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, job);
  return job;
}

/** Lets Settings report and reset what has been resolved. */
export const coverCache = covers;
