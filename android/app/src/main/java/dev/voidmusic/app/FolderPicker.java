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

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.text.TextUtils;
import android.util.Log;
import android.webkit.MimeTypeMap;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Turns a folder the user picked into a list the web app can import.
 *
 * <p>A WebView cannot pick a directory: {@code <input webkitdirectory>} has no
 * equivalent in Android's file chooser, so the browser path in the web app can
 * only ever offer "choose files". Android's own answer is the Storage Access
 * Framework — the user grants one folder, and the app walks it.
 *
 * <p>The bytes are deliberately not passed across the JavaScript bridge.
 * Base64 over that bridge would triple the size of every song and copy the lot
 * through a string. Instead each file gets a short-lived id, and the page reads
 * it back with a normal {@code fetch()} from the app's own origin, which the
 * WebView serves straight from the content provider as a stream.
 */
final class FolderPicker {

    private static final String TAG = "VoidMusic";

    /** Same set the web app accepts, so the two sides agree on what music is. */
    private static final String AUDIO_EXT =
            "mp3 m4a m4b aac mp4 flac ogg oga opus wav aif aiff wma";

    /** A folder of a few thousand songs is a library; more is a mistake. */
    private static final int MAX_FILES = 5000;

    /** Guards against a symlinked or pathological tree taking the app down. */
    private static final int MAX_DIRS = 2000;

    /** id → document Uri, for the files the page is allowed to read back. */
    private final Map<String, Uri> files = new ConcurrentHashMap<>();

    private final Context context;

    FolderPicker(Context context) {
        this.context = context.getApplicationContext();
    }

    Uri uriFor(String id) {
        return files.get(id);
    }

    void clear() {
        files.clear();
    }

    /**
     * Walk a granted tree and return the audio files inside it as JSON:
     * {@code [{id, name, path, size, mime}]}. Runs on a background thread —
     * every level costs a content-provider query.
     */
    String scan(Uri treeUri) {
        files.clear();
        JSONArray out = new JSONArray();

        final ContentResolver resolver = context.getContentResolver();
        final String rootId = DocumentsContract.getTreeDocumentId(treeUri);
        final String rootName = displayNameOf(resolver, treeUri, rootId);

        // Breadth-first, so the first files found are the ones nearest the top.
        Deque<String[]> queue = new ArrayDeque<>();   // { documentId, pathSoFar }
        queue.add(new String[]{ rootId, rootName });

        int dirs = 0;
        while (!queue.isEmpty() && files.size() < MAX_FILES && dirs < MAX_DIRS) {
            String[] entry = queue.poll();
            dirs++;

            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, entry[0]);
            try (Cursor c = resolver.query(children, new String[]{
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_MIME_TYPE,
                    DocumentsContract.Document.COLUMN_SIZE,
            }, null, null, null)) {

                if (c == null) continue;
                while (c.moveToNext() && files.size() < MAX_FILES) {
                    String docId = c.getString(0);
                    String name = c.getString(1);
                    String mime = c.getString(2);
                    long size = c.isNull(3) ? 0 : c.getLong(3);
                    if (TextUtils.isEmpty(name)) continue;

                    String path = entry[1] + "/" + name;

                    if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                        queue.add(new String[]{ docId, path });
                        continue;
                    }
                    if (!isAudio(name, mime) || size <= 0) continue;

                    String id = Integer.toHexString(path.hashCode()) + "-" + files.size();
                    Uri fileUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId);
                    files.put(id, fileUri);

                    JSONObject o = new JSONObject();
                    try {
                        o.put("id", id);
                        o.put("name", name);
                        o.put("path", path);
                        o.put("size", size);
                        o.put("mime", mimeFor(name, mime));
                        out.put(o);
                    } catch (Exception e) {
                        files.remove(id);
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "could not read folder: " + e.getMessage());
            }
        }

        return out.toString();
    }

    private static String displayNameOf(ContentResolver resolver, Uri treeUri, String documentId) {
        Uri doc = DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId);
        try (Cursor c = resolver.query(doc,
                new String[]{ DocumentsContract.Document.COLUMN_DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String name = c.getString(0);
                if (!TextUtils.isEmpty(name)) return name;
            }
        } catch (Exception ignored) {
            // A provider that will not tell us the name is not a reason to stop.
        }
        return "Music";
    }

    private static boolean isAudio(String name, String mime) {
        if (mime != null && mime.toLowerCase(Locale.US).startsWith("audio/")) return true;
        return AUDIO_EXT.contains(extensionOf(name));
    }

    private static String extensionOf(String name) {
        int dot = name.lastIndexOf('.');
        if (dot < 0 || dot == name.length() - 1) return "";
        return name.substring(dot + 1).toLowerCase(Locale.US);
    }

    /**
     * Providers often report {@code application/octet-stream} for music. The
     * extension is the better guess, and the web app's tag reader needs a
     * sensible type to pick a parser.
     */
    private static String mimeFor(String name, String reported) {
        if (reported != null && reported.toLowerCase(Locale.US).startsWith("audio/")) return reported;
        String guess = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extensionOf(name));
        if (guess != null) return guess;
        return "audio/mpeg";
    }
}
