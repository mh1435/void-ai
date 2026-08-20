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
import android.app.Activity;
import android.app.AlertDialog;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Toast;

/**
 * A real youtube.com sign-in, inside the app.
 *
 * <p>This is deliberately not the same shape as {@link OAuthClient}'s sign-in,
 * which hands off to the system browser. Google actively detects and blocks
 * an embedded WebView specifically on its OAuth consent page (the
 * {@code disallowed_useragent} error) — that restriction exists for the
 * authorization endpoint, not for the ordinary youtube.com sign-in form, so
 * loading the real site here and letting the user tap its own "Sign in"
 * works the same way it would in any other embedded browser.
 *
 * <p>What this Activity produces is not a token but a cookie — the same
 * session cookie youtube.com hands any signed-in browser tab. See
 * {@link YoutubeCookieSession} for what that session is then used for and
 * why: reading a private, undocumented endpoint rather than the official API,
 * a tradeoff this exists specifically so the user can choose rather than have
 * decided for them.
 */
public class YoutubeLoginActivity extends Activity {

    private static final String START_URL = "https://www.youtube.com/";
    /**
     * Present once a tab is actually signed in; absent for an anonymous
     * visitor. Checked against both names {@link YoutubeCookieSession} itself
     * accepts when signing a request, so a device that only ever sets one of
     * the two is not stuck waiting on the other.
     */
    private static boolean looksSignedIn(String cookies) {
        return cookies != null && (cookies.contains("SAPISID=") || cookies.contains("__Secure-3PAPISID="));
    }

    private WebView webView;
    private boolean resolved;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        int pad = dp(12);
        bar.setPadding(pad, pad, pad, pad);

        Button cancel = new Button(this);
        cancel.setText("Cancel");
        cancel.setOnClickListener(v -> finishWith(false, "Cancelled"));

        Button paste = new Button(this);
        paste.setText("Paste cookie");
        paste.setOnClickListener(v -> showPasteDialog());

        LinearLayout.LayoutParams spacer = new LinearLayout.LayoutParams(0, 0, 1f);
        View gap = new View(this);
        gap.setLayoutParams(spacer);

        bar.addView(cancel);
        bar.addView(gap);
        bar.addView(paste);

        webView = new WebView(this);
        webView.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        // The ordinary desktop sign-in form is more consistently full-featured
        // than the mobile one, and this device's real Chrome build number is
        // not something to imitate — a stable desktop string is what most
        // similar tools use, and youtube.com serves it the normal page.
        webView.getSettings().setUserAgentString(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                        + "Chrome/124.0.0.0 Safari/537.36");

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                checkSignedIn();
            }
        });

        root.addView(bar);
        root.addView(webView);
        setContentView(root);

        webView.loadUrl(START_URL);
    }

    /**
     * After every navigation: is a real session cookie sitting there yet?
     *
     * {@link CookieManager#getCookie} takes a URL, not a bare domain — a
     * cookie set with {@code Domain=.youtube.com} still matches a query
     * against {@code https://www.youtube.com}, by the same domain-matching
     * rule a real browser applies, so the concrete page actually loaded is
     * what gets asked, on both hosts the session might be scoped to.
     */
    private void checkSignedIn() {
        if (resolved) return;
        String cookies = CookieManager.getInstance().getCookie("https://www.youtube.com");
        if (!looksSignedIn(cookies)) return;

        // A cookie scoped narrowly to music.youtube.com (rather than shared
        // across all of youtube.com) would not show up in the query above,
        // so it is asked for too — whichever the innertube call ends up
        // needing, it is already captured either way.
        String musicCookies = CookieManager.getInstance().getCookie("https://music.youtube.com");
        String combined = looksSignedIn(musicCookies) ? musicCookies : cookies;

        finishWith(true, combined);
    }

    private void showPasteDialog() {
        EditText field = new EditText(this);
        field.setHint("Cookie header value, copied from a signed-in browser tab");
        field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        field.setMinLines(3);
        int pad = dp(16);
        field.setPadding(pad, pad, pad, pad);

        new AlertDialog.Builder(this)
                .setTitle("Paste a YouTube cookie")
                .setMessage("From a browser where you are signed in to YouTube: open dev tools on "
                        + "any music.youtube.com request, find the Cookie request header, and "
                        + "paste its whole value here.")
                .setView(field)
                .setPositiveButton("Use this", (d, w) -> finishWith(true, field.getText().toString()))
                .setNegativeButton("Cancel", null)
                .show();
    }

    private void finishWith(boolean ok, String cookieOrMessage) {
        if (resolved) return;
        resolved = true;

        if (!ok) {
            WebAppHolder.eval("window.__voidYtCookie && window.__voidYtCookie(false,"
                    + quote(cookieOrMessage) + ")");
            finish();
            return;
        }

        String error = YoutubeCookieSession.adopt(this, cookieOrMessage);
        if (error != null) {
            Toast.makeText(this, error, Toast.LENGTH_LONG).show();
            resolved = false; // let them try again rather than close on a rejected paste
            return;
        }

        WebAppHolder.eval("window.__voidYtCookie && window.__voidYtCookie(true, \"\")");
        finish();
    }

    private static String quote(String value) {
        return '"' + (value == null ? "" : value)
                .replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", " ").replace("\r", " ") + '"';
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
