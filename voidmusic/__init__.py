"""Void Music — an offline-first player for openly-licensed recordings.

This package is the *optional* half of the app. The player is a static PWA
that talks straight to archive.org and works with no server at all; this
process exists for the case where that is impossible:

    your phone                  your server                  the open web
  ┌────────────┐  HTTPS to    ┌─────────────┐   HTTPS to   ┌──────────────┐
  │ Void Music │ ───────────► │   Python    │ ───────────► │ archive.org  │
  │    PWA     │ your-app.com │  (stdlib)   │              │ lrclib, CAA… │
  └────────────┘ ◄─────────── └─────────────┘ ◄─────────── └──────────────┘
        ▲                            ▲
   blocked network          somewhere the Archive
   only ever sees           is reachable
   your own host

An app on a phone cannot talk its way past a network block: if your ISP
filters archive.org by DNS, SNI or IP, every client on that device is
filtered with it. So the *server* — which you run somewhere the Archive is
reachable — makes every request, including the audio bytes themselves, and
the app only ever loads one hostname: yours.
"""

__version__ = "2.1.0"
