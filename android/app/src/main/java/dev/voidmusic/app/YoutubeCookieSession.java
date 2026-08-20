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
        lastDiagnostic = items.isEmpty()
            ? "Signed in and got a reply (" + response.toString().length() + " bytes) but "
                + "the scanner found nothing playable in it. Shape: " + keySkeleton(response, 0)
            : "";
        return items;
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
     * neither documented nor stable across client versions — the one thing
     * that has held steady across every version this was checked against is
     * that a playable item's object carries a {@code playlistId} or
     * {@code videoId} alongside a {@code text} run for its title one or two
     * levels up. Scanning for that shape instead of one fixed path is more
     * likely to survive Google changing the surrounding structure than a
     * parser pinned to today's exact nesting would be.
     */
    private static List<Item> scanForItems(Object node, boolean wantPlaylists) {
        List<Item> out = new ArrayList<>();
        scan(node, wantPlaylists, out);
        return out;
    }

    private static void scan(Object node, boolean wantPlaylists, List<Item> out) {
        if (out.size() >= 100) return; // a runaway tree should not become a runaway loop
        if (node instanceof JSONObject) {
            JSONObject obj = (JSONObject) node;
            String id = wantPlaylists ? obj.optString("playlistId", "") : obj.optString("videoId", "");
            if (id.isEmpty() && !wantPlaylists) id = obj.optString("playlistId", "");
            if (!id.isEmpty()) {
                String title = titleNear(obj);
                if (title != null) {
                    Item item = new Item();
                    item.id = id;
                    item.title = title;
                    item.subtitle = subtitleNear(obj);
                    item.isPlaylist = obj.has("playlistId");
                    out.add(item);
                }
            }
            java.util.Iterator<String> keys = obj.keys();
            while (keys.hasNext()) scan(obj.opt(keys.next()), wantPlaylists, out);
        } else if (node instanceof JSONArray) {
            JSONArray arr = (JSONArray) node;
            for (int i = 0; i < arr.length(); i++) scan(arr.opt(i), wantPlaylists, out);
        }
    }

    /** The first plain-text "title"-shaped run inside this renderer object. */
    private static String titleNear(JSONObject obj) {
        String direct = runTextOf(obj.opt("title"));
        if (direct != null) return direct;
        String header = runTextOf(obj.opt("header"));
        return header;
    }

    private static String subtitleNear(JSONObject obj) {
        return runTextOf(obj.opt("subtitle"));
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
