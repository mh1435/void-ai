"""The normalisers are where Instagram's several response shapes become one.

Everything the client sees goes through here, so these tests are the closest
thing this project has to a spec.
"""

import unittest

from loop import instagram


def candidates(*sizes):
    return {"candidates": [
        {"url": f"https://scontent.cdninstagram.com/{w}.jpg", "width": w, "height": h}
        for w, h in sizes
    ]}


class NormalisePostTests(unittest.TestCase):

    def test_picks_the_largest_image_candidate(self):
        post = instagram.normalise_post({
            "pk": "1", "media_type": 1,
            "image_versions2": candidates((320, 400), (1080, 1350), (640, 800)),
        })
        self.assertIn("1080.jpg", post["slides"][0]["image"])

    def test_rewrites_every_url_through_the_media_proxy(self):
        post = instagram.normalise_post({
            "pk": "1", "media_type": 2,
            "user": {"username": "a",
                     "profile_pic_url": "https://scontent.cdninstagram.com/a.jpg"},
            "image_versions2": candidates((720, 1280)),
            "video_versions": [{"url": "https://scontent.cdninstagram.com/v.mp4"}],
        })
        self.assertTrue(post["slides"][0]["image"].startswith("/media?"))
        self.assertTrue(post["slides"][0]["video"].startswith("/media?"))
        self.assertTrue(post["user"]["avatar"].startswith("/media?"))
        self.assertTrue(post["thumb"].startswith("/media?"))

    def test_drops_entries_that_carry_no_media(self):
        # Timelines interleave suggested-user blocks and ad units with posts.
        self.assertIsNone(instagram.normalise_post({"id": "x", "suggested_users": {}}))
        self.assertIsNone(instagram.normalise_post({}))
        self.assertIsNone(instagram.normalise_post(None))
        self.assertIsNone(instagram.normalise_post({"media_type": 1}))  # no id

    def test_carousel_slides_keep_their_own_media(self):
        post = instagram.normalise_post({
            "pk": "1", "media_type": 8,
            "carousel_media": [
                {"pk": "a", "media_type": 1, "image_versions2": candidates((1080, 1080))},
                {"pk": "b", "media_type": 2,
                 "image_versions2": candidates((1080, 1080)),
                 "video_versions": [{"url": "https://scontent.cdninstagram.com/v.mp4"}]},
            ],
        })
        self.assertEqual("carousel", post["type"])
        self.assertEqual(2, len(post["slides"]))
        self.assertIsNone(post["slides"][0]["video"])
        self.assertIsNotNone(post["slides"][1]["video"])
        # The cover is the first slide, so a carousel is not "a video".
        self.assertIsNone(post["video"])

    def test_caption_shapes(self):
        base = {"pk": "1", "media_type": 1, "image_versions2": candidates((1, 1))}
        self.assertEqual("hi", instagram.normalise_post(
            dict(base, caption={"text": "hi"}))["caption"])
        self.assertEqual("", instagram.normalise_post(
            dict(base, caption=None))["caption"])
        self.assertEqual("edge", instagram.normalise_post(dict(
            base, edge_media_to_caption={"edges": [{"node": {"text": "edge"}}]},
        ))["caption"])

    def test_counts_default_to_zero_rather_than_none(self):
        post = instagram.normalise_post({
            "pk": "1", "media_type": 1, "image_versions2": candidates((1, 1)),
        })
        for key in ("like_count", "comment_count", "view_count", "taken_at"):
            self.assertEqual(0, post[key], key)
        self.assertEqual("", post["location"])
        self.assertIsNone(post["audio"])

    def test_audio_prefers_licensed_track_then_original(self):
        base = {"pk": "1", "media_type": 2,
                "image_versions2": candidates((1, 1)),
                "video_versions": [{"url": "https://scontent.cdninstagram.com/v.mp4"}]}

        licensed = instagram.normalise_post(dict(base, clips_metadata={
            "music_info": {"music_asset_info": {
                "title": "Track", "display_artist": "Artist"}}}))
        self.assertEqual({"title": "Track", "artist": "Artist"}, licensed["audio"])

        original = instagram.normalise_post(dict(base, clips_metadata={
            "original_sound_info": {"original_audio_title": "Original",
                                    "ig_artist": {"username": "someone"}}}))
        self.assertEqual({"title": "Original", "artist": "someone"}, original["audio"])


class NormaliseGraphqlTests(unittest.TestCase):

    def test_graphql_and_feed_shapes_agree(self):
        """A profile grid and a timeline must produce the same keys."""
        feed = instagram.normalise_post({
            "pk": "1", "media_type": 1, "image_versions2": candidates((1, 1)),
        })
        graph = instagram.normalise_graphql({
            "id": "1", "__typename": "GraphImage",
            "display_url": "https://scontent.cdninstagram.com/a.jpg",
            "dimensions": {"width": 1, "height": 1},
        })
        self.assertEqual(sorted(feed.keys()), sorted(graph.keys()))
        self.assertEqual(sorted(feed["slides"][0].keys()),
                         sorted(graph["slides"][0].keys()))

    def test_sidecar_becomes_a_carousel(self):
        post = instagram.normalise_graphql({
            "id": "1", "__typename": "GraphSidecar",
            "display_url": "https://scontent.cdninstagram.com/a.jpg",
            "edge_sidecar_to_children": {"edges": [
                {"node": {"display_url": "https://scontent.cdninstagram.com/1.jpg"}},
                {"node": {"display_url": "https://scontent.cdninstagram.com/2.jpg"}},
            ]},
        })
        self.assertEqual("carousel", post["type"])
        self.assertEqual(2, len(post["slides"]))

    def test_video_typename(self):
        post = instagram.normalise_graphql({
            "id": "1", "__typename": "GraphVideo", "is_video": True,
            "video_url": "https://scontent.cdninstagram.com/v.mp4",
            "display_url": "https://scontent.cdninstagram.com/a.jpg",
        })
        self.assertEqual("video", post["type"])
        self.assertTrue(post["video"].startswith("/media?"))


class StoryAndCommentTests(unittest.TestCase):

    def test_story_video_and_photo(self):
        photo = instagram._normalise_story({
            "pk": "1", "taken_at": 5, "image_versions2": candidates((1, 1))})
        self.assertFalse(photo["is_video"])
        self.assertIsNone(photo["video"])
        self.assertEqual(5, photo["duration"])  # falls back for photos

        video = instagram._normalise_story({
            "pk": "2", "image_versions2": candidates((1, 1)),
            "video_versions": [{"url": "https://scontent.cdninstagram.com/v.mp4"}],
            "video_duration": 9.5})
        self.assertTrue(video["is_video"])
        self.assertEqual(9.5, video["duration"])

    def test_comment_author_is_always_present(self):
        comment = instagram._normalise_comment({"pk": "1", "text": "hi"})
        self.assertEqual("", comment["user"]["username"])
        self.assertEqual("", comment["user"]["avatar"])
        self.assertFalse(comment["liked"])


if __name__ == "__main__":
    unittest.main()
