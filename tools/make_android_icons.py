#!/usr/bin/env python3
"""Generate Android launcher icons from the same artwork as the web icons.

Writes the mipmap density buckets the APK needs:
    python3 tools/make_android_icons.py

Legacy square icons use the full-bleed artwork; the adaptive-icon foreground
uses the maskable variant, which keeps the glyph inside the safe zone that
launchers crop to.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from make_icons import render  # noqa: E402  (same-folder helper)

RES = os.path.join(os.path.dirname(HERE), "android", "app", "src", "main", "res")

# Android's launcher-icon buckets. 48dp base, scaled per density.
LEGACY = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}

# Adaptive foregrounds are 108dp with only the middle 72dp guaranteed visible.
ADAPTIVE = {
    "mipmap-mdpi": 108,
    "mipmap-hdpi": 162,
    "mipmap-xhdpi": 216,
    "mipmap-xxhdpi": 324,
    "mipmap-xxxhdpi": 432,
}


def main():
    for folder, size in LEGACY.items():
        path = os.path.join(RES, folder)
        os.makedirs(path, exist_ok=True)
        with open(os.path.join(path, "ic_launcher.png"), "wb") as fh:
            fh.write(render(size, maskable=False))
        with open(os.path.join(path, "ic_launcher_round.png"), "wb") as fh:
            fh.write(render(size, maskable=True))

    for folder, size in ADAPTIVE.items():
        path = os.path.join(RES, folder)
        os.makedirs(path, exist_ok=True)
        with open(os.path.join(path, "ic_launcher_foreground.png"), "wb") as fh:
            fh.write(render(size, maskable=True))

    print(f"wrote launcher icons into {RES}")


if __name__ == "__main__":
    main()
