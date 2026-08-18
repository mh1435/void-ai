package dev.voidmusic.app;

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
