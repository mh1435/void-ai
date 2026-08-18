/* Scrobbling to ListenBrainz.
 *
 * ListenBrainz is the open listening history: no API key to apply for, no
 * corporate gatekeeper, and no reason for it to be blocked anywhere. You paste
 * a token from your own account and your plays are yours.
 *
 * Two rules from their guidelines shape the logic:
 *   - a "playing now" goes out when a track starts;
 *   - a listen counts once the track has played for four minutes or half its
 *     length, whichever comes first, and tracks under 30 seconds never count.
 *
 * Failures are never lost. Anything that cannot be sent is written to
 * IndexedDB and flushed when the connection returns — which, for the places
 * this app is built for, is the normal case rather than the exception. */

import { player, state } from './player.js';
import { listens, getSetting, setSetting } from './store.js';
import { diag } from './net.js';

const API = 'https://api.listenbrainz.org/1';
const MIN_TRACK_SECONDS = 30;
const MAX_WAIT_SECONDS = 4 * 60;

const bus = new EventTarget();

let session = null;      // { track, startedAt, played, submitted }
let lastTick = 0;

function token() {
  return String(getSetting('scrobbleToken') || '').trim();
}

function enabled() {
  return Boolean(getSetting('scrobbleEnabled')) && Boolean(token());
}

/** Tracks with no real artist cannot be matched to anything, so don't send. */
function scrobbleable(track) {
  if (!track) return false;
  if (track.source === 'demo') return false;
  const artist = String(track.artist || '').trim();
  if (!artist || /^unknown artist$/i.test(artist)) return false;
  return Boolean(String(track.title || '').trim());
}

function metadataFor(track) {
  const info = {
    media_player: 'Void Music',
    submission_client: 'Void Music',
  };
  if (track.duration > 0) info.duration = Math.round(track.duration);
  if (track.ext) info.music_service_name = track.source === 'local' ? 'Local files' : 'Internet Archive';

  return {
    artist_name: String(track.artist).trim(),
    track_name: String(track.title).trim(),
    release_name: track.album && track.album !== 'Your files' ? String(track.album).trim() : undefined,
    additional_info: info,
  };
}

async function post(path, body, { timeoutMs = 10000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Token ${token()}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json().catch(() => ({}));
  } finally {
    clearTimeout(timer);
  }
}

/* ── Submitting ────────────────────────────────────────────────────── */

async function sendPlayingNow(track) {
  if (!enabled() || !scrobbleable(track)) return;
  try {
    await post('/submit-listens', {
      listen_type: 'playing_now',
      payload: [{ track_metadata: metadataFor(track) }],
    });
  } catch {
    // "Playing now" is ephemeral by definition; there is nothing to queue.
  }
}

async function sendListen(entry) {
  await post('/submit-listens', {
    listen_type: 'single',
    payload: [{ listened_at: entry.listened_at, track_metadata: entry.metadata }],
  });
}

async function submit(track, listenedAt) {
  const entry = {
    id: `${listenedAt}::${track.id}`,
    listened_at: listenedAt,
    metadata: metadataFor(track),
  };

  try {
    await sendListen(entry);
    diag.log('ok', `scrobbled “${track.title}”`);
    bus.dispatchEvent(new CustomEvent('scrobble', { detail: { track, queued: false } }));
  } catch (err) {
    await listens.add(entry);
    diag.log('warn', `scrobble queued (${err.message}) — will retry`);
    bus.dispatchEvent(new CustomEvent('scrobble', { detail: { track, queued: true } }));
  }
}

/** Send everything that was written down while we could not reach the server. */
export async function flush() {
  if (!enabled() || !navigator.onLine) return 0;
  const pending = await listens.all();
  let sent = 0;

  for (const entry of pending) {
    try {
      await sendListen(entry);
      await listens.remove(entry.id);
      sent++;
    } catch {
      break;   // still unreachable; keep the rest for next time
    }
  }
  if (sent) diag.log('ok', `sent ${sent} queued listen${sent === 1 ? '' : 's'}`);
  return sent;
}

/* ── Play tracking ─────────────────────────────────────────────────── */

function threshold(track) {
  const dur = track.duration || state.duration || 0;
  if (dur <= 0) return MAX_WAIT_SECONDS;
  return Math.min(MAX_WAIT_SECONDS, dur / 2);
}

function startSession(track) {
  session = {
    track,
    startedAt: Math.floor(Date.now() / 1000),
    played: 0,
    submitted: false,
  };
  lastTick = 0;
}

player.addEventListener('track', (e) => {
  startSession(e.detail.track);
  sendPlayingNow(e.detail.track);
});

player.addEventListener('time', (e) => {
  if (!session || session.submitted) return;
  const t = e.detail.time;

  // Count real elapsed playback only: a seek must not earn credit, and a
  // paused player emits nothing, so the sum stays honest.
  const delta = t - lastTick;
  if (delta > 0 && delta < 2) session.played += delta;
  lastTick = t;

  const dur = session.track.duration || e.detail.duration || 0;
  if (dur > 0 && dur < MIN_TRACK_SECONDS) return;
  if (session.played < threshold(session.track)) return;

  session.submitted = true;
  if (enabled() && scrobbleable(session.track)) submit(session.track, session.startedAt);
});

/* ── Public surface ────────────────────────────────────────────────── */

export const scrobbler = {
  bus,
  enabled,
  get token() { return token(); },

  /** Check a token against the server and report who it belongs to. */
  async validate(candidate) {
    const value = String(candidate || '').trim();
    if (!value) return { ok: false, error: 'No token' };
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 10000);
      const res = await fetch(`${API}/validate-token`, {
        signal: ctl.signal,
        headers: { Authorization: `Token ${value}` },
      }).finally(() => clearTimeout(timer));

      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const data = await res.json();
      return data?.valid
        ? { ok: true, user: data.user_name }
        : { ok: false, error: data?.message || 'Token rejected' };
    } catch (err) {
      return { ok: false, error: err.name === 'AbortError' ? 'timed out' : err.message };
    }
  },

  async setToken(value) {
    await setSetting('scrobbleToken', String(value || '').trim());
  },

  async setEnabled(on) {
    await setSetting('scrobbleEnabled', Boolean(on));
    if (on) flush();
  },

  pending: () => listens.count(),
  clearPending: () => listens.clear(),
  flush,
};

/** Retry the queue when the connection comes back, and once at startup. */
export function initScrobbler() {
  addEventListener('online', () => { flush(); });
  if (enabled()) flush();
}
