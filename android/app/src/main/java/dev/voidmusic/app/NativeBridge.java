package dev.voidmusic.app;

import android.app.Activity;
import android.webkit.JavascriptInterface;

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

    private final Activity activity;

    NativeBridge(Activity activity) {
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
}
