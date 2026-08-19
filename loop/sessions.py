"""Server-side session store.

The browser never holds Instagram cookies. It holds one opaque token; this
module maps that token to the Instagram cookie jar, CSRF token and www-claim
for that account. Two consequences worth stating plainly:

  * The phone never has to reach instagram.com, which is the whole point.
  * Anyone with filesystem access to SESSION_DIR can act as the logged-in
    account, so run this on a host you control.
"""

import json
import os
import secrets
import threading
import time

from . import config


class Session:
    __slots__ = ("token", "cookies", "www_claim", "user_id", "username",
                 "created", "touched", "user_agent")

    def __init__(self, token, cookies=None, www_claim="0", user_id="",
                 username="", created=None, touched=None, user_agent=""):
        self.token = token
        self.cookies = cookies or {}
        self.www_claim = www_claim or "0"
        self.user_id = user_id
        self.username = username
        self.created = created or time.time()
        self.touched = touched or time.time()
        # The user-agent this session must be used with. A session adopted from
        # a browser is bound by Instagram to the browser that made it; sending
        # a different one is rejected as "useragent mismatch".
        self.user_agent = user_agent

    @property
    def csrf(self):
        return self.cookies.get("csrftoken", "")

    @property
    def authenticated(self):
        return bool(self.cookies.get("sessionid") and self.user_id)

    def to_dict(self):
        return {
            "token": self.token,
            "cookies": self.cookies,
            "www_claim": self.www_claim,
            "user_id": self.user_id,
            "username": self.username,
            "created": self.created,
            "touched": self.touched,
            "user_agent": self.user_agent,
        }

    @classmethod
    def from_dict(cls, raw):
        return cls(**{k: v for k, v in raw.items()
                      if k in ("token", "cookies", "www_claim", "user_id",
                               "username", "created", "touched", "user_agent")})


class SessionStore:
    def __init__(self, directory=None, ttl=None):
        self.dir = directory or config.SESSION_DIR
        self.ttl = ttl or config.SESSION_TTL
        self._lock = threading.RLock()
        self._cache = {}
        try:
            os.makedirs(self.dir, exist_ok=True)
        except OSError:
            self.dir = None  # read-only filesystem: memory-only is fine
        self._load()

    # -- persistence --------------------------------------------------------
    def _path(self, token):
        # Tokens are hex, so they are already safe as filenames; assert it
        # anyway rather than trusting a value that arrived over the wire.
        safe = "".join(c for c in token if c.isalnum())
        return os.path.join(self.dir, f"{safe}.json")

    def _load(self):
        if not self.dir:
            return
        try:
            names = os.listdir(self.dir)
        except OSError:
            return
        now = time.time()
        for name in names:
            if not name.endswith(".json"):
                continue
            try:
                with open(os.path.join(self.dir, name), "r") as fh:
                    session = Session.from_dict(json.load(fh))
            except Exception:
                continue
            if now - session.touched > self.ttl:
                self._unlink(session.token)
                continue
            self._cache[session.token] = session

    def _persist(self, session):
        if not self.dir:
            return
        try:
            path = self._path(session.token)
            tmp = path + ".tmp"
            with open(tmp, "w") as fh:
                json.dump(session.to_dict(), fh)
            os.replace(tmp, path)
            os.chmod(path, 0o600)
        except OSError:
            pass

    def _unlink(self, token):
        if not self.dir:
            return
        try:
            os.unlink(self._path(token))
        except OSError:
            pass

    # -- api ----------------------------------------------------------------
    def create(self):
        with self._lock:
            session = Session(secrets.token_hex(24))
            self._cache[session.token] = session
            self._persist(session)
            return session

    def get(self, token):
        if not token:
            return None
        with self._lock:
            session = self._cache.get(token)
            if not session:
                return None
            if time.time() - session.touched > self.ttl:
                self.drop(token)
                return None
            return session

    def save(self, session):
        with self._lock:
            session.touched = time.time()
            self._cache[session.token] = session
            self._persist(session)

    def drop(self, token):
        with self._lock:
            self._cache.pop(token, None)
            self._unlink(token)

    def __len__(self):
        with self._lock:
            return len(self._cache)

    def sweep(self):
        now = time.time()
        with self._lock:
            stale = [t for t, s in self._cache.items()
                     if now - s.touched > self.ttl]
            for token in stale:
                self.drop(token)
            return len(stale)


store = SessionStore()
