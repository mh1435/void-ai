// Internet Archive client — a free, keyless catalog of Creative Commons
// audio. This is what Void works with out of the box, before anyone has
// pasted a Jamendo key in Settings.
//
// Two-step lookup: advancedsearch.php finds CC-licensed audio items, then
// each item's metadata endpoint is read to find its actual playable file.
// Artwork comes from Archive's generic per-item thumbnail service, which
// needs no extra request.

const SEARCH_URL = 'https://archive.org/advancedsearch.php';
const METADATA_URL = 'https://archive.org/metadata';
const DOWNLOAD_URL = 'https://archive.org/download';
const THUMB_URL = 'https://archive.org/services/img';

const AUDIO_EXT = /\.(mp3|ogg|m4a|flac)$/i;

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`archive.org ${res.status}`);
  return res.json();
}

async function search(query, limit) {
  const url = new URL(SEARCH_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('rows', String(limit));
  url.searchParams.set('output', 'json');
  url.searchParams.set('sort[]', '-addeddate');
  ['identifier', 'title', 'creator'].forEach((f) => url.searchParams.append('fl[]', f));

  const data = await fetchJson(url.toString());
  return (data.response && data.response.docs) || [];
}

function pickAudioFile(meta) {
  const files = meta.files || [];
  return files.find((f) => f.name && AUDIO_EXT.test(f.name) && /mp3/i.test(f.format || f.name))
    || files.find((f) => f.name && AUDIO_EXT.test(f.name));
}

async function hydrate(doc) {
  try {
    const meta = await fetchJson(`${METADATA_URL}/${encodeURIComponent(doc.identifier)}`);
    const file = pickAudioFile(meta);
    if (!file) return null;
    return normalizeArchiveItem(doc, meta, file);
  } catch {
    return null;
  }
}

function normalizeArchiveItem(doc, meta, file) {
  const identifier = doc.identifier;
  const title = file.title || doc.title || identifier;
  const artist = doc.creator || (meta.metadata && meta.metadata.creator) || 'Unknown artist';
  return {
    id: `archive-${identifier}-${file.name}`,
    kind: 'track',
    title: Array.isArray(title) ? title[0] : title,
    artist: Array.isArray(artist) ? artist[0] : artist,
    album: (meta.metadata && meta.metadata.album) || 'Internet Archive',
    duration: file.length ? Math.round(parseFloat(file.length)) : 0,
    url: `${DOWNLOAD_URL}/${identifier}/${encodeURIComponent(file.name)}`,
    artwork: `${THUMB_URL}/${identifier}`,
    source: 'archive',
    license: 'CC',
    flac: /\.flac$/i.test(file.name),
  };
}

async function hydrateAll(docs, limit) {
  const picked = docs.slice(0, limit);
  const results = await Promise.all(picked.map(hydrate));
  return results.filter(Boolean);
}

export async function getArchiveNewReleases(limit = 10) {
  const docs = await search(
    'mediatype:(audio) AND licenseurl:(*creativecommons*)',
    Math.max(limit * 2, limit + 5),
  );
  return hydrateAll(docs, limit);
}

export async function searchArchive(query, limit = 10) {
  const safe = query.replace(/["\\]/g, ' ').trim();
  if (!safe) return [];
  const docs = await search(
    `mediatype:(audio) AND licenseurl:(*creativecommons*) AND (${safe})`,
    Math.max(limit * 2, limit + 5),
  );
  return hydrateAll(docs, limit);
}
