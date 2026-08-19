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

/* Resilient fetch layer.
 *
 * The design target is a network that is slow, lossy, and sometimes filtered
 * outright: requests time out rather than hanging forever, transient failures
 * are retried with backoff, and every request can be raced across mirror hosts
 * so one blocked or dead endpoint never takes the app down. */

export const bus = new EventTarget();

/** Rolling record of what the network has been doing, surfaced in Settings. */
export const diag = {
  entries: [],
  max: 120,
  log(level, msg) {
    const entry = { level, msg, at: Date.now() };
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.shift();
    bus.dispatchEvent(new CustomEvent('diag', { detail: entry }));
    return entry;
  },
};

/**
 * Health as the app currently understands it:
 *   ok | slow | blocked | offline | probing
 *
 * `blocked` is the case this app most cares about: the device has a working
 * connection, but requests to the Archive die anyway — filtered, throttled to
 * death, or refused upstream. Calling that "slow" would send users hunting for
 * the wrong problem.
 */
export const health = {
  state: navigator.onLine ? 'probing' : 'offline',
  latency: null,
  lastOkAt: null,
  set(state, latency) {
    const changed = this.state !== state;
    this.state = state;
    if (typeof latency === 'number') this.latency = latency;
    if (state === 'ok' || state === 'slow') this.lastOkAt = Date.now();
    if (changed) bus.dispatchEvent(new CustomEvent('health', { detail: { ...this } }));
  },
};

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
  /** 4xx (except 408/429) means "asking again won't help". */
  get retryable() {
    return !(this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429);
  }
}

export class TimeoutError extends Error {
  constructor(ms, url) {
    super(`Timed out after ${ms}ms`);
    this.name = 'TimeoutError';
    this.url = url;
    this.retryable = true;
  }
}

export class OfflineError extends Error {
  constructor() {
    super('No network connection');
    this.name = 'OfflineError';
    this.retryable = false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with full jitter, so retries don't stampede. */
function backoffDelay(attempt, base = 350, cap = 6000) {
  const ceiling = Math.min(cap, base * 2 ** attempt);
  return Math.random() * ceiling;
}

/**
 * fetch() with a hard timeout that also honours an external abort signal.
 */
export async function fetchWithTimeout(url, { timeout = 12000, signal, ...init } = {}) {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ctl.abort(new TimeoutError(timeout, url)), timeout);

  const started = performance.now();
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const elapsed = Math.round(performance.now() - started);
    if (!res.ok) throw new HttpError(res.status, url);
    health.set(elapsed > 2500 ? 'slow' : 'ok', elapsed);
    return res;
  } catch (err) {
    // AbortError raised by our own timer carries the TimeoutError as reason.
    if (err?.name === 'AbortError' && ctl.signal.reason instanceof TimeoutError) {
      throw ctl.signal.reason;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Fetch with retries. `attempts` counts total tries, not extra ones.
 */
export async function request(url, opts = {}) {
  const { attempts = 3, timeout = 12000, signal, label = url, ...init } = opts;

  if (!navigator.onLine) throw new OfflineError();

  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchWithTimeout(url, { timeout, signal, ...init });
      if (i > 0) diag.log('ok', `recovered after ${i + 1} tries: ${label}`);
      return res;
    } catch (err) {
      lastErr = err;

      // A caller-initiated abort is intentional; never retry it.
      if (err?.name === 'AbortError') throw err;
      if (err instanceof OfflineError || !navigator.onLine) {
        health.set('offline');
        throw new OfflineError();
      }
      if (err instanceof HttpError && !err.retryable) {
        diag.log('err', `${err.message} (final): ${label}`);
        throw err;
      }
      if (i === attempts - 1) break;

      const wait = backoffDelay(i);
      diag.log('warn', `${err.message} — retry ${i + 1}/${attempts - 1} in ${Math.round(wait)}ms: ${label}`);
      await sleep(wait);
    }
  }

  health.set(navigator.onLine ? 'blocked' : 'offline');
  diag.log('err', `failed after ${attempts} tries: ${label} (${lastErr?.message})`);
  throw lastErr;
}

export async function requestJSON(url, opts = {}) {
  const res = await request(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
  try {
    return await res.json();
  } catch {
    throw new Error('Malformed JSON response');
  }
}

/**
 * Race the same logical request across several hosts and take the first win.
 *
 * This is the main trick behind "always works": if one mirror is throttled or
 * blocked on the user's network, another usually is not, and we pay the
 * latency of the *fastest* one rather than the slowest.
 */
export async function raceHosts(urls, opts = {}) {
  if (!navigator.onLine) throw new OfflineError();
  if (urls.length === 1) return requestJSON(urls[0], opts);

  const ctl = new AbortController();
  const { signal: outer, ...rest } = opts;
  if (outer) outer.addEventListener('abort', () => ctl.abort(outer.reason), { once: true });

  let settled = 0;
  const errors = [];

  return new Promise((resolve, reject) => {
    for (const url of urls) {
      requestJSON(url, { ...rest, attempts: 2, signal: ctl.signal })
        .then((data) => {
          ctl.abort(); // Cancel the losers; we already have an answer.
          resolve(data);
        })
        .catch((err) => {
          errors.push(err);
          if (++settled === urls.length) {
            reject(errors.find((e) => !(e instanceof HttpError) || e.retryable) ?? errors[0]);
          }
        });
    }
  });
}

/**
 * Probe reachability of a host without caring about the response body.
 * Used for the connection chip and the Settings diagnostics.
 */
export async function probe(url, timeout = 8000) {
  const started = performance.now();
  try {
    await fetchWithTimeout(url, { timeout, cache: 'no-store', mode: 'cors' });
    return { ok: true, ms: Math.round(performance.now() - started) };
  } catch (err) {
    return { ok: false, ms: Math.round(performance.now() - started), error: err.message };
  }
}

// Keep health in step with the browser's own idea of connectivity.
addEventListener('online', () => {
  diag.log('ok', 'browser reports online');
  health.set('probing');
});
addEventListener('offline', () => {
  diag.log('warn', 'browser reports offline');
  health.set('offline');
});
