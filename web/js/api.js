// Every request in this app is same-origin: /api/* and /media. The server makes
// the hop to Instagram, not the browser — which is what lets the client work
// from inside a country that blocks it.

class ApiError extends Error {
  constructor(message, kind, status) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

const listeners = new Set();

/** Views subscribe to auth-level failures instead of each handling them. */
export function onAuthError(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function request(path, { method = 'GET', body, signal } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      signal,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    // The one failure this app must explain well: our own server is the
    // thing that is unreachable, not Instagram.
    throw new ApiError(
      'Cannot reach your Loop server. Check your connection, or whether the server is awake.',
      'offline', 0,
    );
  }

  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { /* non-JSON error page */ }

  if (!response.ok) {
    const error = new ApiError(
      payload.error || `Request failed (${response.status}).`,
      payload.kind || 'error',
      response.status,
    );
    if (error.kind === 'login_required' || error.kind === 'gate') {
      listeners.forEach((fn) => fn(error));
    }
    throw error;
  }
  return payload;
}

export const api = {
  session: () => request('/api/session'),
  gate: (code) => request('/api/session/gate', { method: 'POST', body: { code } }),
  login: (username, password) =>
    request('/api/session/login', { method: 'POST', body: { username, password } }),
  loginWithCookie: (sessionid, csrftoken) =>
    request('/api/session/cookie', { method: 'POST', body: { sessionid, csrftoken } }),
  twoFactor: (username, identifier, code) =>
    request('/api/session/two-factor', { method: 'POST', body: { username, identifier, code } }),
  logout: () => request('/api/session/logout', { method: 'POST' }),

  feed: (maxId) => request(`/api/feed${maxId ? `?max_id=${encodeURIComponent(maxId)}` : ''}`),
  stories: () => request('/api/stories'),
  story: (id) => request(`/api/stories/${id}`),
  explore: (maxId) => request(`/api/explore${maxId ? `?max_id=${encodeURIComponent(maxId)}` : ''}`),
  reels: (maxId) => request(`/api/reels${maxId ? `?max_id=${encodeURIComponent(maxId)}` : ''}`),
  user: (username) => request(`/api/user/${encodeURIComponent(username)}`),
  userFeed: (id, maxId) =>
    request(`/api/user/${id}/feed${maxId ? `?max_id=${encodeURIComponent(maxId)}` : ''}`),
  post: (id) => request(`/api/post/${id}`),
  byShortcode: (code) => request(`/api/p/${encodeURIComponent(code)}`),
  comments: (id, minId) =>
    request(`/api/post/${id}/comments${minId ? `?min_id=${encodeURIComponent(minId)}` : ''}`),
  addComment: (id, text) =>
    request(`/api/post/${id}/comments`, { method: 'POST', body: { text } }),
  search: (q, signal) => request(`/api/search?q=${encodeURIComponent(q)}`, { signal }),
  tag: (name) => request(`/api/tag/${encodeURIComponent(name)}`),
  activity: () => request('/api/activity'),
  health: () => request('/api/health'),

  like: (id, on) => request(`/api/post/${id}/like`, { method: 'POST', body: { on } }),
  save: (id, on) => request(`/api/post/${id}/save`, { method: 'POST', body: { on } }),
  follow: (id, on) => request(`/api/user/${id}/follow`, { method: 'POST', body: { on } }),
};

export { ApiError };
