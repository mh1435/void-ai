"""Encoding a password the way instagram.com encodes it.

Instagram's web app does not send passwords in the clear. It publishes a
Curve25519 public key, seals a fresh AES-256 key to it, encrypts the password
with AES-GCM under that key, and sends the bundle base64-encoded:

    #PWD_INSTAGRAM_BROWSER:10:<unix time>:<base64 payload>

    payload = 0x01                      version
              key_id                    which published key was used
              len(sealed) little-endian 2 bytes
              sealed                    AES key, sealed to Instagram's key
              tag                       16-byte AES-GCM tag
              ciphertext                the password

There is an older form, `:0:<time>:<password>`, that sends the password as
plain text inside the request body. It is what this project used at first, and
Instagram increasingly answers it with a refusal that gives no reason - which
is indistinguishable from a wrong password and sends people off retyping a
correct one. It stays here only as a fallback for installs without the crypto
libraries.
"""

import base64
import json
import os
import struct
import time

from . import netclient

# Both are optional. Without them the server still runs, still serves the app,
# and still signs in anywhere the old form is accepted.
try:
    from nacl.public import PublicKey, SealedBox
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    ENCRYPTION_AVAILABLE = True
except ImportError:  # pragma: no cover - depends on the install
    ENCRYPTION_AVAILABLE = False


SHARED_DATA = "https://www.instagram.com/data/shared_data/"

# The published key changes rarely; refetching it on every sign-in would be a
# needless round trip and a needless way to fail.
_cache = {"key": None, "fetched": 0.0}
_CACHE_TTL = 3600


class PasswordEncodingError(Exception):
    pass


def fetch_key(cookies=None, force=False):
    """Instagram's current public key, as {key_id, public_key, version}."""
    now = time.time()
    if not force and _cache["key"] and now - _cache["fetched"] < _CACHE_TTL:
        return _cache["key"]

    resp = netclient.request(
        "GET", SHARED_DATA,
        headers={"Accept": "application/json", "X-Requested-With": "XMLHttpRequest"},
        cookies=cookies or {},
    )
    try:
        body = json.loads(resp.body.decode("utf-8", "replace"))
    except ValueError as exc:
        raise PasswordEncodingError(
            "Instagram did not return its key material as JSON."
        ) from exc

    encryption = body.get("encryption") or {}
    if not encryption.get("public_key") or encryption.get("key_id") is None:
        raise PasswordEncodingError(
            "Instagram's response carried no public key to encrypt with."
        )

    _cache["key"] = encryption
    _cache["fetched"] = now
    return encryption


def encode(password, cookies=None):
    """Return an enc_password string, encrypted when that is possible."""
    stamp = str(int(time.time()))

    if not ENCRYPTION_AVAILABLE:
        return plaintext(password, stamp)

    try:
        key = fetch_key(cookies)
        return encrypted(password, key, stamp)
    except (PasswordEncodingError, netclient.HTTPError, Exception):
        # Falling back beats refusing to try: the old form still works in
        # places, and a failure here would otherwise block sign-in entirely.
        return plaintext(password, stamp)


def plaintext(password, stamp=None):
    stamp = stamp or str(int(time.time()))
    return f"#PWD_INSTAGRAM_BROWSER:0:{stamp}:{password}"


def encrypted(password, key, stamp=None):
    """Build the :10: form. `key` is the dict returned by [fetch_key]."""
    if not ENCRYPTION_AVAILABLE:
        raise PasswordEncodingError("nacl and cryptography are not installed")

    stamp = stamp or str(int(time.time()))
    key_id = int(key["key_id"])
    public_key = bytes.fromhex(key["public_key"])

    session_key = os.urandom(32)
    sealed = SealedBox(PublicKey(public_key)).encrypt(session_key)

    # A zero IV is safe here only because the AES key is fresh for every
    # single password, which is what the web app does too.
    iv = b"\x00" * 12
    combined = AESGCM(session_key).encrypt(
        iv, password.encode("utf-8"), stamp.encode("ascii")
    )
    ciphertext, tag = combined[:-16], combined[-16:]

    payload = (
        bytes([1, key_id])
        + struct.pack("<H", len(sealed))
        + sealed
        + tag
        + ciphertext
    )
    return f"#PWD_INSTAGRAM_BROWSER:10:{stamp}:{base64.b64encode(payload).decode()}"
