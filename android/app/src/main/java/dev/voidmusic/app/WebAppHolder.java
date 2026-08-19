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

import android.annotation.SuppressLint;
import android.content.Context;
import android.view.ViewGroup;
import android.webkit.WebSettings;
import android.webkit.WebView;

/**
 * The one WebView, owned by the process rather than by the Activity.
 *
 * <p>This is what lets music keep playing after the app is closed. The audio
 * belongs to the WebView; if the WebView dies with the Activity — which is what
 * happens when the task is swiped out of Recents — the sound stops no matter
 * what the foreground service does. So the WebView is built against the
 * application context and kept here: the Activity borrows it, adds it to its
 * layout, and hands it back on the way out instead of destroying it.
 *
 * <p>The service keeps the process alive while something is playing, and when
 * the user returns, the same WebView is re-attached with the queue, the
 * position and the whole page state exactly as they left it.
 */
final class WebAppHolder {

    private static WebView webView;
    private static boolean loaded;

    private WebAppHolder() {}

    @SuppressLint("SetJavaScriptEnabled")
    static synchronized WebView get(Context context) {
        if (webView != null) return webView;

        // Application context on purpose: an Activity context here would leak
        // the Activity for as long as the process lives.
        WebView view = new WebView(context.getApplicationContext());
        view.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        view.setBackgroundColor(0xFF000000);

        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        // Audio must be able to start from the app's own UI without a second
        // gesture; the user already tapped a track.
        settings.setMediaPlaybackRequiresUserGesture(false);
        // Nothing is loaded from disk or content providers, so keep both shut.
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView = view;
        return webView;
    }

    /** True the first time only, so the page is loaded once per process. */
    static synchronized boolean needsLoad() {
        if (loaded) return false;
        loaded = true;
        return true;
    }

    /** Take the WebView out of whatever layout is holding it, without killing it. */
    static void detach(WebView view) {
        if (view == null) return;
        ViewGroup parent = (ViewGroup) view.getParent();
        if (parent != null) parent.removeView(view);
    }

    /** Run some JavaScript in the page, whether or not an Activity is showing. */
    static synchronized void eval(String js) {
        if (webView == null) return;
        webView.post(() -> {
            try {
                webView.evaluateJavascript(js, null);
            } catch (Exception ignored) {
                // The page may be mid-reload; a dropped command is not fatal.
            }
        });
    }

    /** Called when playback has stopped and the app is gone: free the memory. */
    static synchronized void destroy() {
        if (webView == null) return;
        detach(webView);
        webView.destroy();
        webView = null;
        loaded = false;
    }
}
