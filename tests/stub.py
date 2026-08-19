"""A stand-in for the upstream web, so tests never touch the network."""

import io

from voidmusic import netclient


class FakeStream(netclient.Stream):
    def __init__(self, status=200, headers=None, body=b""):
        super().__init__(status, headers or {}, io.BytesIO(body), "https://x/")


class Upstream:
    """Records what was asked for and answers with whatever you queued.

    Use as a context manager; it swaps netclient.stream out for the duration.
    """

    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []
        self._real = None

    def __enter__(self):
        self._real = netclient.stream
        netclient.stream = self._stream
        return self

    def __exit__(self, *exc):
        netclient.stream = self._real
        return False

    def _stream(self, method, url, *, headers=None, timeout=None,
                max_redirects=3, on_redirect=None):
        self.calls.append({"method": method, "url": url,
                           "headers": headers or {},
                           "on_redirect": on_redirect})
        if not self.responses:
            return FakeStream(200, {"content-length": "2",
                                    "content-type": "application/json"}, b"{}")
        answer = self.responses.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


def body_of(result):
    """The bytes a Result would put on the wire, streamed or not."""
    if result.chunks is not None:
        return b"".join(result.chunks)
    return result.body or b""
