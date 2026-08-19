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

/* Mixes: playlists you can actually pass to someone.
 *
 * A mix carries no audio. It is the part of a playlist that is yours — the
 * songs you chose and the order you put them in — written down as names:
 *
 *     Videoclub — Amour Plastique
 *     Massive Attack — Teardrop
 *     ...
 *
 * Whoever opens it resolves those names against what *their* copy can play:
 * their own imported files first, then the open catalogue. Two people with the
 * same mix and different libraries hear the same running order from different
 * sources, and nobody has shipped a recording anywhere.
 *
 * That also means there is no server in this, and nothing to sign in to. A mix
 * is a short string you can send in any chat, or a small file. Nothing to
 * block, nothing to take down, and no API key to be refused. */

import * as A from './archive.js';
import { local, offline, likes, matches } from './store.js';

const MAGIC = 'VOIDMIX1';
const MAX_TRACKS = 500;

/* ── Writing a mix ─────────────────────────────────────────────────── */

/** Short keys: a mix should fit in a chat message, not a file transfer. */
function compact(playlist) {
  return {
    v: 1,
    n: String(playlist.name || 'Mix').slice(0, 120),
    c: Date.now(),
    t: (playlist.tracks || []).slice(0, MAX_TRACKS).map((track) => {
      const entry = { t: String(track.title || '').slice(0, 200) };
      const artist = String(track.artist || '').trim();
      const album = String(track.album || '').trim();
      if (artist && !/^unknown artist$/i.test(artist)) entry.a = artist.slice(0, 160);
      if (album && !/^(your files|void music)$/i.test(album)) entry.b = album.slice(0, 160);
      if (track.duration > 0) entry.d = Math.round(track.duration);
      return entry;
    }),
  };
}

function expand(data) {
  if (!data || !Array.isArray(data.t)) return null;
  return {
    name: String(data.n || 'Shared mix'),
    createdAt: Number(data.c) || 0,
    entries: data.t.slice(0, MAX_TRACKS).map((e) => ({
      title: String(e.t || '').trim(),
      artist: String(e.a || '').trim(),
      album: String(e.b || '').trim(),
      duration: Number(e.d) || 0,
    })).filter((e) => e.title),
  };
}

const toBase64Url = (bytes) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (text) => {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};

async function deflate(bytes) {
  if (typeof CompressionStream !== 'function') return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

async function inflate(bytes) {
  if (typeof DecompressionStream !== 'function') return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Turn a playlist into a code you can paste into a message.
 * `VOIDMIX1z…` is compressed, `VOIDMIX1p…` is not — old browsers can still read
 * what a new one wrote, and vice versa.
 */
export async function encodeMix(playlist) {
  const json = JSON.stringify(compact(playlist));
  const raw = new TextEncoder().encode(json);
  const squeezed = await deflate(raw);
  return squeezed
    ? `${MAGIC}z${toBase64Url(squeezed)}`
    : `${MAGIC}p${toBase64Url(raw)}`;
}

/** Read a code back. Returns null rather than throwing on anything malformed. */
export async function decodeMix(code) {
  const text = String(code || '').trim().replace(/\s+/g, '');
  if (!text.startsWith(MAGIC)) return null;

  const mode = text[MAGIC.length];
  const payload = text.slice(MAGIC.length + 1);

  try {
    let bytes = fromBase64Url(payload);
    if (mode === 'z') {
      bytes = await inflate(bytes);
      if (!bytes) return null;
    } else if (mode !== 'p') {
      return null;
    }
    return expand(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

/* ── Reading a list someone pasted ─────────────────────────────────── */

/**
 * Accept the formats people actually have to hand: a plain "Artist - Title"
 * list, an .m3u, or the CSV that playlist-export sites produce.
 */
export function parseText(text, name = 'Imported mix') {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;

  const entries = looksLikeCsv(lines) ? parseCsv(lines) : parseLines(lines);
  return entries.length ? { name, createdAt: Date.now(), entries: entries.slice(0, MAX_TRACKS) } : null;
}

function looksLikeCsv(lines) {
  const head = lines[0].toLowerCase();
  return head.includes(',') && /track ?name|title/.test(head) && /artist/.test(head);
}

function splitCsv(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out.map((f) => f.trim());
}

function parseCsv(lines) {
  const head = splitCsv(lines[0]).map((h) => h.toLowerCase());
  const find = (...names) => head.findIndex((h) => names.some((n) => h.includes(n)));

  const iTitle = find('track name', 'title', 'name');
  const iArtist = find('artist');
  const iAlbum = find('album');
  const iDur = find('duration', 'length');
  if (iTitle < 0) return [];

  return lines.slice(1).map((line) => {
    const cells = splitCsv(line);
    const title = cells[iTitle] || '';
    if (!title) return null;
    return {
      title,
      artist: iArtist >= 0 ? (cells[iArtist] || '').split(/[,;]/)[0].trim() : '',
      album: iAlbum >= 0 ? cells[iAlbum] || '' : '',
      duration: iDur >= 0 ? durationOf(cells[iDur]) : 0,
    };
  }).filter(Boolean);
}

function durationOf(value) {
  const text = String(value || '').trim();
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return n > 1000 ? Math.round(n / 1000) : n;   // some exports use milliseconds
  }
  const parts = text.split(':').map(Number);
  if (parts.length === 2 && parts.every(Number.isFinite)) return parts[0] * 60 + parts[1];
  return 0;
}

function parseLines(lines) {
  const out = [];
  let pending = null;                              // an #EXTINF waiting for its line

  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      const [, secs, rest] = line.match(/^#EXTINF:(-?\d+)\s*,\s*(.*)$/) || [];
      if (rest) pending = { ...splitArtistTitle(rest), duration: Math.max(0, Number(secs) || 0) };
      continue;
    }
    if (line.startsWith('#')) continue;            // any other playlist directive

    if (pending) {
      out.push(pending);                           // the URL line itself is of no use to us
      pending = null;
      continue;
    }
    const parsed = splitArtistTitle(line);
    if (parsed.title) out.push({ ...parsed, album: '', duration: 0 });
  }
  if (pending) out.push(pending);
  return out;
}

/** "Videoclub - Amour Plastique", "1. Videoclub – Amour Plastique", "Amour Plastique". */
function splitArtistTitle(line) {
  let text = line.replace(/^\s*\d{1,3}[.)]\s+/, '').trim();
  const parts = text.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim(), album: '' };
  }
  return { artist: '', title: text, album: '' };
}

/* ── Finding something to play ─────────────────────────────────────── */

const norm = (s) => String(s || '')
  .toLowerCase()
  .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
  .replace(/\b(feat|ft|featuring|with)\b.*$/i, ' ')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const keyFor = (entry) => `${norm(entry.artist)}|${norm(entry.title)}`;

/** How well a candidate answers what the mix asked for. 0 means "no". */
function score(entry, track) {
  const wantTitle = norm(entry.title);
  const gotTitle = norm(track.title);
  if (!wantTitle || !gotTitle) return 0;

  let points = 0;
  if (gotTitle === wantTitle) points += 100;
  else if (gotTitle.startsWith(wantTitle) || wantTitle.startsWith(gotTitle)) points += 70;
  else if (gotTitle.includes(wantTitle) || wantTitle.includes(gotTitle)) points += 45;
  else return 0;                                   // a different song is worse than silence

  const wantArtist = norm(entry.artist);
  const gotArtist = norm(track.artist);
  if (wantArtist && gotArtist) {
    if (gotArtist === wantArtist) points += 60;
    else if (gotArtist.includes(wantArtist) || wantArtist.includes(gotArtist)) points += 35;
    else points -= 25;                             // right title, wrong act: probably a cover
  }

  if (entry.duration && track.duration) {
    const gap = Math.abs(entry.duration - track.duration);
    if (gap <= 5) points += 20;
    else if (gap <= 20) points += 8;
    else if (gap > 90) points -= 15;
  }

  // Something already on the device beats anything that needs the network.
  if (track.source === 'local') points += 12;
  return points;
}

function bestOf(entry, candidates, floor = 60) {
  let best = null;
  let bestScore = floor;
  for (const track of candidates) {
    const points = score(entry, track);
    if (points > bestScore) { best = track; bestScore = points; }
  }
  return best;
}

let libraryCache = null;

async function libraryTracks() {
  if (libraryCache) return libraryCache;
  const [mine, saved, liked] = await Promise.all([local.all(), offline.all(), likes.all()]);
  libraryCache = [...mine, ...saved, ...liked];
  return libraryCache;
}

/** Call after importing or downloading, so new files become matchable. */
export function forgetLibrary() {
  libraryCache = null;
}

/**
 * Find something playable for one entry.
 *
 * Your own files are tried first — they are instant, they work with no
 * connection, and they are the likeliest match for music you chose. Only then
 * does it ask the Archive, and the answer is remembered either way so the
 * second open of a mix costs nothing.
 */
export async function resolveEntry(entry, { signal, useNetwork = true } = {}) {
  const own = bestOf(entry, await libraryTracks());
  if (own) return { track: own, from: own.source === 'local' ? 'your files' : 'your library' };

  const key = keyFor(entry);
  const cached = await matches.get(key);
  if (cached !== undefined) {
    if (!cached) return { track: null, from: null };
    return { track: cached, from: 'archive' };
  }
  if (!useNetwork || !navigator.onLine) return { track: null, from: null, deferred: true };

  const query = [entry.artist, entry.title].filter(Boolean).join(' ');
  let found = null;
  try {
    const results = await A.searchSongs({ query, signal, itemLimit: 6, limit: 20 });
    found = bestOf(entry, results);
  } catch {
    return { track: null, from: null, deferred: true };   // don't cache a network failure
  }

  await matches.set(key, found);
  return { track: found, from: found ? 'archive' : null };
}

/**
 * Resolve a whole mix, reporting as it goes.
 *
 * Deliberately sequential for the network half: forty parallel searches would
 * hammer the Archive and finish no sooner on a slow link.
 */
export async function resolveMix(mix, { onProgress = () => {}, signal, useNetwork = true } = {}) {
  forgetLibrary();
  const rows = mix.entries.map((entry) => ({ entry, track: null, from: null, pending: true }));
  onProgress({ rows, done: 0, total: rows.length });

  for (let i = 0; i < rows.length; i++) {
    if (signal?.aborted) break;
    const result = await resolveEntry(rows[i].entry, { signal, useNetwork });
    rows[i] = { entry: rows[i].entry, track: result.track, from: result.from, pending: false };
    onProgress({ rows, done: i + 1, total: rows.length });
  }
  return rows;
}

/** A mix, ready to hand to the player: only the entries that resolved. */
export const playable = (rows) => rows.filter((r) => r.track).map((r) => r.track);
