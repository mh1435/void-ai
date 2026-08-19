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

/* Your own YouTube playlists, read through YouTube's own API.
 *
 * This reads exactly one thing: the list of what you saved. Titles, channels,
 * order. That is what the Data API is for, it is your account asking about
 * your own library, and it is all this file does.
 *
 * It does not fetch audio from YouTube, and cannot — the API does not offer
 * that, and going around it is the one thing this app will not do. What comes
 * back is a list of names, which the mix resolver then finds in your own
 * imported files or in the open catalogue. So a YouTube playlist becomes a
 * running order that plays from sources the app is allowed to play.
 *
 * Signing in is the real OAuth flow, run by the wrapper: the browser handles
 * Google's consent page and the app keeps a refresh token, so you approve once
 * and stay signed in. In a plain browser, where nothing can catch the redirect
 * back from Google, a pasted access token still works as a fallback.
 *
 * No client ID is compiled in. This is GPL software, so anything shipped
 * inside it is public; the user registers their own once instead. For an
 * Android client Google issues no secret at all — the app is identified by its
 * package name and signing certificate. */

import { getSetting, setSetting } from './store.js';
import { googleAccount, canSignIn, phoneAccount, canPickAccount } from './native.js';

const API = 'https://www.googleapis.com/youtube/v3';
const TIMEOUT_MS = 15000;

/** Liked videos live in a playlist with a fixed id, same for every account. */
export const LIKED_PLAYLIST = 'LL';

/**
 * The token to use right now, in order of how little the user had to do:
 *
 *  1. the Google account already on the phone, brokered by Android;
 *  2. the client-ID sign-in, for when Google refuses to broker;
 *  3. a pasted token, which is all a plain browser can manage.
 *
 * Both wrapper paths refresh their own tokens, so what comes back is live.
 */
export function token() {
  if (canPickAccount && phoneAccount.signedIn()) {
    const brokered = phoneAccount.token();
    if (brokered) return brokered;
  }
  if (canSignIn) {
    const managed = googleAccount.token();
    if (managed) return managed;
  }
  return String(getSetting('youtubeToken') || '').trim();
}

export function connected() {
  return Boolean(token());
}

/** True when the account was signed in properly rather than pasted. */
export function signedIn() {
  return (canPickAccount && phoneAccount.signedIn()) || (canSignIn && googleAccount.signedIn());
}

/** True when the sign-in was the one-tap kind, with nothing to configure. */
export function signedInByPhone() {
  return canPickAccount && phoneAccount.signedIn();
}

/** Whose account is connected, as far as the app knows without asking YouTube. */
export function accountLabel() {
  if (signedInByPhone()) return phoneAccount.name();
  return canSignIn ? googleAccount.name() : '';
}

export async function setToken(value) {
  await setSetting('youtubeToken', String(value || '').trim());
}

async function call(path, params = {}, { signal } = {}) {
  const access = token();
  if (!access) throw new Error('Not connected');

  const url = new URL(`${API}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') url.searchParams.set(key, String(value));
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  signal?.addEventListener('abort', () => ctl.abort(), { once: true });

  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { Authorization: `Bearer ${access}`, Accept: 'application/json' },
    });

    if (res.status === 401) throw new Error('Token expired — connect again');
    if (res.status === 403) throw new Error('YouTube refused the request (quota or scope)');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Confirm a token works, and say whose it is. */
export async function verify(candidate) {
  const previous = String(getSetting('youtubeToken') || '');
  if (candidate != null) await setToken(candidate);
  try {
    const name = await whoAmI();
    return { ok: true, name };
  } catch (err) {
    if (candidate != null) await setToken(previous);
    return { ok: false, error: err.message };
  }
}

/** Whose account this token belongs to. */
export async function whoAmI({ signal } = {}) {
  const data = await call('channels', { part: 'snippet', mine: 'true' }, { signal });
  const channel = data?.items?.[0];
  if (!channel) throw new Error('No YouTube channel on that account');
  return channel.snippet?.title || 'your account';
}

/* ── Reading the library ───────────────────────────────────────────── */

/** Every playlist you own, plus Liked videos, which the API keeps separate. */
export async function myPlaylists({ signal } = {}) {
  const out = [{
    id: LIKED_PLAYLIST,
    title: 'Liked videos',
    count: null,
    cover: null,
    liked: true,
  }];

  let pageToken = '';
  do {
    const data = await call('playlists', {
      part: 'snippet,contentDetails',
      mine: 'true',
      maxResults: 50,
      pageToken,
    }, { signal });

    for (const item of data.items || []) {
      out.push({
        id: item.id,
        title: item.snippet?.title || 'Untitled playlist',
        count: item.contentDetails?.itemCount ?? null,
        cover: thumbOf(item.snippet?.thumbnails),
        liked: false,
      });
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return out;
}

/** The contents of one playlist, as mix entries. */
export async function playlistEntries(playlistId, { signal, max = 400 } = {}) {
  const entries = [];
  let pageToken = '';

  do {
    const data = await call('playlistItems', {
      part: 'snippet',
      playlistId,
      maxResults: 50,
      pageToken,
    }, { signal });

    for (const item of data.items || []) {
      const snippet = item.snippet || {};
      // Deleted and private videos come back as placeholders with no owner.
      if (!snippet.title || /^(deleted|private) video$/i.test(snippet.title)) continue;
      entries.push(toEntry(snippet.title, snippet.videoOwnerChannelTitle));
      if (entries.length >= max) return entries;
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return entries;
}

function thumbOf(thumbnails) {
  if (!thumbnails) return null;
  const pick = thumbnails.medium || thumbnails.high || thumbnails.default;
  return pick?.url || null;
}

/* ── Turning a video title into a song ─────────────────────────────── */

/** The production noise people put in YouTube titles, in several languages. */
const NOISE = new RegExp(
  '\\\\b(official\\\\s*(music\\\\s*)?(video|audio|visualizer|lyric[s]?\\\\s*video)?'
  + '|clip\\\\s*officiel|audio\\\\s*officiel|video\\\\s*oficial|videoclip'
  + '|lyric[s]?(\\\\s*video)?|letra|paroles'
  + '|hd|hq|4k|8k|full\\\\s*album|full\\\\s*ep|mv|m/v'
  + '|live\\\\s*(session|performance)?|remaster(ed)?(\\\\s*\\\\d{4})?'
  + '|audio|visualizer|explicit|free\\\\s*download|out\\\\s*now)\\\\b',
  'gi',
);

/**
 * "VIDEOCLUB - Amour Plastique (Clip Officiel)" → Videoclub / Amour Plastique.
 *
 * A channel name is the fallback artist, with " - Topic" stripped: those are
 * YouTube's auto-generated artist channels and the suffix is not part of the
 * name.
 */
export function toEntry(rawTitle, channel) {
  let text = String(rawTitle || '')
    .replace(/[（(\[【][^)）\]】]*[)）\]】]/g, ' ')   // bracketed noise, any width
    .replace(NOISE, ' ')
    .replace(/\s*[|｜]\s*.*$/, ' ')                  // "Song | Channel" tails
    .replace(/\s+/g, ' ')
    .trim();

  const artistFromChannel = String(channel || '')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\s*(VEVO|Official|Music)$/i, '')
    .trim();

  const parts = text.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    const artist = parts[0].trim();
    const title = parts.slice(1).join(' - ').trim();
    if (artist && title) return { title, artist, album: '', duration: 0 };
  }

  return {
    title: text || String(rawTitle || '').trim(),
    artist: artistFromChannel,
    album: '',
    duration: 0,
  };
}

/** A whole playlist, in the shape the mix resolver expects. */
export async function playlistAsMix(playlist, { signal } = {}) {
  const entries = await playlistEntries(playlist.id, { signal });
  return {
    name: playlist.title,
    createdAt: Date.now(),
    entries,
  };
}
