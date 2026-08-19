package dev.voidmusic.app;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

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
