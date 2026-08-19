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

/* Route views. Each exported function fills the #view container. */

import * as A from './archive.js';
import * as P from './player.js';
import { likes, playlists, offline, local, recent, usage, getSetting, setSetting } from './store.js';
import { demoItem, isDemoTrack, renderDemoBlob, DEMO_ITEM_ID } from './demo.js';
import { health, diag, bus, probe } from './net.js';
import { resolveCover, coverCache } from './artwork.js';
import { currentTheme, amoledOn, setTheme, setAmoled } from './theme.js';
import { checkForUpdate, APP_VERSION } from './update.js';
import { canPickFolder, pickFolder, openExternal } from './native.js';
import { encodeMix, decodeMix, parseText, resolveMix, playable, forgetLibrary } from './mix.js';
import * as YT from './youtube.js';
import { canSignIn, googleAccount, signInWithGoogle } from './native.js';
import { importFiles, filesFromDrop, isAudioFile } from './import.js';
import { scrobbler } from './scrobble.js';
import {
  $, el, svg, ICONS, fmtTime, fmtBytes, fmtCount, toast, artNode, tintedArt,
  loadingRow, emptyState, errorBox,
} from './ui.js';

let navigate = () => {};
export function setNavigator(fn) { navigate = fn; }

/** Aborts in-flight work when the user navigates away mid-load. */
let viewAbort = null;
function freshSignal() {
  viewAbort?.abort();
  viewAbort = new AbortController();
  return viewAbort.signal;
}

/** Routes that are a destination rather than a drill-down. */
const TOP_LEVEL = /^#\/(home|library|offline|settings)$|^#\/search/;

/**
 * Put a view on screen.
 *
 * Titles live inside the scrolling area, not in a fixed bar: a large heading
 * that scrolls away with the content, and a back chevron beside it on any page
 * you drilled into.
 */
function mount(node, title, actions = []) {
  const view = $('#view');
  const parts = [];
  const drilled = !TOP_LEVEL.test(location.hash || '#/home');

  // Pages that carry their own artwork header (an album, an artist) still
  // need a way back, so they get the chevron on its own.
  if (!title && drilled) {
    parts.push(el('div', { class: 'view-head bare' },
      el('button', {
        class: 'icon-btn', type: 'button', 'aria-label': 'Go back',
        onclick: () => history.back(),
      }, svg(ICONS.back, 24))));
  }

  if (title) {
    const head = el('div', { class: 'view-head' });
    if (drilled) {
      head.append(el('button', {
        class: 'icon-btn', type: 'button', 'aria-label': 'Go back',
        onclick: () => history.back(),
      }, svg(ICONS.back, 24)));
    }
    head.append(el('h1', { class: 'view-title' }, title));
    for (const action of actions) if (action) head.append(action);
    parts.push(head);
  }

  parts.push(node);
  view.replaceChildren(...parts);
  view.scrollTop = 0;
  document.title = title ? `${title} · Void Music` : 'Void Music';
  return node;
}

/** A round icon button for a page header. */
function headAction(icon, label, onclick, accent = false) {
  return el('button', {
    class: `icon-btn${accent ? ' accent' : ''}`, type: 'button',
    'aria-label': label, title: label, onclick,
  }, svg(icon, 24));
}

/* ── Marks (liked / offline) ───────────────────────────────────────── */

let offlineIds = new Set();
let likedIds = new Set();

export async function refreshMarks() {
  offlineIds = await offline.ids();
  likedIds = new Set((await likes.all()).map((t) => t.id));
}

export function isLiked(id) { return likedIds.has(id); }

/* ── Artwork ───────────────────────────────────────────────────────── */

/**
 * Artwork that fills itself in.
 *
 * Draws the generated tile immediately so nothing pops in late, then asks the
 * Cover Art Archive for the real cover and swaps it in if one turns up. Only
 * runs when the item carries no art of its own, and only for things actually
 * on screen — an IntersectionObserver keeps a long list from queueing hundreds
 * of lookups the user will never scroll to.
 */
const artObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries, obs) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        obs.unobserve(entry.target);
        entry.target._fillArt?.();
      }
    }, { rootMargin: '250px' })
  : null;

export function smartArt(track, seed, className, fallback = '♪') {
  const node = tintedArt(track.cover, seed, className, fallback);
  if (track.cover) return node;

  node._fillArt = async () => {
    node._fillArt = null;
    const url = await resolveCover({
      artist: track.artist || track.creator,
      title: track.title,
      album: track.album || track.albumTitle,
    }).catch(() => null);
    if (!url || !node.isConnected) return;

    const img = el('img', { alt: '', loading: 'lazy', decoding: 'async', src: url });
    img.addEventListener('load', () => node.querySelector('.art-glyph')?.remove(), { once: true });
    img.addEventListener('error', () => img.remove(), { once: true });
    node.append(img);
  };

  if (artObserver) artObserver.observe(node);
  else node._fillArt();

  return node;
}

/* ── Track rows ────────────────────────────────────────────────────── */

const MORE_ICON = 'M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4m0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4m0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4';

function sourceLabel(track) {
  if (track.source === 'local') return { text: 'Imported', key: 'local' };
  if (offlineIds.has(track.id)) return { text: 'Offline', key: 'offline' };
  if (track.source === 'demo') return { text: 'On device', key: 'local' };
  return { text: 'Archive', key: 'archive' };
}

/**
 * One row in a track list. `queue` is what plays when the row is tapped.
 */
export function trackRow(track, queue, opts = {}) {
  const { onRemove = null, context = null, showSource = true } = opts;

  const row = el('div', {
    class: 'track',
    tabindex: '0',
    role: 'button',
    dataset: { trackId: track.id },
    onclick: () => P.playTrack(track, queue, context),
    onkeydown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); P.playTrack(track, queue, context); }
    },
  });

  // Seeded per track, so songs still lacking artwork read as distinct rows
  // rather than a column of the same colour.
  row.append(smartArt(track, track.id || track.title, 'track-art'));

  row.append(el('div', { class: 'track-main' },
    el('div', { class: 'track-title' }, track.title),
    el('div', { class: 'track-sub' }, track.artist || 'Unknown artist'),
  ));

  const right = el('div', { class: 'track-right' });
  if (track.duration) right.append(el('span', { class: 'track-dur' }, fmtTime(track.duration)));
  if (showSource) {
    const src = sourceLabel(track);
    right.append(el('span', { class: 'src-dot', dataset: { src: src.key } }, src.text));
  }
  row.append(right);

  // Saving for offline is the action people reach for most, so it gets its own
  // target rather than living one tap deep in the menu.
  if (track.source !== 'local') {
    const dl = el('button', {
      class: 'icon-btn row-dl', type: 'button',
      'aria-label': `Save ${track.title} for offline`,
      'aria-pressed': String(offlineIds.has(track.id)),
      onclick: async (e) => {
        e.stopPropagation();
        await downloadTrack(track, e.currentTarget);
      },
    }, svg(ICONS.download, 19));
    row.append(dl);
  } else {
    row.append(el('span', {}));
  }

  row.append(el('button', {
    class: 'icon-btn row-menu', type: 'button', 'aria-label': `Options for ${track.title}`,
    onclick: (e) => { e.stopPropagation(); openTrackMenu(track, onRemove); },
  }, svg(MORE_ICON, 18)));

  if (P.state.track?.id === track.id) row.classList.add('playing');
  return row;
}

/** Keep the "now playing" highlight in sync across every rendered list. */
P.player.addEventListener('track', (e) => {
  const id = e.detail.track?.id;
  document.querySelectorAll('.track').forEach((row) => {
    row.classList.toggle('playing', row.dataset.trackId === id);
  });
});

/* ── Sheets ────────────────────────────────────────────────────────── */

function openSheet(build) {
  const scrim = el('div', { class: 'scrim', onclick: close });
  const box = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });

  function close() {
    scrim.remove();
    box.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }

  build(box, close);
  document.body.append(scrim, box);
  document.addEventListener('keydown', onKey);
  return close;
}

function sheetHead(title, close) {
  return el('div', { class: 'modal-head' },
    el('h2', {}, title),
    el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: close }, svg(ICONS.x, 18)),
  );
}

/**
 * Ask before something destructive.
 *
 * Deliberately not window.confirm: inside the Android wrapper the WebView has
 * no Activity of its own to hang a system dialog on, so the browser dialog
 * either does nothing or takes the app down. This is also the nicer of the two.
 */
function confirmSheet({ title, body, confirmLabel = 'Delete', danger = true }) {
  return new Promise((resolve) => {
    let answered = false;
    openSheet((box, close) => {
      const finish = (value) => { if (!answered) { answered = true; resolve(value); } close(); };

      box.append(
        sheetHead(title, () => finish(false)),
        el('p', { class: 'modal-hint', style: 'text-align:left;padding:16px 18px 4px' }, body),
        el('div', { class: 'modal-foot' },
          el('button', { class: 'btn secondary', type: 'button', style: 'flex:1', onclick: () => finish(false) },
            'Cancel'),
          el('button', {
            class: 'btn', type: 'button', style: `flex:1${danger ? ';background:var(--danger)' : ''}`,
            onclick: () => finish(true),
          }, confirmLabel),
        ),
      );
      // Dismissing by tapping outside counts as "no".
      setTimeout(() => {
        const scrim = document.querySelector('.scrim');
        scrim?.addEventListener('click', () => finish(false), { once: true });
      }, 0);
    });
  });
}

function openTrackMenu(track, onRemove) {
  openSheet((box, close) => {
    const liked = likedIds.has(track.id);
    const saved = offlineIds.has(track.id);

    const row = (icon, label, sub, fn) => el('button', {
      class: 'modal-row', type: 'button',
      onclick: async () => { close(); await fn(); },
    }, svg(icon, 20), el('strong', {}, label), sub ? el('span', {}, sub) : null);

    const list = el('div', { class: 'modal-list' },
      row(ICONS.heart, liked ? 'Remove from Liked' : 'Save to Liked', null, async () => {
        const on = await likes.toggle(track);
        if (on) likedIds.add(track.id); else likedIds.delete(track.id);
        toast(on ? 'Saved to Liked' : 'Removed from Liked', on ? 'ok' : '');
      }),
      row(ICONS.queueAdd, 'Play next', null, () => {
        P.playNextUp(track);
        toast('Added to queue', 'ok');
      }),
      row(ICONS.plus, 'Add to playlist', null, () => openPlaylistPicker([track])),
      track.source !== 'local'
        ? row(ICONS.download, saved ? 'Remove offline copy' : 'Save for offline',
            saved ? null : 'Plays with no connection', () => downloadTrack(track))
        : null,
      track.itemId && track.itemId !== 'local'
        ? row(ICONS.external, 'Go to album', track.albumTitle || track.album,
            () => navigate(`#/item/${encodeURIComponent(track.itemId)}`))
        : null,
      onRemove ? row(ICONS.trash, 'Remove from this list', null, () => onRemove(track)) : null,
    );

    box.append(sheetHead(track.title, close), list);
  });
}

export async function openPlaylistPicker(tracks) {
  const all = await playlists.all();
  openSheet((box, close) => {
    const list = el('div', { class: 'modal-list' });
    if (!all.length) list.append(el('p', { class: 'modal-hint' }, 'No playlists yet — make one below.'));

    for (const pl of all) {
      list.append(el('button', {
        class: 'modal-row', type: 'button',
        onclick: async () => {
          await playlists.addTracks(pl.id, tracks);
          close();
          toast(`Added to “${pl.name}”`, 'ok');
        },
      }, svg(ICONS.queueAdd, 20), el('strong', {}, pl.name),
         el('span', {}, `${pl.tracks.length} track${pl.tracks.length === 1 ? '' : 's'}`)));
    }

    const input = el('input', { type: 'text', placeholder: 'New playlist name', 'aria-label': 'New playlist name' });
    box.append(
      sheetHead(`Add ${tracks.length > 1 ? `${tracks.length} tracks` : 'track'} to playlist`, close),
      list,
      el('div', { class: 'modal-foot' }, input,
        el('button', {
          class: 'btn', type: 'button',
          onclick: async () => {
            const pl = await playlists.create(input.value || 'New playlist');
            await playlists.addTracks(pl.id, tracks);
            close();
            toast(`Created “${pl.name}”`, 'ok');
          },
        }, 'Create')),
    );
    setTimeout(() => input.focus(), 50);
  });
}

/* ── Offline downloads ─────────────────────────────────────────────── */

async function downloadTrack(track, btn) {
  if (offlineIds.has(track.id)) {
    await offline.remove(track.id);
    offlineIds.delete(track.id);
    btn?.setAttribute('aria-pressed', 'false');
    toast('Removed offline copy');
    return;
  }

  btn?.classList.add('busy');
  const t = toast(`Saving “${track.title}”…`, '', 60000);
  try {
    const blob = isDemoTrack(track) ? await renderDemoBlob(track) : await A.fetchTrackBlob(track);
    await offline.save(track, blob);
    offlineIds.add(track.id);
    t?.remove();
    btn?.setAttribute('aria-pressed', 'true');
    toast(`Saved — ${fmtBytes(blob.size)}`, 'ok');
  } catch (err) {
    t?.remove();
    toast(`Couldn't save: ${err.message}`, 'err', 5000);
  } finally {
    btn?.classList.remove('busy');
  }
}

async function saveAllOffline(tracks, btn) {
  btn.disabled = true;
  const label = btn.textContent;
  let done = 0;
  for (const t of tracks) {
    if (offlineIds.has(t.id)) { done++; continue; }
    try {
      const blob = isDemoTrack(t) ? await renderDemoBlob(t) : await A.fetchTrackBlob(t);
      await offline.save(t, blob);
      offlineIds.add(t.id);
      done++;
      btn.textContent = `Saving ${done}/${tracks.length}…`;
    } catch { /* one bad file shouldn't abandon the album */ }
  }
  btn.disabled = false;
  btn.textContent = label;
  toast(`Saved ${done} of ${tracks.length}`, done ? 'ok' : 'err');
}

/* ── Tiles ─────────────────────────────────────────────────────────── */

function itemTile(item, badge) {
  const tile = el('button', {
    class: 'tile', type: 'button',
    onclick: () => navigate(`#/item/${encodeURIComponent(item.id)}`),
  });
  const art = smartArt(
    { cover: item.cover, artist: item.creator, album: item.title, title: item.title },
    item.id, 'tile-art');
  if (badge) art.append(el('span', { class: 'tile-badge' }, badge));
  tile.append(art,
    el('div', { class: 'tile-title' }, item.title),
    el('div', { class: 'tile-sub' }, [item.year, item.creator].filter(Boolean).join(' • ')),
  );
  return tile;
}

function skeletonShelf(n = 5) {
  return el('div', { class: 'shelf' },
    ...Array.from({ length: n }, () => el('div', { class: 'tile' },
      el('div', { class: 'skeleton sk-art' }),
      el('div', { class: 'skeleton sk-line' }),
      el('div', { class: 'skeleton sk-line short' }),
    )));
}

function sectionHead(title, moreLabel, onMore) {
  return el('div', { class: 'section-head' },
    el('h2', {}, title),
    moreLabel ? el('button', { class: 'more', type: 'button', onclick: onMore }, moreLabel) : null,
  );
}

/* ── Home ──────────────────────────────────────────────────────────── */

let homeCollection = 'netlabels';

export async function renderHome() {
  const signal = freshSignal();
  const root = el('div', {});

  const heroSlot = el('div', {});
  const newSlot = el('section', { class: 'section' });
  const popularSlot = el('section', { class: 'section' });
  const chartSlot = el('section', { class: 'section' });

  const chipRow = el('div', { class: 'chips' },
    ...A.COLLECTIONS.map((c) => el('button', {
      class: `chip${c.id === homeCollection ? ' active' : ''}`,
      type: 'button',
      dataset: { collection: c.id },
      onclick: (e) => {
        homeCollection = c.id;
        [...chipRow.children].forEach((n) => n.classList.toggle('active', n === e.currentTarget));
        loadShelves(signal, newSlot, popularSlot, chartSlot);
      },
    }, c.name)),
  );

  root.append(heroSlot, chipRow, newSlot, popularSlot, chartSlot);
  mount(root, null);

  paintHero(heroSlot);
  newSlot.append(sectionHead('New Releases'), skeletonShelf());
  popularSlot.append(sectionHead('Popular now'), skeletonShelf());
  loadShelves(signal, newSlot, popularSlot, chartSlot);
}

function paintHero(slot) {
  const demo = demoItem();
  const hero = el('div', { class: 'hero' },
    (() => {
      const art = el('div', { class: 'hero-art' }, el('i', { class: 'art-glyph' }, '∿'));
      return art;
    })(),
    el('div', { class: 'hero-body' },
      el('div', { class: 'hero-kicker' }, 'Daily discovery'),
      el('div', { class: 'hero-title' }, demo.title),
      el('div', { class: 'hero-sub' }, `${demo.tracks.length} tracks · made on your device`),
    ),
    el('div', { class: 'hero-actions' },
      el('button', {
        class: 'hero-play', type: 'button', 'aria-label': 'Play',
        onclick: (e) => { e.stopPropagation(); P.playAll(demo.tracks, 0, demo.title); },
      }, svg(ICONS.play, 28)),
      el('button', {
        class: 'hero-add', type: 'button', 'aria-label': 'Add to playlist',
        onclick: (e) => { e.stopPropagation(); openPlaylistPicker(demo.tracks); },
      }, svg(ICONS.plus, 20)),
    ),
  );
  hero.addEventListener('click', () => navigate(`#/item/${DEMO_ITEM_ID}`));
  slot.replaceChildren(hero);
}

async function loadShelves(signal, newSlot, popularSlot, chartSlot) {
  const collection = homeCollection;
  const meta = A.COLLECTIONS.find((c) => c.id === collection);

  newSlot.replaceChildren(sectionHead('New Releases',
    'See all', () => navigate(`#/collection/${collection}`)), skeletonShelf());
  popularSlot.replaceChildren(sectionHead('Popular now'), skeletonShelf());
  chartSlot.replaceChildren();

  try {
    const { items } = await A.search({ collection, rows: 24, signal });
    if (signal.aborted) return;

    const fresh = items.slice(0, 10);
    const popular = [...items].sort((a, b) => b.downloads - a.downloads).slice(0, 10);
    const top = [...items].sort((a, b) => b.downloads - a.downloads).slice(0, 5);

    newSlot.replaceChildren(
      sectionHead('New Releases', 'See all', () => navigate(`#/collection/${collection}`)),
      el('div', { class: 'shelf' }, ...fresh.map((i) => itemTile(i, meta?.badge || 'MP3'))),
    );
    popularSlot.replaceChildren(
      sectionHead(`Popular in ${meta?.name || collection}`),
      el('div', { class: 'shelf' }, ...popular.map((i) => itemTile(i))),
    );
    chartSlot.replaceChildren(
      sectionHead('Top Albums'),
      ...top.map((item, i) => {
        const row = el('div', {
          class: 'chart-row', tabindex: '0', role: 'button',
          onclick: () => navigate(`#/item/${encodeURIComponent(item.id)}`),
        },
          el('span', { class: 'chart-rank' }, String(i + 1)),
          smartArt({ cover: item.cover, artist: item.creator, album: item.title, title: item.title },
            item.id, 'chart-art'),
          el('div', { class: 'track-main' },
            el('div', { class: 'track-title' }, item.title),
            el('div', { class: 'track-sub' }, item.creator),
          ),
          el('span', { class: 'track-dur' }, fmtCount(item.downloads)),
        );
        return row;
      }),
    );
  } catch (err) {
    if (signal.aborted) return;
    newSlot.replaceChildren(sectionHead('New Releases'),
      networkError(err, () => loadShelves(signal, newSlot, popularSlot, chartSlot)));
    popularSlot.replaceChildren();
    chartSlot.replaceChildren();
  }
}

function networkError(err, onRetry) {
  const offlineNow = !navigator.onLine || err?.name === 'OfflineError';
  return errorBox({
    title: offlineNow ? 'You are offline' : 'Could not reach the Archive',
    body: offlineNow
      ? 'Anything you saved for offline still plays from your Library.'
      : `${err?.message || 'Request failed'}. Usually a slow or filtered connection rather than the app.`,
    hint: offlineNow ? null
      : 'If archive.org is blocked on your network, add a mirror under <b>Settings → Connection</b>.',
    onRetry,
  });
}

/* ── Search ────────────────────────────────────────────────────────── */

let searchInput = null;

export async function renderSearch(query) {
  const signal = freshSignal();
  const root = el('div', {});

  const clear = el('button', {
    class: 'icon-btn clear', type: 'button', 'aria-label': 'Clear search',
    hidden: !query,
    onclick: () => { searchInput.value = ''; navigate('#/search'); },
  }, svg(ICONS.x, 20));

  const box = el('div', { class: 'searchbox' },
    svg(ICONS.search, 22),
    el('input', {
      type: 'search', placeholder: 'Songs, artists, albums…',
      value: query || '', autocomplete: 'off', autocorrect: 'off',
      spellcheck: false, 'aria-label': 'Search music', enterkeyhint: 'search',
    }),
    clear,
  );
  searchInput = box.querySelector('input');
  searchInput.addEventListener('input', () => { clear.hidden = !searchInput.value; });
  root.append(box);

  const body = el('div', {});
  root.append(body);
  mount(root, 'Search');

  wireSearchInput(searchInput);

  if (!query) {
    await paintRecent(body);
    return;
  }

  const topSlot = el('div', {});
  const songSection = el('section', { class: 'section' },
    sectionHead('Songs'),
    loadingRow('Finding songs…'));
  const artistSection = el('section', { class: 'section' });
  const albumSection = el('section', { class: 'section' },
    sectionHead('Albums'), skeletonShelf(4));
  body.replaceChildren(topSlot, songSection, artistSection, albumSection);

  // Albums resolve from a single request, so they land well before songs.
  A.search({ query, rows: 30, signal }).then((res) => {
    if (signal.aborted) return;

    const q = query.toLowerCase().trim();
    const artists = A.artistsFrom(res.items);
    // Exact name wins over one that merely contains the query, so searching
    // "videoclub" leads with Videoclub, not "closed videoclub".
    const match = artists.find((a) => a.name.toLowerCase() === q)
      || artists.find((a) => a.name.toLowerCase().startsWith(q))
      || artists.find((a) => a.name.toLowerCase().includes(q));

    // A confident artist match becomes the top result, the way a search for a
    // person should lead with the person rather than one of their records.
    if (match && q.length > 2) {
      topSlot.replaceChildren(el('button', {
        class: 'top-result', type: 'button',
        onclick: () => navigate(`#/artist/${encodeURIComponent(match.name)}`),
      },
        tintedArt(match.cover, match.name, 'top-art'),
        el('div', { class: 'top-body' },
          el('div', { class: 'top-kicker' }, 'Artist'),
          el('div', { class: 'top-name' }, match.name),
          el('div', { class: 'tile-sub' },
            `${match.releases} release${match.releases === 1 ? '' : 's'}`),
        ),
        el('span', { class: 'setting-chev' }, svg(ICONS.chevron, 22)),
      ));
    }

    const others = artists.filter((a) => a !== match).slice(0, 10);
    if (others.length) {
      artistSection.replaceChildren(
        sectionHead('Artists'),
        el('div', { class: 'shelf' }, ...others.map(artistTile)),
      );
    }

    // Split the way the releases actually divide: full records vs short ones.
    albumSection.replaceChildren(
      sectionHead('Albums'),
      res.items.length
        ? el('div', { class: 'shelf' }, ...res.items.map((i) => itemTile(i)))
        : el('p', { class: 'modal-hint' }, 'No matching albums.'),
    );
  }).catch((err) => {
    if (signal.aborted) return;
    albumSection.replaceChildren(sectionHead('Albums'),
      networkError(err, () => renderSearch(query)));
  });

  // Songs need per-item metadata, so they stream in as items resolve.
  //
  // Rows are appended, never reordered: re-sorting a list someone is already
  // looking at moves the row out from under their finger, and they tap the
  // wrong song. `queue` is the same array throughout, so it stays current.
  try {
    const queue = [];
    const shown = new Set();
    let list = null;

    const paint = (partial) => {
      if (signal.aborted || !partial.length) return;
      if (!list) {
        list = el('div', { class: 'tracks' });
        songSection.replaceChildren(sectionHead('Songs'), list);
      }
      for (const track of partial) {
        if (shown.has(track.id)) continue;
        shown.add(track.id);
        queue.push(track);
        list.append(trackRow(track, queue, { context: `Search: ${query}` }));
      }
    };

    const songs = await A.searchSongs({ query, signal, onPartial: paint });
    if (signal.aborted) return;
    paint(songs);

    if (!queue.length) {
      songSection.replaceChildren(
        sectionHead('Songs'),
        el('p', { class: 'modal-hint' }, 'No individual songs matched — try the albums below.'),
      );
    }
  } catch (err) {
    if (signal.aborted) return;
    songSection.replaceChildren(sectionHead('Songs'), networkError(err, () => renderSearch(query)));
  }
}

let searchTimer = null;
function wireSearchInput(input) {
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    searchTimer = setTimeout(() => {
      navigate(q ? `#/search/${encodeURIComponent(q)}` : '#/search');
    }, 500);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    clearTimeout(searchTimer);
    const q = input.value.trim();
    navigate(q ? `#/search/${encodeURIComponent(q)}` : '#/search');
    input.blur();
  });
}

async function paintRecent(body) {
  const rows = await recent.all(10);
  if (!rows.length) {
    body.replaceChildren(emptyState({
      emoji: '⌕',
      title: 'What do you want to hear?',
      body: 'Try a song title, an artist, or a genre — “piano”, “delta blues”, “ambient”, “1928”.',
    }));
    return;
  }
  body.replaceChildren(
    el('div', { class: 'recent-head' },
      el('span', {}, 'Recent'),
      el('button', {
        type: 'button',
        onclick: async () => { await recent.clear(); renderSearch(''); },
      }, 'Clear'),
    ),
    ...rows.map((r) => {
      const row = el('div', { class: 'recent-row' });
      row.append(
        el('button', {
          class: 'queue-main', type: 'button', style: 'padding:0;gap:14px',
          onclick: () => navigate(`#/item/${encodeURIComponent(r.id)}`),
        },
          tintedArt(r.cover, r.id, 'track-art'),
          el('span', { class: 'queue-meta' },
            el('span', { class: 'track-title' }, r.title),
            r.creator ? el('span', { class: 'track-sub' }, r.creator) : null,
          ),
        ),
        el('span', {}),
        el('button', {
          class: 'icon-btn', type: 'button', 'aria-label': `Remove ${r.title} from recent`,
          onclick: async () => { await recent.remove(r.id); paintRecent(body); },
        }, svg(ICONS.x, 20)),
      );
      return row;
    }),
  );
}

export async function renderCollection(id) {
  const signal = freshSignal();
  const meta = A.COLLECTIONS.find((c) => c.id === id) || { name: id, blurb: '' };
  const body = el('div', {}, skeletonShelf(6));
  const root = el('div', {},
    meta.blurb ? el('p', { class: 'item-desc', style: 'margin-bottom:18px' }, meta.blurb) : null,
    body);
  mount(root, meta.name);

  try {
    const { items } = await A.search({ collection: id, rows: 48, signal });
    if (signal.aborted) return;
    body.replaceChildren(items.length
      ? el('div', { class: 'shelf', style: 'flex-wrap:wrap;overflow:visible' }, ...items.map((i) => itemTile(i)))
      : emptyState({ emoji: '∅', title: 'Nothing here right now' }));
  } catch (err) {
    if (signal.aborted) return;
    body.replaceChildren(networkError(err, () => renderCollection(id)));
  }
}

/* ── Item ──────────────────────────────────────────────────────────── */

export async function renderItem(id) {
  const signal = freshSignal();

  if (id === DEMO_ITEM_ID) {
    await refreshMarks();
    paintItem(demoItem());
    return;
  }

  mount(el('div', {}, loadingRow('Loading…')), null);

  try {
    const item = await A.getItem(id, { signal });
    if (signal.aborted) return;
    await refreshMarks();
    paintItem(item);
    recent.push({ id: item.id, title: item.title, creator: item.creator, cover: item.cover });
  } catch (err) {
    if (signal.aborted) return;
    mount(el('div', {}, networkError(err, () => renderItem(id))), null);
  }
}

function paintItem(item) {
  const tracks = item.tracks;
  const root = el('div', {});

  root.append(el('div', { class: 'item-head' },
    smartArt({ cover: item.cover, artist: item.creator, album: item.title, title: item.title },
      item.id, 'item-art'),
    el('div', { class: 'item-info' },
      el('div', { class: 'item-kicker' }, item.isDemo ? 'Generated on device' : 'Archive item'),
      el('h1', {}, item.title),
      el('div', { class: 'item-meta' },
        [item.creator, item.year, `${tracks.length} track${tracks.length === 1 ? '' : 's'}`]
          .filter(Boolean).join(' · ')),
      item.description ? el('p', { class: 'item-desc' }, item.description) : null,
      el('div', { class: 'item-actions' },
        el('button', { class: 'btn', type: 'button', onclick: () => P.playAll(tracks, 0, item.title) },
          svg(ICONS.play, 18), 'Play'),
        el('button', {
          class: 'btn secondary', type: 'button',
          onclick: () => {
            if (!P.state.shuffle) P.toggleShuffle();
            P.playAll(tracks, Math.floor(Math.random() * tracks.length), item.title);
          },
        }, 'Shuffle'),
        el('button', {
          class: 'btn secondary', type: 'button',
          onclick: (e) => saveAllOffline(tracks, e.currentTarget),
        }, svg(ICONS.download, 18), 'Save all'),
        el('button', { class: 'btn secondary', type: 'button', onclick: () => openPlaylistPicker(tracks) },
          svg(ICONS.plus, 18), 'Add all'),
      ),
    ),
  ));

  root.append(el('div', { class: 'tracks' },
    ...tracks.map((t) => trackRow(t, tracks, { context: item.title, showSource: false }))));

  mount(root, null);
}

/* ── Artist ────────────────────────────────────────────────────────── */

export async function renderArtist(name) {
  const signal = freshSignal();
  mount(el('div', {}, loadingRow(`Loading ${name}…`)), null);

  let artist;
  try {
    artist = await A.getArtist(name, { signal });
  } catch (err) {
    if (signal.aborted) return;
    mount(el('div', {}, networkError(err, () => renderArtist(name))), name);
    return;
  }
  if (signal.aborted) return;
  await refreshMarks();

  const root = el('div', {});

  root.append(el('div', { class: 'artist-head' },
    tintedArt(artist.cover, name, 'artist-photo', '♪'),
    el('div', { class: 'artist-id' },
      el('div', { class: 'item-kicker' }, 'Artist'),
      el('h1', {}, name),
      el('div', { class: 'item-meta' },
        `${artist.releaseCount} release${artist.releaseCount === 1 ? '' : 's'}`),
    ),
  ));

  if (artist.songs.length) {
    root.append(el('div', { class: 'item-actions', style: 'margin-bottom:20px' },
      el('button', { class: 'btn', type: 'button', onclick: () => P.playAll(artist.songs, 0, name) },
        svg(ICONS.play, 18), 'Play'),
      el('button', {
        class: 'btn secondary', type: 'button',
        onclick: () => {
          if (!P.state.shuffle) P.toggleShuffle();
          P.playAll(artist.songs, Math.floor(Math.random() * artist.songs.length), name);
        },
      }, 'Shuffle'),
    ));

    root.append(el('section', { class: 'section' },
      sectionHead('Songs'),
      el('div', { class: 'tracks' },
        ...artist.songs.map((t) => trackRow(t, artist.songs, { context: name, showSource: false }))),
    ));
  }

  if (artist.albums.length) {
    root.append(el('section', { class: 'section' },
      sectionHead('Albums'),
      el('div', { class: 'shelf' }, ...artist.albums.map((i) => itemTile(i))),
    ));
  }

  if (artist.singles.length) {
    root.append(el('section', { class: 'section' },
      sectionHead('Singles & EPs'),
      el('div', { class: 'shelf' }, ...artist.singles.map((i) => itemTile(i))),
    ));
  }

  if (artist.about) {
    root.append(el('section', { class: 'section' },
      sectionHead('About'),
      el('div', { class: 'about-card' }, el('p', {}, artist.about)),
    ));
  }

  mount(root, null);
}

function artistTile(artist) {
  const tile = el('button', {
    class: 'tile artist-tile', type: 'button',
    onclick: () => navigate(`#/artist/${encodeURIComponent(artist.name)}`),
  });
  tile.append(
    tintedArt(artist.cover, artist.name, 'tile-art round'),
    el('div', { class: 'tile-title' }, artist.name),
    el('div', { class: 'tile-sub' }, `${artist.releases} release${artist.releases === 1 ? '' : 's'}`),
  );
  return tile;
}

/* ── Library ───────────────────────────────────────────────────────── */

let libraryTab = 'liked';

export async function renderLibrary() {
  freshSignal();
  await refreshMarks();

  const root = el('div', {});
  const body = el('div', {});

  const tabs = [
    ['songs', 'Songs'],
    ['liked', 'Liked'],
    ['playlists', 'Playlists'],
    ['artists', 'Artists'],
    ['albums', 'Albums'],
    ['imported', 'Imported'],
  ];

  const chips = el('div', { class: 'chips' },
    ...tabs.map(([key, label]) => el('button', {
      class: `chip${key === libraryTab ? ' active' : ''}`, type: 'button',
      onclick: (e) => {
        libraryTab = key;
        [...chips.children].forEach((n) => n.classList.toggle('active', n === e.currentTarget));
        paintLibraryTab(body);
      },
    }, label)),
  );

  root.append(chips, body);
  mount(root, 'Library', [
    headAction(ICONS.shuffle, 'Shuffle everything', async () => {
      const all = dedupeById([...await likes.all(), ...await offline.all(), ...await local.all()]);
      if (!all.length) { toast('Nothing in your library yet'); return; }
      if (!P.state.shuffle) P.toggleShuffle();
      P.playAll(all, Math.floor(Math.random() * all.length), 'Your library');
    }, true),
    headAction(ICONS.plus, 'New playlist', async () => {
      const pl = await playlists.create('New playlist');
      navigate(`#/playlist/${pl.id}`);
    }),
    headAction(ICONS.search, 'Search', () => navigate('#/search')),
  ]);
  paintLibraryTab(body);
}

async function paintLibraryTab(body) {
  body.replaceChildren(loadingRow());

  if (libraryTab === 'songs' || libraryTab === 'liked') {
    const tracks = libraryTab === 'liked'
      ? await likes.all()
      : dedupeById([...await likes.all(), ...await offline.all(), ...await local.all()]);
    body.replaceChildren(tracks.length
      ? el('div', {},
          playAllBar(tracks, libraryTab === 'liked' ? 'Liked Songs' : 'Your songs'),
          el('div', { class: 'tracks' },
            ...tracks.map((t) => trackRow(t, tracks, {
              context: libraryTab === 'liked' ? 'Liked Songs' : 'Your songs',
              onRemove: libraryTab === 'liked'
                ? async (x) => { await likes.remove(x.id); likedIds.delete(x.id); renderLibrary(); }
                : null,
            }))))
      : emptyState({
          emoji: '♡', title: libraryTab === 'liked' ? 'No liked songs yet' : 'No songs yet',
          body: 'Tap the ⋮ on any track and save it here.',
          action: el('button', { class: 'btn', type: 'button', onclick: () => navigate('#/search') }, 'Find something'),
        }));
    return;
  }

  // Artists and Albums are derived from what you have actually kept, so the
  // library reflects your collection without needing a second index.
  if (libraryTab === 'artists' || libraryTab === 'albums') {
    const mine = [...await likes.all(), ...await offline.all()];
    const groups = new Map();

    for (const track of mine) {
      const key = libraryTab === 'artists'
        ? (track.artist || 'Unknown artist')
        : (track.album || track.albumTitle || 'Unknown album');
      const entry = groups.get(key) || { key, tracks: [], cover: null, itemId: track.itemId };
      entry.tracks.push(track);
      if (!entry.cover && track.cover) entry.cover = track.cover;
      groups.set(key, entry);
    }

    const list = [...groups.values()].sort((a, b) => b.tracks.length - a.tracks.length);
    body.replaceChildren(list.length
      ? el('div', { class: 'grid-shelf' }, ...list.map((g) => {
          const tile = el('button', {
            class: 'tile', type: 'button',
            onclick: () => {
              if (libraryTab === 'artists') navigate(`#/artist/${encodeURIComponent(g.key)}`);
              else if (g.itemId && g.itemId !== 'local') navigate(`#/item/${encodeURIComponent(g.itemId)}`);
              else P.playAll(g.tracks, 0, g.key);
            },
          });
          const art = tintedArt(g.cover, g.key, 'tile-art');
          if (libraryTab === 'artists') art.classList.add('round');
          tile.append(art,
            el('div', { class: 'tile-title' }, g.key),
            el('div', { class: 'tile-sub' }, `${g.tracks.length} track${g.tracks.length === 1 ? '' : 's'}`));
          return tile;
        }))
      : emptyState({
          emoji: libraryTab === 'artists' ? '☺' : '◎',
          title: `No ${libraryTab} yet`,
          body: 'Like a song or save it offline and it shows up here, grouped automatically.',
          action: el('button', { class: 'btn', type: 'button', onclick: () => navigate('#/search') }, 'Find music'),
        }));
    return;
  }

  if (libraryTab === 'imported') {
    const tracks = await local.all();

    const fileInput = el('input', {
      type: 'file', accept: 'audio/*', multiple: true, style: 'display:none',
      onchange: (e) => { const f = [...e.target.files]; e.target.value = ''; runImport(f); },
    });
    // webkitdirectory is what turns the picker into a folder picker. It is not
    // in the HTML spec but every browser that can do this at all uses the name.
    const folderInput = el('input', {
      type: 'file', multiple: true, style: 'display:none',
      onchange: (e) => { const f = [...e.target.files]; e.target.value = ''; runImport(f); },
    });
    folderInput.setAttribute('webkitdirectory', '');
    folderInput.setAttribute('directory', '');

    const drop = el('div', { class: 'dropzone', id: 'import-drop' },
      el('strong', {}, 'Add your own music'),
      el('span', {}, 'Pick a folder and everything in it comes in at once — titles, artists, '
        + 'albums and covers are read from the files themselves.'),
      el('div', { class: 'dropzone-actions' },
        el('button', {
          class: 'btn', type: 'button',
          // Inside the Android app the folder comes from the system picker:
          // a WebView's file input cannot select a directory at all.
          onclick: async () => {
            if (canPickFolder) runImport(await pickFolder());
            else folderInput.click();
          },
        }, svg(ICONS.plus, 18), 'Add a folder'),
        el('button', { class: 'btn secondary', type: 'button', onclick: () => fileInput.click() },
          'Choose files'),
      ),
      el('span', { class: 'dropzone-hint' }, 'or drag music here'),
    );

    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', async (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      runImport(await filesFromDrop(e.dataTransfer));
    });

    body.replaceChildren(
      fileInput, folderInput, drop,
      tracks.length
        ? el('div', {},
            playAllBar(tracks, 'Imported'),
            el('div', { class: 'tracks' },
              ...tracks.map((t) => trackRow(t, tracks, {
                context: 'Imported',
                onRemove: async (x) => { await local.remove(x.id); renderLibrary(); },
              }))))
        : el('p', { class: 'modal-hint' }, 'Your own files stay on this device and play with no connection.'),
    );
    return;
  }

  const pls = await playlists.all();
  body.replaceChildren(
    el('button', {
      class: 'btn secondary block', type: 'button', style: 'margin-bottom:10px',
      onclick: openMixImporter,
    }, svg(ICONS.download, 18), 'Import a mix'),
    el('button', {
      class: 'btn block', type: 'button', style: 'margin-bottom:18px',
      onclick: () => openSheet((box, close) => {
        const input = el('input', { type: 'text', placeholder: 'Playlist name' });
        box.append(sheetHead('New playlist', close),
          el('div', { class: 'modal-foot' }, input,
            el('button', {
              class: 'btn', type: 'button',
              onclick: async () => {
                const pl = await playlists.create(input.value || 'New playlist');
                close();
                toast(`Created “${pl.name}”`, 'ok');
                renderLibrary();
              },
            }, 'Create')));
        setTimeout(() => input.focus(), 50);
      }),
    }, svg(ICONS.plus, 18), 'New playlist'),
    pls.length
      ? el('div', { class: 'tracks' }, ...pls.map((pl) => el('div', {
          class: 'track', tabindex: '0', role: 'button',
          onclick: () => navigate(`#/playlist/${pl.id}`),
        },
          (() => { const a = tintedArt(null, pl.id, 'track-art', '≡'); return a; })(),
          el('div', { class: 'track-main' },
            el('div', { class: 'track-title' }, pl.name),
            el('div', { class: 'track-sub' }, `${pl.tracks.length} track${pl.tracks.length === 1 ? '' : 's'}`),
          ),
        )))
      : el('p', { class: 'modal-hint' }, 'Playlists you make show up here.'),
  );
}

/**
 * Run an import with a progress sheet in front of it. A folder of several
 * hundred files takes a while, and a frozen-looking screen is the fastest way
 * to make someone force-quit halfway through.
 */
async function runImport(files) {
  // An empty list means the picker was dismissed; that needs no comment.
  if (!files.length) return;

  const audio = files.filter(isAudioFile);
  if (!audio.length) {
    toast('No audio files in that selection', 'warn');
    return;
  }

  const controller = new AbortController();
  const bar = el('i');
  const count = el('strong', {}, `0 of ${audio.length}`);
  const now = el('span', { class: 'import-current' }, 'Reading tags…');
  let sheetClose = () => {};

  openSheet((box, close) => {
    sheetClose = close;
    box.append(
      sheetHead(`Importing ${audio.length} file${audio.length === 1 ? '' : 's'}`, () => {
        controller.abort();
        close();
      }),
      el('div', { class: 'import-body' },
        el('div', { class: 'import-bar' }, bar),
        el('div', { class: 'import-stats' }, count, now),
      ),
    );
  });

  const result = await importFiles(audio, {
    signal: controller.signal,
    onProgress: (p) => {
      bar.style.width = `${Math.round((p.done / p.total) * 100)}%`;
      count.textContent = `${p.done} of ${p.total}`;
      now.textContent = p.current || '';
    },
  });

  sheetClose();

  const parts = [`Imported ${result.added}`];
  if (result.skipped) parts.push(`${result.skipped} already here`);
  if (result.failed) parts.push(`${result.failed} unreadable`);
  toast(parts.join(' · '), result.added ? 'ok' : 'warn', 4500);
  renderLibrary();
}

/** Same recording can be liked, saved offline and imported; show it once. */
function dedupeById(tracks) {
  const seen = new Set();
  return tracks.filter((t) => !seen.has(t.id) && seen.add(t.id));
}

function playAllBar(tracks, context) {
  return el('div', { class: 'item-actions', style: 'margin-bottom:16px' },
    el('button', { class: 'btn', type: 'button', onclick: () => P.playAll(tracks, 0, context) },
      svg(ICONS.play, 18), 'Play'),
    el('button', {
      class: 'btn secondary', type: 'button',
      onclick: () => {
        if (!P.state.shuffle) P.toggleShuffle();
        P.playAll(tracks, Math.floor(Math.random() * tracks.length), context);
      },
    }, 'Shuffle'),
  );
}

/* ── Mixes ─────────────────────────────────────────────────────────── */

/**
 * Hand a playlist to someone else.
 *
 * What travels is the running order, not the music: titles, artists and the
 * sequence you chose. Their copy finds each song in their own files or in the
 * open catalogue. No account, no server, nothing to be refused a key for.
 */
async function shareMix(playlist) {
  if (!playlist.tracks?.length) {
    toast('Add some tracks first', 'warn');
    return;
  }

  const code = await encodeMix(playlist);
  const field = el('textarea', {
    class: 'mix-code', readonly: true, rows: '4', spellcheck: false, value: code,
  });

  openSheet((box, close) => {
    box.append(
      sheetHead(`Share “${playlist.name}”`, close),
      el('div', { class: 'import-body' },
        el('p', { class: 'modal-hint', style: 'text-align:left;padding:0' },
          `${playlist.tracks.length} track${playlist.tracks.length === 1 ? '' : 's'} — the list and its `
          + 'order, not the audio. Whoever opens it plays it from their own files or the Archive.'),
        field,
        el('div', { class: 'item-actions' },
          el('button', {
            class: 'btn', type: 'button', style: 'flex:1',
            onclick: async () => {
              const ok = await copyText(code);
              toast(ok ? 'Mix code copied' : 'Select the text and copy it', ok ? 'ok' : 'warn');
            },
          }, 'Copy code'),
          el('button', {
            class: 'btn secondary', type: 'button', style: 'flex:1',
            onclick: () => saveTextFile(`${playlist.name.replace(/[^\w\s-]/g, '').trim() || 'mix'}.voidmix`, code),
          }, 'Save as file'),
        ),
      ),
    );
    setTimeout(() => field.select(), 60);
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function saveTextFile(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const link = el('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Paste a code, paste a track list, or open a file someone sent. */
export function openMixImporter() {
  openSheet((box, close) => {
    const field = el('textarea', {
      class: 'mix-code', rows: '6', spellcheck: false,
      placeholder: 'Paste a VOIDMIX code, or a list like:\n\nVideoclub - Amour Plastique\nMassive Attack - Teardrop',
    });

    const file = el('input', {
      type: 'file', accept: '.voidmix,.txt,.csv,.m3u,.m3u8,text/*', style: 'display:none',
      onchange: async (e) => {
        const chosen = e.target.files?.[0];
        e.target.value = '';
        if (!chosen) return;
        field.value = await chosen.text();
        take(chosen.name.replace(/\.[^.]+$/, ''));
      },
    });

    const take = async (fallbackName = 'Imported mix') => {
      const text = field.value.trim();
      if (!text) { toast('Nothing to import', 'warn'); return; }

      const mix = (await decodeMix(text)) || parseText(text, fallbackName);
      if (!mix || !mix.entries.length) {
        toast('That does not look like a mix or a track list', 'err', 4500);
        return;
      }
      close();
      pendingMix = mix;
      navigate('#/mix');
    };

    box.append(
      sheetHead('Import a mix', close),
      el('div', { class: 'import-body' },
        el('p', { class: 'modal-hint', style: 'text-align:left;padding:0' },
          'A mix is a list of songs and their order. Void Music finds each one in your own '
          + 'files or the Archive. A plain “Artist - Title” list, an .m3u or a playlist CSV works too.'),
        field,
        file,
        el('div', { class: 'item-actions' },
          el('button', { class: 'btn', type: 'button', style: 'flex:1', onclick: () => take() }, 'Import'),
          el('button', {
            class: 'btn secondary', type: 'button', style: 'flex:1', onclick: () => file.click(),
          }, 'Open a file'),
        ),
      ),
    );
    setTimeout(() => field.focus(), 60);
  });
}

/* ── YouTube ───────────────────────────────────────────────────────── */

function youtubeStatusText() {
  if (YT.signedIn()) {
    const who = googleAccount.name();
    return who ? `Signed in as ${who}` : 'Signed in';
  }
  return YT.connected() ? 'Token saved' : 'Not connected';
}

/**
 * The YouTube card.
 *
 * Inside the app this is a real sign-in: one tap, Google's own consent page in
 * the browser, and it stays signed in afterwards because the wrapper keeps a
 * refresh token. The only thing it needs first is a client ID, which the user
 * registers once — nothing can be shipped inside a GPL app and still be theirs.
 *
 * In a plain browser there is no way to catch the redirect back from Google, so
 * that case keeps the pasted-token path.
 */
function youtubeSetting(status) {
  const body = el('span', { class: 'setting-body' },
    el('strong', {}, 'YouTube'),
    el('span', {}, 'Read your own playlists and liked videos, and play them from your files or '
      + 'the open catalogue. Void Music never takes audio from YouTube — only the list of what '
      + 'you saved.'),
  );

  if (canSignIn) body.append(...signInControls(status));
  else body.append(...pastedTokenControls(status));

  return el('div', { class: 'setting static' }, body);
}

function signInControls(status) {
  const clientInput = el('input', {
    type: 'text', value: googleAccount.clientId(),
    placeholder: 'Google OAuth client ID', 'aria-label': 'Google OAuth client ID',
    autocomplete: 'off', spellcheck: false,
  });

  const signIn = el('button', {
    class: 'btn', type: 'button',
    onclick: async (e) => {
      const id = clientInput.value.trim();
      if (!id) { toast('Paste your client ID first', 'warn'); return; }

      e.currentTarget.disabled = true;
      status.textContent = 'Waiting for Google…';
      const result = await signInWithGoogle(id);

      if (!result.ok) {
        status.textContent = result.error || 'Sign-in failed';
        toast(result.error || 'Sign-in failed', 'err', 5000);
        renderSettings('accounts');
        return;
      }

      // The token is live now; ask YouTube whose it is so the card can say so.
      try {
        const name = await YT.whoAmI();
        googleAccount.setName(name);
        toast(`Signed in as ${name}`, 'ok');
      } catch (err) {
        toast(`Signed in, but YouTube said: ${err.message}`, 'warn', 5000);
      }
      renderSettings('accounts');
    },
  }, 'Sign in with Google');

  const out = [];

  if (YT.signedIn()) {
    out.push(
      status,
      el('span', { style: 'margin-top:12px;display:flex;gap:8px;flex-wrap:wrap' },
        el('button', {
          class: 'btn', type: 'button', onclick: () => navigate('#/youtube'),
        }, 'My playlists'),
        el('button', {
          class: 'btn secondary', type: 'button',
          onclick: async () => {
            googleAccount.signOut();
            await YT.setToken('');
            toast('Signed out of YouTube');
            renderSettings('accounts');
          },
        }, 'Sign out'),
      ),
    );
    return out;
  }

  out.push(
    el('span', { style: 'margin-top:12px' }, clientInput),
    status,
    el('span', { style: 'margin-top:12px;display:flex;gap:8px;flex-wrap:wrap' }, signIn),
    el('span', { style: 'margin-top:12px' },
      'The client ID is a one-time setup, and after it you just tap the button. In Google Cloud '
      + 'Console: create a project, enable the YouTube Data API v3, then under Credentials create '
      + 'an OAuth client of type ', el('strong', {}, 'Android'),
      ' with package name ', el('code', {}, 'dev.voidmusic.app'),
      ' and this app’s signing fingerprint. Google issues no secret for that type — the app is '
      + 'identified by its signature instead. Add your own address as a test user and Google will '
      + 'warn that the app is unverified; that is expected for an app only you use.'),
    el('span', { style: 'margin-top:10px;display:flex;gap:8px;flex-wrap:wrap' },
      el('button', {
        class: 'btn outline', type: 'button',
        onclick: () => openExternal('https://console.cloud.google.com/apis/credentials'),
      }, 'Open Google Cloud Console'),
      el('button', {
        class: 'btn outline', type: 'button',
        onclick: () => openSheet((box, close) => {
          box.append(sheetHead('Signing fingerprint', close),
            el('div', { class: 'import-body' },
              el('p', { class: 'modal-hint', style: 'text-align:left;padding:0' },
                'Google asks for the SHA-1 fingerprint of the key this app is signed with. Every '
                + 'Void Music release is signed with the same key, which lives in the repository '
                + 'at android/keystore/void-signing.jks. Run this where you have the repo:'),
              el('pre', { class: 'mix-code' },
                'keytool -list -v -keystore android/keystore/void-signing.jks \\\n'
                + '  -alias void -storepass voidmusic | grep SHA1'),
            ));
        }),
      }, 'Where do I find the fingerprint?'),
    ),
  );
  return out;
}

function pastedTokenControls(status) {
  const ytToken = el('input', {
    type: 'password', value: String(getSetting('youtubeToken') || ''), placeholder: 'Access token',
    'aria-label': 'YouTube access token', autocomplete: 'off', spellcheck: false,
  });

  return [
    el('span', { style: 'margin-top:12px;display:flex;gap:8px' }, ytToken,
      el('button', {
        class: 'btn secondary', type: 'button', style: 'flex:none',
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          status.textContent = 'Checking…';
          const r = await YT.verify(ytToken.value);
          btn.disabled = false;
          status.textContent = r.ok ? `Connected as ${r.name}` : `Rejected — ${r.error}`;
          toast(r.ok ? `Connected to YouTube as ${r.name}` : 'That token did not work',
            r.ok ? 'ok' : 'err');
          if (r.ok) renderSettings('accounts');
        },
      }, 'Connect')),
    status,
    el('span', { style: 'margin-top:10px' },
      'In a browser there is no way to catch the redirect back from Google, so this takes a '
      + 'pasted token: open Google’s OAuth 2.0 Playground, pick the YouTube Data API v3 scope '
      + 'ending in ', el('code', {}, 'youtube.readonly'),
      ', authorise your account and exchange it for an access token. It lasts about an hour. '
      + 'The Android app signs in properly and stays signed in.'),
    el('span', { style: 'margin-top:10px;display:flex;gap:8px;flex-wrap:wrap' },
      el('button', {
        class: 'btn outline', type: 'button',
        onclick: () => openExternal('https://developers.google.com/oauthplayground/'),
      }, 'Open OAuth Playground'),
      YT.connected() ? el('button', {
        class: 'btn', type: 'button', onclick: () => navigate('#/youtube'),
      }, 'My playlists') : null,
      YT.connected() ? el('button', {
        class: 'btn secondary', type: 'button',
        onclick: async () => {
          await YT.setToken('');
          toast('Disconnected from YouTube');
          renderSettings('accounts');
        },
      }, 'Disconnect') : null,
    ),
  ];
}



/**
 * Your own YouTube playlists, listed from YouTube's own API.
 *
 * Opening one turns it into a mix: the titles and the order come from your
 * account, and every song is then found in your files or the open catalogue.
 * No audio is taken from YouTube — the API does not offer it, and this app
 * does not go around that.
 */
export async function renderYouTube() {
  const signal = freshSignal();

  if (!YT.connected()) {
    mount(el('div', {}, emptyState({
      emoji: '▶',
      title: 'Not connected to YouTube',
      body: 'Connect your account under Settings → Accounts & Sync, then your playlists show up here.',
      action: el('button', {
        class: 'btn', type: 'button', onclick: () => navigate('#/settings/accounts'),
      }, 'Open settings'),
    })), 'YouTube');
    return;
  }

  const body = el('div', {}, loadingRow('Reading your playlists…'));
  mount(body, 'YouTube');

  let lists;
  try {
    lists = await YT.myPlaylists({ signal });
  } catch (err) {
    if (signal.aborted) return;
    body.replaceChildren(errorBox({
      title: 'Could not read your playlists',
      body: err.message,
      hint: 'An access token lasts about an hour. If it has expired, get a fresh one and paste it '
        + 'again under Settings → Accounts & Sync.',
      onRetry: renderYouTube,
    }));
    return;
  }
  if (signal.aborted) return;

  if (!lists.length) {
    body.replaceChildren(emptyState({ emoji: '∅', title: 'No playlists on that account' }));
    return;
  }

  body.replaceChildren(
    el('p', { class: 'item-meta', style: 'margin-bottom:14px' },
      `${lists.length} playlist${lists.length === 1 ? '' : 's'} · tap one to find its songs here`),
    el('div', { class: 'tracks' }, ...lists.map((list) => el('div', {
      class: 'track', tabindex: '0', role: 'button',
      onclick: () => openYouTubePlaylist(list),
      onkeydown: (e) => { if (e.key === 'Enter') openYouTubePlaylist(list); },
    },
      tintedArt(list.cover, list.id, 'track-art', list.liked ? '♥' : '≡'),
      el('div', { class: 'track-main' },
        el('div', { class: 'track-title' }, list.title),
        el('div', { class: 'track-sub' },
          list.count == null ? 'from YouTube' : `${list.count} video${list.count === 1 ? '' : 's'}`),
      ),
      el('span', {}), el('span', {}),
      el('span', { class: 'setting-chev' }, svg(ICONS.chevron, 20)),
    ))),
  );
}

async function openYouTubePlaylist(list) {
  const sheet = toast(`Reading “${list.title}”…`, '', 20000);
  try {
    const mix = await YT.playlistAsMix(list);
    sheet?.remove();
    if (!mix.entries.length) {
      toast('That playlist has nothing readable in it', 'warn');
      return;
    }
    pendingMix = mix;
    navigate('#/mix');
  } catch (err) {
    sheet?.remove();
    toast(`Could not read that playlist — ${err.message}`, 'err', 5000);
  }
}

/** Set when a mix arrives by paste or file rather than through the URL. */
let pendingMix = null;

/**
 * Show an incoming mix and find something to play for every line of it.
 *
 * Rows appear straight away and fill in as they resolve, because a long mix
 * takes a while over a slow link and a blank screen looks broken.
 */
export async function renderMix(code) {
  const signal = freshSignal();

  const mix = code ? await decodeMix(decodeURIComponent(code)) : pendingMix;
  pendingMix = null;

  if (!mix) {
    mount(el('div', {}, emptyState({
      emoji: '≡',
      title: 'That mix could not be read',
      body: 'The code may have been cut short in the message it arrived in. Ask for it again, '
        + 'or import it as a file.',
      action: el('button', { class: 'btn', type: 'button', onclick: openMixImporter }, 'Import a mix'),
    })), 'Mix');
    return;
  }

  const summary = el('p', { class: 'item-meta', style: 'margin-bottom:14px' },
    `${mix.entries.length} track${mix.entries.length === 1 ? '' : 's'} · finding them…`);
  const list = el('div', { class: 'tracks' });
  const actions = el('div', { class: 'item-actions', style: 'margin-bottom:16px' });

  mount(el('div', {}, summary, actions, list), mix.name);

  const paint = ({ rows, done, total }) => {
    if (signal.aborted) return;
    const found = rows.filter((r) => r.track).length;
    summary.textContent = done < total
      ? `${done} of ${total} looked up · ${found} playable here`
      : `${found} of ${total} playable here`;

    list.replaceChildren(...rows.map(({ entry, track, pending }) => {
      if (track) {
        return trackRow(track, rows.filter((r) => r.track).map((r) => r.track), { context: mix.name });
      }
      return el('div', { class: `track missing${pending ? ' pending' : ''}` },
        tintedArt(null, entry.title, 'track-art', pending ? '⋯' : '∅'),
        el('div', { class: 'track-main' },
          el('div', { class: 'track-title' }, entry.title),
          el('div', { class: 'track-sub' }, entry.artist || 'Unknown artist'),
        ),
        el('span', { class: 'track-right' },
          el('span', { class: 'src-dot', dataset: { src: 'missing' } },
            pending ? 'looking…' : 'not here')),
        el('span', {}),
        el('span', {}),
      );
    }));
  };

  const rows = await resolveMix(mix, { onProgress: paint, signal });
  if (signal.aborted) return;

  const tracks = playable(rows);
  actions.replaceChildren(
    el('button', {
      class: 'btn', type: 'button',
      disabled: !tracks.length,
      onclick: () => P.playAll(tracks, 0, mix.name),
    }, svg(ICONS.play, 18), 'Play'),
    el('button', {
      class: 'btn secondary', type: 'button',
      disabled: !tracks.length,
      onclick: async () => {
        const pl = await playlists.create(mix.name);
        await playlists.addTracks(pl.id, tracks);
        toast(`Saved ${tracks.length} track${tracks.length === 1 ? '' : 's'} to your playlists`, 'ok');
        navigate(`#/playlist/${pl.id}`);
      },
    }, 'Save to my playlists'),
  );

  if (!tracks.length) {
    list.append(el('p', { class: 'modal-hint' },
      'None of these are in your files or the open catalogue yet. Import the songs you own '
      + 'under Library → Imported and open the mix again — it will match them.'));
  }
}

/* ── Offline / playlist routes ─────────────────────────────────────── */

export async function renderOffline() {
  freshSignal();
  await refreshMarks();
  const tracks = await offline.all();
  const bytes = await offline.bytes();

  const root = el('div', {});
  if (tracks.length) {
    root.append(
      el('p', { class: 'item-meta', style: 'margin-bottom:14px' },
        `${tracks.length} track${tracks.length === 1 ? '' : 's'} · ${fmtBytes(bytes)} on this device`),
      playAllBar(tracks, 'Offline'),
      el('div', { class: 'tracks' },
        ...tracks.map((t) => trackRow(t, tracks, {
          context: 'Offline',
          onRemove: async (x) => { await offline.remove(x.id); offlineIds.delete(x.id); renderOffline(); },
        }))),
    );
  } else {
    root.append(emptyState({
      emoji: '⤓',
      title: 'Nothing saved offline',
      body: 'Save tracks from the ⋮ menu. They play instantly and work with no connection at all.',
      action: el('button', { class: 'btn', type: 'button', onclick: () => navigate('#/search') }, 'Find music'),
    }));
  }
  mount(root, 'Offline');
}

export async function renderPlaylist(id) {
  freshSignal();
  await refreshMarks();
  const pl = await playlists.get(id);
  if (!pl) {
    mount(el('div', {}, emptyState({ emoji: '∅', title: 'Playlist not found' })), null);
    return;
  }

  const root = el('div', {},
    el('p', { class: 'item-meta', style: 'margin-bottom:14px' },
      `${pl.tracks.length} track${pl.tracks.length === 1 ? '' : 's'}`),
    pl.tracks.length ? playAllBar(pl.tracks, pl.name) : null,
    el('div', { class: 'item-actions', style: 'margin-bottom:16px' },
      el('button', {
        class: 'btn-ghost', type: 'button',
        onclick: () => openSheet((box, close) => {
          const input = el('input', { type: 'text', value: pl.name });
          box.append(sheetHead('Rename playlist', close),
            el('div', { class: 'modal-foot' }, input,
              el('button', {
                class: 'btn', type: 'button',
                onclick: async () => { await playlists.rename(id, input.value); close(); renderPlaylist(id); },
              }, 'Save')));
        }),
      }, 'Rename'),
      el('button', {
        class: 'btn-ghost', type: 'button',
        onclick: () => shareMix(pl),
      }, 'Share'),
      el('button', {
        class: 'btn-ghost', type: 'button',
        onclick: async () => {
          const sure = await confirmSheet({
            title: 'Delete playlist',
            body: `“${pl.name}” and its running order are removed. The tracks themselves stay in your library.`,
          });
          if (!sure) return;
          await playlists.remove(id);
          toast('Playlist deleted');
          navigate('#/library');
        },
      }, 'Delete'),
    ),
    pl.tracks.length
      ? el('div', { class: 'tracks' }, ...pl.tracks.map((t) => trackRow(t, pl.tracks, {
          context: pl.name,
          onRemove: async (x) => { await playlists.removeTrack(id, x.id); renderPlaylist(id); },
        })))
      : el('p', { class: 'modal-hint' }, 'Empty — add tracks from the ⋮ menu on any song.'),
  );
  mount(root, pl.name);
}

/* ── Settings ──────────────────────────────────────────────────────── */

/* ── Settings ──────────────────────────────────────────────────────── */

/**
 * Settings is a hub with sub-pages rather than one long scroll: each row says
 * what it currently holds, so the state you care about is visible without
 * opening anything.
 */
export async function renderSettings(section = '') {
  switch (section) {
    case 'playback':   return settingsPlayback();
    case 'connection': return settingsConnection();
    case 'accounts':   return settingsAccounts();
    case 'storage':    return settingsStorage();
    case 'appearance': return settingsAppearance();
    case 'about':      return settingsAbout();
    default:           return settingsHub();
  }
}

async function settingsHub() {
  freshSignal();
  const root = el('div', {});

  root.append(el('div', { class: 'support-card' },
    el('h2', {}, 'Open music, no strings'),
    el('p', {}, 'Everything here is public domain, Creative Commons, or shared with the artist’s '
      + 'blessing. No account, no ads, no subscription — and nothing that checks what country you are in.'),
    el('div', { class: 'support-actions' },
      el('a', { class: 'btn', href: 'https://archive.org/donate', target: '_blank', rel: 'noopener noreferrer' },
        svg(ICONS.heart, 18), 'Support the Archive'),
      el('a', {
        class: 'btn outline', href: 'https://github.com/mh1435/void-music',
        target: '_blank', rel: 'noopener noreferrer',
      }, 'Source'),
    ),
  ));

  const [savedCount, savedBytes, localCount] = await Promise.all([
    offline.count(), offline.bytes(), local.count(),
  ]);

  const crossfade = Number(getSetting('crossfade') || 0);
  const scrobbling = getSetting('scrobbleEnabled') && getSetting('scrobbleToken');
  const themeName = { dark: 'Dark', light: 'Light', system: 'Follow system' }[currentTheme()];

  const row = (icon, title, sub, target) => el('button', {
    class: 'setting', type: 'button', onclick: () => navigate(`#/settings/${target}`),
  },
    el('span', { class: 'setting-icon' }, svg(icon, 22)),
    el('span', { class: 'setting-body' }, el('strong', {}, title), el('span', {}, sub)),
    el('span', { class: 'setting-chev' }, svg(ICONS.chevron, 20)),
  );

  root.append(el('div', { class: 'group' },
    row(ICONS.play, 'Playback',
      `${crossfade ? `Crossfade ${crossfade}s` : 'Crossfade off'} · ${getSetting('preferLowBitrate') ? 'Data saver on' : 'Best quality'}`,
      'playback'),
    row(ICONS.wifi, 'Connection', describeHealth(), 'connection'),
    row(ICONS.person, 'Accounts & Sync', scrobbling ? 'ListenBrainz connected' : 'Not connected', 'accounts'),
    row(ICONS.folder, 'Library & Storage',
      `${savedCount + localCount} track${savedCount + localCount === 1 ? '' : 's'} · ${fmtBytes(savedBytes)}`,
      'storage'),
    row(ICONS.palette, 'Appearance', `${themeName}${amoledOn() ? ' · AMOLED' : ''}`, 'appearance'),
    row(ICONS.info, 'About & Help', `v${APP_VERSION}`, 'about'),
  ));

  mount(root, 'Settings');
}

function settingsPlayback() {
  freshSignal();
  const root = el('div', {});

  const xfValue = el('span', { class: 'range-value' });
  const xfInput = el('input', {
    type: 'range', min: '0', max: '12', step: '1',
    value: String(P.state.crossfade || 0), 'aria-label': 'Crossfade seconds',
  });
  const paintXf = () => {
    const v = Number(xfInput.value);
    xfValue.textContent = v ? `${v}s` : 'Off';
  };
  paintXf();
  xfInput.addEventListener('input', paintXf);
  xfInput.addEventListener('change', () => {
    const v = P.setCrossfade(Number(xfInput.value));
    toast(v ? `Crossfade ${v} seconds` : 'Crossfade off');
  });

  root.append(
    el('p', { class: 'group-label' }, 'Crossfade'),
    el('div', { class: 'group' },
      el('div', { class: 'setting static' },
        el('span', { class: 'setting-body' },
          el('strong', {}, 'Crossfade'),
          el('span', {}, 'Overlap the end of one track with the start of the next. At zero the '
            + 'next song still begins the instant this one ends — it is already buffered before '
            + 'it is needed.'),
          el('span', { class: 'range-row' }, xfInput, xfValue),
        ),
      ),
    ),
    el('p', { class: 'group-label' }, 'Streaming'),
    el('div', { class: 'group' },
      toggleRow('Data saver', 'Pick the smallest encoding of each track. Helps a lot on a slow or metered link.',
        null, Boolean(getSetting('preferLowBitrate')), async (on) => {
          await setSetting('preferLowBitrate', on);
          A.config.preferLowBitrate = on;
        }),
    ),
  );

  mount(root, 'Playback');
}

function settingsConnection() {
  const signal = freshSignal();
  const root = el('div', {});

  const statusLine = el('span', {}, describeHealth());
  const mirrorInput = el('input', {
    type: 'text', value: getSetting('mirrors') || '', placeholder: 'https://my-mirror.example',
    'aria-label': 'Mirror base URLs, comma separated',
  });

  root.append(
    el('p', { class: 'group-label' }, 'Status'),
    el('div', { class: 'group' },
      el('button', {
        class: 'setting', type: 'button',
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          statusLine.textContent = 'Testing…';
          const r = await probe('https://archive.org/metadata/nasa');
          statusLine.textContent = r.ok
            ? `archive.org reachable in ${r.ms} ms`
            : `archive.org unreachable — ${r.error}`;
          btn.disabled = false;
        },
      },
        el('span', { class: 'setting-icon' }, svg(ICONS.wifi, 22)),
        el('span', { class: 'setting-body' }, el('strong', {}, 'Connection status'), statusLine),
        el('span', { class: 'setting-chev' }, svg(ICONS.chevron, 20)),
      ),
    ),
    el('p', { class: 'group-label' }, 'Mirror'),
    el('div', { class: 'group' },
      el('div', { class: 'setting static' },
        el('span', { class: 'setting-body' },
          el('strong', {}, 'Mirror or proxy'),
          el('span', {}, 'If archive.org is blocked on your network, point the app at your own https '
            + 'mirror. Tried in parallel with the official host; the fastest answer wins.'),
          el('span', { style: 'margin-top:12px;display:flex;gap:8px' }, mirrorInput,
            el('button', {
              class: 'btn secondary', type: 'button', style: 'flex:none',
              onclick: async () => {
                const raw = mirrorInput.value.trim();
                const list = raw.split(',').map((x) => x.trim()).filter(Boolean);
                for (const u of list) {
                  try { new URL(u); } catch { toast(`Not a valid URL: ${u}`, 'err'); return; }
                }
                await setSetting('mirrors', raw);
                A.config.mirrors = list;
                toast(list.length ? `Using ${list.length} mirror(s)` : 'Mirrors cleared', 'ok');
              },
            }, 'Save')),
        ),
      ),
    ),
  );

  const log = el('div', { class: 'diag-log' });
  const paintLog = () => {
    log.replaceChildren(...diag.entries.slice(-50).reverse().map((e) =>
      el('div', { class: `lvl-${e.level}` }, `${new Date(e.at).toLocaleTimeString()}  ${e.msg}`)));
    if (!diag.entries.length) log.textContent = 'No network events yet.';
  };
  paintLog();
  bus.addEventListener('diag', paintLog, { signal });

  root.append(
    el('p', { class: 'group-label' }, 'Network log'),
    el('div', { class: 'group' },
      el('div', { class: 'setting static' },
        el('span', { class: 'setting-body' },
          el('strong', {}, 'Every retry and failure'),
          el('span', {}, 'So you can tell the app apart from your connection.')),
      ),
      log,
    ),
  );

  mount(root, 'Connection');
}

async function settingsAccounts() {
  freshSignal();
  const root = el('div', {});

  const lbToken = el('input', {
    type: 'password', value: getSetting('scrobbleToken') || '',
    placeholder: 'User token', 'aria-label': 'ListenBrainz user token',
    autocomplete: 'off', spellcheck: false,
  });
  const lbStatus = el('span', {}, getSetting('scrobbleToken') ? 'Token saved' : 'Not connected');
  const pendingCount = await scrobbler.pending();

  const ytStatus = el('span', {}, youtubeStatusText());

  root.append(
    el('p', { class: 'group-label' }, 'Connections'),
    el('div', { class: 'group' },
      youtubeSetting(ytStatus),
      el('div', { class: 'setting static' },
        el('span', { class: 'setting-body' },
          el('strong', {}, 'ListenBrainz'),
          el('span', {}, 'Open scrobbling from MetaBrainz. Your listening data stays yours and '
            + 'exportable. Paste your user token from listenbrainz.org/profile.'),
          el('span', { style: 'margin-top:12px;display:flex;gap:8px' }, lbToken,
            el('button', {
              class: 'btn secondary', type: 'button', style: 'flex:none',
              onclick: async (e) => {
                const btn = e.currentTarget;
                btn.disabled = true;
                lbStatus.textContent = 'Checking…';
                const r = await scrobbler.validate(lbToken.value);
                btn.disabled = false;
                if (r.ok) {
                  await scrobbler.setToken(lbToken.value);
                  lbStatus.textContent = `Connected as ${r.user}`;
                  toast(`Connected to ListenBrainz as ${r.user}`, 'ok');
                } else {
                  lbStatus.textContent = `Token rejected — ${r.error}`;
                  toast('That token did not work', 'err');
                }
              },
            }, 'Connect')),
          lbStatus,
        ),
      ),
      toggleRow('Scrobble what I play',
        'Sends a listen once a track has played for half its length, or four minutes. '
        + 'Anything that fails to send is kept and retried.',
        null, Boolean(getSetting('scrobbleEnabled')), async (on) => {
          await scrobbler.setEnabled(on);
          toast(on ? 'Scrobbling on' : 'Scrobbling off');
        }),
      pendingCount ? el('button', {
        class: 'setting', type: 'button',
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          const sent = await scrobbler.flush();
          toast(sent ? `Sent ${sent} listen${sent === 1 ? '' : 's'}` : 'Still cannot reach ListenBrainz',
            sent ? 'ok' : 'warn');
          renderSettings('accounts');
        },
      },
        el('span', { class: 'setting-icon' }, svg(ICONS.download, 22)),
        el('span', { class: 'setting-body' },
          el('strong', {}, `${pendingCount} listen${pendingCount === 1 ? '' : 's'} waiting`),
          el('span', {}, 'Saved while offline. Tap to send them now.')),
        el('span', { class: 'setting-chev' }, svg(ICONS.chevron, 20)),
      ) : null,
    ),
  );

  mount(root, 'Accounts & Sync');
}

async function settingsStorage() {
  const signal = freshSignal();
  const root = el('div', {});

  const [savedCount, savedBytes, likeCount, localCount, est] = await Promise.all([
    offline.count(), offline.bytes(), likes.count(), local.count(), usage(),
  ]);
  if (signal.aborted) return;

  root.append(
    el('p', { class: 'group-label' }, 'Library'),
    el('div', { class: 'group' },
      el('div', { class: 'stat-grid' },
        el('div', { class: 'stat' }, el('b', {}, String(savedCount)), el('span', {}, 'offline')),
        el('div', { class: 'stat' }, el('b', {}, String(likeCount)), el('span', {}, 'liked')),
        el('div', { class: 'stat' }, el('b', {}, String(localCount)), el('span', {}, 'imported')),
        el('div', { class: 'stat' }, el('b', {}, fmtBytes(savedBytes)), el('span', {}, 'stored')),
      ),
      est ? el('div', { class: 'setting static' },
        el('span', { class: 'setting-icon' }, svg(ICONS.download, 22)),
        el('span', { class: 'setting-body' },
          el('strong', {}, 'Space available'),
          el('span', {}, `${fmtBytes(est.quota - est.used)} free of ${fmtBytes(est.quota)} this browser allows.`)),
      ) : null,
    ),
    el('p', { class: 'group-label' }, 'Clean up'),
    el('div', { class: 'group' },
      el('button', {
        class: 'setting', type: 'button',
        onclick: async () => {
          const sure = await confirmSheet({
            title: 'Clear offline audio',
            body: 'Every downloaded file is removed from this device. Playlists and likes are kept, '
              + 'and anything still on the Archive can be saved again.',
            confirmLabel: 'Clear',
          });
          if (!sure) return;
          await offline.clear();
          offlineIds.clear();
          toast('Offline audio cleared', 'ok');
          renderSettings('storage');
        },
      },
        el('span', { class: 'setting-icon' }, svg(ICONS.trash, 22)),
        el('span', { class: 'setting-body' },
          el('strong', {}, 'Clear offline audio'),
          el('span', {}, 'Removes downloaded files, keeps playlists and likes.')),
        el('span', { class: 'setting-chev' }, svg(ICONS.chevron, 20)),
      ),
      el('button', {
        class: 'setting', type: 'button',
        onclick: async () => {
          await coverCache.clear();
          toast('Artwork cache cleared — covers will be looked up again', 'ok');
        },
      },
        el('span', { class: 'setting-icon' }, svg(ICONS.external, 22)),
        el('span', { class: 'setting-body' },
          el('strong', {}, 'Clear artwork cache'),
          el('span', {}, 'Forget which covers were found, and look them all up again.')),
        el('span', { class: 'setting-chev' }, svg(ICONS.chevron, 20)),
      ),
    ),
  );

  mount(root, 'Library & Storage');
}

function settingsAppearance() {
  freshSignal();
  const root = el('div', {});
  const picker = el('div', { class: 'theme-picker' });

  const paint = () => {
    const active = currentTheme();
    picker.replaceChildren(...[
      ['dark', 'Dark', ['dark']],
      ['light', 'Light', ['light']],
      ['system', 'Follow system', ['dark', 'light']],
    ].map(([key, label, halves]) => el('button', {
      class: 'theme-choice', type: 'button', role: 'radio',
      'aria-checked': String(active === key),
      onclick: async () => { await setTheme(key); paint(); },
    },
      el('span', { class: 'theme-card' },
        ...halves.map((tone) => el('span', { class: `theme-half ${tone}` },
          el('span', { class: 'theme-bar', style: 'width:55%' }),
          el('span', { class: 'theme-bar dim', style: 'width:85%' }),
          el('span', { class: 'theme-bar dim', style: 'width:70%' }),
          el('span', { class: 'theme-foot' }),
        )),
        active === key ? el('span', { class: 'theme-check' }, '✓') : null,
      ),
      el('span', { class: 'theme-name' }, label),
    )));
  };
  paint();

  root.append(
    el('p', { class: 'group-label' }, 'Theme'),
    picker,
    el('p', { class: 'theme-note' }, 'Follow system matches your device’s day/night setting.'),
    el('p', { class: 'group-label' }, 'Dark theme'),
    el('div', { class: 'group' },
      toggleRow('Pure black (AMOLED)',
        'True-black backgrounds whenever dark theme is active — OLED pixels switch off',
        null, amoledOn(), async (on) => { await setAmoled(on); }),
    ),
  );

  mount(root, 'Appearance');
}

function settingsAbout() {
  freshSignal();
  const root = el('div', {});
  const updateLine = el('span', {}, `Version ${APP_VERSION}`);

  root.append(
    el('p', { class: 'group-label' }, 'About'),
    el('div', { class: 'group' },
      el('button', {
        class: 'setting', type: 'button',
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          updateLine.textContent = 'Checking…';
          const r = await checkForUpdate();
          btn.disabled = false;

          if (r.status === 'update') {
            updateLine.textContent = `${r.version} available — tap to download`;
            btn.onclick = () => openExternal(r.apk || r.url);
            toast(`Version ${r.version} is available`, 'ok', 6000);
          } else if (r.status === 'current') {
            updateLine.textContent = `Version ${APP_VERSION} — up to date`;
          } else {
            updateLine.textContent = `Version ${APP_VERSION} — could not check (${r.reason})`;
          }
        },
      },
        el('span', { class: 'setting-icon' }, svg(ICONS.download, 22)),
        el('span', { class: 'setting-body' }, el('strong', {}, 'Check for updates'), updateLine),
        el('span', { class: 'setting-chev' }, svg(ICONS.chevron, 20)),
      ),
      el('div', { class: 'setting static' },
        el('span', { class: 'setting-icon' }, svg(ICONS.info, 22)),
        el('span', { class: 'setting-body' },
          el('strong', {}, 'Void Music'),
          el('span', {}, 'Open-licensed music · GPL-3.0-or-later. Audio from the Internet Archive, '
            + 'artwork from iTunes and the Cover Art Archive, lyrics from LRCLIB, listening '
            + 'history to ListenBrainz.')),
      ),
    ),
  );

  mount(root, 'About & Help');
}

/** A switch row. Pass `icon: null` for the plain form the reference uses. */
function toggleRow(title, sub, icon, checked, onChange) {
  const input = el('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { class: 'setting' },
    icon ? el('span', { class: 'setting-icon' }, svg(icon, 22)) : null,
    el('span', { class: 'setting-body' }, el('strong', {}, title), el('span', {}, sub)),
    el('span', { class: 'switch' }, input, el('span', { class: 'slider' })),
  );
}

function describeHealth() {
  switch (health.state) {
    case 'ok': return `Connected${health.latency ? ` · ${health.latency} ms` : ''}`;
    case 'slow': return `Reachable but slow${health.latency ? ` · ${health.latency} ms` : ''}`;
    case 'blocked': return 'Your connection works, but archive.org is not answering';
    case 'offline': return 'Offline — saved music still plays';
    default: return 'Tap to test';
  }
}

export function focusSearch() {
  searchInput?.focus();
}
