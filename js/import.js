/* Bringing your own music in.
 *
 * The Archive's catalogue is open but small. Your own files are the rest of
 * your library, and they should not have to be added one at a time — so this
 * takes a whole folder, reads the real tags out of every file, and writes them
 * into the same shape as anything else the app plays.
 *
 * Nothing leaves the device. The files are copied into IndexedDB so they keep
 * playing with no connection and survive the browser forgetting the folder. */

import { local } from './store.js';
import { readTags, readDuration } from './tags.js';

const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|mp4|flac|ogg|oga|opus|wav|aiff?|wma)$/i;
const AUDIO_MIME = /^audio\//i;

/** How many files to work on at once: enough to hide latency, not enough to
 *  make a phone stutter while it is also playing something. */
const CONCURRENCY = 4;

/** Anything larger than this is almost certainly not a song. */
const MAX_BYTES = 512 * 1024 * 1024;

export function isAudioFile(file) {
  return AUDIO_MIME.test(file.type || '') || AUDIO_EXT.test(file.name || '');
}

/** Stable id, so re-importing the same folder updates rather than duplicates. */
function idFor(file) {
  const path = file.webkitRelativePath || file.name;
  return `local::${path}::${file.size}`;
}

function trackFrom(file, tags, duration) {
  const path = file.webkitRelativePath || file.name;
  return {
    id: idFor(file),
    itemId: 'local',
    file: file.name,
    path,
    title: tags.title,
    artist: tags.artist || 'Unknown artist',
    album: tags.album || folderOf(path) || 'Your files',
    albumArtist: tags.albumArtist || '',
    year: tags.year || '',
    genre: tags.genre || '',
    duration,
    size: file.size,
    mime: file.type || 'audio/mpeg',
    ext: (file.name.split('.').pop() || '').toLowerCase(),
    trackNo: tags.trackNo || null,
    cover: null,               // filled in from the stored blob when listed
    urls: [],
    source: 'local',
  };
}

/** "Artists/Portishead/Dummy/03 track.flac" → "Dummy". */
function folderOf(path) {
  const parts = String(path).split('/');
  return parts.length > 1 ? parts[parts.length - 2] : '';
}

/**
 * Import a list of files.
 *
 * `onProgress({done, total, current, added, skipped, failed})` is called as it
 * goes so the UI can show real movement on a folder of several hundred songs.
 * Resolves with the totals. Individual failures never stop the run.
 */
export async function importFiles(files, { onProgress = () => {}, signal } = {}) {
  const list = [...files].filter((f) => isAudioFile(f) && f.size > 0 && f.size <= MAX_BYTES);
  const total = list.length;
  const result = { total, added: 0, skipped: 0, failed: 0, done: 0 };
  if (!total) return result;

  const existing = await local.ids();
  let cursor = 0;

  async function worker() {
    while (cursor < list.length) {
      if (signal?.aborted) return;
      const file = list[cursor++];

      try {
        if (existing.has(idFor(file))) {
          result.skipped++;
        } else {
          const tags = await readTags(file);
          const duration = await readDuration(file);
          const track = trackFrom(file, tags, duration);
          await local.add(track, file, tags.picture);
          existing.add(track.id);
          result.added++;
        }
      } catch {
        // A file the browser cannot read is one file, not a failed import.
        result.failed++;
      }

      result.done++;
      onProgress({ ...result, current: file.name });
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
  return result;
}

/**
 * Pull every audio file out of a drag-and-drop, walking into folders when the
 * browser exposes the directory entry API (Chrome, Edge, Safari — which is to
 * say, dragging a folder in works).
 */
export async function filesFromDrop(dataTransfer) {
  const items = [...(dataTransfer.items || [])];
  const entries = items
    .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
    .filter(Boolean);

  if (!entries.length) return [...(dataTransfer.files || [])];

  const out = [];
  await Promise.all(entries.map((entry) => walkEntry(entry, out)));
  return out;
}

async function walkEntry(entry, out, depth = 0) {
  if (depth > 8 || out.length > 5000) return;

  if (entry.isFile) {
    const file = await new Promise((res) => entry.file(res, () => res(null)));
    if (file && isAudioFile(file)) {
      // Keep the folder structure, which is where album names often live.
      try {
        Object.defineProperty(file, 'webkitRelativePath', {
          value: entry.fullPath.replace(/^\//, ''),
          configurable: true,
        });
      } catch { /* read-only in some engines; the name still works */ }
      out.push(file);
    }
    return;
  }

  if (entry.isDirectory) {
    const reader = entry.createReader();
    // readEntries returns at most 100 at a time and must be called until empty.
    for (;;) {
      const batch = await new Promise((res) => reader.readEntries(res, () => res([])));
      if (!batch.length) break;
      for (const child of batch) await walkEntry(child, out, depth + 1);
    }
  }
}
