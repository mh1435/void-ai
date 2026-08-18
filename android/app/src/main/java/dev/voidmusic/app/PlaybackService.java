package dev.voidmusic.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.os.Build;
import android.os.IBinder;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.core.app.NotificationCompat;
import androidx.media.app.NotificationCompat.MediaStyle;
import androidx.media.session.MediaButtonReceiver;

/**
 * The media session and the foreground service, which are really one job.
 *
 * <p>The audio itself belongs to the WebView — there is no second player here.
 * What this adds is everything the system needs to treat that audio as music
 * rather than as a browser making noise: a {@link MediaSessionCompat} carrying
 * the title, artist, artwork and position, and a MediaStyle notification built
 * from it. That session is what the lock screen, the notification shade,
 * Bluetooth, headset buttons and HyperOS's island all read from. Without it the
 * OS has nothing to show.
 *
 * <p>Commands arriving from any of those surfaces are forwarded into the page,
 * so the web app stays the single source of truth for playback.
 */
public class PlaybackService extends Service {

    private static final String CHANNEL_ID = "void_playback";
    private static final int NOTIFICATION_ID = 1;

    private static final String ACTION_UPDATE = "dev.voidmusic.app.UPDATE";
    private static final String ACTION_STOP = "dev.voidmusic.app.STOP";

    /**
     * What is playing, shared in-process rather than passed through Intent
     * extras: cover artwork is far too big for a Binder transaction.
     */
    static final class NowPlaying {
        String title = "Void Music";
        String artist = "";
        String album = "";
        long durationMs = 0;
        long positionMs = 0;
        boolean playing = false;
        Bitmap artwork;
    }

    private static final NowPlaying state = new NowPlaying();

    private MediaSessionCompat session;
    private boolean started;

    /** Push the current state to the notification and the media session. */
    static void update(Context context, NowPlaying next) {
        synchronized (state) {
            state.title = next.title;
            state.artist = next.artist;
            state.album = next.album;
            state.durationMs = next.durationMs;
            state.positionMs = next.positionMs;
            state.playing = next.playing;
            if (next.artwork != null) state.artwork = next.artwork;
        }
        Intent intent = new Intent(context, PlaybackService.class).setAction(ACTION_UPDATE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    /** A copy of what is currently showing, for callers that update one field. */
    static NowPlaying currentState() {
        NowPlaying copy = new NowPlaying();
        synchronized (state) {
            copy.title = state.title;
            copy.artist = state.artist;
            copy.album = state.album;
            copy.durationMs = state.durationMs;
            copy.positionMs = state.positionMs;
            copy.playing = state.playing;
            copy.artwork = state.artwork;
        }
        return copy;
    }

    /** Older entry point: title/artist only, still used when a track starts. */
    public static void start(Context context, String title, String artist) {
        NowPlaying next = new NowPlaying();
        synchronized (state) {
            next.title = title;
            next.artist = artist;
            next.album = state.album;
            next.durationMs = state.durationMs;
            next.artwork = state.artwork;
        }
        next.playing = true;
        update(context, next);
    }

    public static void stop(Context context) {
        context.startService(new Intent(context, PlaybackService.class).setAction(ACTION_STOP));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();

        session = new MediaSessionCompat(this, "VoidMusic");
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay()          { command("play"); }
            @Override public void onPause()         { command("pause"); }
            @Override public void onSkipToNext()    { command("next"); }
            @Override public void onSkipToPrevious(){ command("prev"); }
            @Override public void onStop()          { command("pause"); }
            @Override public void onSeekTo(long ms) {
                WebAppHolder.eval("window.__voidCommand && window.__voidCommand('seek'," + (ms / 1000.0) + ")");
            }
        });
        session.setActive(true);
    }

    private void command(String name) {
        WebAppHolder.eval("window.__voidCommand && window.__voidCommand('" + name + "')");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // A media button pressed while nothing is in the foreground arrives here.
        MediaButtonReceiver.handleIntent(session, intent);

        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            command("pause");
            stopForegroundCompat(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        NowPlaying snapshot = snapshot();
        session.setMetadata(metadataOf(snapshot));
        session.setPlaybackState(stateOf(snapshot));

        Notification notification = buildNotification(snapshot);
        if (!started) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
            started = true;
        } else {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.notify(NOTIFICATION_ID, notification);
            if (!snapshot.playing) {
                // Paused: drop out of the foreground so the notification can be
                // swiped away, but keep it on screen to resume from.
                stopForegroundCompat(false);
                started = false;
            }
        }
        return START_NOT_STICKY;
    }

    private NowPlaying snapshot() {
        NowPlaying copy = new NowPlaying();
        synchronized (state) {
            copy.title = state.title;
            copy.artist = state.artist;
            copy.album = state.album;
            copy.durationMs = state.durationMs;
            copy.positionMs = state.positionMs;
            copy.playing = state.playing;
            copy.artwork = state.artwork;
        }
        return copy;
    }

    private MediaMetadataCompat metadataOf(NowPlaying now) {
        MediaMetadataCompat.Builder b = new MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, now.title)
                .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_TITLE, now.title)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, now.artist)
                .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_SUBTITLE, now.artist)
                .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, now.album)
                .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, now.durationMs);
        if (now.artwork != null) {
            b.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, now.artwork);
            b.putBitmap(MediaMetadataCompat.METADATA_KEY_ART, now.artwork);
        }
        return b.build();
    }

    private PlaybackStateCompat stateOf(NowPlaying now) {
        return new PlaybackStateCompat.Builder()
                .setActions(PlaybackStateCompat.ACTION_PLAY
                        | PlaybackStateCompat.ACTION_PAUSE
                        | PlaybackStateCompat.ACTION_PLAY_PAUSE
                        | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
                        | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
                        | PlaybackStateCompat.ACTION_SEEK_TO
                        | PlaybackStateCompat.ACTION_STOP)
                .setState(now.playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
                        now.positionMs, now.playing ? 1f : 0f)
                .build();
    }

    private Notification buildNotification(NowPlaying now) {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;

        // Tapping the notification returns to the running app rather than
        // starting a second copy of it.
        Intent open = new Intent(this, MainActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, open, flags);
        session.setSessionActivity(contentIntent);

        PendingIntent stopIntent = PendingIntent.getService(this, 1,
                new Intent(this, PlaybackService.class).setAction(ACTION_STOP), flags);

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(now.title)
                .setContentText(now.artist)
                .setSubText(now.album)
                .setLargeIcon(now.artwork)
                .setContentIntent(contentIntent)
                .setDeleteIntent(stopIntent)
                .setOngoing(now.playing)
                .setShowWhen(false)
                .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setPriority(NotificationCompat.PRIORITY_LOW);

        b.addAction(new NotificationCompat.Action(R.drawable.ic_media_prev, "Previous",
                mediaAction(PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS)));
        b.addAction(now.playing
                ? new NotificationCompat.Action(R.drawable.ic_media_pause, "Pause",
                        mediaAction(PlaybackStateCompat.ACTION_PLAY_PAUSE))
                : new NotificationCompat.Action(R.drawable.ic_media_play, "Play",
                        mediaAction(PlaybackStateCompat.ACTION_PLAY_PAUSE)));
        b.addAction(new NotificationCompat.Action(R.drawable.ic_media_next, "Next",
                mediaAction(PlaybackStateCompat.ACTION_SKIP_TO_NEXT)));

        b.setStyle(new MediaStyle()
                .setMediaSession(session.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2)
                .setShowCancelButton(true)
                .setCancelButtonIntent(stopIntent));

        return b.build();
    }

    private PendingIntent mediaAction(long action) {
        return MediaButtonReceiver.buildMediaButtonPendingIntent(this, action);
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;

        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                getString(R.string.notification_channel_name),
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription(getString(R.string.notification_channel_description));
        channel.setShowBadge(false);
        channel.setSound(null, null);
        manager.createNotificationChannel(channel);
    }

    @SuppressWarnings("deprecation")
    private void stopForegroundCompat(boolean removeNotification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(removeNotification ? Service.STOP_FOREGROUND_REMOVE
                    : Service.STOP_FOREGROUND_DETACH);
        } else {
            stopForeground(removeNotification);
        }
    }

    /**
     * The task was swiped out of Recents. Deliberately does not stop: the
     * WebView lives in the process, not in the Activity, so the music can carry
     * on exactly as it does with the screen off.
     */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        if (!snapshot().playing) {
            WebAppHolder.destroy();
            stopForegroundCompat(true);
            stopSelf();
        }
    }

    @Override
    public void onDestroy() {
        if (session != null) {
            session.setActive(false);
            session.release();
            session = null;
        }
        stopForegroundCompat(true);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null; // started service only
    }
}
