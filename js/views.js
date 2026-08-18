/* Route views. Each exported function fills the #view container. */

import * as A from './archive.js';
import * as P from './player.js';
import { likes, playlists, offline, local, recent, usage, getSetting, setSetting } from './store.js';
import { demoItem, isDemoTrack, renderDemoBlob, DEMO_ITEM_ID } from './demo.js';
import { health, diag, bus, probe } from './net.js';
import { resolveCover } from './artwork.js';
import { currentTheme, amoledOn, setTheme, setAmoled } from './theme.js';
import { checkForUpdate, APP_VERSION } from './update.js';
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

function mount(node, title) {
  setPageTitle(title);
  const view = $('#view');
  view.replaceChildren(node);
  view.scrollTop = 0;
  return node;
}

function setPageTitle(title) {
  const word = $('#wordmark');
  const heading = $('#page-title');
  if (title) {
    word.hidden = true;
    heading.hidden = false;
    heading.textContent = title;
  } else {
    word.hidden = false;
    heading.hidden = true;
  }
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

  const box = el('div', { class: 'searchbox' },
    svg(ICONS.search, 20),
    el('input', {
      type: 'search', placeholder: 'Songs, artists, albums…',
      value: query || '', autocomplete: 'off', autocorrect: 'off',
      spellcheck: false, 'aria-label': 'Search music', enterkeyhint: 'search',
    }),
  );
  searchInput = box.querySelector('input');
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
    el('div', { class: 'section-head' },
      el('h2', { style: 'font-size:15px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)' }, 'Recent'),
      el('button', {
        class: 'more', type: 'button',
        onclick: async () => { await recent.clear(); renderSearch(''); },
      }, 'Clear'),
    ),
    ...rows.map((r) => el('div', {
      class: 'recent-row', tabindex: '0', role: 'button',
      onclick: () => navigate(`#/item/${encodeURIComponent(r.id)}`),
    },
      tintedArt(r.cover, r.id, 'recent-art'),
      el('div', { class: 'track-main' },
        el('div', { class: 'track-title' }, r.title),
        el('div', { class: 'track-sub' }, r.creator),
      ),
    )),
  );
}

/* ── Collection ────────────────────────────────────────────────────── */

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
  mount(root, 'Library');
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
    const input = el('input', {
      type: 'file', accept: 'audio/*', multiple: true, style: 'display:none',
      onchange: (e) => importFiles([...e.target.files], e.target),
    });
    body.replaceChildren(
      input,
      el('button', {
        class: 'btn block', type: 'button', style: 'margin-bottom:18px',
        onclick: () => input.click(),
      }, svg(ICONS.plus, 18), 'Add files from this device'),
      tracks.length
        ? el('div', { class: 'tracks' },
            ...tracks.map((t) => trackRow(t, tracks, {
              context: 'Imported',
              onRemove: async (x) => { await local.remove(x.id); renderLibrary(); },
            })))
        : el('p', { class: 'modal-hint' }, 'Your own files stay on this device and play with no connection.'),
    );
    return;
  }

  const pls = await playlists.all();
  body.replaceChildren(
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

async function importFiles(files, input) {
  if (input) input.value = '';
  if (!files.length) return;
  let ok = 0;
  for (const f of files) {
    try {
      await local.add({
        id: `local::${f.name}::${f.size}`,
        itemId: 'local',
        file: f.name,
        title: f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '),
        artist: 'Imported',
        album: 'Your files',
        duration: 0,
        size: f.size,
        mime: f.type || 'audio/mpeg',
        ext: (f.name.split('.').pop() || '').toLowerCase(),
        trackNo: ok + 1,
        cover: null,
        urls: [],
        source: 'local',
      }, f);
      ok++;
    } catch (err) {
      toast(`Couldn't import ${f.name}`, 'err');
    }
  }
  toast(`Imported ${ok} file${ok === 1 ? '' : 's'}`, 'ok');
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
        onclick: async () => {
          if (!confirm(`Delete “${pl.name}”?`)) return;
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

export async function renderSettings() {
  const signal = freshSignal();
  const root = el('div', {});

  root.append(el('div', { class: 'support-card' },
    el('h2', {}, 'Open music, no strings'),
    el('p', {}, 'Everything here is public domain, Creative Commons, or shared with the artist’s '
      + 'blessing. No account, no ads, no subscription — and nothing that checks what country you are in.'),
    el('div', { class: 'support-actions' },
      el('a', { class: 'btn', href: 'https://archive.org/donate', target: '_blank', rel: 'noopener noreferrer' },
        svg(ICONS.heart, 18), 'Support the Archive'),
    ),
  ));

  /* Connection */
  const statusLine = el('span', {}, describeHealth());
  const mirrorInput = el('input', {
    type: 'text', value: getSetting('mirrors') || '', placeholder: 'https://my-mirror.example',
    'aria-label': 'Mirror base URLs, comma separated',
  });

  root.append(el('p', { class: 'group-label' }, 'Connection'));
  root.append(el('div', { class: 'group' },
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
    el('div', { class: 'setting static' },
      el('span', { class: 'setting-icon' }, svg(ICONS.external, 22)),
      el('span', { class: 'setting-body' },
        el('strong', {}, 'Mirror or proxy'),
        el('span', {}, 'If archive.org is blocked on your network, point the app at your own https mirror. '
          + 'Tried in parallel with the official host; the fastest answer wins.'),
        el('span', { style: 'margin-top:10px;display:flex;gap:8px' }, mirrorInput,
          el('button', {
            class: 'btn secondary', type: 'button', style: 'flex:none',
            onclick: async () => {
              const raw = mirrorInput.value.trim();
              const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
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
    toggleRow('Data saver', 'Pick the smallest encoding of each track. Helps a lot on a slow or metered link.',
      ICONS.download, Boolean(getSetting('preferLowBitrate')), async (on) => {
        await setSetting('preferLowBitrate', on);
        A.config.preferLowBitrate = on;
      }),
  ));

  /* Storage */
  const [savedCount, savedBytes, likeCount, localCount, est] = await Promise.all([
    offline.count(), offline.bytes(), likes.count(), local.count(), usage(),
  ]);
  if (signal.aborted) return;

  root.append(el('p', { class: 'group-label' }, 'Library & storage'));
  root.append(el('div', { class: 'group' },
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
    el('button', {
      class: 'setting', type: 'button',
      onclick: async () => {
        if (!confirm('Delete all offline audio? Playlists and likes are kept.')) return;
        await offline.clear();
        offlineIds.clear();
        toast('Offline audio cleared', 'ok');
        renderSettings();
      },
    },
      el('span', { class: 'setting-icon' }, svg(ICONS.trash, 22)),
      el('span', { class: 'setting-body' },
        el('strong', {}, 'Clear offline audio'),
        el('span', {}, 'Removes downloaded files, keeps playlists and likes.')),
      el('span', { class: 'setting-chev' }, svg(ICONS.chevron, 20)),
    ),
  ));

  /* Diagnostics */
  const log = el('div', { class: 'diag-log' });
  const paintLog = () => {
    log.replaceChildren(...diag.entries.slice(-50).reverse().map((e) =>
      el('div', { class: `lvl-${e.level}` }, `${new Date(e.at).toLocaleTimeString()}  ${e.msg}`)));
    if (!diag.entries.length) log.textContent = 'No network events yet.';
  };
  paintLog();
  bus.addEventListener('diag', paintLog, { signal });

  root.append(el('p', { class: 'group-label' }, 'Diagnostics'));
  root.append(el('div', { class: 'group' },
    el('div', { class: 'setting static' },
      el('span', { class: 'setting-icon' }, svg(ICONS.wifi, 22)),
      el('span', { class: 'setting-body' },
        el('strong', {}, 'Network log'),
        el('span', {}, 'Every retry and failure, so you can tell the app apart from your connection.')),
    ),
    log,
  ));

  /* Appearance */
  const themeGroup = el('div', { class: 'group' });
  const paintTheme = () => {
    const active = currentTheme();
    themeGroup.replaceChildren(
      ...[['dark', 'Dark'], ['light', 'Light'], ['system', 'Follow system']].map(([key, label]) =>
        el('button', {
          class: 'radio-row', type: 'button', role: 'radio',
          'aria-checked': String(active === key),
          onclick: async () => { await setTheme(key); paintTheme(); },
        },
          el('span', { class: 'radio-dot' }),
          el('span', { class: 'radio-body' },
            el('strong', {}, label),
            key === 'system' ? el('span', {}, 'Matches your device’s day/night setting') : null),
        )),
      toggleRow('Pure black (AMOLED)', 'True-black backgrounds in dark mode — OLED pixels switch off, saving battery.',
        ICONS.check, amoledOn(), async (on) => { await setAmoled(on); }),
    );
  };
  paintTheme();
  root.append(el('p', { class: 'group-label' }, 'Appearance'), themeGroup);

  /* About & updates */
  const updateLine = el('span', {}, `Version ${APP_VERSION}`);
  root.append(el('p', { class: 'group-label' }, 'About'));
  root.append(el('div', { class: 'group' },
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
          btn.onclick = () => window.open(r.apk || r.url, '_blank', 'noopener');
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
      el('span', { class: 'setting-icon' }, svg(ICONS.play, 22)),
      el('span', { class: 'setting-body' },
        el('strong', {}, 'Void Music'),
        el('span', {}, 'Open-licensed music · MIT. Artwork from the Cover Art Archive, '
          + 'lyrics from LRCLIB, audio from the Internet Archive.')),
    ),
  ));

  mount(root, 'Settings');
}

function toggleRow(title, sub, icon, checked, onChange) {
  const input = el('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { class: 'setting' },
    el('span', { class: 'setting-icon' }, svg(icon, 22)),
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
