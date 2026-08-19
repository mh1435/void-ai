#!/usr/bin/env python3
"""Generate API fixtures for the Android core module's contract tests.

The Kotlin models in android/core must decode exactly what loop/instagram.py
emits. Rather than hand-maintaining two copies of the shape, this feeds
realistic raw Instagram payloads through the real normalisers and writes the
result to android/core/src/test/resources/.

Re-run it whenever a normaliser changes:

    python3 tools/gen_fixtures.py

If the Kotlin tests then fail, the contract moved and the models need updating.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Media URLs are HMAC-signed with LOOP_SECRET, which is random per process by
# design. Pin it here so the fixtures are byte-for-byte reproducible and CI can
# tell a real shape change from a fresh signing key. This value is only ever
# used to generate test data.
os.environ.setdefault("LOOP_SECRET", "fixtures-only-not-a-real-secret")

from loop import instagram  # noqa: E402

OUT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "android", "core", "src", "test", "resources",
)

CDN = "https://scontent-lhr8-1.cdninstagram.com"


def image_versions(width=1080, height=1350):
    return {"candidates": [
        {"url": f"{CDN}/v/small.jpg", "width": 320, "height": 400},
        {"url": f"{CDN}/v/large.jpg", "width": width, "height": height},
    ]}


def raw_user(pk="17841400000", name="alice"):
    return {
        "pk": pk, "username": name, "full_name": name.title(),
        "profile_pic_url": f"{CDN}/v/{name}.jpg", "is_verified": True,
    }


def raw_photo():
    return {
        "pk": "3200000000000000001", "code": "CxAbCdEfGhI", "media_type": 1,
        "taken_at": 1731000000, "like_count": 4321, "comment_count": 87,
        "has_liked": False, "has_viewer_saved": False,
        "user": raw_user(), "caption": {"text": "evening in @beirut #sunset"},
        "location": {"name": "Beirut, Lebanon"},
        "image_versions2": image_versions(),
        "original_width": 1080, "original_height": 1350,
        "accessibility_caption": "Photo of a sunset",
    }


def raw_carousel():
    child = {
        "pk": "child1", "media_type": 1,
        "image_versions2": image_versions(1080, 1080),
        "original_width": 1080, "original_height": 1080,
    }
    child2 = dict(child, pk="child2", media_type=2,
                  video_versions=[{"url": f"{CDN}/v/clip.mp4", "width": 720}])
    return {
        "pk": "3200000000000000002", "code": "CxCarousel", "media_type": 8,
        "taken_at": 1731000100, "like_count": 12, "comment_count": 0,
        "user": raw_user(), "caption": None,
        "carousel_media": [child, child2],
    }


def raw_clip():
    return {
        "pk": "3200000000000000003", "code": "CxReel", "media_type": 2,
        "taken_at": 1731000200, "like_count": 900000, "comment_count": 1200,
        "play_count": 4500000, "has_liked": True,
        "user": raw_user("17841400001", "bob"),
        "caption": {"text": "watch this"},
        "image_versions2": image_versions(720, 1280),
        "video_versions": [{"url": f"{CDN}/v/reel.mp4", "width": 720}],
        "original_width": 720, "original_height": 1280,
        "clips_metadata": {
            "music_info": {"music_asset_info": {
                "title": "Some Song", "display_artist": "Some Artist"}},
        },
    }


def write(name, payload):
    path = os.path.join(OUT, name)
    with open(path, "w") as fh:
        json.dump(payload, fh, indent=2, sort_keys=True)
    print(f"  {name:24} {os.path.getsize(path):>6} bytes")


def main():
    os.makedirs(OUT, exist_ok=True)
    print(f"writing fixtures to {OUT}")

    # A timeline carries media, ads and non-media blocks in the same array.
    feed_items = [
        {"media_or_ad": raw_photo()},
        {"media_or_ad": raw_carousel()},
        {"media_or_ad": raw_clip()},
        {"id": "suggested_users_xyz", "suggested_users": {"suggestions": []}},
    ]
    posts = [instagram.normalise_post(item.get("media_or_ad") or item)
             for item in feed_items]
    write("feed.json", {
        "posts": [p for p in posts if p],
        "next_max_id": "QVFB_page_two",
    })

    write("profile.json", {
        "user": {
            "id": "17841400000", "username": "alice", "full_name": "Alice",
            "biography": "photos\nand @things", "avatar": "/media?u=x&s=y",
            "is_private": False, "is_verified": True,
            "followed_by_viewer": False, "follows_viewer": True,
            "requested_by_viewer": False, "external_url": "https://example.com",
            "counts": {"posts": 214, "followers": 1200000, "following": 301},
        },
        "posts": [instagram.normalise_graphql({
            "id": "3200000000000000004", "shortcode": "CxGraph",
            "__typename": "GraphSidecar", "taken_at_timestamp": 1731000300,
            "owner": raw_user(), "display_url": f"{CDN}/v/g.jpg",
            "edge_media_to_caption": {"edges": [{"node": {"text": "hi"}}]},
            "edge_liked_by": {"count": 5}, "edge_media_to_comment": {"count": 2},
            "dimensions": {"width": 1080, "height": 1080},
            "edge_sidecar_to_children": {"edges": [
                {"node": {"display_url": f"{CDN}/v/a.jpg",
                          "dimensions": {"width": 1, "height": 1}}},
            ]},
        })],
        "next_max_id": None,
    })

    write("stories.json", {"tray": [
        {"id": "17841400001", "username": "bob", "avatar": "/media?u=b&s=c",
         "seen": False, "count": 3},
    ]})

    write("story.json", {
        "username": "bob", "avatar": "/media?u=b&s=c",
        "items": [
            instagram._normalise_story({
                "pk": "s1", "taken_at": 1731000400,
                "image_versions2": image_versions(720, 1280)}),
            instagram._normalise_story({
                "pk": "s2", "taken_at": 1731000500,
                "image_versions2": image_versions(720, 1280),
                "video_versions": [{"url": f"{CDN}/v/s.mp4"}],
                "video_duration": 11.4}),
        ],
    })

    write("comments.json", {
        "comments": [instagram._normalise_comment({
            "pk": "18000000000000000", "text": "beautiful @alice",
            "created_at": 1731000600, "comment_like_count": 14,
            "has_liked_comment": True,
            "user": {"username": "carol", "profile_pic_url": f"{CDN}/v/c.jpg",
                     "is_verified": False},
        })],
        "next_min_id": "cursor", "count": 87,
    })

    write("search.json", {
        "users": [{"id": "1", "username": "bob", "full_name": "Bob",
                   "avatar": "/media?u=b&s=c", "is_verified": False,
                   "is_private": True}],
        "hashtags": [{"name": "sunset", "count": 4200000}],
    })

    write("activity.json", {"items": [
        {"id": "1", "text": "bob liked your photo.", "timestamp": 1731000700,
         "avatar": "/media?u=b&s=c", "media": "/media?u=m&s=n", "new": True},
    ]})

    write("health.json", {
        "ok": True, "instagram_reachable": True, "detail": "HTTP 200",
        "upstream_proxy": False, "sessions": 2,
    })

    write("session.json", {
        "gate_required": True, "gate_open": True, "authenticated": True,
        "username": "alice", "user_id": "17841400000", "proxy": False,
    })

    write("two_factor.json", {
        "status": "two_factor", "identifier": "abc123",
        "username": "alice", "method": "app",
    })

    write("error.json", {
        "error": "Instagram is rate-limiting this server. Wait a few minutes.",
        "kind": "rate_limited",
    })


if __name__ == "__main__":
    main()
