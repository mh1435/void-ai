"""Static file server for Void Arena on Render.

Render's existing service runs `python3 void_web_cloud.py`, so this file
keeps that entrypoint alive: it just serves the game (index.html + assets)
from the repo root.
"""

import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", 8080))
ROOT = os.path.dirname(os.path.abspath(__file__))


class GameHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # Always revalidate HTML so a deploy is picked up immediately. The HTML
        # references its scripts with ?v=N query strings, so once the browser
        # has the fresh HTML it fetches the current JS too. (Previously only
        # "/" and "/index.html" were no-cache, so 3d.html stayed cached and
        # kept loading stale script references — the "camera still shifted"
        # bug that survived deploys.)
        path = (self.path or "").split("?", 1)[0]
        if path in ("/", "") or path.endswith(".html"):
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # keep Render logs quiet


if __name__ == "__main__":
    print(f"Void Arena serving on port {PORT}")
    ThreadingHTTPServer(("", PORT), GameHandler).serve_forever()
