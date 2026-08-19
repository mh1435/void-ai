"""Compatibility entrypoint.

The Render service for this repo was created with `python3 void_web_cloud.py`
as its start command, which is baked into the service and not read from
render.yaml on every deploy. Keeping this shim means an existing deployment
picks up the music app without anyone having to touch the dashboard.
"""

from server import main

if __name__ == "__main__":
    main()
