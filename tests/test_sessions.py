"""Sessions hold the Instagram cookies, so their lifecycle is security-relevant."""

import os
import shutil
import tempfile
import time
import unittest

from loop.sessions import Session, SessionStore


class SessionStoreTests(unittest.TestCase):

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.store = SessionStore(directory=self.dir, ttl=3600)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_a_new_session_is_unauthenticated(self):
        session = self.store.create()
        self.assertFalse(session.authenticated)
        self.assertEqual("", session.csrf)
        self.assertEqual(48, len(session.token))

    def test_authenticated_requires_both_cookie_and_user(self):
        session = self.store.create()
        session.cookies["sessionid"] = "abc"
        self.assertFalse(session.authenticated)
        session.user_id = "7"
        self.assertTrue(session.authenticated)

    def test_sessions_survive_a_restart(self):
        session = self.store.create()
        session.cookies = {"sessionid": "abc", "csrftoken": "tok"}
        session.user_id = "7"
        session.username = "alice"
        self.store.save(session)

        reopened = SessionStore(directory=self.dir, ttl=3600)
        restored = reopened.get(session.token)
        self.assertIsNotNone(restored)
        self.assertEqual("alice", restored.username)
        self.assertEqual("tok", restored.csrf)

    def test_session_files_are_not_world_readable(self):
        session = self.store.create()
        self.store.save(session)
        path = os.path.join(self.dir, f"{session.token}.json")
        self.assertEqual(0o600, os.stat(path).st_mode & 0o777)

    def test_an_expired_session_is_dropped_on_read(self):
        session = self.store.create()
        session.touched = time.time() - 7200
        self.store.save(session)
        self.store._cache[session.token].touched = time.time() - 7200

        self.assertIsNone(self.store.get(session.token))
        self.assertFalse(os.path.exists(os.path.join(self.dir, f"{session.token}.json")))

    def test_unknown_and_empty_tokens_return_nothing(self):
        self.assertIsNone(self.store.get(""))
        self.assertIsNone(self.store.get(None))
        self.assertIsNone(self.store.get("does-not-exist"))

    def test_drop_removes_the_file_too(self):
        session = self.store.create()
        self.store.save(session)
        self.store.drop(session.token)
        self.assertIsNone(self.store.get(session.token))
        self.assertEqual(0, len(self.store))

    def test_a_token_from_the_wire_cannot_escape_the_session_directory(self):
        """Tokens arrive in a cookie, so the path they build must be inert."""
        path = self.store._path("../../etc/passwd")
        self.assertEqual(self.dir, os.path.dirname(path))
        self.assertNotIn("..", path)

    def test_sweep_clears_only_stale_sessions(self):
        fresh = self.store.create()
        stale = self.store.create()
        self.store._cache[stale.token].touched = time.time() - 7200

        self.assertEqual(1, self.store.sweep())
        self.assertIsNotNone(self.store.get(fresh.token))
        self.assertIsNone(self.store.get(stale.token))

    def test_a_read_only_directory_degrades_to_memory(self):
        store = SessionStore(directory="/proc/nonexistent-loop", ttl=60)
        session = store.create()
        self.assertIsNotNone(store.get(session.token))

    def test_corrupt_files_are_skipped_rather_than_crashing_startup(self):
        with open(os.path.join(self.dir, "garbage.json"), "w") as fh:
            fh.write("{not json")
        store = SessionStore(directory=self.dir, ttl=3600)
        self.assertEqual(0, len(store))


class SessionSerialisationTests(unittest.TestCase):

    def test_round_trip(self):
        session = Session("tok", cookies={"a": "b"}, www_claim="hmac.x",
                          user_id="7", username="alice")
        restored = Session.from_dict(session.to_dict())
        self.assertEqual(session.to_dict(), restored.to_dict())

    def test_the_password_is_never_part_of_a_session(self):
        session = Session("tok")
        self.assertNotIn("password", session.to_dict())
        self.assertNotIn("password", Session.__slots__)


if __name__ == "__main__":
    unittest.main()
