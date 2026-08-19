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

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.Base64;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;

/**
 * Signing in to Google, properly: one tap, and it stays signed in.
 *
 * <p>The page used to ask for a pasted access token, which expires after an
 * hour. This does the real thing — Authorization Code with PKCE — so the user
 * approves once in their browser and the app keeps a refresh token from then
 * on.
 *
 * <p>Two decisions worth knowing:
 *
 * <p><b>The exchange happens here, not in JavaScript.</b> The page runs on
 * {@code appassets.androidplatform.net}, and Google's token endpoint has no
 * reason to allow that origin. Doing it over a plain HTTPS connection from
 * Java sidesteps the question entirely — and it means the refresh token, the
 * long-lived secret of the pair, never enters the page at all. The page only
 * ever receives a short-lived access token.
 *
 * <p><b>No client ID is compiled in.</b> This is GPL software: anything
 * shipped inside it is public. The user registers their own OAuth client once
 * and pastes the ID, which is not a secret — for an Android client Google
 * issues no secret at all, because the app is verified by its package name and
 * signing certificate instead.
 */
final class OAuthClient {

    private static final String TAG = "VoidMusic";
    private static final String PREFS = "void_oauth";

    private static final String KEY_CLIENT_ID = "client_id";
    private static final String KEY_VERIFIER = "verifier";
    private static final String KEY_REFRESH = "refresh_token";
    private static final String KEY_ACCESS = "access_token";
    private static final String KEY_EXPIRES = "expires_at";
    private static final String KEY_ACCOUNT = "account";

    private static final String AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
    private static final String TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
    private static final String SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

    /** For an Android client the scheme must be the package name. */
    static final String REDIRECT_URI = "dev.voidmusic.app:/oauth2redirect";

    private OAuthClient() {}

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean signedIn(Context context) {
        return !prefs(context).getString(KEY_REFRESH, "").isEmpty();
    }

    static String account(Context context) {
        return prefs(context).getString(KEY_ACCOUNT, "");
    }

    static void setAccount(Context context, String name) {
        prefs(context).edit().putString(KEY_ACCOUNT, name == null ? "" : name).apply();
    }

    static String clientId(Context context) {
        return prefs(context).getString(KEY_CLIENT_ID, "");
    }

    static void signOut(Context context) {
        prefs(context).edit()
                .remove(KEY_REFRESH).remove(KEY_ACCESS).remove(KEY_EXPIRES)
                .remove(KEY_VERIFIER).remove(KEY_ACCOUNT)
                .apply();
    }

    /* ── Starting the flow ─────────────────────────────────────────── */

    /**
     * Send the user to Google's consent page in their browser.
     *
     * <p>Deliberately the browser and not a WebView: a sign-in page inside the
     * app is exactly what a phishing page looks like, Google rejects it for
     * that reason, and the browser already holds the session so there is
     * usually nothing to type.
     */
    static boolean begin(Activity activity, String clientId) {
        String id = clientId == null ? "" : clientId.trim();
        if (id.isEmpty()) return false;

        String verifier = randomVerifier();
        prefs(activity).edit()
                .putString(KEY_CLIENT_ID, id)
                .putString(KEY_VERIFIER, verifier)
                .apply();

        String url = AUTH_ENDPOINT
                + "?client_id=" + enc(id)
                + "&redirect_uri=" + enc(REDIRECT_URI)
                + "&response_type=code"
                + "&scope=" + enc(SCOPE)
                + "&code_challenge=" + enc(challengeOf(verifier))
                + "&code_challenge_method=S256"
                // offline + consent is what makes Google hand back a refresh
                // token, which is the whole point of doing this properly.
                + "&access_type=offline"
                + "&prompt=consent";

        try {
            activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            return true;
        } catch (Exception e) {
            Log.w(TAG, "no browser to sign in with: " + e.getMessage());
            return false;
        }
    }

    /** The browser has come back to us. Returns true if this was our redirect. */
    static boolean handleRedirect(Context context, Uri uri) {
        if (uri == null || !REDIRECT_URI.startsWith(uri.getScheme() + ":")) return false;

        String error = uri.getQueryParameter("error");
        if (error != null) {
            WebAppHolder.eval("window.__voidOAuth && window.__voidOAuth(false,"
                    + quote(friendly(error)) + ")");
            return true;
        }

        final String code = uri.getQueryParameter("code");
        if (code == null || code.isEmpty()) return false;

        new Thread(() -> {
            String failure = exchange(context, code);
            WebAppHolder.eval("window.__voidOAuth && window.__voidOAuth("
                    + (failure == null) + "," + quote(failure == null ? "" : failure) + ")");
        }, "void-oauth-exchange").start();

        return true;
    }

    private static String friendly(String error) {
        if ("access_denied".equals(error)) return "You cancelled the sign-in";
        return "Google refused the sign-in (" + error + ")";
    }

    /* ── Talking to Google ─────────────────────────────────────────── */

    /** Trade the one-time code for tokens. Returns null on success. */
    private static String exchange(Context context, String code) {
        SharedPreferences prefs = prefs(context);
        String verifier = prefs.getString(KEY_VERIFIER, "");
        String id = prefs.getString(KEY_CLIENT_ID, "");
        if (verifier.isEmpty() || id.isEmpty()) return "Sign-in expired, try again";

        String body = "code=" + enc(code)
                + "&client_id=" + enc(id)
                + "&redirect_uri=" + enc(REDIRECT_URI)
                + "&code_verifier=" + enc(verifier)
                + "&grant_type=authorization_code";

        try {
            JSONObject json = post(body);
            String refresh = json.optString("refresh_token", "");
            String access = json.optString("access_token", "");
            if (access.isEmpty()) return "Google sent no access token";

            SharedPreferences.Editor edit = prefs.edit()
                    .putString(KEY_ACCESS, access)
                    .putLong(KEY_EXPIRES, expiryOf(json))
                    .remove(KEY_VERIFIER);
            // Google only sends a refresh token the first time an account
            // approves; keep the old one if this grant did not carry one.
            if (!refresh.isEmpty()) edit.putString(KEY_REFRESH, refresh);
            edit.apply();
            return null;
        } catch (Exception e) {
            Log.w(TAG, "token exchange failed: " + e.getMessage());
            return "Could not complete sign-in (" + e.getMessage() + ")";
        }
    }

    /**
     * A usable access token, refreshed if the old one has run out.
     * Returns an empty string when nobody is signed in.
     *
     * <p>Called from the JavaScript bridge, which runs on a worker thread —
     * blocking here is correct and keeps the page's own code simple.
     */
    static synchronized String accessToken(Context context) {
        SharedPreferences prefs = prefs(context);
        String access = prefs.getString(KEY_ACCESS, "");
        long expires = prefs.getLong(KEY_EXPIRES, 0);

        // Refresh a minute early rather than let a call fail on the boundary.
        if (!access.isEmpty() && System.currentTimeMillis() < expires - 60_000) return access;

        String refresh = prefs.getString(KEY_REFRESH, "");
        String id = prefs.getString(KEY_CLIENT_ID, "");
        if (refresh.isEmpty() || id.isEmpty()) return "";

        try {
            JSONObject json = post("client_id=" + enc(id)
                    + "&refresh_token=" + enc(refresh)
                    + "&grant_type=refresh_token");
            String fresh = json.optString("access_token", "");
            if (fresh.isEmpty()) return "";

            prefs.edit()
                    .putString(KEY_ACCESS, fresh)
                    .putLong(KEY_EXPIRES, expiryOf(json))
                    .apply();
            return fresh;
        } catch (Exception e) {
            Log.w(TAG, "token refresh failed: " + e.getMessage());
            return "";
        }
    }

    private static long expiryOf(JSONObject json) {
        long seconds = json.optLong("expires_in", 3600);
        return System.currentTimeMillis() + seconds * 1000;
    }

    private static JSONObject post(String body) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(TOKEN_ENDPOINT).openConnection();
        try {
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(15000);
            conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");

            try (OutputStream out = conn.getOutputStream()) {
                out.write(body.getBytes(StandardCharsets.UTF_8));
            }

            int status = conn.getResponseCode();
            InputStream stream = status < 400 ? conn.getInputStream() : conn.getErrorStream();
            String text = read(stream);

            if (status >= 400) {
                JSONObject error = new JSONObject(text);
                throw new Exception(error.optString("error_description",
                        error.optString("error", "HTTP " + status)));
            }
            return new JSONObject(text);
        } finally {
            conn.disconnect();
        }
    }

    private static String read(InputStream stream) throws Exception {
        if (stream == null) return "{}";
        StringBuilder out = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) out.append(line);
        }
        return out.toString();
    }

    /* ── PKCE ──────────────────────────────────────────────────────── */

    private static String randomVerifier() {
        byte[] bytes = new byte[64];
        new SecureRandom().nextBytes(bytes);
        return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    private static String challengeOf(String verifier) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(verifier.getBytes(StandardCharsets.US_ASCII));
            return Base64.encodeToString(digest, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 is missing", e);
        }
    }

    private static String enc(String value) {
        try {
            return URLEncoder.encode(value, "UTF-8");
        } catch (Exception e) {
            return value;
        }
    }

    /** Quote a string for injection into a JavaScript call. */
    private static String quote(String value) {
        return '"' + value.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", " ").replace("\r", " ") + '"';
    }
}
