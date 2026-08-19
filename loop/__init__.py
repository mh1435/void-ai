"""Loop — a self-hosted Instagram client.

The browser only ever talks to *this* server. This server talks to Instagram.
That indirection is the whole point: if instagram.com and its CDNs are blocked
by your ISP, they are still reachable from wherever this process runs.
"""

__version__ = "1.0.0"
