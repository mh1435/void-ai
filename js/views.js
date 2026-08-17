/* Route views. Each exported function fills the #view container. */

import * as A from './archive.js';
import * as P from './player.js';
import { likes, playlists, offline, local, recent, usage, getSetting, setSetting } from './store.js';
import { demoItem, isDemoTrack, renderDemoBlob, DEMO_ITEM_ID } from './demo.js';
import { health, diag, bus, probe } from './net.js';
import {
  $, el, svg, ICONS, fmtTime, fmtBytes, fmtCount, toast, artNode,
  skeletonGrid, loadingRow, emptyState, errorBox, sectionHead,
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

function mount(node) {
  const view = $('#view');
  view.replaceChildren(node);
  view.scrollTop = 0;
  return node;
}

/* ── Shared: track rows ────────────────────────────────────────────── */

let offlineIds = new Set();
let likedIds = new Set();

export async function refreshMarks() {
  offlineIds = await offline.ids();
  likedIds = new Set((await likes.all()).map((t) => t.id));
}

function iconBtn(pathData, label, onClick, { pressed = null, keepMobile = false } = {}) {
  const b = el('button', {
    class: `icon-btn${keepMobile ? ' keep-mobile' : ''}`,
    type: 'button',
    'aria-label': label,
    title: label,
    onclick: (e) => { e.stopPropagation(); onClick(e, b); },
  }, svg(pathData, 18));
  if (pressed !== null) b.setAttribute('aria-pressed', String(pressed));
  return b;
}

/**
 * One row in a track list. `queue` is what plays when the row is clicked.
 */
export function trackRow(track, queue, opts = {}) {
  const { index, showArt = false, onRemove = null, context = null } = opts;

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

  row.append(el('div', { class: 'track-idx' }, String(index ?? track.trackNo ?? '')));

  if (showArt) {
    row.append(artNode(track.cover, '♪', 'track-art'));
  } else {
    row.append(el('div', { class: 'track-art' }, el('span', {}, '♪')));
  }

  row.append(el('div', { class: 'track-main' },
    el('div', { class: 'track-title' }, track.title),
    el('div', { class: 'track-sub' }, [track.artist, track.album && track.album !== track.title ? track.album : null].filter(Boolean).join(' — ')),
  ));

  const badges = el('div', { class: 'track-badges' });
  if (offlineIds.has(track.id)) badges.append(el('span', { class: 'badge offline' }, 'Offline'));
  if (track.source === 'local') badges.append(el('span', { class: 'badge local' }, 'Imported'));
  if (track.source === 'demo') badges.append(el('span', { class: 'badge local' }, 'Generated'));
  if (track.ext && track.source === 'archive') badges.append(el('span', { class: 'badge' }, track.ext));
  row.append(badges);

  const actions = el('div', { class: 'track-actions' });

  const likeBtn = iconBtn(ICONS.heart, 'Save to Liked', async (e, btn) => {
    const on = await likes.toggle(track);
    btn.setAttribute('aria-pressed', String(on));
    if (on) likedIds.add(track.id); else likedIds.delete(track.id);
    toast(on ? 'Saved to Liked' : 'Removed from Liked', on ? 'ok' : '');
  }, { pressed: likedIds.has(track.id) });
  actions.append(likeBtn);

  actions.append(iconBtn(ICONS.queueAdd, 'Add to queue', () => {
    P.playNextUp(track);
    toast('Added to queue', 'ok');
  }));

  actions.append(iconBtn(ICONS.plus, 'Add to playlist', () => openPlaylistPicker([track])));

  if (track.source !== 'local') {
    const dl = iconBtn(ICONS.download, 'Save for offline', (e, btn) => downloadTrack(track, btn), { keepMobile: true });
    if (offlineIds.has(track.id)) dl.setAttribute('aria-pressed', 'true');
    actions.append(dl);
  }

  if (onRemove) {
    actions.append(iconBtn(ICONS.trash, 'Remove', () => onRemove(track)));
  }

  row.append(el('div', { class: 'track-dur' }, fmtTime(track.duration)));
  row.append(actions);

  markPlaying(row, track);
  return row;
}

function markPlaying(row, track) {
  if (P.state.track?.id === track.id) row.classList.add('playing');
}

/** Keep the "now playing" highlight in sync across every rendered list. */
P.player.addEventListener('track', (e) => {
  const id = e.detail.track?.id;
  document.querySelectorAll('.track').forEach((row) => {
    row.classList.toggle('playing', row.dataset.trackId === id);
  });
});

/* ── Offline downloads ─────────────────────────────────────────────── */

async function downloadTrack(track, btn) {
  if (offlineIds.has(track.id)) {
    await offline.remove(track.id);
    offlineIds.delete(track.id);
    btn?.setAttribute('aria-pressed', 'false');
    btn?.closest('.track')?.querySelector('.badge.offline')?.remove();
    toast('Removed offline copy');
    return;
  }

  btn?.setAttribute('aria-pressed', 'true');
  const t = toast(`Saving “${track.title}”…`, '', 60000);
  try {
    const blob = isDemoTrack(track)
      ? await renderDemoBlob(track)
      : await A.fetchTrackBlob(track);
    await offline.save(track, blob);
    offlineIds.add(track.id);
    t?.remove();
    toast(`“${track.title}” saved — ${fmtBytes(blob.size)}`, 'ok');

    const row = btn?.closest('.track');
    if (row && !row.querySelector('.badge.offline')) {
      row.querySelector('.track-badges')?.prepend(el('span', { class: 'badge offline' }, 'Offline'));
    }
  } catch (err) {
    t?.remove();
    btn?.setAttribute('aria-pressed', 'false');
    toast(`Couldn't save: ${err.message}`, 'err', 5000);
  }
}

/* ── Playlist picker ───────────────────────────────────────────────── */

export async function openPlaylistPicker(tracks) {
  const all = await playlists.all();
  const scrim = el('div', { class: 'scrim', onclick: close });
  const box = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Add to playlist' });

  function close() {
    scrim.remove();
    box.remove();
  }

  const list = el('div', { class: 'modal-list' });
  if (!all.length) {
    list.append(el('p', { class: 'modal-hint' }, 'No playlists yet — create one below.'));
  }
  for (const pl of all) {
    list.append(el('button', {
      class: 'modal-row', type: 'button',
      onclick: async () => {
        await playlists.addTracks(pl.id, tracks);
        close();
        toast(`Added to “${pl.name}”`, 'ok');
      },
    }, el('strong', {}, pl.name), el('span', {}, `${pl.tracks.length} track${pl.tracks.length === 1 ? '' : 's'}`)));
  }

  const input = el('input', { type: 'text', placeholder: 'New playlist name', 'aria-label': 'New playlist name' });
  const createBtn = el('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      const pl = await playlists.create(input.value || 'New playlist');
      await playlists.addTracks(pl.id, tracks);
      close();
      toast(`Created “${pl.name}”`, 'ok');
    },
  }, 'Create');

  box.append(
    el('div', { class: 'modal-head' },
      el('h2', {}, `Add ${tracks.length > 1 ? `${tracks.length} tracks` : 'track'} to playlist`),
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: close }, svg(ICONS.x, 18)),
    ),
    list,
    el('div', { class: 'modal-foot' }, input, createBtn),
  );

  document.body.append(scrim, box);
  input.focus();
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });
}

/* ── Home ──────────────────────────────────────────────────────────── */

export async function renderHome() {
  const signal = freshSignal();
  const root = el('div', {});

  root.append(el('section', { class: 'hero' },
    el('h1', {}, 'Music that just plays.'),
    el('p', {}, 'Open-licensed recordings from the Internet Archive — public-domain classics, '
      + 'Creative Commons netlabels, and artist-authorised live sets. No account, no ads, '
      + 'no subscription, and nothing that checks what country you are in.'),
    el('div', { class: 'hero-actions' },
      el('button', { class: 'btn', type: 'button', onclick: () => navigate('#/search') },
        svg(ICONS.play, 18), 'Start browsing'),
      el('button', { class: 'btn secondary', type: 'button', onclick: () => navigate(`#/item/${DEMO_ITEM_ID}`) },
        'Try offline demo'),
    ),
  ));

  const recentSection = el('section', { class: 'section' });
  root.append(recentSection);

  root.append(el('section', { class: 'section' },
    sectionHead('Collections', 'Curated corners of the Archive'),
    el('div', { class: 'grid' },
      ...A.COLLECTIONS.map((c) => {
        const card = el('button', {
          class: 'card collection-card', type: 'button',
          onclick: () => navigate(`#/collection/${c.id}`),
        });
        card.style.setProperty('--c1', c.c1);
        card.style.setProperty('--c2', c.c2);
        card.append(
          el('div', { class: 'art' }, el('span', { class: 'art-fallback' }, c.glyph)),
          el('div', { class: 'card-title' }, c.name),
          el('div', { class: 'card-sub' }, c.blurb),
        );
        return card;
      }),
      (() => {
        const card = el('button', {
          class: 'card collection-card', type: 'button',
          onclick: () => navigate(`#/item/${DEMO_ITEM_ID}`),
        });
        card.style.setProperty('--c1', '#5a2a5a');
        card.style.setProperty('--c2', '#1a1a3a');
        card.append(
          el('div', { class: 'art' }, el('span', { class: 'art-fallback' }, '∿')),
          el('div', { class: 'card-title' }, 'Offline Sessions'),
          el('div', { class: 'card-sub' }, 'Generated on your device — works with no network'),
        );
        return card;
      })(),
    ),
  ));

  mount(root);

  // Recently played is local, so it renders without waiting on the network.
  const rows = await recent.all(6);
  if (signal.aborted) return;
  if (rows.length) {
    recentSection.append(
      sectionHead('Jump back in'),
      el('div', { class: 'grid' }, ...rows.map((r) => itemCard(r))),
    );
  }
}

function itemCard(item) {
  const card = el('button', {
    class: 'card', type: 'button',
    onclick: () => navigate(`#/item/${encodeURIComponent(item.id)}`),
  });
  card.append(
    artNode(item.cover, '♪'),
    el('div', { class: 'card-title' }, item.title),
    el('div', { class: 'card-sub' },
      [item.creator, item.year, item.downloads ? `${fmtCount(item.downloads)} plays` : null]
        .filter(Boolean).join(' · ')),
  );
  return card;
}

/* ── Search & collection listing ───────────────────────────────────── */

export async function renderSearch(query) {
  const signal = freshSignal();
  const root = el('div', {});

  if (!query) {
    root.append(el('section', { class: 'section' },
      sectionHead('Search'),
      emptyState({
        emoji: '⌕',
        title: 'What do you want to hear?',
        body: 'Try an artist, a song title, a genre, or a year — “piano”, “delta blues”, '
            + '“1928”, “ambient”, “Grateful Dead”.',
      }),
    ));
    mount(root);
    return;
  }

  root.append(sectionHead(`Results for “${query}”`));
  const results = el('div', {});
  results.append(skeletonGrid(12));
  root.append(results);
  mount(root);

  try {
    const { items, total } = await A.search({ query, signal });
    if (signal.aborted) return;

    if (!items.length) {
      results.replaceChildren(emptyState({
        emoji: '∅',
        title: 'Nothing found',
        body: 'No open-licensed recordings matched that. Try a broader term, or browse a collection from Home.',
      }));
      return;
    }
    results.replaceChildren(
      el('p', { class: 'card-sub', style: 'margin:0 0 14px' }, `${fmtCount(total)} matching items`),
      el('div', { class: 'grid' }, ...items.map(itemCard)),
    );
  } catch (err) {
    if (signal.aborted) return;
    results.replaceChildren(networkError(err, () => renderSearch(query)));
  }
}

export async function renderCollection(id) {
  const signal = freshSignal();
  const meta = A.COLLECTIONS.find((c) => c.id === id) || { name: id, blurb: '' };
  const root = el('div', {});
  root.append(sectionHead(meta.name, meta.blurb));
  const results = el('div', {});
  results.append(skeletonGrid(12));
  root.append(results);
  mount(root);

  try {
    const { items } = await A.search({ collection: id, rows: 48, signal });
    if (signal.aborted) return;
    results.replaceChildren(
      items.length
        ? el('div', { class: 'grid' }, ...items.map(itemCard))
        : emptyState({ emoji: '∅', title: 'Nothing here right now', body: 'This collection returned no audio items.' }),
    );
  } catch (err) {
    if (signal.aborted) return;
    results.replaceChildren(networkError(err, () => renderCollection(id)));
  }
}

function networkError(err, onRetry) {
  const offlineNow = !navigator.onLine || err?.name === 'OfflineError';
  return errorBox({
    title: offlineNow ? 'You are offline' : 'Could not reach the Archive',
    body: offlineNow
      ? 'Your device reports no connection. Anything you saved for offline still plays from Library.'
      : `The request failed: ${err?.message || 'unknown error'}. This is usually a slow or filtered connection rather than a problem with the app.`,
    hint: offlineNow ? null
      : 'If archive.org is blocked on your network, you can add a mirror or proxy under <b>Settings → Connection</b> and everything will route through it.',
    onRetry,
  });
}

/* ── Item (album) ──────────────────────────────────────────────────── */

export async function renderItem(id) {
  const signal = freshSignal();

  if (id === DEMO_ITEM_ID) {
    paintItem(demoItem());
    return;
  }

  mount(el('div', {}, loadingRow('Loading item…')));

  try {
    const item = await A.getItem(id, { signal });
    if (signal.aborted) return;
    await refreshMarks();
    paintItem(item);
    recent.push({ id: item.id, title: item.title, creator: item.creator, cover: item.cover });
  } catch (err) {
    if (signal.aborted) return;
    mount(el('div', {}, networkError(err, () => renderItem(id))));
  }
}

function paintItem(item) {
  const root = el('div', {});
  const tracks = item.tracks;

  root.append(el('div', { class: 'item-head' },
    artNode(item.cover, '♪', 'item-art'),
    el('div', { class: 'item-info' },
      el('div', { class: 'item-kicker' }, item.isDemo ? 'Generated on device' : 'Archive item'),
      el('h1', {}, item.title),
      el('div', { class: 'item-meta' },
        [item.creator, item.year, `${tracks.length} track${tracks.length === 1 ? '' : 's'}`]
          .filter(Boolean).join(' · ')),
      item.description ? el('p', { class: 'card-sub', style: 'margin-top:10px;max-width:64ch;white-space:normal' }, item.description) : null,
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
        el('button', { class: 'btn secondary', type: 'button', onclick: () => openPlaylistPicker(tracks) },
          svg(ICONS.plus, 18), 'Add all'),
        el('button', {
          class: 'btn secondary', type: 'button',
          onclick: (e) => saveAllOffline(tracks, e.currentTarget),
        }, svg(ICONS.download, 18), 'Save all'),
        item.pageUrl ? el('a', { class: 'btn secondary', href: item.pageUrl, target: '_blank', rel: 'noopener noreferrer' },
          svg(ICONS.external, 18), 'Source') : null,
      ),
    ),
  ));

  root.append(el('div', { class: 'tracks' },
    ...tracks.map((t, i) => trackRow(t, tracks, { index: i + 1, context: item.title })),
  ));

  if (item.licence) {
    root.append(el('p', { class: 'card-sub', style: 'margin-top:20px' },
      el('a', { href: item.licence, target: '_blank', rel: 'noopener noreferrer' }, 'Licence details')));
  }

  mount(root);
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
    } catch {
      // Keep going; one bad file shouldn't abandon the whole album.
    }
  }
  btn.disabled = false;
  btn.textContent = label;
  toast(`Saved ${done} of ${tracks.length} tracks for offline`, done ? 'ok' : 'err');
  document.querySelectorAll('.track').forEach((row) => {
    if (offlineIds.has(row.dataset.trackId) && !row.querySelector('.badge.offline')) {
      row.querySelector('.track-badges')?.prepend(el('span', { class: 'badge offline' }, 'Offline'));
    }
  });
}

/* ── Library ───────────────────────────────────────────────────────── */

export async function renderLibrary() {
  freshSignal();
  await refreshMarks();

  const [pls, liked, saved, imported] = await Promise.all([
    playlists.all(), likes.all(), offline.all(), local.all(),
  ]);

  const root = el('div', {});

  root.append(el('div', { class: 'section-head' },
    el('h2', {}, 'Your Library'),
    el('button', {
      class: 'more', type: 'button',
      onclick: async () => {
        const name = prompt('Playlist name');
        if (name === null) return;
        const pl = await playlists.create(name);
        toast(`Created “${pl.name}”`, 'ok');
        renderLibrary();
      },
    }, '+ New playlist'),
  ));

  const shelves = el('div', { class: 'grid' });

  shelves.append(shelfCard('♥', 'Liked Songs', `${liked.length} track${liked.length === 1 ? '' : 's'}`,
    '#/liked', '#7a2a52', '#2a1e46'));
  shelves.append(shelfCard('⤓', 'Offline', `${saved.length} saved`, '#/offline', '#1e5a5a', '#182838'));
  shelves.append(shelfCard('⊕', 'Imported', `${imported.length} file${imported.length === 1 ? '' : 's'}`,
    '#/imported', '#4b2a7a', '#1e2a52'));

  for (const pl of pls) {
    shelves.append(shelfCard('≡', pl.name, `${pl.tracks.length} track${pl.tracks.length === 1 ? '' : 's'}`,
      `#/playlist/${pl.id}`, '#33305a', '#1a1830'));
  }

  root.append(shelves);

  root.append(el('section', { class: 'section', style: 'margin-top:28px' },
    sectionHead('Import your own music', 'Files stay on this device'),
    el('div', { class: 'panel' },
      el('p', {}, 'Add audio files from your phone or computer. They are stored locally in the app '
        + 'and play with no connection at all — nothing is uploaded anywhere.'),
      fileImportControl(),
    ),
  ));

  mount(root);
}

function shelfCard(glyph, title, sub, route, c1, c2) {
  const card = el('button', { class: 'card collection-card', type: 'button', onclick: () => navigate(route) });
  card.style.setProperty('--c1', c1);
  card.style.setProperty('--c2', c2);
  card.append(
    el('div', { class: 'art' }, el('span', { class: 'art-fallback' }, glyph)),
    el('div', { class: 'card-title' }, title),
    el('div', { class: 'card-sub' }, sub),
  );
  return card;
}

function fileImportControl() {
  const input = el('input', {
    type: 'file', accept: 'audio/*', multiple: true,
    style: 'display:none', id: 'file-input',
    onchange: async (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      if (!files.length) return;
      let ok = 0;
      for (const f of files) {
        try {
          const track = {
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
          };
          await local.add(track, f);
          ok++;
        } catch (err) {
          toast(`Couldn't import ${f.name}: ${err.message}`, 'err');
        }
      }
      toast(`Imported ${ok} file${ok === 1 ? '' : 's'}`, 'ok');
      renderLibrary();
    },
  });

  return el('div', {}, input,
    el('button', { class: 'btn', type: 'button', onclick: () => input.click() },
      svg(ICONS.plus, 18), 'Choose files'));
}

/* ── Track-list routes ─────────────────────────────────────────────── */

export async function renderLiked() {
  freshSignal();
  await refreshMarks();
  const tracks = await likes.all();
  paintTrackList({
    title: 'Liked Songs',
    sub: `${tracks.length} track${tracks.length === 1 ? '' : 's'}`,
    glyph: '♥',
    tracks,
    empty: emptyState({
      emoji: '♡',
      title: 'No liked songs yet',
      body: 'Tap the heart on any track and it lands here.',
      action: el('button', { class: 'btn', type: 'button', onclick: () => navigate('#/search') }, 'Find something'),
    }),
    onRemove: async (t) => { await likes.remove(t.id); renderLiked(); },
  });
}

export async function renderOffline() {
  freshSignal();
  await refreshMarks();
  const tracks = await offline.all();
  const bytes = await offline.bytes();
  paintTrackList({
    title: 'Offline',
    sub: `${tracks.length} track${tracks.length === 1 ? '' : 's'} · ${fmtBytes(bytes)}`,
    glyph: '⤓',
    tracks,
    empty: emptyState({
      emoji: '⤓',
      title: 'Nothing saved offline',
      body: 'Use the download button on a track to keep it on this device. Saved tracks play instantly '
          + 'and work with no connection.',
    }),
    onRemove: async (t) => { await offline.remove(t.id); renderOffline(); },
  });
}

export async function renderImported() {
  freshSignal();
  await refreshMarks();
  const tracks = await local.all();
  paintTrackList({
    title: 'Imported',
    sub: `${tracks.length} file${tracks.length === 1 ? '' : 's'}`,
    glyph: '⊕',
    tracks,
    empty: emptyState({
      emoji: '⊕',
      title: 'No imported files',
      body: 'Add your own audio from Library — it never leaves this device.',
      action: el('button', { class: 'btn', type: 'button', onclick: () => navigate('#/library') }, 'Go to Library'),
    }),
    onRemove: async (t) => { await local.remove(t.id); renderImported(); },
  });
}

export async function renderPlaylist(id) {
  freshSignal();
  await refreshMarks();
  const pl = await playlists.get(id);
  if (!pl) {
    mount(el('div', {}, emptyState({ emoji: '∅', title: 'Playlist not found', body: 'It may have been deleted.' })));
    return;
  }
  paintTrackList({
    title: pl.name,
    sub: `${pl.tracks.length} track${pl.tracks.length === 1 ? '' : 's'}`,
    glyph: '≡',
    tracks: pl.tracks,
    empty: emptyState({
      emoji: '≡',
      title: 'This playlist is empty',
      body: 'Add tracks with the + button on any row.',
    }),
    onRemove: async (t) => { await playlists.removeTrack(id, t.id); renderPlaylist(id); },
    extraActions: [
      el('button', {
        class: 'btn secondary', type: 'button',
        onclick: async () => {
          const name = prompt('Rename playlist', pl.name);
          if (name === null) return;
          await playlists.rename(id, name);
          renderPlaylist(id);
        },
      }, 'Rename'),
      el('button', {
        class: 'btn secondary', type: 'button',
        onclick: async () => {
          if (!confirm(`Delete “${pl.name}”? This cannot be undone.`)) return;
          await playlists.remove(id);
          toast('Playlist deleted');
          navigate('#/library');
        },
      }, svg(ICONS.trash, 18), 'Delete'),
    ],
  });
}

function paintTrackList({ title, sub, glyph, tracks, empty, onRemove, extraActions = [] }) {
  const root = el('div', {});

  root.append(el('div', { class: 'item-head' },
    el('div', { class: 'item-art' }, el('span', {}, glyph)),
    el('div', { class: 'item-info' },
      el('div', { class: 'item-kicker' }, 'Collection'),
      el('h1', {}, title),
      el('div', { class: 'item-meta' }, sub),
      el('div', { class: 'item-actions' },
        el('button', {
          class: 'btn', type: 'button', disabled: !tracks.length,
          onclick: () => P.playAll(tracks, 0, title),
        }, svg(ICONS.play, 18), 'Play'),
        tracks.length ? el('button', {
          class: 'btn secondary', type: 'button',
          onclick: () => {
            if (!P.state.shuffle) P.toggleShuffle();
            P.playAll(tracks, Math.floor(Math.random() * tracks.length), title);
          },
        }, 'Shuffle') : null,
        ...extraActions,
      ),
    ),
  ));

  root.append(tracks.length
    ? el('div', { class: 'tracks' },
        ...tracks.map((t, i) => trackRow(t, tracks, { index: i + 1, showArt: true, onRemove, context: title })))
    : empty);

  mount(root);
}

/* ── Settings ──────────────────────────────────────────────────────── */

export async function renderSettings() {
  const signal = freshSignal();
  const root = el('div', {});
  root.append(sectionHead('Settings'));

  /* Connection */
  const probeOut = el('div', { class: 'card-sub' }, describeHealth());
  const connPanel = el('div', { class: 'panel' },
    el('h2', {}, 'Connection'),
    el('p', {}, 'Void Music talks to one host: archive.org. If that is slow or blocked on your '
      + 'network, add a mirror below and every request will use it instead.'),
    el('div', { class: 'row' },
      el('div', { class: 'row-main' },
        el('strong', {}, 'Status'),
        probeOut,
      ),
      el('button', {
        class: 'btn secondary', type: 'button',
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          probeOut.textContent = 'Testing…';
          const r = await probe(`https://archive.org/metadata/nasa`);
          probeOut.textContent = r.ok
            ? `archive.org reachable in ${r.ms} ms`
            : `archive.org unreachable (${r.error}) — try a mirror below`;
          btn.disabled = false;
        },
      }, 'Test now'),
    ),
  );

  const mirrorInput = el('input', {
    type: 'text', value: getSetting('mirrors') || '', style: 'flex:1;min-width:220px',
    placeholder: 'https://my-mirror.example',
    'aria-label': 'Mirror base URLs, comma separated',
  });
  connPanel.append(el('div', { class: 'row' },
    el('div', { class: 'row-main' },
      el('strong', {}, 'Mirror / proxy'),
      el('span', {}, 'Comma-separated base URLs that mirror archive.org. Tried in parallel with the '
        + 'official host; whichever answers first wins.'),
    ),
    mirrorInput,
    el('button', {
      class: 'btn secondary', type: 'button',
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
    }, 'Save'),
  ));

  const lowBitrate = el('input', { type: 'checkbox', checked: Boolean(getSetting('preferLowBitrate')) });
  lowBitrate.addEventListener('change', async () => {
    await setSetting('preferLowBitrate', lowBitrate.checked);
    A.config.preferLowBitrate = lowBitrate.checked;
    toast(lowBitrate.checked ? 'Preferring smaller files' : 'Preferring better quality', 'ok');
  });
  connPanel.append(el('div', { class: 'row' },
    el('div', { class: 'row-main' },
      el('strong', {}, 'Data saver'),
      el('span', {}, 'Pick the smallest available encoding of each track. Helps a lot on a metered or congested link.'),
    ),
    el('label', { class: 'switch' }, lowBitrate, el('span', { class: 'slider' })),
  ));
  root.append(connPanel);

  /* Storage */
  const [savedCount, savedBytes, likeCount, localCount, est] = await Promise.all([
    offline.count(), offline.bytes(), likes.count(), local.count(), usage(),
  ]);

  root.append(el('div', { class: 'panel' },
    el('h2', {}, 'Storage'),
    el('p', {}, 'Everything is kept on this device. Clearing your browser data for this site removes it.'),
    el('div', { class: 'stat-grid' },
      el('div', { class: 'stat' }, el('b', {}, String(savedCount)), el('span', {}, 'offline tracks')),
      el('div', { class: 'stat' }, el('b', {}, fmtBytes(savedBytes)), el('span', {}, 'audio stored')),
      el('div', { class: 'stat' }, el('b', {}, String(likeCount)), el('span', {}, 'liked')),
      el('div', { class: 'stat' }, el('b', {}, String(localCount)), el('span', {}, 'imported')),
      est ? el('div', { class: 'stat' }, el('b', {}, fmtBytes(est.quota)), el('span', {}, 'quota available')) : null,
    ),
    el('div', { class: 'row', style: 'margin-top:12px' },
      el('div', { class: 'row-main' },
        el('strong', {}, 'Clear offline audio'),
        el('span', {}, 'Removes downloaded files but keeps playlists and likes.'),
      ),
      el('button', {
        class: 'btn secondary', type: 'button',
        onclick: async () => {
          if (!confirm('Delete all offline audio?')) return;
          await offline.clear();
          toast('Offline audio cleared', 'ok');
          renderSettings();
        },
      }, 'Clear'),
    ),
  ));

  /* Diagnostics */
  const log = el('div', { class: 'diag-log' });
  function paintLog() {
    log.replaceChildren(...diag.entries.slice(-60).reverse().map((e) => {
      const t = new Date(e.at).toLocaleTimeString();
      return el('div', { class: `lvl-${e.level}` }, `${t}  ${e.msg}`);
    }));
    if (!diag.entries.length) log.textContent = 'No network events yet.';
  }
  paintLog();
  // Drop the listener when the user navigates away, or every visit to Settings
  // would leave another one attached to the bus.
  bus.addEventListener('diag', paintLog, { signal });

  root.append(el('div', { class: 'panel' },
    el('h2', {}, 'Diagnostics'),
    el('p', {}, 'A live record of network attempts, retries and failures — useful when working out '
      + 'whether a problem is the app, your connection, or a block upstream.'),
    log,
  ));

  /* About */
  root.append(el('div', { class: 'panel' },
    el('h2', {}, 'About'),
    el('p', {}, 'Void Music streams openly-licensed recordings from the Internet Archive: '
      + 'public-domain works, Creative Commons releases, and live recordings the artists allow to be traded. '
      + 'It has no advertising and no subscription because the material is free to share, not because '
      + 'any paywall was bypassed. Commercial catalogues are not available here — those require a licence '
      + 'that a free app cannot grant itself.'),
    el('div', { class: 'row' },
      el('div', { class: 'row-main' },
        el('strong', {}, 'Install as an app'),
        el('span', {}, 'On Android, use your browser menu → “Install app” / “Add to Home screen”. '
          + 'It runs full-screen with its own icon and needs no app store.'),
      ),
    ),
  ));

  mount(root);
}

function describeHealth() {
  switch (health.state) {
    case 'ok':      return `Connected${health.latency ? ` · ${health.latency} ms` : ''}`;
    case 'slow':    return `Reachable but slow${health.latency ? ` · ${health.latency} ms` : ''}`;
    case 'blocked': return 'Your connection works, but archive.org is not answering — try a mirror below';
    case 'offline': return 'Offline — saved music still plays';
    default:        return 'Not tested yet';
  }
}
