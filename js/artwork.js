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

const MB = 'https://musicbrainz.org/ws/2';
const CAA = 'https://coverartarchive.org';

/** Roughly one request per second, as MusicBrainz asks. */
const MIN_GAP_MS = 1100;
const TIMEOUT_MS = 8000;

let chain = Promise.resolve();
let lastCall = 0;
const inFlight = new Map();

/** Turn off after repeated failures so a blocked host stops costing time. */
let consecutiveFailures = 0;
let disabled = false;

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
function queued(fn) {
  const run = chain.then(async () => {
    const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastCall));
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
  return `${CAA}/${kind}/${mbid}/front-500`;
}

async function lookupRelease(artist, album, signal) {
  const q = `release:"${album}" AND artist:"${artist}"`;
  const url = `${MB}/release/?query=${encodeURIComponent(q)}&fmt=json&limit=5`;
  const data = await fetchJSON(url, signal);
  const releases = data?.releases || [];
  // Prefer a release the Cover Art Archive is known to have art for.
  const withArt = releases.find((r) => r['cover-art-archive']?.front);
  const pick = withArt || releases[0];
  return pick?.id ? caaFront(pick.id) : null;
}

async function lookupRecording(artist, title, signal) {
  const q = `recording:"${title}" AND artist:"${artist}"`;
  const url = `${MB}/recording/?query=${encodeURIComponent(q)}&fmt=json&limit=5`;
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
  if (disabled || !navigator.onLine) return null;
  if (isUseless(artist)) return null;

  // An album lookup covers every track on it, so prefer it when we have one.
  const subject = !isUseless(album) ? album : title;
  if (isUseless(subject)) return null;

  const key = cacheKey(artist, subject);
  const cached = await covers.get(key);
  if (cached !== undefined) return cached;
  if (inFlight.has(key)) return inFlight.get(key);

  const job = queued(async () => {
    let url = null;
    try {
      url = !isUseless(album)
        ? await lookupRelease(artist, album, signal)
        : await lookupRecording(artist, title, signal);
      consecutiveFailures = 0;
    } catch (err) {
      if (++consecutiveFailures >= 4) {
        disabled = true;
        diag.log('warn', 'cover lookup unavailable — using generated artwork');
      }
      url = null;
    }

    if (url && !(await imageLoads(url, signal))) url = null;
    await covers.set(key, url);
    return url;
  }).finally(() => inFlight.delete(key));

  inFlight.set(key, job);
  return job;
}

/** Lets Settings report and reset what has been resolved. */
export const coverCache = covers;
