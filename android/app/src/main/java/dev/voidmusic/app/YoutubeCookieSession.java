/*
 * Void Music — a music player for open catalogues.
 * Copyright (C) 2026 Void Music contributors
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version. It is distributed WITHOUT ANY WARRANTY; see the GNU
 * General Public License in LICENSE for details.
 */
package dev.voidmusic.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;

/**
 * Reading your own YouTube Music library through a signed-in browser session,
 * instead of a registered OAuth client.
 *
 * <p><b>What this is, plainly.</b> The official YouTube Data API — what
 * {@link OAuthClient} talks to — has no method for "my liked songs" or "my
 * library playlists" that a personal, unpublished app can use without Google
 * requiring a registered OAuth client first. That registration step is a real
 * piece of friction for a sideloaded app with no build machine or Cloud
 * Console access handy.
 *
 * <p>What YouTube Music's own web client uses instead is not a public API at
 * all — it is the same internal "innertube" endpoint the music.youtube.com
 * page itself calls, authenticated the same way any logged-in browser tab
 * authenticates itself to Google: by attaching the session's own cookies, plus
 * a request signature computed from one of them ({@code SAPISID}). This class
 * reproduces exactly that — nothing more privileged than what the site sends
 * from a normal browser tab, using a session the user creates by actually
 * signing in on youtube.com in {@link YoutubeLoginActivity}.
 *
 * <p><b>This is not the official, documented way to do this</b>, and it is
 * why {@link OAuthClient} exists as the alternative: Google could change the
 * internal response shape or start rejecting this kind of client at any time,
 * with no notice and no version to pin against. It is offered because the
 * registered-client path is real friction for exactly the audience this app
 * is built for, and the tradeoff is deliberately left to that audience —
 * this class does not run unless the user chooses "Sign in with YouTube" over
 * the Cloud Console setup.
 */
final class YoutubeCookieSession {

    private static final String TAG = "VoidMusic";
    private static final String PREFS = "void_yt_cookie";
    private static final String KEY_COOKIE = "cookie";
    private static final String KEY_ACCOUNT = "account";

    /** Matches YouTube Music's own web client, which is what a scraped cookie is good for. */
    private static final String ORIGIN = "https://music.youtube.com";
    private static final String BROWSE_ENDPOINT = ORIGIN + "/youtubei/v1/browse"
            + "?key=AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30&prettyPrint=false";
    private static final String SEARCH_ENDPOINT = ORIGIN + "/youtubei/v1/search"
            + "?key=AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30&prettyPrint=false";
    private static final String USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                    + "Chrome/124.0.0.0 Safari/537.36";

    private YoutubeCookieSession() {}

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean signedIn(Context context) {
        return !cookie(context).isEmpty() && sapisidOf(cookie(context)) != null;
    }

    static String cookie(Context context) {
        return prefs(context).getString(KEY_COOKIE, "");
    }

    static String accountLabel(Context context) {
        return prefs(context).getString(KEY_ACCOUNT, "");
    }

    static void setAccountLabel(Context context, String name) {
        prefs(context).edit().putString(KEY_ACCOUNT, name == null ? "" : name).apply();
    }

    static void signOut(Context context) {
        prefs(context).edit().remove(KEY_COOKIE).remove(KEY_ACCOUNT).apply();
    }

    /**
     * Store a cookie header, however it arrived — captured from the login
     * WebView or pasted from a browser's dev tools. Rejects anything that
     * plainly cannot work (no {@code SAPISID}) rather than storing something
     * that will only fail later, less clearly.
     */
    static String adopt(Context context, String rawCookieHeader) {
        String cleaned = clean(rawCookieHeader);
        if (sapisidOf(cleaned) == null) {
            return "That does not look like a signed-in YouTube session — no SAPISID cookie in it. "
                    + "Copy the whole 'cookie' request header from a signed-in tab, not just one value.";
        }
        prefs(context).edit().putString(KEY_COOKIE, cleaned).apply();
        return null; // null = accepted
    }

    /**
     * A pasted value arrives in whatever shape the place it was copied from
     * uses: the header itself ({@code name=value; name2=value2}), one
     * {@code name=value} pair per line from a cookie table or a bookmarklet
     * that logs {@code document.cookie} split apart, or wrapped in a leading
     * "Cookie:" and/or stray quotes. Normalising all of that to one
     * semicolon-joined line is what the actual parsing below expects.
     */
    private static String clean(String raw) {
        String s = raw == null ? "" : raw.trim();
        if (s.regionMatches(true, 0, "cookie:", 0, 7)) s = s.substring(7).trim();
        if (s.length() >= 2 && ((s.charAt(0) == '"' && s.charAt(s.length() - 1) == '"')
                || (s.charAt(0) == '\'' && s.charAt(s.length() - 1) == '\''))) {
            s = s.substring(1, s.length() - 1).trim();
        }
        // A newline is never legal inside a cookie header; if the paste has
        // one, it was laid out one name=value pair per line and needs joining
        // back into the single line the parsing below expects. Left alone
        // otherwise — a stray tab is ambiguous enough to guess wrong about,
        // so this does not try to reconstruct name=value out of one.
        if (s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0) {
            s = String.join("; ", s.split("[\\r\\n]+"));
        }
        return s;
    }

    private static String sapisidOf(String cookieHeader) {
        for (String part : cookieHeader.split(";")) {
            String p = part.trim();
            if (p.startsWith("SAPISID=")) return p.substring("SAPISID=".length());
            if (p.startsWith("__Secure-3PAPISID=")) return p.substring("__Secure-3PAPISID=".length());
        }
        return null;
    }

    /**
     * {@code Authorization: SAPISIDHASH}, the scheme every logged-in Google
     * property's own JavaScript uses to sign a request with cookies alone —
     * documented by Google as the "SAPISIDHASH" auth scheme, not invented
     * here. {@code SHA1("<unix-seconds> <SAPISID> <origin>")}, hex-encoded,
     * prefixed with the timestamp so the server can check it was made
     * recently.
     */
    private static String sapisidHash(String sapisid, String origin) {
        try {
            long ts = System.currentTimeMillis() / 1000L;
            String input = ts + " " + sapisid + " " + origin;
            byte[] digest = MessageDigest.getInstance("SHA-1")
                    .digest(input.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(digest.length * 2);
            for (byte b : digest) hex.append(String.format("%02x", b));
            return "SAPISIDHASH " + ts + "_" + hex;
        } catch (Exception e) {
            return null;
        }
    }

    /** One playlist or song found in a browse/search response. */
    static final class Item {
        String id;
        String title;
        String subtitle;
        boolean isPlaylist;
    }

    /**
     * Why the most recent call came back empty, or "" after one that
     * genuinely found nothing. This exists because "empty" was ambiguous in
     * a way that made the last two rounds of fixes guesses instead of
     * diagnoses: a rejected cookie, a stale API key, and a response whose
     * shape this cannot parse all look identical from the page's side
     * without it. Read once, right after a call returns an empty list — a
     * second call overwrites it.
     */
    private static volatile String lastDiagnostic = "";

    static String lastDiagnostic() {
        return lastDiagnostic;
    }

    /** "Your library" playlists, including Liked Music. Empty list on any failure. */
    static List<Item> libraryPlaylists(Context context) {
        JSONObject body = baseBody();
        try {
            body.put("browseId", "FEmusic_liked_playlists");
        } catch (Exception ignored) { /* JSONObject.put only throws on a null key */ }
        return fetch(context, BROWSE_ENDPOINT, body, true);
    }

    /**
     * The tracks in any playlist by id — not only one in the signed-in
     * account's own library. Innertube addresses a playlist's browse page as
     * its id with {@code VL} in front; that convention, unlike the response
     * shape it returns, has been stable for years and is what youtube.com's
     * own "playlist" URLs resolve through.
     */
    static List<Item> playlistTracks(Context context, String playlistId) {
        JSONObject body = baseBody();
        try {
            String browseId = playlistId.startsWith("VL") ? playlistId : "VL" + playlistId;
            body.put("browseId", browseId);
        } catch (Exception ignored) {
        }
        return fetch(context, BROWSE_ENDPOINT, body, false);
    }

    /** Search YouTube Music itself. Empty list on any failure. */
    static List<Item> search(Context context, String query) {
        JSONObject body = baseBody();
        try {
            body.put("query", query);
            // "Songs" filter param, straight from YouTube Music's own request —
            // without it a search returns a mix of videos, artists and albums.
            body.put("params", "EgWKAQIIAWoKEAMQBBAJEAoQBQ==");
        } catch (Exception ignored) {
        }
        return fetch(context, SEARCH_ENDPOINT, body, false);
    }

    /** post(), then set lastDiagnostic when the caller is about to see an empty list. */
    private static List<Item> fetch(Context context, String url, JSONObject body, boolean wantPlaylists) {
        JSONObject response = post(context, url, body);
        if (response == null) return new ArrayList<>(); // post() already set lastDiagnostic

        List<Item> items = scanForItems(response, wantPlaylists);
        if (!items.isEmpty()) {
            lastDiagnostic = "";
            return items;
        }
        // Two very different failures used to look identical here: YouTube
        // returning a page with no results in it at all, versus a page full of
        // results this parser could not read. Whether the raw text contains
        // "videoId" separates them in one glance, instead of another round of
        // guessing from a key skeleton that stops above the interesting depth.
        String text = response.toString();
        int idCount = countOccurrences(text, "\"videoId\"");
        lastDiagnostic = "Signed in, reply " + text.length() + " chars, "
            + idCount + " videoId(s) in the raw JSON, but the parser read none of them. "
            + "Shape: " + keySkeleton(response, 0);
        return items;
    }

    private static int countOccurrences(String haystack, String needle) {
        int count = 0;
        for (int i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length())) count++;
        return count;
    }

    /**
     * A compact outline of an unknown JSON tree's key names and shapes — the
     * actual ground truth {@link #scanForItems} needs to be fixed against,
     * since this sandbox cannot fetch a real response to inspect and the raw
     * body is too large to read productively. An object shows its keys; an
     * array shows its length and, if the budget allows, the shape of its
     * first element, since innertube nests almost everything worth finding
     * inside arrays named {@code contents}.
     */
    private static String keySkeleton(Object node, int depth) {
        if (depth >= 5) return "…";
        if (node instanceof JSONObject) {
            JSONObject obj = (JSONObject) node;
            StringBuilder out = new StringBuilder("{");
            java.util.Iterator<String> keys = obj.keys();
            boolean first = true;
            while (keys.hasNext()) {
                String key = keys.next();
                if (!first) out.append(',');
                first = false;
                out.append(key);
                Object child = obj.opt(key);
                if (child instanceof JSONObject || child instanceof JSONArray) {
                    out.append(':').append(keySkeleton(child, depth + 1));
                }
                if (out.length() > 350) { out.append(",…"); break; }
            }
            return out.append('}').toString();
        }
        if (node instanceof JSONArray) {
            JSONArray arr = (JSONArray) node;
            if (arr.length() == 0) return "[]";
            return "[" + arr.length() + "×" + keySkeleton(arr.opt(0), depth + 1) + "]";
        }
        return String.valueOf(node).length() > 12
            ? "\"" + String.valueOf(node).substring(0, 12) + "…\"" : "\"" + node + "\"";
    }

    private static JSONObject baseBody() {
        JSONObject body = new JSONObject();
        try {
            JSONObject context = new JSONObject();
            JSONObject client = new JSONObject();
            client.put("clientName", "WEB_REMIX");
            client.put("clientVersion", "1.20260101.01.00");
            client.put("hl", "en");
            client.put("gl", "US");
            context.put("client", client);
            body.put("context", context);
        } catch (Exception ignored) {
        }
        return body;
    }

    private static JSONObject post(Context context, String url, JSONObject body) {
        String cookieHeader = cookie(context);
        String sapisid = sapisidOf(cookieHeader);
        if (sapisid == null) {
            lastDiagnostic = "No signed-in session stored";
            return null;
        }

        String auth = sapisidHash(sapisid, ORIGIN);
        if (auth == null) {
            lastDiagnostic = "Could not sign the request (SHA-1 unavailable)";
            return null;
        }

        try {
            HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
            try {
                conn.setRequestMethod("POST");
                conn.setDoOutput(true);
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(15000);
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setRequestProperty("Cookie", cookieHeader);
                conn.setRequestProperty("Authorization", auth);
                conn.setRequestProperty("Origin", ORIGIN);
                conn.setRequestProperty("X-Origin", ORIGIN);
                conn.setRequestProperty("X-Goog-AuthUser", "0");
                conn.setRequestProperty("User-Agent", USER_AGENT);

                try (OutputStream out = conn.getOutputStream()) {
                    out.write(body.toString().getBytes(StandardCharsets.UTF_8));
                }

                int status = conn.getResponseCode();
                InputStream stream = status < 400 ? conn.getInputStream() : conn.getErrorStream();
                String text = read(stream);
                if (status >= 400) {
                    Log.w(TAG, "youtube music request failed: HTTP " + status + ": " + text);
                    lastDiagnostic = "HTTP " + status + errorSummary(text);
                    return null;
                }
                return new JSONObject(text);
            } finally {
                conn.disconnect();
            }
        } catch (Exception e) {
            Log.w(TAG, "youtube music request failed: " + e.getMessage());
            lastDiagnostic = "Network error: " + e.getMessage();
            return null;
        }
    }

    /** ": <reason>" pulled out of an error body shaped like Google's usual {error:{message}}, or a raw snippet. */
    private static String errorSummary(String body) {
        try {
            JSONObject error = new JSONObject(body).optJSONObject("error");
            String message = error == null ? "" : error.optString("message", "");
            if (!message.isEmpty()) return ": " + message;
        } catch (Exception ignored) {
        }
        String snippet = body == null ? "" : body.trim();
        if (snippet.isEmpty()) return "";
        return ": " + snippet.substring(0, Math.min(snippet.length(), 200));
    }

    private static String read(InputStream stream) throws Exception {
        if (stream == null) return "{}";
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = stream.read(buf)) != -1) out.write(buf, 0, n);
        return out.toString("UTF-8");
    }

    /**
     * Innertube's response is a deeply nested tree whose exact shape is
     * neither documented nor stable across client versions.
     *
     * <p>The previous version of this scanner required an item's id and its
     * title to sit in the <em>same</em> JSON object. That is why a perfectly
     * good 196KB search response produced zero results on a real device:
     * YouTube Music puts the id in a tiny leaf ({@code playlistItemData:
     * {videoId}}, {@code watchEndpoint:{videoId}}) that has no title beside
     * it, and keeps the title several levels away in {@code flexColumns}. So
     * every item was found and then silently dropped. The javadoc claimed it
     * looked "one or two levels up"; the code never did.
     *
     * <p>This version looks for the <em>container</em> renderer instead: an
     * object with an id a short hop beneath it and a title-shaped text run
     * nearby. {@link #ID_DEPTH} is deliberately tight — that is what stops a
     * whole shelf (whose first item's id is further down) from collapsing
     * into one bogus result.
     */
    private static List<Item> scanForItems(Object node, boolean wantPlaylists) {
        List<Item> out = new ArrayList<>();
        scan(node, wantPlaylists, out);
        if (out.isEmpty()) scanByRendererName(node, wantPlaylists, out);
        return out;
    }

    /** How far beneath a container its id may sit. Small on purpose — see above. */
    private static final int ID_DEPTH = 2;
    /** Titles legitimately sit deeper, since flexColumns nests a few levels. */
    private static final int TITLE_DEPTH = 3;

    /** Subtrees that hold menu and overlay labels ("Play next"), never the item's own title. */
    private static final java.util.Set<String> NOISE = new java.util.HashSet<>(java.util.Arrays.asList(
            "menu", "overlay", "badges", "thumbnail", "thumbnailRenderer", "trackingParams",
            "navigationEndpoint", "serviceEndpoint", "playlistItemData", "loggingDirectives"));

    private static void scan(Object node, boolean wantPlaylists, List<Item> out) {
        if (out.size() >= 100) return; // a runaway tree should not become a runaway loop
        if (node instanceof JSONObject) {
            JSONObject obj = (JSONObject) node;
            String id = findId(obj, wantPlaylists, ID_DEPTH);
            if (id != null) {
                String title = findTitle(obj, TITLE_DEPTH);
                if (title != null) {
                    out.add(itemOf(id, title, findSubtitle(obj, TITLE_DEPTH), wantPlaylists));
                    return; // this object was one whole item; its innards are its own fields
                }
            }
            java.util.Iterator<String> keys = obj.keys();
            while (keys.hasNext()) scan(obj.opt(keys.next()), wantPlaylists, out);
        } else if (node instanceof JSONArray) {
            JSONArray arr = (JSONArray) node;
            for (int i = 0; i < arr.length(); i++) scan(arr.opt(i), wantPlaylists, out);
        }
    }

    /**
     * Fallback for a layout where the id sits deeper than {@link #ID_DEPTH}:
     * trust the renderer's key name to mark an item boundary, and search
     * further inside it. Only runs when the strict pass found nothing, so a
     * shape it would mis-split cannot cost anything that already worked.
     */
    private static void scanByRendererName(Object node, boolean wantPlaylists, List<Item> out) {
        if (out.size() >= 100) return;
        if (node instanceof JSONObject) {
            JSONObject obj = (JSONObject) node;
            java.util.Iterator<String> keys = obj.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                Object child = obj.opt(key);
                if (looksLikeItemRenderer(key) && child instanceof JSONObject) {
                    String id = findId(child, wantPlaylists, 6);
                    String title = findTitle(child, 5);
                    if (id != null && title != null) {
                        out.add(itemOf(id, title, findSubtitle(child, 5), wantPlaylists));
                        continue;
                    }
                }
                scanByRendererName(child, wantPlaylists, out);
            }
        } else if (node instanceof JSONArray) {
            JSONArray arr = (JSONArray) node;
            for (int i = 0; i < arr.length(); i++) scanByRendererName(arr.opt(i), wantPlaylists, out);
        }
    }

    private static boolean looksLikeItemRenderer(String key) {
        if (!key.endsWith("Renderer")) return false;
        String k = key.toLowerCase(java.util.Locale.ROOT);
        return k.contains("video") || k.contains("song") || k.contains("track")
                || k.contains("playlist") || k.contains("responsivelistitem") || k.contains("tworowitem");
    }

    private static Item itemOf(String id, String title, String subtitle, boolean wantPlaylists) {
        Item item = new Item();
        item.id = id;
        item.title = title;
        item.subtitle = subtitle == null ? "" : subtitle;
        item.isPlaylist = wantPlaylists;
        return item;
    }

    /** The first {@code videoId}/{@code playlistId} within {@code budget} hops. */
    private static String findId(Object node, boolean wantPlaylists, int budget) {
        if (node instanceof JSONObject) {
            JSONObject obj = (JSONObject) node;
            String direct = obj.optString(wantPlaylists ? "playlistId" : "videoId", "");
            if (!direct.isEmpty()) return direct;
            if (budget <= 0) return null;
            java.util.Iterator<String> keys = obj.keys();
            while (keys.hasNext()) {
                String found = findId(obj.opt(keys.next()), wantPlaylists, budget - 1);
                if (found != null) return found;
            }
        } else if (node instanceof JSONArray && budget > 0) {
            JSONArray arr = (JSONArray) node;
            for (int i = 0; i < arr.length(); i++) {
                String found = findId(arr.opt(i), wantPlaylists, budget - 1);
                if (found != null) return found;
            }
        }
        return null;
    }

    private static String findTitle(Object node, int budget) {
        if (node instanceof JSONObject) {
            JSONObject obj = (JSONObject) node;
            String direct = titleOf(obj);
            if (direct != null) return direct;
            if (budget <= 0) return null;
            java.util.Iterator<String> keys = obj.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                if (NOISE.contains(key)) continue;
                String found = findTitle(obj.opt(key), budget - 1);
                if (found != null) return found;
            }
        } else if (node instanceof JSONArray && budget > 0) {
            JSONArray arr = (JSONArray) node;
            for (int i = 0; i < arr.length(); i++) {
                String found = findTitle(arr.opt(i), budget - 1);
                if (found != null) return found;
            }
        }
        return null;
    }

    /** The title-shaped fields a renderer may use, in the order they should win. */
    private static String titleOf(JSONObject obj) {
        String t = runTextOf(obj.opt("title"));
        if (t != null) return t;
        t = flexColumnText(obj, 0);
        if (t != null) return t;
        t = runTextOf(obj.opt("headline"));
        if (t != null) return t;
        return runTextOf(obj.opt("header"));
    }

    private static String findSubtitle(Object node, int budget) {
        if (node instanceof JSONObject) {
            JSONObject obj = (JSONObject) node;
            String s = runTextOf(obj.opt("subtitle"));
            if (s != null) return s;
            s = flexColumnText(obj, 1);
            if (s != null) return s;
            s = runTextOf(obj.opt("longBylineText"));
            if (s != null) return s;
            s = runTextOf(obj.opt("shortBylineText"));
            if (s != null) return s;
            if (budget <= 0) return null;
            java.util.Iterator<String> keys = obj.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                if (NOISE.contains(key)) continue;
                String found = findSubtitle(obj.opt(key), budget - 1);
                if (found != null) return found;
            }
        } else if (node instanceof JSONArray && budget > 0) {
            JSONArray arr = (JSONArray) node;
            for (int i = 0; i < arr.length(); i++) {
                String found = findSubtitle(arr.opt(i), budget - 1);
                if (found != null) return found;
            }
        }
        return null;
    }

    /** YouTube Music lays a row's text out in flexColumns: [0] is the title, [1] the artist. */
    private static String flexColumnText(JSONObject obj, int index) {
        JSONArray cols = obj.optJSONArray("flexColumns");
        if (cols == null || cols.length() <= index) return null;
        JSONObject col = cols.optJSONObject(index);
        if (col == null) return null;
        JSONObject renderer = col.optJSONObject("musicResponsiveListItemFlexColumnRenderer");
        if (renderer == null) return null;
        return runTextOf(renderer.opt("text"));
    }

    /** Innertube spells plain text as {"runs":[{"text":"..."}]} or {"simpleText":"..."}. */
    private static String runTextOf(Object field) {
        if (!(field instanceof JSONObject)) return null;
        JSONObject o = (JSONObject) field;
        String simple = o.optString("simpleText", "");
        if (!simple.isEmpty()) return simple;
        JSONArray runs = o.optJSONArray("runs");
        if (runs != null && runs.length() > 0) {
            JSONObject first = runs.optJSONObject(0);
            if (first != null) {
                String text = first.optString("text", "");
                if (!text.isEmpty()) return text;
            }
        }
        return null;
    }
}
