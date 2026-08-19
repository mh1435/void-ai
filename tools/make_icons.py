#!/usr/bin/env python3
"""Generate Void Music app icons as PNGs, with no third-party dependencies.

Writes the PWA icon set into assets/. Re-run after changing the palette:
    python3 tools/make_icons.py
"""
import math
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(os.path.dirname(HERE), "assets")

BG_OUTER = (11, 10, 19)
BG_INNER = (26, 20, 48)
RING_HOT = (167, 108, 255)
RING_COOL = (60, 214, 224)
GLYPH = (240, 238, 255)


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def over(dst, src, alpha):
    """Composite src onto dst with the given coverage in 0..1."""
    if alpha <= 0:
        return dst
    if alpha >= 1:
        return src
    return tuple(round(d + (s - d) * alpha) for d, s in zip(dst, src))


def coverage(dist, edge, feather=1.2):
    """Antialiased inside-ness: 1 well inside `edge`, 0 well outside."""
    return max(0.0, min(1.0, (edge - dist) / feather + 0.5))


def render(size, maskable=False):
    """Render one icon. Maskable variants keep art inside the safe zone."""
    cx = cy = (size - 1) / 2.0
    # Maskable icons get cropped to a circle by the launcher, so shrink the art.
    scale = 0.68 if maskable else 1.0
    disc_r = size * 0.5 * (1.0 if maskable else 0.94)
    ring_outer = size * 0.34 * scale
    ring_inner = size * 0.235 * scale
    tri_r = size * 0.15 * scale

    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            dx, dy = x - cx, y - cy
            dist = math.hypot(dx, dy)

            # Background: radial gradient from a lit centre out to near-black.
            t = min(1.0, dist / (size * 0.62))
            px = lerp(BG_INNER, BG_OUTER, t * t)

            if not maskable:
                # Round the square slightly so it looks right unmasked.
                px = over((0, 0, 0), px, coverage(dist, disc_r, 1.6))
            else:
                px = over(BG_OUTER, px, coverage(dist, disc_r, 1.6))

            # The "void" ring: an annulus whose hue sweeps with the angle.
            ang = math.atan2(dy, dx)
            sweep = (math.cos(ang - math.pi / 4) + 1) / 2
            ring_col = lerp(RING_COOL, RING_HOT, sweep)
            ring_cov = min(
                coverage(dist, ring_outer, 1.4),
                coverage(ring_inner, dist, 1.4),
            )
            # Fade the ring out at its tail for a sense of rotation.
            ring_cov *= 0.35 + 0.65 * sweep
            px = over(px, ring_col, ring_cov)

            # Play glyph: a triangle pointing right, nudged for optical centre.
            gx, gy = dx + tri_r * 0.28, dy
            inside_tri = (
                gx <= tri_r * 0.85
                and abs(gy) <= (tri_r - gx * 0.5) * 0.92
                and gx >= -tri_r
            )
            if inside_tri:
                # Distance to the nearest triangle edge, for cheap antialiasing.
                edge = min(
                    (tri_r * 0.85 - gx),
                    ((tri_r - gx * 0.5) * 0.92 - abs(gy)),
                )
                px = over(px, GLYPH, max(0.0, min(1.0, edge / 1.2 + 0.5)))

            row += bytes(px)
        rows.append(row)

    raw = b"".join(b"\x00" + bytes(r) for r in rows)
    return png_bytes(size, size, raw)


def png_bytes(w, h, raw):
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)  # 8-bit truecolour
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main():
    os.makedirs(ASSETS, exist_ok=True)
    targets = [
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-512.png", 512, True),
        ("apple-touch-icon.png", 180, True),
    ]
    for name, size, maskable in targets:
        path = os.path.join(ASSETS, name)
        with open(path, "wb") as fh:
            fh.write(render(size, maskable))
        print(f"wrote {path} ({size}x{size}{', maskable' if maskable else ''})")


if __name__ == "__main__":
    main()
