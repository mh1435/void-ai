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

/* Reading tags out of audio files, in the browser, with no dependencies.
 *
 * Importing a folder is only worth doing if the songs arrive with their real
 * names and covers rather than "track_03". So we read the metadata ourselves:
 * ID3v2 for MP3, Vorbis comments for FLAC and Ogg, iTunes-style atoms for MP4.
 *
 * Everything here is defensive. A malformed tag is extremely common in the
 * wild, and the correct response to one is to fall back to the filename, never
 * to fail the import. Nothing in this file throws. */

const dec = {
  latin1: new TextDecoder('iso-8859-1'),
  utf8: new TextDecoder('utf-8'),
  utf16le: new TextDecoder('utf-16le'),
  utf16be: new TextDecoder('utf-16be'),
};

/**
 * ID3v2 encoding 0x01 is "UTF-16 with a byte-order mark", and the mark — not
 * the spec — decides the order, per frame.
 *
 * The obvious `new TextDecoder('utf-16')` does NOT sniff it. The Encoding
 * Standard defines `utf-16` as a plain alias for `utf-16le`, so a big-endian
 * frame read under that label pairs each ASCII byte with the zero beside it
 * and yields one CJK ideograph per character: "Stream" decodes to "匀琀爀攀愀洀".
 * Tags written big-endian are common enough (iTunes and several taggers emit
 * them) that this is what a mangled title in the player almost always is.
 *
 * Both decoders strip the mark themselves once the order is right.
 */
function decodeUtf16(bytes) {
  const bigEndian = bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF;
  return (bigEndian ? dec.utf16be : dec.utf16le).decode(bytes);
}

/** Read the head of a file without pulling the whole thing into memory. */
async function head(file, bytes) {
  const slice = file.slice(0, Math.min(bytes, file.size));
  return new Uint8Array(await slice.arrayBuffer());
}

async function chunk(file, start, length) {
  if (start >= file.size) return new Uint8Array(0);
  const end = Math.min(file.size, start + length);
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

const ascii = (b, at, len) => dec.latin1.decode(b.subarray(at, at + len));
const u32be = (b, at) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const u32le = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/** ID3 sizes are "syncsafe": seven bits per byte, top bit always clear. */
const syncsafe = (b, at) => (b[at] << 21) | (b[at + 1] << 14) | (b[at + 2] << 7) | b[at + 3];

function decodeText(bytes, encoding) {
  let out;
  switch (encoding) {
    case 1: out = decodeUtf16(bytes); break;
    case 2: out = dec.utf16be.decode(bytes); break;
    case 3: out = dec.utf8.decode(bytes); break;
    default: out = dec.latin1.decode(bytes); break;
  }
  return out.replace(/\0+$/, '').trim();
}

/* ── ID3v2 (MP3) ───────────────────────────────────────────────────── */

const ID3_TEXT = {
  TIT2: 'title', TT2: 'title',
  TPE1: 'artist', TP1: 'artist',
  TPE2: 'albumArtist', TP2: 'albumArtist',
  TALB: 'album', TAL: 'album',
  TRCK: 'trackNo', TRK: 'trackNo',
  TYER: 'year', TYE: 'year', TDRC: 'year',
  TCON: 'genre', TCO: 'genre',
};

async function readID3(file) {
  const probe = await head(file, 10);
  if (probe.length < 10 || ascii(probe, 0, 3) !== 'ID3') return null;

  const major = probe[3];
  const flags = probe[5];
  const size = syncsafe(probe, 6);
  const bytes = await head(file, Math.min(10 + size, file.size));

  let at = 10;
  // An extended header, when present, sits between the header and the frames.
  if (flags & 0x40) {
    at += major >= 4 ? syncsafe(bytes, at) : u32be(bytes, at) + 4;
  }

  const idLen = major === 2 ? 3 : 4;
  const headerLen = major === 2 ? 6 : 10;
  const out = {};

  while (at + headerLen <= bytes.length) {
    const id = ascii(bytes, at, idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;    // padding, or we lost the thread

    let frameSize;
    if (major === 2) frameSize = (bytes[at + 3] << 16) | (bytes[at + 4] << 8) | bytes[at + 5];
    else if (major >= 4) frameSize = syncsafe(bytes, at + 4);
    else frameSize = u32be(bytes, at + 4);

    const body = at + headerLen;
    if (frameSize <= 0 || body + frameSize > bytes.length) break;
    const frame = bytes.subarray(body, body + frameSize);

    const field = ID3_TEXT[id];
    if (field) {
      const value = decodeText(frame.subarray(1), frame[0]);
      if (value && !out[field]) out[field] = value;
    } else if (id === 'APIC' || id === 'PIC') {
      const pic = readPicture(frame, id === 'PIC');
      if (pic && !out.picture) out.picture = pic;
    }

    at = body + frameSize;
  }

  return out;
}

/** APIC/PIC payload: encoding, mime, type, description, then the image. */
function readPicture(frame, short) {
  try {
    const encoding = frame[0];
    let at = 1;
    let mime;

    if (short) {
      mime = ({ jpg: 'image/jpeg', png: 'image/png' })[ascii(frame, 1, 3).toLowerCase()] || 'image/jpeg';
      at = 4;
    } else {
      const end = frame.indexOf(0, at);
      if (end < 0) return null;
      mime = ascii(frame, at, end - at) || 'image/jpeg';
      if (!mime.includes('/')) mime = `image/${mime.toLowerCase()}`;
      at = end + 1;
    }

    at += 1; // picture type byte

    // Skip the description, which is terminated the same way it is encoded.
    if (encoding === 1 || encoding === 2) {
      while (at + 1 < frame.length && !(frame[at] === 0 && frame[at + 1] === 0)) at += 2;
      at += 2;
    } else {
      const end = frame.indexOf(0, at);
      if (end < 0) return null;
      at = end + 1;
    }

    if (at >= frame.length) return null;
    return new Blob([frame.subarray(at)], { type: mime });
  } catch {
    return null;
  }
}

/* ── Vorbis comments (FLAC, Ogg, Opus) ─────────────────────────────── */

const VORBIS_FIELDS = {
  TITLE: 'title',
  ARTIST: 'artist',
  ALBUMARTIST: 'albumArtist',
  ALBUM: 'album',
  TRACKNUMBER: 'trackNo',
  DATE: 'year',
  GENRE: 'genre',
};

/** Parse "KEY=value" entries; `at` points at the vendor string length. */
function readVorbisComments(bytes, at, out) {
  const vendorLen = u32le(bytes, at);
  at += 4 + vendorLen;
  let count = u32le(bytes, at);
  at += 4;

  // Guard against a corrupt count sending us into a very long loop.
  count = Math.min(count, 512);

  for (let i = 0; i < count && at + 4 <= bytes.length; i++) {
    const len = u32le(bytes, at);
    at += 4;
    if (len <= 0 || at + len > bytes.length) break;
    const entry = dec.utf8.decode(bytes.subarray(at, at + len));
    at += len;

    const eq = entry.indexOf('=');
    if (eq < 1) continue;
    const key = entry.slice(0, eq).toUpperCase();
    const value = entry.slice(eq + 1).trim();

    const field = VORBIS_FIELDS[key];
    if (field && value && !out[field]) out[field] = value;

    // FLAC also allows a base64 picture inside a comment.
    if (key === 'METADATA_BLOCK_PICTURE' && !out.picture) {
      out.picture = readFlacPicture(base64Bytes(value));
    }
  }
  return at;
}

function base64Bytes(s) {
  try {
    const bin = atob(s);
    const b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return b;
  } catch {
    return new Uint8Array(0);
  }
}

function readFlacPicture(bytes) {
  try {
    let at = 4;                              // picture type
    const mimeLen = u32be(bytes, at); at += 4;
    const mime = ascii(bytes, at, mimeLen); at += mimeLen;
    const descLen = u32be(bytes, at); at += 4 + descLen;
    at += 16;                                // width, height, depth, colours
    const dataLen = u32be(bytes, at); at += 4;
    if (!dataLen || at + dataLen > bytes.length) return null;
    return new Blob([bytes.subarray(at, at + dataLen)], { type: mime || 'image/jpeg' });
  } catch {
    return null;
  }
}

async function readFlac(file) {
  const bytes = await head(file, Math.min(file.size, 4 * 1024 * 1024));
  if (ascii(bytes, 0, 4) !== 'fLaC') return null;

  const out = {};
  let at = 4;
  while (at + 4 <= bytes.length) {
    const last = (bytes[at] & 0x80) !== 0;
    const type = bytes[at] & 0x7f;
    const len = (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
    const body = at + 4;
    if (body + len > bytes.length) break;

    if (type === 4) readVorbisComments(bytes, body, out);
    else if (type === 6 && !out.picture) out.picture = readFlacPicture(bytes.subarray(body, body + len));

    if (last) break;
    at = body + len;
  }
  return out;
}

/** Find a byte pattern, so we can locate a comment header inside Ogg pages. */
function indexOfBytes(haystack, needle, from = 0) {
  outer:
  for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

const bytesOf = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/**
 * Ogg wraps its packets in pages, and a comment header can be split across
 * them. Rather than implement page reassembly for the rare large-cover case,
 * we read the comment header where it sits contiguously — which is how
 * virtually every encoder writes it.
 */
async function readOgg(file) {
  const bytes = await head(file, Math.min(file.size, 1024 * 1024));
  if (ascii(bytes, 0, 4) !== 'OggS') return null;

  const out = {};
  const vorbis = indexOfBytes(bytes, bytesOf('\x03vorbis'));
  if (vorbis >= 0) {
    readVorbisComments(bytes, vorbis + 7, out);
    return out;
  }
  const opus = indexOfBytes(bytes, bytesOf('OpusTags'));
  if (opus >= 0) {
    readVorbisComments(bytes, opus + 8, out);
    return out;
  }
  return out;
}

/* ── MP4 / M4A atoms ───────────────────────────────────────────────── */

const MP4_FIELDS = {
  '©nam': 'title',
  '©ART': 'artist',
  aART: 'albumArtist',
  '©alb': 'album',
  '©day': 'year',
  '©gen': 'genre',
  trkn: 'trackNo',
};

/** Walk top-level atoms until we find moov, then read that one whole. */
async function readMp4(file) {
  let at = 0;
  for (let guard = 0; guard < 64 && at + 8 <= file.size; guard++) {
    const header = await chunk(file, at, 16);
    if (header.length < 8) return null;

    let size = u32be(header, 0);
    const type = ascii(header, 4, 4);
    let bodyAt = at + 8;

    if (size === 1) {
      // 64-bit size; the high word is always 0 for anything we can hold.
      size = u32be(header, 12);
      bodyAt = at + 16;
    } else if (size === 0) {
      size = file.size - at;
    }
    if (size < 8) return null;

    if (type === 'moov') {
      const moov = await chunk(file, bodyAt, Math.min(size, 12 * 1024 * 1024));
      const out = {};
      walkAtoms(moov, 0, moov.length, out, 0);
      return out;
    }
    if (type !== 'ftyp' && type !== 'free' && type !== 'skip' && type !== 'wide' && type !== 'mdat') {
      // Unknown container at the top level: keep going, but don't trust it.
    }
    at += size;
  }
  return null;
}

function walkAtoms(bytes, start, end, out, depth) {
  if (depth > 6) return;
  let at = start;
  while (at + 8 <= end) {
    const size = u32be(bytes, at);
    const type = ascii(bytes, at + 4, 4);
    if (size < 8 || at + size > end) return;

    if (type === 'udta' || type === 'ilst') {
      walkAtoms(bytes, at + 8, at + size, out, depth + 1);
    } else if (type === 'meta') {
      // `meta` carries a version/flags word before its children.
      walkAtoms(bytes, at + 12, at + size, out, depth + 1);
    } else if (type === 'covr' && !out.picture) {
      out.picture = readMp4Data(bytes, at + 8, at + size, true);
    } else if (MP4_FIELDS[type]) {
      const value = readMp4Data(bytes, at + 8, at + size, false);
      if (value && !out[MP4_FIELDS[type]]) out[MP4_FIELDS[type]] = value;
    }
    at += size;
  }
}

/** The value of an iTunes atom lives in a nested `data` atom. */
function readMp4Data(bytes, start, end, asImage) {
  let at = start;
  while (at + 16 <= end) {
    const size = u32be(bytes, at);
    const type = ascii(bytes, at + 4, 4);
    if (size < 16 || at + size > end) return null;

    if (type === 'data') {
      const flag = u32be(bytes, at + 8) & 0xffffff;
      const body = bytes.subarray(at + 16, at + size);
      if (asImage) {
        const mime = flag === 14 ? 'image/png' : 'image/jpeg';
        return body.length ? new Blob([body], { type: mime }) : null;
      }
      // Track numbers are stored as binary, everything else as UTF-8 text.
      if (flag === 0 && body.length >= 4) return String(body[3] || body[1] || '');
      return dec.utf8.decode(body).replace(/\0+$/, '').trim();
    }
    at += size;
  }
  return null;
}

/* ── Duration ──────────────────────────────────────────────────────── */

/**
 * Ask the browser rather than parsing frame headers: it already has a decoder
 * for every format it can play, and getting this wrong by hand is easy.
 */
export function readDuration(file, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const probe = new Audio();
    let settled = false;

    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probe.removeAttribute('src');
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(value) && value > 0 ? value : 0);
    };

    const timer = setTimeout(() => done(0), timeoutMs);
    probe.preload = 'metadata';
    probe.addEventListener('loadedmetadata', () => done(probe.duration), { once: true });
    probe.addEventListener('error', () => done(0), { once: true });
    probe.src = url;
  });
}

/* ── Filename fallback ─────────────────────────────────────────────── */

/**
 * Guess from the name when there are no tags at all. Handles the two layouts
 * people actually use: "Artist - Title" and "03 - Artist - Title".
 */
export function fromFilename(name) {
  let base = String(name).replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  let trackNo = null;

  const lead = base.match(/^(\d{1,3})\s*[-.–—]\s*(.+)$/);
  if (lead) {
    trackNo = Number(lead[1]);
    base = lead[2].trim();
  }

  const parts = base.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim(), trackNo };
  }
  return { artist: '', title: base, trackNo };
}

/* ── Public entry point ────────────────────────────────────────────── */

const EXT = (name) => (String(name).split('.').pop() || '').toLowerCase();

/**
 * Everything we could learn about one file: tags where they exist, the
 * filename where they don't, plus duration and any embedded cover.
 * Never rejects.
 */
export async function readTags(file) {
  const ext = EXT(file.name);
  let tags = null;

  try {
    if (ext === 'flac') tags = await readFlac(file);
    else if (ext === 'ogg' || ext === 'oga' || ext === 'opus') tags = await readOgg(file);
    else if (ext === 'm4a' || ext === 'mp4' || ext === 'm4b' || ext === 'aac') tags = await readMp4(file);
    else tags = await readID3(file);

    // A mis-named file is common; try the other readers before giving up.
    if (!tags || !tags.title) {
      for (const reader of [readID3, readFlac, readMp4, readOgg]) {
        const alt = await reader(file).catch(() => null);
        if (alt?.title) { tags = { ...(tags || {}), ...alt }; break; }
      }
    }
  } catch {
    tags = null;
  }

  const guess = fromFilename(file.name);
  const t = tags || {};

  return {
    title: clean(t.title) || guess.title || file.name,
    artist: clean(t.artist) || clean(t.albumArtist) || guess.artist || '',
    album: clean(t.album) || '',
    albumArtist: clean(t.albumArtist) || '',
    year: (String(t.year || '').match(/\d{4}/) || [''])[0],
    genre: clean(t.genre) || '',
    trackNo: trackNumber(t.trackNo) || guess.trackNo || null,
    picture: t.picture instanceof Blob && t.picture.size > 512 ? t.picture : null,
  };
}

function clean(v) {
  const s = String(v ?? '').replace(/\0/g, '').trim();
  return s && s !== 'Unknown' ? s : '';
}

/**
 * Undo the mangling described on decodeUtf16, for tags that were already read
 * and stored before it was fixed. Re-importing would not do it: the importer
 * skips files it has seen, so a mangled title would survive until the track
 * was deleted by hand.
 *
 * The fingerprint is U+FFFE at the head — a byte-swapped BOM, and a permanent
 * noncharacter that cannot legitimately appear in text, so nothing else can
 * match it. The mangling is a pure 16-bit byte swap, so swapping back recovers
 * the original exactly, in any script.
 */
export function repairMangledText(v) {
  if (typeof v !== 'string' || v.charCodeAt(0) !== 0xFFFE) return v;
  let out = '';
  for (let i = 1; i < v.length; i++) {
    const c = v.charCodeAt(i);
    out += String.fromCharCode(((c & 0xFF) << 8) | ((c >> 8) & 0xFF));
  }
  return out.replace(/\0+$/, '').trim();
}

function trackNumber(v) {
  const n = parseInt(String(v ?? '').split('/')[0], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
