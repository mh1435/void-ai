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

/* The optional self-hosted backend.
 *
 * Everything in this app works with no server at all: the player talks
 * straight to archive.org and fails over between mirrors when a route dies.
 * That stops working in exactly one situation — every route to the catalogue
 * is filtered — and no amount of client-side cleverness fixes it, because a
 * blocked host is blocked for every app on the device.
 *
 * So the user runs `server.py` somewhere the Archive is reachable, and this
 * module points the app at it. From then on the device resolves one hostname,
 * theirs, and the server does the rest. Requests are rewritten:
 *
 *     https://archive.org/metadata/x   ->  https://their.server/via/archive.org/metadata/x
 *     https://ia80.us.archive.org/…    ->  https://their.server/via/ia80.us.archive.org/…
 *
 * which is the whole integration: the URLs the app already knows how to build
 * keep working, because only their prefix changes. */

import { requestJSON, diag } from './net.js';

export const backend = {
  /** Origin of the server, no trailing slash. Empty means "not in use". */
  base: '',
  /** Access code, if the deployment sets one. */
  code: '',
  /** Route *everything* through the server rather than racing it against
   *  the direct hosts. On by default: someone who set this up almost always
   *  did so because the direct route does not work, and a request to a
   *  blocked host is a request that can be logged. */
  only: true,
  /** off | checking | ok | error */
  status: 'off',
  detail: '',
};

export const active = () => Boolean(backend.base) && backend.status === 'ok';

/** Trim a user-typed URL down to a bare origin. */
export function normalise(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  const url = new URL(withScheme);       // throws on nonsense; callers catch
  return url.origin;
}

/** The base URL to use when talking to `host`. */
export function origin(host) {
  return active() ? `${backend.base}/via/${host}` : `https://${host}`;
}

/**
 * Rewrite an absolute URL to go through the server, if one is in use.
 *
 * The result is deliberately unsigned: signing is the caller's last step, so
 * that a URL passed through here and then signed cannot end up carrying the
 * access code twice.
 */
export function reroute(url) {
  if (!active()) return url;
  try {
    const parsed = new URL(url, location.href);
    if (parsed.origin === backend.base) return url;   // already ours
    return `${backend.base}/via/${parsed.host}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/**
 * Add the access code to a URL pointing at our server.
 *
 * It travels in the query string rather than a header for two reasons: an
 * <audio src> cannot set a header, and a custom header would make every
 * request wait for a CORS preflight — a round trip this app cannot spare on
 * the kind of link it is built for.
 */
export function sign(url) {
  if (!backend.code || !url.startsWith(`${backend.base}/via/`)) return url;
  return url + (url.includes('?') ? '&' : '?') + `code=${encodeURIComponent(backend.code)}`;
}

/**
 * Order the candidate URLs for one resource.
 *
 * With no server, nothing changes. With a server in exclusive mode, only
 * proxied URLs survive. Otherwise the direct routes are tried first and the
 * server is kept as the thing that catches them when they fail.
 */
export function route(urls) {
  if (!active()) return urls;
  const viaServer = urls.map(reroute);
  return backend.only ? [...new Set(viaServer)] : [...new Set([...urls, ...viaServer])];
}

/**
 * Ask a server what it is. Resolves to { ok, version, gate_required, ... }
 * or throws — a plain static host answers a 404 here, which is the useful
 * way to find out that a URL is not a Void server.
 */
export async function check(base, code, { signal, timeout = 8000 } = {}) {
  const url = `${base}/api/health${code ? `?code=${encodeURIComponent(code)}` : ''}`;
  const data = await requestJSON(url, {
    attempts: 1, timeout, signal, cache: 'no-store', label: 'server health',
  });
  if (!data || data.app !== 'void-music') {
    throw new Error('That URL answered, but it is not a Void Music server.');
  }
  return data;
}

/** Point the app at `base`, verifying it first. Returns the health payload. */
export async function connect(base, code, opts = {}) {
  backend.status = 'checking';
  try {
    const health = await check(base, code, opts);
    backend.base = base;
    backend.code = code || '';
    backend.status = 'ok';
    backend.detail = health.gate_required && !health.gate_open
      ? 'connected, but the access code is wrong'
      : `connected to ${base}`;
    if (health.gate_required && !health.gate_open) {
      backend.status = 'error';
      throw new Error('This server requires an access code.');
    }
    diag.log('ok', `using backend ${base}`);
    return health;
  } catch (err) {
    if (backend.status === 'checking') {
      backend.status = 'error';
      backend.detail = err.message;
    }
    throw err;
  }
}

export function disconnect() {
  backend.base = '';
  backend.code = '';
  backend.status = 'off';
  backend.detail = '';
}

/**
 * When the app was *served by* a Void server, use it without being asked.
 *
 * This is the case worth making seamless: someone deploys the server, opens
 * its URL on their phone and installs it from there. Nothing about that flow
 * should require then typing the same URL into a settings field.
 */
export async function detect({ signal } = {}) {
  if (!location.origin.startsWith('http')) return false;
  try {
    await connect(location.origin, '', { signal, timeout: 4000 });
    return true;
  } catch {
    // A static host — GitHub Pages, a plain file server — answers 404 here,
    // which is not an error worth showing anyone.
    disconnect();
    return false;
  }
}
