"""Password encoding — the bug that made a correct password read as wrong.

The encryption round-trip (encode here, decrypt as Instagram would) needs
PyNaCl and cryptography. When they are absent the tests that need them skip,
but the fallback and wiring are always checked.
"""

import base64
import struct
import unittest

from loop import passwords


class PlaintextFallbackTests(unittest.TestCase):

    def test_plaintext_form_is_well_shaped(self):
        out = passwords.plaintext("hunter2", "1700000000")
        self.assertEqual("#PWD_INSTAGRAM_BROWSER:0:1700000000:hunter2", out)

    def test_encode_never_raises_even_with_no_key_reachable(self):
        # With no network and/or no libs, encode must still return something
        # usable rather than blowing up the whole sign-in.
        out = passwords.encode("pw", cookies={})
        self.assertTrue(out.startswith("#PWD_INSTAGRAM_BROWSER:"))
        self.assertIn("pw", out) if not passwords.ENCRYPTION_AVAILABLE else None


@unittest.skipUnless(passwords.ENCRYPTION_AVAILABLE,
                     "PyNaCl and cryptography not installed")
class EncryptionTests(unittest.TestCase):

    def _decrypt(self, enc, private_key):
        from nacl.public import SealedBox
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        prefix, ver, stamp, b64 = enc.split(":", 3)
        self.assertEqual("#PWD_INSTAGRAM_BROWSER", prefix)
        self.assertEqual("10", ver)
        blob = base64.b64decode(b64)
        self.assertEqual(1, blob[0])
        slen = struct.unpack("<H", blob[2:4])[0]
        sealed = blob[4:4 + slen]
        tag = blob[4 + slen:4 + slen + 16]
        ct = blob[4 + slen + 16:]
        session_key = SealedBox(private_key).decrypt(sealed)
        return AESGCM(session_key).decrypt(b"\x00" * 12, ct + tag, stamp.encode())

    def test_instagram_could_decrypt_what_we_produce(self):
        from nacl.public import PrivateKey
        priv = PrivateKey.generate()
        key = {"key_id": 42, "public_key": bytes(priv.public_key).hex(), "version": 10}
        enc = passwords.encrypted("café ☕ pÁssword", key, stamp="1700000000")
        self.assertEqual("café ☕ pÁssword", self._decrypt(enc, priv).decode("utf-8"))

    def test_the_key_id_is_carried_through(self):
        from nacl.public import PrivateKey
        priv = PrivateKey.generate()
        key = {"key_id": 200, "public_key": bytes(priv.public_key).hex()}
        enc = passwords.encrypted("x", key, stamp="1700000000")
        blob = base64.b64decode(enc.split(":", 3)[3])
        self.assertEqual(200, blob[1])


if __name__ == "__main__":
    unittest.main()
