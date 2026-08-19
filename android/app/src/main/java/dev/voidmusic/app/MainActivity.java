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

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.accounts.AccountManager;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.KeyEvent;
import android.app.AlertDialog;
import android.webkit.ConsoleMessage;
import android.webkit.JsResult;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.InputStream;
import java.util.Collections;

import androidx.webkit.ServiceWorkerClientCompat;
import androidx.webkit.ServiceWorkerControllerCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewFeature;

/**
 * Hosts the Void Music web app in a WebView.
 *
 * <p>The web assets are bundled in the APK and served through
 * {@link WebViewAssetLoader} over {@code https://appassets.androidplatform.net/}.
 * That detail matters: loading them from {@code file://} would put the app on an
 * opaque origin, where IndexedDB is unreliable and service workers refuse to
 * register. Served this way, the packaged app is a normal secure origin and
 * behaves exactly as it does in a browser — including working offline from the
 * first launch, with no server anywhere.
 */
public class MainActivity extends Activity {

    private static final String TAG = "VoidMusic";
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final String START_URL = ORIGIN + "/assets/www/index.html";
    private static final int REQ_FILE_CHOOSER = 1001;
    private static final int REQ_NOTIFICATIONS = 1002;
    private static final int REQ_FOLDER = 1003;
    private static final int REQ_ACCOUNT = 1004;

    /** Path the page fetches a picked file's bytes from, on our own origin. */
    private static final String LOCAL_FILE_PATH = "/localfile/";

    private WebView webView;
    private ValueCallback<Uri[]> pendingFileCallback;
    private FolderPicker folderPicker;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .setDomain("appassets.androidplatform.net")
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        folderPicker = new FolderPicker(this);

        // The WebView belongs to the process, not to this Activity: that is
        // what lets audio survive the app being closed. Borrow it and hand it
        // back in onDestroy rather than creating a new one.
        webView = WebAppHolder.get(this);
        WebAppHolder.detach(webView);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse local = serveLocalFile(request.getUrl());
                if (local != null) return local;
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (ORIGIN.equals(uri.getScheme() + "://" + uri.getHost())) {
                    return false; // our own page: let the WebView navigate
                }
                openExternally(uri);
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
                // Subresource failures (a blocked archive.org call) are the web
                // app's problem to report; only a failed main frame is fatal.
                if (request.isForMainFrame()) {
                    Log.e(TAG, "main frame failed: " + error.getDescription());
                    Toast.makeText(MainActivity.this, R.string.load_failed, Toast.LENGTH_LONG).show();
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (pendingFileCallback != null) {
                    pendingFileCallback.onReceiveValue(null);
                }
                pendingFileCallback = callback;
                try {
                    Intent intent = params.createIntent();
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    startActivityForResult(
                            Intent.createChooser(intent, getString(R.string.file_chooser_title)),
                            REQ_FILE_CHOOSER);
                    return true;
                } catch (ActivityNotFoundException e) {
                    pendingFileCallback = null;
                    return false;
                }
            }

            @Override
            public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
                // The WebView is built against the application context so it can
                // outlive this Activity, which means it has no window token of
                // its own to hang a dialog on. Build it here instead.
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm())
                        .setOnCancelListener(d -> result.cancel())
                        .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm())
                        .setNegativeButton(android.R.string.cancel, (d, w) -> result.cancel())
                        .setOnCancelListener(d -> result.cancel())
                        .show();
                return true;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    Log.w(TAG, "web: " + message.message() + " @" + message.lineNumber());
                }
                return true;
            }
        });

        // Service-worker requests bypass the WebViewClient, so they need the
        // asset loader wired up separately or the app's own sw.js would 404.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE)) {
            ServiceWorkerControllerCompat.getInstance().setServiceWorkerClient(
                    new ServiceWorkerClientCompat() {
                        @Override
                        public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                            return assetLoader.shouldInterceptRequest(request.getUrl());
                        }
                    });
        }

        // Safe because the WebView only ever loads our own bundled page; remote
        // content is fetched as data by that page, never loaded as a document.
        webView.addJavascriptInterface(new NativeBridge(this), "VoidNative");

        setContentView(webView);

        // Only the first Activity of the process loads the page; a later one is
        // re-attaching a WebView that has been playing all along.
        if (WebAppHolder.needsLoad()) webView.loadUrl(START_URL);

        // We may have been launched *by* the sign-in redirect.
        handleOAuthIntent(getIntent());

        requestNotificationPermissionIfNeeded();
    }

    /**
     * Hand back the bytes of a file from the folder the user granted.
     *
     * <p>Only ids handed out by {@link FolderPicker} resolve, so the page can
     * read exactly the files it was told about and nothing else on the device.
     */
    private WebResourceResponse serveLocalFile(Uri url) {
        if (url == null || !"appassets.androidplatform.net".equals(url.getHost())) return null;
        String path = url.getPath();
        if (path == null || !path.startsWith(LOCAL_FILE_PATH)) return null;

        Uri file = folderPicker.uriFor(path.substring(LOCAL_FILE_PATH.length()));
        if (file == null) return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                Collections.emptyMap(), null);

        try {
            InputStream in = getContentResolver().openInputStream(file);
            if (in == null) throw new java.io.IOException("no stream");
            String type = getContentResolver().getType(file);
            return new WebResourceResponse(
                    type != null ? type : "application/octet-stream", null,
                    200, "OK", Collections.emptyMap(), in);
        } catch (Exception e) {
            Log.w(TAG, "could not open picked file: " + e.getMessage());
            return new WebResourceResponse("text/plain", "utf-8", 500, "Error",
                    Collections.emptyMap(), null);
        }
    }

    /** Ask for a folder. The web app is told what is in it once one is granted. */
    void pickFolder() {
        try {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            startActivityForResult(intent, REQ_FOLDER);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, R.string.no_folder_picker, Toast.LENGTH_LONG).show();
            deliverFolder("[]");
        }
    }

    private void onFolderGranted(Uri tree) {
        try {
            getContentResolver().takePersistableUriPermission(tree,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException e) {
            // Not every provider offers a persistable grant; this session's is enough.
        }
        // Walking the tree is one content-provider query per folder, so keep it
        // off the UI thread even for a modest library.
        new Thread(() -> {
            final String json = folderPicker.scan(tree);
            runOnUiThread(() -> deliverFolder(json));
        }, "void-folder-scan").start();
    }

    private void deliverFolder(String json) {
        if (webView == null) return;
        webView.evaluateJavascript(
                "window.__voidFolderPicked && window.__voidFolderPicked(" + json + ")", null);
    }

    private void openExternally(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "No app can open that link", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleOAuthIntent(intent);
    }

    /** The browser returning from Google's consent page. */
    private void handleOAuthIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return;
        Uri data = intent.getData();
        if (data != null) OAuthClient.handleRedirect(this, data);
    }

    /** Begin the sign-in flow, from the JavaScript bridge. */
    boolean startSignIn(String clientId) {
        return OAuthClient.begin(this, clientId);
    }

    /**
     * The one-tap path: Android's own account picker, then Google's own consent
     * prompt. Nothing to register, nothing to paste.
     */
    void pickGoogleAccount() {
        try {
            startActivityForResult(AccountAuth.chooserIntent(), REQ_ACCOUNT);
        } catch (Exception e) {
            Log.w(TAG, "no account picker on this device: " + e.getMessage());
            AccountAuth.fail("This phone has no account picker");
        }
    }

    /** Same thing, reachable from the JavaScript bridge. */
    void openExternal(String url) {
        try {
            openExternally(Uri.parse(url));
        } catch (Exception e) {
            Log.w(TAG, "bad external url: " + url);
        }
    }

    /** Android 13+ needs explicit consent before the playback notification shows. */
    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFICATIONS);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_ACCOUNT) {
            String name = resultCode == RESULT_OK && data != null
                    ? data.getStringExtra(AccountManager.KEY_ACCOUNT_NAME)
                    : null;
            // Asking for a token is what triggers Google's "allow?" prompt, so
            // the sign-in is not finished until that comes back.
            AccountAuth.authorise(this, name);
            return;
        }
        if (requestCode == REQ_FOLDER) {
            Uri tree = resultCode == RESULT_OK && data != null ? data.getData() : null;
            if (tree != null) onFolderGranted(tree);
            else deliverFolder("[]");
            return;
        }
        if (requestCode == REQ_FILE_CHOOSER) {
            if (pendingFileCallback != null) {
                pendingFileCallback.onReceiveValue(
                        WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                pendingFileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        // The app routes with hash changes, so WebView history is the back stack.
        if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        // Hand the WebView back rather than destroying it: it keeps playing,
        // and the next Activity re-attaches it with all of its state intact.
        // The foreground service is what keeps the process around.
        if (webView != null) {
            webView.setWebChromeClient(null);
            WebAppHolder.detach(webView);
            webView = null;
        }
        super.onDestroy();
    }
}
