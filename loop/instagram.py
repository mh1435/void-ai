"""Bindings for Instagram's web API, plus normalisation into one clean shape.

Instagram's web app calls a private JSON API at instagram.com/api/v1/*. It is
not documented and not stable — endpoints move and response shapes differ
between them (a profile grid comes back as GraphQL edges, a timeline comes
back as `items`). Everything here funnels into `normalise_post`, so the
frontend only ever sees one post shape.
"""

import json
import sys
import time
import urllib.parse

from . import config, mediaproxy, netclient, passwords

BASE = "https://www.instagram.com"
API = BASE + "/api/v1"


class InstagramError(Exception):
    def __init__(self, message, kind="error", status=0, payload=None):
        super().__init__(message)
        self.kind = kind          # error | login_required | challenge | rate_limited
        self.status = status
        self.payload = payload or {}


class LoginRequired(InstagramError):
    def __init__(self, message="Instagram wants you to sign in again."):
        super().__init__(message, kind="login_required", status=401)


# --------------------------------------------------------------------------
# request plumbing
# --------------------------------------------------------------------------

def _headers(session, extra=None, referer=BASE + "/"):
    headers = {
        "X-IG-App-ID": config.IG_APP_ID,
        "X-ASBD-ID": config.IG_ASBD_ID,
        "X-IG-WWW-Claim": session.www_claim or "0",
        "X-Requested-With": "XMLHttpRequest",
        # instagram.com sends this on every XHR; its absence is one of the
        # cheaper ways to look like something other than the web app.
        "X-Instagram-AJAX": "1",
        "Referer": referer,
        "Origin": BASE,
        "Accept": "*/*",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
    }
    if session.csrf:
        headers["X-CSRFToken"] = session.csrf
    if extra:
        headers.update(extra)
    return headers


def call(session, method, path, *, params=None, data=None, headers=None,
         referer=BASE + "/", store=None):
    """Call an api/v1 endpoint with this session's cookies, and fold any
    cookie / www-claim updates back into the session."""
    url = path if path.startswith("http") else API + path
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)

    resp = netclient.request(
        method, url,
        headers=_headers(session, headers, referer),
        data=data,
        cookies=session.cookies,
    )

    dirty = False
    if resp.cookies:
        session.cookies.update(resp.cookies)
        dirty = True
    claim = resp.headers.get("x-ig-set-www-claim")
    if claim and claim != session.www_claim:
        session.www_claim = claim
        dirty = True
    if dirty and store is not None:
        store.save(session)

    # Parse once, up front. Instagram explains itself in the body even on a
    # 400, and discarding that leaves nothing to debug but a status code.
    payload = _try_json(resp)

    if config.DEBUG and not resp.ok:
        print(f"[loop] {method} {url} -> {resp.status} {resp.body[:600]!r}",
              file=sys.stderr)

    if _is_challenge(payload):
        raise InstagramError(
            "Instagram flagged this sign-in and wants you to confirm it in "
            "the official app or on the web, then try again.",
            kind="challenge", status=resp.status, payload=payload or {},
        )

    if resp.status == 429 or (payload or {}).get("message") == "rate_limited":
        raise InstagramError(
            "Instagram is rate-limiting this server. Wait a few minutes, or "
            "set UPSTREAM_PROXY if this keeps happening — shared datacenter "
            "addresses get throttled hard.",
            kind="rate_limited", status=429,
        )

    if resp.status in (401, 403):
        raise LoginRequired(_instagram_message(payload) or LoginRequired().args[0])

    if not resp.ok:
        # Surface Instagram's own words. "HTTP 400" alone is not actionable
        # by anyone, including whoever is reading the source.
        detail = _instagram_message(payload)
        raise InstagramError(
            f"Instagram rejected the request ({resp.status})."
            + (f" It said: {detail}" if detail else
               " It sent no explanation, which usually means a required field "
               "or header has changed."),
            status=resp.status, payload=payload or {},
        )

    if payload is None:
        raise InstagramError(
            "Instagram returned something that was not JSON — the endpoint has "
            "probably changed.", status=resp.status,
        )
    return payload


def _instagram_message(payload):
    """The most human-readable thing in an Instagram error body."""
    if not isinstance(payload, dict):
        return ""
    for key in ("message", "error_message", "feedback_message", "title"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    errors = payload.get("errors")
    if isinstance(errors, dict):
        for values in errors.values():
            if isinstance(values, list) and values:
                return str(values[0])
    return ""


def _is_challenge(payload):
    if not isinstance(payload, dict):
        return False
    if payload.get("message") == "checkpoint_required":
        return True
    return bool(payload.get("checkpoint_url") or payload.get("challenge"))


def _try_json(resp):
    ctype = resp.headers.get("content-type", "")
    if "json" not in ctype and not resp.body.strip().startswith(b"{"):
        return None
    try:
        return resp.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None


# --------------------------------------------------------------------------
# auth
# --------------------------------------------------------------------------

def bootstrap(session, store=None):
    """Pick up the csrftoken / mid / ig_did cookies a login needs.

    Without a csrftoken the login endpoint rejects the request before it ever
    looks at the credentials, and the rejection says nothing useful. Several
    sources are tried because which one hands over a token varies by edge and
    by how the address is regarded.
    """
    attempts = (
        (BASE + "/", {"Accept": "text/html,application/xhtml+xml"}),
        (BASE + "/accounts/login/", {"Accept": "text/html,application/xhtml+xml"}),
    )
    for url, extra in attempts:
        try:
            resp = netclient.request(
                "GET", url,
                headers=dict(extra, **{"Accept-Language": "en-US,en;q=0.9"}),
                cookies=session.cookies,
            )
        except netclient.HTTPError:
            continue
        session.cookies.update(resp.cookies)
        if session.cookies.get("csrftoken"):
            break

    if not session.cookies.get("csrftoken"):
        # Some edges hand the token over only in shared_data's JSON.
        try:
            shared = netclient.request(
                "GET", BASE + "/data/shared_data/",
                headers=_headers(session), cookies=session.cookies,
            )
            session.cookies.update(shared.cookies)
            body = _try_json(shared) or {}
            token = (body.get("config") or {}).get("csrf_token")
            if token:
                session.cookies["csrftoken"] = token
        except netclient.HTTPError:
            pass

    if store is not None:
        store.save(session)
    return bool(session.cookies.get("csrftoken"))


def _enc_password(session, password):
    # Encrypts the password the way instagram.com does when the crypto
    # libraries are present, and falls back to the older plaintext form when
    # they are not. The password is held only for the length of this call;
    # nothing writes it to disk or to the log.
    return passwords.encode(password, session.cookies)


def login(session, username, password, store=None):
    if not session.cookies.get("csrftoken"):
        bootstrap(session, store)

    # Sending the login without one gets a bare 400 that blames nothing.
    # Say what is actually missing instead.
    if not session.cookies.get("csrftoken"):
        raise InstagramError(
            "This server could reach Instagram but Instagram would not issue "
            "it a session token, so the sign-in cannot even be attempted. That "
            "usually means the address it is running from is being refused — "
            "set UPSTREAM_PROXY, or host it somewhere with its own IP.",
            kind="no_csrf",
        )

    payload = call(
        session, "POST", "/web/accounts/login/ajax/",
        data={
            "username": username,
            "enc_password": _enc_password(session, password),
            "queryParams": "{}",
            "optIntoOneTap": "false",
            "trustedDeviceRecords": "{}",
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        referer=BASE + "/accounts/login/",
        store=store,
    )

    if payload.get("two_factor_required"):
        info = payload.get("two_factor_info") or {}
        return {
            "status": "two_factor",
            "identifier": info.get("two_factor_identifier", ""),
            "username": info.get("username", username),
            "method": _two_factor_method(info),
        }

    if payload.get("authenticated"):
        session.user_id = str(payload.get("userId") or payload.get("user_id") or "")
        session.username = username
        if store is not None:
            store.save(session)
        return {"status": "ok", "user_id": session.user_id, "username": username}

    if payload.get("user") is False:
        raise InstagramError("No account with that username.", kind="bad_user")
    if payload.get("message") == "checkpoint_required":
        raise InstagramError(
            "Instagram wants to verify this login. Open the official app or "
            "instagram.com once, approve the login, then try again.",
            kind="challenge", payload=payload,
        )

    if config.DEBUG:
        # The password is not in this payload; the response to a refused login
        # carries only flags and, sometimes, a reason.
        print(f"[loop] login refused for {username}: {json.dumps(payload)}",
              file=sys.stderr)

    message = _instagram_message(payload)
    if message:
        raise InstagramError(message, kind="bad_password", payload=payload)

    # Instagram answers a refused login with authenticated:false and no reason,
    # and it does that for a wrong password, a disabled account, and a password
    # it could not decode alike. Saying "wrong password" here was a guess
    # dressed up as a fact, and it sends people off retyping a correct one.
    raise InstagramError(
        "Instagram refused the sign-in without saying why. That answer covers "
        "three different things: the password really is wrong, the account is "
        "disabled, or this server encoded the password in a way Instagram no "
        "longer accepts. Set LOOP_DEBUG=1 on the server and try once more - the "
        "log will show which.",
        kind="login_refused", payload=payload,
    )


def _two_factor_method(info):
    if info.get("totp_two_factor_on"):
        return "app"
    if info.get("sms_two_factor_on"):
        return "sms"
    return "code"


def two_factor(session, username, identifier, code, store=None):
    payload = call(
        session, "POST", "/web/accounts/login/ajax/two_factor/",
        data={
            "username": username,
            "identifier": identifier,
            "verificationCode": code.strip().replace(" ", ""),
            "verification_method": "3",
            "trust_signal": "true",
        },
        referer=BASE + "/accounts/login/two_factor/",
        store=store,
    )
    if payload.get("authenticated"):
        session.user_id = str(payload.get("userId") or payload.get("user_id") or "")
        session.username = username
        if store is not None:
            store.save(session)
        return {"status": "ok", "user_id": session.user_id, "username": username}
    raise InstagramError(
        payload.get("message") or "That code was not accepted.",
        kind="bad_code",
    )


def logout(session, store=None):
    try:
        call(session, "POST", "/web/accounts/logout/ajax/",
             data={"one_tap_app_login": "0"}, store=store)
    except (InstagramError, netclient.HTTPError):
        pass  # dropping our copy of the session is what actually matters
    session.cookies = {}
    session.user_id = ""
    session.username = ""
    session.www_claim = "0"


def current_user(session, store=None):
    payload = call(session, "GET", "/accounts/edit/web_form_data/", store=store)
    form = (payload.get("form_data") or {})
    return {
        "username": form.get("username") or session.username,
        "full_name": form.get("first_name", ""),
        "biography": form.get("biography", ""),
        "user_id": session.user_id,
    }


# --------------------------------------------------------------------------
# reading
# --------------------------------------------------------------------------

def timeline(session, max_id=None, store=None):
    data = {"reason": "cold_start_fetch" if not max_id else "pagination"}
    if max_id:
        data["max_id"] = max_id
    payload = call(session, "POST", "/feed/timeline/", data=data, store=store)
    posts = [normalise_post(item.get("media_or_ad") or item)
             for item in payload.get("feed_items", [])
             if (item.get("media_or_ad") or item.get("id"))]
    return {
        "posts": [p for p in posts if p],
        "next_max_id": payload.get("next_max_id") if payload.get("more_available") else None,
    }


def stories_tray(session, store=None):
    payload = call(session, "GET", "/feed/reels_tray/", store=store)
    tray = []
    for item in payload.get("tray", []):
        user = item.get("user") or {}
        tray.append({
            "id": str(item.get("id") or user.get("pk") or ""),
            "username": user.get("username", ""),
            "avatar": mediaproxy.wrap(user.get("profile_pic_url", "")),
            "seen": bool(item.get("seen") and item.get("seen") >= item.get("latest_reel_media", 0)),
            "count": item.get("media_count", 0),
        })
    return {"tray": tray}


def story_reel(session, reel_id, store=None):
    payload = call(session, "GET", "/feed/reels_media/",
                   params={"reel_ids": reel_id}, store=store)
    reels = payload.get("reels") or payload.get("reels_media") or {}
    reel = reels.get(str(reel_id)) if isinstance(reels, dict) else None
    if not reel and isinstance(reels, list) and reels:
        reel = reels[0]
    if not reel:
        return {"items": []}
    user = reel.get("user") or {}
    return {
        "username": user.get("username", ""),
        "avatar": mediaproxy.wrap(user.get("profile_pic_url", "")),
        "items": [_normalise_story(item) for item in reel.get("items", [])],
    }


def _normalise_story(item):
    videos = item.get("video_versions") or []
    return {
        "id": str(item.get("pk") or item.get("id") or ""),
        "taken_at": item.get("taken_at", 0),
        "is_video": bool(videos),
        "image": mediaproxy.wrap(_best_image(item)),
        "video": mediaproxy.wrap(videos[0]["url"]) if videos else None,
        "duration": item.get("video_duration") or 5,
    }


def profile(session, username, store=None):
    payload = call(
        session, "GET", "/users/web_profile_info/",
        params={"username": username},
        referer=f"{BASE}/{username}/",
        store=store,
    )
    user = ((payload.get("data") or {}).get("user")) or {}
    if not user:
        raise InstagramError(f"No account called @{username}.", kind="not_found",
                             status=404)
    grid = user.get("edge_owner_to_timeline_media") or {}
    page = grid.get("page_info") or {}
    return {
        "user": {
            "id": str(user.get("id", "")),
            "username": user.get("username", ""),
            "full_name": user.get("full_name", ""),
            "biography": user.get("biography", ""),
            "avatar": mediaproxy.wrap(
                user.get("profile_pic_url_hd") or user.get("profile_pic_url", "")),
            "is_private": bool(user.get("is_private")),
            "is_verified": bool(user.get("is_verified")),
            "followed_by_viewer": bool(user.get("followed_by_viewer")),
            "follows_viewer": bool(user.get("follows_viewer")),
            "requested_by_viewer": bool(user.get("requested_by_viewer")),
            "external_url": user.get("external_url") or "",
            "counts": {
                "posts": grid.get("count", 0),
                "followers": (user.get("edge_followed_by") or {}).get("count", 0),
                "following": (user.get("edge_follow") or {}).get("count", 0),
            },
        },
        "posts": [normalise_graphql(edge.get("node") or {})
                  for edge in grid.get("edges", [])],
        "next_max_id": page.get("end_cursor") if page.get("has_next_page") else None,
    }


def user_feed(session, user_id, max_id=None, store=None):
    params = {"count": 12}
    if max_id:
        params["max_id"] = max_id
    payload = call(session, "GET", f"/feed/user/{user_id}/", params=params,
                   store=store)
    return {
        "posts": [normalise_post(i) for i in payload.get("items", [])],
        "next_max_id": payload.get("next_max_id") if payload.get("more_available") else None,
    }


def media_info(session, media_id, store=None):
    payload = call(session, "GET", f"/media/{media_id}/info/", store=store)
    items = payload.get("items") or []
    if not items:
        raise InstagramError("That post is gone.", kind="not_found", status=404)
    return normalise_post(items[0])


def media_by_shortcode(session, shortcode, store=None):
    """Resolve a /p/<shortcode>/ link, which is what shared links look like."""
    payload = call(
        session, "GET", f"{BASE}/p/{shortcode}/",
        params={"__a": 1, "__d": "dis"},
        referer=f"{BASE}/p/{shortcode}/",
        store=store,
    )
    items = payload.get("items") or []
    if items:
        return normalise_post(items[0])
    node = ((payload.get("graphql") or {}).get("shortcode_media")) or {}
    if node:
        return normalise_graphql(node)
    raise InstagramError("Could not open that post.", kind="not_found", status=404)


def comments(session, media_id, min_id=None, store=None):
    params = {"can_support_threading": "true", "permalink_enabled": "false"}
    if min_id:
        params["min_id"] = min_id
    payload = call(session, "GET", f"/media/{media_id}/comments/",
                   params=params, store=store)
    return {
        "comments": [_normalise_comment(c) for c in payload.get("comments", [])],
        "next_min_id": payload.get("next_min_id"),
        "count": payload.get("comment_count", 0),
    }


def _normalise_comment(raw):
    user = raw.get("user") or {}
    return {
        "id": str(raw.get("pk") or ""),
        "text": raw.get("text", ""),
        "created_at": raw.get("created_at", 0),
        "like_count": raw.get("comment_like_count", 0),
        "liked": bool(raw.get("has_liked_comment")),
        "user": {
            "username": user.get("username", ""),
            "avatar": mediaproxy.wrap(user.get("profile_pic_url", "")),
            "is_verified": bool(user.get("is_verified")),
        },
    }


def explore(session, max_id=None, store=None):
    params = {"is_prefetch": "false", "omit_cover_media": "true",
              "module": "explore_popular", "use_sectional_payload": "true"}
    if max_id:
        params["max_id"] = max_id
    payload = call(session, "GET", "/discover/web/explore_grid/", params=params,
                   referer=BASE + "/explore/", store=store)
    posts = []
    for section in payload.get("sectional_items", []):
        medias = ((section.get("layout_content") or {}).get("medias")) or []
        for entry in medias:
            post = normalise_post(entry.get("media") or {})
            if post:
                posts.append(post)
    if not posts:  # older shape
        for item in payload.get("items", []):
            post = normalise_post(item.get("media") or item)
            if post:
                posts.append(post)
    return {
        "posts": posts,
        "next_max_id": payload.get("next_max_id") if payload.get("more_available") else None,
    }


def clips(session, max_id=None, store=None):
    data = {"container_module": "clips_viewer_clips_tab"}
    if max_id:
        data["max_id"] = max_id
    payload = call(session, "POST", "/clips/home/", data=data,
                   referer=BASE + "/reels/", store=store)
    posts = []
    for item in payload.get("items", []):
        post = normalise_post(item.get("media") or item)
        if post and post.get("video"):
            posts.append(post)
    paging = payload.get("paging_info") or {}
    return {
        "posts": posts,
        "next_max_id": paging.get("max_id") if paging.get("more_available") else None,
    }


def search(session, query, store=None):
    payload = call(session, "GET", "/web/search/topsearch/",
                   params={"context": "blended", "query": query,
                           "include_reel": "true"},
                   store=store)
    users = []
    for entry in payload.get("users", []):
        user = entry.get("user") or {}
        users.append({
            "id": str(user.get("pk", "")),
            "username": user.get("username", ""),
            "full_name": user.get("full_name", ""),
            "avatar": mediaproxy.wrap(user.get("profile_pic_url", "")),
            "is_verified": bool(user.get("is_verified")),
            "is_private": bool(user.get("is_private")),
        })
    hashtags = [{
        "name": (h.get("hashtag") or {}).get("name", ""),
        "count": (h.get("hashtag") or {}).get("media_count", 0),
    } for h in payload.get("hashtags", [])]
    return {"users": users, "hashtags": hashtags}


def hashtag(session, name, store=None):
    payload = call(session, "GET", "/tags/web_info/",
                   params={"tag_name": name},
                   referer=f"{BASE}/explore/tags/{name}/", store=store)
    data = payload.get("data") or {}
    posts = []
    for key in ("top", "recent"):
        section = data.get(key) or {}
        for entry in section.get("sections", []):
            for media in ((entry.get("layout_content") or {}).get("medias")) or []:
                post = normalise_post(media.get("media") or {})
                if post:
                    posts.append(post)
    return {
        "name": name,
        "count": data.get("media_count", 0),
        "posts": posts,
    }


def activity(session, store=None):
    payload = call(session, "GET", "/news/inbox/", store=store)
    items = []
    for story in payload.get("new_stories", []) + payload.get("old_stories", []):
        args = story.get("args") or {}
        items.append({
            "id": str(story.get("pk", "")),
            "text": (args.get("text") or ""),
            "timestamp": args.get("timestamp", 0),
            "avatar": mediaproxy.wrap(
                ((args.get("profile_image") or "")) or ""),
            "media": mediaproxy.wrap(
                ((args.get("media") or [{}])[0].get("image") or "")),
            "new": story in payload.get("new_stories", []),
        })
    return {"items": items}


# --------------------------------------------------------------------------
# writing
# --------------------------------------------------------------------------

def _action(session, path, store=None, data=None):
    payload = call(session, "POST", path, data=data or {"container_module": "feed_timeline"},
                   store=store)
    if payload.get("status") != "ok":
        raise InstagramError(payload.get("message") or "Instagram refused that.")
    return payload


def like(session, media_id, on=True, store=None):
    verb = "like" if on else "unlike"
    _action(session, f"/web/likes/{media_id}/{verb}/", store)
    return {"liked": on}


def save(session, media_id, on=True, store=None):
    verb = "save" if on else "unsave"
    _action(session, f"/web/save/{media_id}/{verb}/", store)
    return {"saved": on}


def follow(session, user_id, on=True, store=None):
    verb = "follow" if on else "unfollow"
    payload = _action(session, f"/web/friendships/{user_id}/{verb}/", store)
    return {
        "following": bool(payload.get("following", on)),
        "requested": bool(payload.get("outgoing_request")),
    }


def add_comment(session, media_id, text, replied_to=None):
    data = {"comment_text": text}
    if replied_to:
        data["replied_to_comment_id"] = replied_to
    payload = call(session, "POST", f"/web/comments/{media_id}/add/", data=data)
    if payload.get("status") != "ok":
        raise InstagramError(payload.get("message") or "Comment was rejected.")
    return _normalise_comment(payload)


def delete_comment(session, media_id, comment_id):
    call(session, "POST", f"/web/comments/{media_id}/delete/{comment_id}/")
    return {"deleted": True}


# --------------------------------------------------------------------------
# normalisation — every reader above ends here
# --------------------------------------------------------------------------

def _best_image(node):
    """Pick the largest candidate Instagram offers for an image."""
    versions = ((node.get("image_versions2") or {}).get("candidates")) or []
    if versions:
        best = max(versions, key=lambda c: c.get("width", 0) or 0)
        return best.get("url", "")
    return node.get("display_url") or node.get("thumbnail_src") or ""


def _media_type(node):
    kind = node.get("media_type")
    if kind == 2:
        return "video"
    if kind == 8:
        return "carousel"
    typename = node.get("__typename") or ""
    if typename == "GraphVideo" or node.get("is_video"):
        return "video"
    if typename == "GraphSidecar":
        return "carousel"
    return "image"


def _caption(node):
    caption = node.get("caption")
    if isinstance(caption, dict):
        return caption.get("text", "")
    edges = ((node.get("edge_media_to_caption") or {}).get("edges")) or []
    if edges:
        return ((edges[0].get("node") or {}).get("text")) or ""
    return caption if isinstance(caption, str) else ""


def _user(node):
    user = node.get("user") or node.get("owner") or {}
    return {
        "id": str(user.get("pk") or user.get("id") or ""),
        "username": user.get("username", ""),
        "full_name": user.get("full_name", ""),
        "avatar": mediaproxy.wrap(user.get("profile_pic_url", "")),
        "is_verified": bool(user.get("is_verified")),
    }


def normalise_post(node):
    """Turn one `items[]`-shaped media object into the frontend's post shape."""
    if not node or not isinstance(node, dict):
        return None
    media_id = str(node.get("pk") or node.get("id") or "")
    if not media_id:
        return None
    # Timelines also carry suggested-user blocks and ad units. They have an id
    # but no media, and would otherwise render as an empty card.
    if not (node.get("image_versions2") or node.get("carousel_media")
            or node.get("video_versions") or node.get("display_url")):
        return None

    kind = _media_type(node)
    slides = []
    if kind == "carousel":
        for child in node.get("carousel_media") or []:
            slides.append(_slide(child))
    else:
        slides.append(_slide(node))

    return {
        "id": media_id,
        "shortcode": node.get("code") or node.get("shortcode") or "",
        "type": kind,
        "user": _user(node),
        "caption": _caption(node),
        "taken_at": node.get("taken_at") or node.get("taken_at_timestamp") or 0,
        "like_count": node.get("like_count") if node.get("like_count") is not None
                      else ((node.get("edge_media_preview_like") or {}).get("count", 0)),
        "comment_count": node.get("comment_count") if node.get("comment_count") is not None
                         else ((node.get("edge_media_to_comment") or {}).get("count", 0)),
        "view_count": node.get("play_count") or node.get("view_count") or 0,
        "liked": bool(node.get("has_liked")),
        "saved": bool(node.get("has_viewer_saved")),
        "location": ((node.get("location") or {}).get("name")) or "",
        "slides": slides,
        # Convenience for the reels view, which only ever wants one video.
        "video": slides[0].get("video") if slides and slides[0].get("video") else None,
        "thumb": slides[0].get("image") if slides else "",
        "audio": _audio(node),
    }


def _slide(node):
    videos = node.get("video_versions") or []
    video_url = videos[0]["url"] if videos else node.get("video_url")
    return {
        "image": mediaproxy.wrap(_best_image(node)),
        "video": mediaproxy.wrap(video_url) if video_url else None,
        "width": ((node.get("original_width") or node.get("dimensions", {}).get("width")) or 0),
        "height": ((node.get("original_height") or node.get("dimensions", {}).get("height")) or 0),
        "alt": node.get("accessibility_caption") or "",
    }


def _audio(node):
    clip = node.get("clips_metadata") or {}
    music = (clip.get("music_info") or {}).get("music_asset_info") or {}
    if music:
        return {
            "title": music.get("title", ""),
            "artist": music.get("display_artist", ""),
        }
    original = clip.get("original_sound_info") or {}
    if original:
        return {
            "title": original.get("original_audio_title") or "Original audio",
            "artist": ((original.get("ig_artist") or {}).get("username")) or "",
        }
    return None


def normalise_graphql(node):
    """Same output shape, from the GraphQL `edges[].node` form used by profiles."""
    if not node:
        return None
    children = ((node.get("edge_sidecar_to_children") or {}).get("edges")) or []
    slides = ([_slide(edge.get("node") or {}) for edge in children]
              if children else [_slide(node)])
    return {
        "id": str(node.get("id", "")),
        "shortcode": node.get("shortcode", ""),
        "type": _media_type(node),
        "user": _user(node),
        "caption": _caption(node),
        "taken_at": node.get("taken_at_timestamp", 0),
        "like_count": (node.get("edge_liked_by") or
                       node.get("edge_media_preview_like") or {}).get("count", 0),
        "comment_count": (node.get("edge_media_to_comment") or {}).get("count", 0),
        "view_count": node.get("video_view_count", 0),
        "liked": bool(node.get("viewer_has_liked")),
        "saved": bool(node.get("viewer_has_saved")),
        "location": ((node.get("location") or {}).get("name")) or "",
        "slides": slides,
        "video": slides[0].get("video") if slides else None,
        "thumb": slides[0].get("image") if slides else "",
        "audio": None,
    }
