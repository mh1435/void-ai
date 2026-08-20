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

import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.security.MessageDigest;
import java.util.Locale;

/**
 * The {@code window.VoidNative} object the web app talks to.
 *
 * <p>Deliberately tiny. The web app owns playback and the library; all the
 * native side needs to know is whether audio is running, so it can hold a
 * foreground service and show a notification while it is.
 *
 * <p>Every method here is callable by any JavaScript in the WebView. That is
 * acceptable only because the WebView loads exactly one document — our own
 * bundled page — and never navigates to remote content. Keep it that way, and
 * keep these methods free of anything that touches the filesystem or user data.
 */
public class NativeBridge {

    private final MainActivity activity;

    NativeBridge(MainActivity activity) {
        this.activity = activity;
    }

    /** True lets the web app hide its browser-only "Install app" affordance. */
    @JavascriptInterface
    public boolean isNativeApp() {
        return true;
    }

    /** Audio started or the track changed. */
    @JavascriptInterface
    public void playbackStarted(final String title, final String artist) {
        // JavascriptInterface calls arrive on a WebView worker thread.
        activity.runOnUiThread(() -> PlaybackService.start(activity, title, artist));
    }

    /** Audio paused, ended, or the queue ran out. */
    @JavascriptInterface
    public void playbackStopped() {
        activity.runOnUiThread(() -> PlaybackService.stop(activity));
    }

    /**
     * Everything the system needs to show this track: what it is, how long it
     * is, where we are in it, and the cover. Handed to the media session, which
     * is what the lock screen and HyperOS's island read.
     *
     * <p>The artwork arrives as a data URL because the page's covers may be
     * blobs it holds in memory — there is no URL the native side could fetch.
     */
    @JavascriptInterface
    public void nowPlaying(String json) {
        final PlaybackService.NowPlaying now = new PlaybackService.NowPlaying();
        try {
            JSONObject o = new JSONObject(json);
            now.title = o.optString("title", "Void Music");
            now.artist = o.optString("artist", "");
            now.album = o.optString("album", "");
            now.durationMs = Math.round(o.optDouble("duration", 0) * 1000);
            now.positionMs = Math.round(o.optDouble("position", 0) * 1000);
            now.playing = o.optBoolean("playing", false);
            now.artwork = decodeArtwork(o.optString("artwork", ""));
        } catch (Exception e) {
            return;
        }
        activity.runOnUiThread(() -> PlaybackService.update(activity, now));
    }

    /** Cheap position/state ticks, without re-sending metadata or artwork. */
    @JavascriptInterface
    public void playbackState(boolean playing, double positionSeconds) {
        final PlaybackService.NowPlaying now = PlaybackService.currentState();
        now.playing = playing;
        now.positionMs = Math.round(positionSeconds * 1000);
        activity.runOnUiThread(() -> PlaybackService.update(activity, now));
    }

    private static Bitmap decodeArtwork(String dataUrl) {
        if (dataUrl == null || dataUrl.isEmpty()) return null;
        int comma = dataUrl.indexOf(',');
        if (comma < 0) return null;
        try {
            byte[] bytes = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT);
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        } catch (Exception e) {
            return null;   // a cover we cannot decode is not worth failing over
        }
    }

    /* ── Signing in to Google ──────────────────────────────────────── */

    /** True when this build can run the real sign-in flow. */
    @JavascriptInterface
    public boolean canSignIn() {
        return true;
    }

    /**
     * True when the phone has a Google account Android can broker for us — the
     * one-tap path, with no client ID anywhere.
     */
    @JavascriptInterface
    public boolean canPickAccount() {
        return AccountAuth.available(activity);
    }

    /**
     * Show the account picker. Android then asks Google for permission on our
     * behalf, and the answer arrives at {@code window.__voidAccount(ok, error)}.
     */
    @JavascriptInterface
    public void pickAccount() {
        // Posted rather than returned: startActivityForResult belongs to the UI
        // thread, so there is nothing to answer synchronously. Success and
        // failure both arrive at window.__voidAccount.
        activity.runOnUiThread(activity::pickGoogleAccount);
    }

    @JavascriptInterface
    public boolean accountSignedIn() {
        return AccountAuth.signedIn(activity);
    }

    @JavascriptInterface
    public String accountName() {
        return AccountAuth.accountName(activity);
    }

    /** A live token for the picked account, refreshed when it has gone stale. */
    @JavascriptInterface
    public String accountToken() {
        return AccountAuth.token(activity);
    }

    @JavascriptInterface
    public void accountSignOut() {
        AccountAuth.signOut(activity);
    }

    /**
     * Send the user to Google's consent page. The answer comes back through
     * {@code window.__voidOAuth(ok, message)} once the browser returns.
     */
    @JavascriptInterface
    public boolean signIn(final String clientId) {
        return activity.startSignIn(clientId);
    }

    @JavascriptInterface
    public boolean signedIn() {
        return OAuthClient.signedIn(activity);
    }

    @JavascriptInterface
    public String signedInAs() {
        return OAuthClient.account(activity);
    }

    @JavascriptInterface
    public void setSignedInAs(String name) {
        OAuthClient.setAccount(activity, name);
    }

    @JavascriptInterface
    public String clientId() {
        return OAuthClient.clientId(activity);
    }

    /** This build's own applicationId, so the setup page never has to hardcode it. */
    @JavascriptInterface
    public String packageName() {
        return activity.getPackageName();
    }

    /**
     * The SHA-1 fingerprint of the certificate this build is signed with, in the
     * colon-separated hex Google Cloud Console's "Android" OAuth client form
     * asks for — the same value {@code keytool -list -v} prints.
     *
     * <p>Registering an Android OAuth client needs this fingerprint, and it is
     * normally the step that sends someone off to install Android Studio or
     * hunt down a keytool command just to read a value the running app already
     * has. It doesn't need a stranger's tool: the certificate the app was
     * installed with is available to the app itself, so this reads it straight
     * from PackageManager and hashes it the same way Google's own tooling does.
     */
    @JavascriptInterface
    public String signingFingerprint() {
        try {
            Signature[] signatures;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                PackageInfo info = activity.getPackageManager().getPackageInfo(
                        activity.getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
                signatures = info.signingInfo.hasMultipleSigners()
                        ? info.signingInfo.getApkContentsSigners()
                        : info.signingInfo.getSigningCertificateHistory();
            } else {
                PackageInfo info = activity.getPackageManager().getPackageInfo(
                        activity.getPackageName(), PackageManager.GET_SIGNATURES);
                signatures = info.signatures;
            }
            if (signatures == null || signatures.length == 0) return "";

            byte[] hash = MessageDigest.getInstance("SHA-1").digest(signatures[0].toByteArray());
            StringBuilder out = new StringBuilder(hash.length * 3 - 1);
            for (int i = 0; i < hash.length; i++) {
                if (i > 0) out.append(':');
                out.append(String.format(Locale.ROOT, "%02X", hash[i]));
            }
            return out.toString();
        } catch (Exception e) {
            return "";
        }
    }

    /**
     * A usable access token, refreshed if it has expired. Empty when nobody is
     * signed in. The refresh token itself never reaches the page.
     */
    @JavascriptInterface
    public String accessToken() {
        return OAuthClient.accessToken(activity);
    }

    @JavascriptInterface
    public void signOut() {
        OAuthClient.signOut(activity);
    }

    /* ── YouTube, signed in by cookie rather than a registered client ── */

    @JavascriptInterface
    public boolean ytCookieSignedIn() {
        return YoutubeCookieSession.signedIn(activity);
    }

    @JavascriptInterface
    public String ytCookieAccountLabel() {
        return YoutubeCookieSession.accountLabel(activity);
    }

    @JavascriptInterface
    public void ytCookieSetAccountLabel(String name) {
        YoutubeCookieSession.setAccountLabel(activity, name);
    }

    @JavascriptInterface
    public void ytCookieSignOut() {
        YoutubeCookieSession.signOut(activity);
    }

    /** Opens the sign-in screen. The answer arrives at window.__voidYtCookie(ok, message). */
    @JavascriptInterface
    public void ytCookieOpenLogin() {
        activity.runOnUiThread(activity::openYoutubeLogin);
    }

    /**
     * Adopt a cookie the page already has some other way, or none at all —
     * returns an error string, or empty on success. Exists mainly so the
     * paste-a-cookie fallback can also be reached from Settings, not only
     * from inside the login screen.
     */
    @JavascriptInterface
    public String ytCookieAdopt(String rawCookieHeader) {
        String error = YoutubeCookieSession.adopt(activity, rawCookieHeader);
        return error == null ? "" : error;
    }

    /**
     * Your library playlists (including Liked Music), as a JSON array of
     * {@code {id, title, subtitle, isPlaylist}}. Empty array on any failure —
     * the page reads that the same way as "nothing found", which is the
     * honest answer when this best-effort endpoint does not cooperate.
     *
     * <p>Blocks on network I/O like {@link #accountToken()} and
     * {@link #accessToken()} already do here; JavascriptInterface calls run
     * on a WebView worker thread, not the UI thread, so that is safe.
     */
    @JavascriptInterface
    public String ytCookieLibraryPlaylists() {
        return jsonOf(YoutubeCookieSession.libraryPlaylists(activity));
    }

    @JavascriptInterface
    public String ytCookieSearch(String query) {
        return jsonOf(YoutubeCookieSession.search(activity, query));
    }

    @JavascriptInterface
    public String ytCookiePlaylistTracks(String playlistId) {
        return jsonOf(YoutubeCookieSession.playlistTracks(activity, playlistId));
    }

    private static String jsonOf(java.util.List<YoutubeCookieSession.Item> items) {
        JSONArray out = new JSONArray();
        for (YoutubeCookieSession.Item item : items) {
            JSONObject o = new JSONObject();
            try {
                o.put("id", item.id);
                o.put("title", item.title);
                o.put("subtitle", item.subtitle == null ? "" : item.subtitle);
                o.put("isPlaylist", item.isPlaylist);
            } catch (Exception ignored) {
            }
            out.put(o);
        }
        return out.toString();
    }

    /**
     * Open a link in the browser. The page cannot do this itself: the WebView
     * has no second window to open one in.
     */
    @JavascriptInterface
    public void openExternal(final String url) {
        if (url == null || url.isEmpty()) return;
        activity.runOnUiThread(() -> activity.openExternal(url));
    }

    /**
     * True when this build can pick a whole folder. A WebView cannot do it
     * through {@code <input webkitdirectory>}, so the web app asks first and
     * falls back to choosing files when the answer is no.
     */
    @JavascriptInterface
    public boolean canPickFolder() {
        return true;
    }

    /**
     * Open the system folder picker. The list of audio files inside whatever
     * the user grants is delivered back to the page through
     * {@code window.__voidFolderPicked}; an empty list means they cancelled.
     */
    @JavascriptInterface
    public void pickFolder() {
        activity.runOnUiThread(activity::pickFolder);
    }
}
