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

/* Bootstrap: routing, transport wiring, now playing, keyboard shortcuts. */

import * as P from './player.js';
import * as V from './views.js';
import * as A from './archive.js';
import { likes, loadSettings, getSetting, setSetting, persist } from './store.js';
import { health, bus, diag } from './net.js';
import { $, el, svg, ICONS, fmtTime, toast, tintFor, dominantColor } from './ui.js';
import { initNative, isNativeApp } from './native.js';
import { getLyrics, lineAt } from './lyrics.js';
import { applyTheme } from './theme.js';
import { initScrobbler } from './scrobble.js';
import './demo.js'; // registers the generated-audio provider

/* ── Routing ───────────────────────────────────────────────────────── */

const ROUTES = [
  [/^#\/home$/,             () => V.renderHome()],
  [/^#\/search$/,           () => V.renderSearch('')],
  [/^#\/search\/(.+)$/,     (m) => V.renderSearch(decodeURIComponent(m[1]))],
  [/^#\/collection\/(.+)$/, (m) => V.renderCollection(decodeURIComponent(m[1]))],
  [/^#\/item\/(.+)$/,       (m) => V.renderItem(decodeURIComponent(m[1]))],
  [/^#\/artist\/(.+)$/,     (m) => V.renderArtist(decodeURIComponent(m[1]))],
  [/^#\/library$/,          () => V.renderLibrary()],
  [/^#\/offline$/,          () => V.renderOffline()],
  [/^#\/playlist\/(.+)$/,   (m) => V.renderPlaylist(decodeURIComponent(m[1]))],
  [/^#\/settings$/,         () => V.renderSettings()],
  [/^#\/settings\/(.+)$/,   (m) => V.renderSettings(m[1])],
];

function navKeyFor(hash) {
  if (hash.startsWith('#/search')) return 'search';
  if (hash.startsWith('#/settings')) return 'settings';
  if (hash.startsWith('#/offline')) return 'offline';
  if (/^#\/(library|playlist)/.test(hash)) return 'library';
  if (/^#\/(collection|item|artist)/.test(hash)) return '';
  return 'home';
}

/** Routes that are a destination in their own right, not a drill-down. */
const TOP_LEVEL = /^#\/(home|search|library|offline|settings)$/;

let depth = 0;

export function navigate(hash) {
  if (location.hash === hash) { route(); return; }
  if (!TOP_LEVEL.test(hash)) depth++;
  else depth = 0;
  location.hash = hash;
}

V.setNavigator(navigate);

function route() {
  const hash = location.hash || '#/home';
  const key = navKeyFor(hash);

  document.querySelectorAll('[data-nav]').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === key);
  });

  // Home keeps the wordmark bar; every other page carries its own big title
  // inside the scrolling area, the way the reference does.
  $('#topbar').hidden = hash !== '#/home';
  $('#ticker').hidden = hash !== '#/home';
  setSetting('lastRoute', hash);

  for (const [re, handler] of ROUTES) {
    const match = hash.match(re);
    if (match) {
      Promise.resolve(handler(match)).catch((err) => {
        diag.log('err', `view failed: ${err.message}`);
        toast(`Something went wrong: ${err.message}`, 'err', 5000);
      });
      return;
    }
  }
  navigate('#/home');
}

addEventListener('hashchange', route);

/* ── Now playing sheet ─────────────────────────────────────────────── */

let npOpen = false;

function openNowPlaying() {
  if (!P.state.track) return;
  const sheet = $('#nowplaying');
  sheet.hidden = false;
  sheet.classList.remove('closing');
  npOpen = true;
}

function closeNowPlaying() {
  const sheet = $('#nowplaying');
  if (sheet.hidden) return;
  sheet.classList.add('closing');
  npOpen = false;
  setTimeout(() => {
    sheet.hidden = true;
    sheet.classList.remove('closing');
  }, 240);
}

/* ── Transport wiring ──────────────────────────────────────────────── */

let seeking = false;

function wireTransport() {
  const mini = $('#miniplayer');
  const sheet = $('#nowplaying');
  const range = $('#np-range');

  $('#mini-open').addEventListener('click', openNowPlaying);
  $('#np-close').addEventListener('click', closeNowPlaying);

  $('#mini-play').addEventListener('click', (e) => { e.stopPropagation(); P.toggle(); });
  $('#mini-next').addEventListener('click', (e) => { e.stopPropagation(); P.next(false); });

  $('#np-play').addEventListener('click', () => P.toggle());
  $('#np-next').addEventListener('click', () => P.next(false));
  $('#np-prev').addEventListener('click', () => P.prev());

  $('#np-shuffle').addEventListener('click', (e) => {
    const on = P.toggleShuffle();
    e.currentTarget.setAttribute('aria-pressed', String(on));
    toast(on ? 'Shuffle on' : 'Shuffle off');
  });

  $('#np-repeat').addEventListener('click', (e) => {
    const mode = P.cycleRepeat();
    e.currentTarget.dataset.mode = mode;
    toast(mode === 'off' ? 'Repeat off' : mode === 'all' ? 'Repeat all' : 'Repeat one');
  });

  $('#np-like').addEventListener('click', async (e) => {
    if (!P.state.track) return;
    const on = await likes.toggle(P.state.track);
    e.currentTarget.setAttribute('aria-pressed', String(on));
    await V.refreshMarks();
    toast(on ? 'Saved to Liked' : 'Removed from Liked', on ? 'ok' : '');
  });

  range.addEventListener('input', () => {
    seeking = true;
    const dur = P.state.duration || 0;
    $('#np-cur').textContent = fmtTime((range.value / 1000) * dur);
    range.style.setProperty('--fill', `${range.value / 10}%`);
  });
  range.addEventListener('change', () => {
    P.seekFraction(range.value / 1000);
    seeking = false;
  });

  // Swipe down on the artwork to dismiss, like a native sheet.
  let touchY = null;
  sheet.addEventListener('touchstart', (e) => { touchY = e.touches[0].clientY; }, { passive: true });
  sheet.addEventListener('touchend', (e) => {
    if (touchY === null) return;
    const dy = e.changedTouches[0].clientY - touchY;
    if (dy > 90 && sheet.scrollTop <= 0) closeNowPlaying();
    touchY = null;
  }, { passive: true });

  P.player.addEventListener('track', async (e) => {
    const t = e.detail.track;
    mini.dataset.empty = 'false';

    $('#mini-title').textContent = t.title;
    $('#mini-artist').textContent = t.artist || '';
    $('#np-title').textContent = t.title;
    $('#np-artist').textContent = t.artist || '';
    $('#np-source').textContent = t.album || 'Void Music';
    $('#np-quality').textContent = qualityLine(t);

    swapArt('#mini-art', t, 'mini-art');
    applyTint(t, swapArt('#np-art', t, 'np-art'));

    $('#np-like').setAttribute('aria-pressed', String(await likes.has(t.id)));
    document.title = `${t.title} — ${t.artist} · Void Music`;
  });

  P.player.addEventListener('status', (e) => {
    const s = e.detail;
    const state = s.loading ? 'loading' : s.playing ? 'playing' : 'paused';
    mini.dataset.state = state;
    sheet.dataset.state = state;
    $('#mini-play').setAttribute('aria-label', s.playing ? 'Pause' : 'Play');
    $('#np-play').setAttribute('aria-label', s.playing ? 'Pause' : 'Play');
    $('#np-shuffle').setAttribute('aria-pressed', String(s.shuffle));
    $('#np-repeat').dataset.mode = s.repeat;
  });

  P.player.addEventListener('time', (e) => {
    const { time, duration } = e.detail;
    const pct = duration ? (time / duration) * 100 : 0;
    $('#mini-bar').style.width = `${pct}%`;
    if (seeking) return;
    $('#np-cur').textContent = fmtTime(time);
    $('#np-rem').textContent = duration ? `-${fmtTime(Math.max(0, duration - time))}` : '0:00';
    range.value = String(pct * 10);
    range.style.setProperty('--fill', `${pct}%`);
  });

  P.player.addEventListener('error', (e) => {
    toast(`Skipping “${e.detail.track.title}” — ${e.detail.error?.message || 'could not play'}`, 'err', 4500);
  });

  P.player.addEventListener('blocked', () => {
    toast('Tap play to start — the browser blocks autoplay until you interact', 'warn', 5000);
  });

  P.player.addEventListener('ended', () => { document.title = 'Void Music'; });
}

function qualityLine(track) {
  const bits = [];
  if (track.ext) bits.push(track.ext.toUpperCase());
  if (track.source === 'demo') bits.push('generated on device');
  else if (track.source === 'local') bits.push('your file');
  else bits.push('via archive.org');
  return bits.join(' · ');
}

function swapArt(selector, track, className) {
  const old = $(selector);
  if (!old) return null;
  // smartArt looks up real artwork when the track carries none.
  const next = V.smartArt(track, track.itemId || track.title, className);
  next.id = old.id;
  old.replaceWith(next);
  return next;
}

/**
 * Colour the now-playing screen from the cover itself: the wash behind the
 * art, the play button and the lyric line all take the same tint.
 *
 * The generated tint goes on immediately so nothing flashes grey, then the
 * real colour replaces it once the artwork is on screen — which may be a
 * moment later, because covers are looked up lazily.
 */
function applyTint(track, artNode) {
  const sheet = $('#nowplaying');
  sheet.style.setProperty('--np-tint', tintFor(track.itemId || track.title).solid);

  const use = (src) => {
    if (!src) return;
    dominantColor(src).then((colour) => {
      // Ignore a colour that arrives after the user moved on.
      if (colour && P.state.track?.id === track.id) sheet.style.setProperty('--np-tint', colour);
    });
  };

  if (track.cover) use(track.cover);
  if (!artNode) return;

  const fromNode = () => {
    const img = artNode.querySelector('img');
    if (!img) return false;
    if (img.complete) use(img.currentSrc || img.src);
    else img.addEventListener('load', () => use(img.currentSrc || img.src), { once: true });
    return true;
  };

  if (fromNode()) return;
  // smartArt fills the cover in later; watch for it exactly once.
  const observer = new MutationObserver(() => { if (fromNode()) observer.disconnect(); });
  observer.observe(artNode, { childList: true });
  setTimeout(() => observer.disconnect(), 20000);
}

/* ── Lyrics ────────────────────────────────────────────────────────── */

let lyrics = null;          // { synced: [{time,text}], plain }
let lyricsToken = 0;
let activeLine = -1;

function wireLyrics() {
  const preview = $('#np-lyric');
  const sheet = $('#lyrics-sheet');
  const body = $('#lyrics-body');

  const open = () => { if (lyrics) { sheet.hidden = false; renderActive(true); } };
  preview.addEventListener('click', open);
  $('#lyrics-close').addEventListener('click', () => { sheet.hidden = true; });

  P.player.addEventListener('track', async (e) => {
    const token = ++lyricsToken;
    lyrics = null;
    activeLine = -1;
    preview.hidden = true;
    preview.textContent = '';
    body.replaceChildren();
    sheet.hidden = true;

    const found = await getLyrics(e.detail.track).catch(() => null);
    if (token !== lyricsToken || !found) return;

    lyrics = found;
    preview.hidden = false;

    if (found.synced.length) {
      body.replaceChildren(...found.synced.map((line, i) =>
        el('div', { class: 'lyric-line', dataset: { i: String(i) } }, line.text || '♪')));
    } else if (found.plain) {
      preview.textContent = 'Lyrics available';
      body.replaceChildren(el('div', { class: 'lyrics-plain' }, found.plain));
    }
  });

  P.player.addEventListener('time', (e) => {
    if (!lyrics?.synced.length) return;
    const idx = lineAt(lyrics.synced, e.detail.time + 0.15);
    if (idx === activeLine) return;
    activeLine = idx;
    preview.textContent = idx >= 0 ? lyrics.synced[idx].text : '';
    renderActive(false);
  });

  function renderActive(jump) {
    if (sheet.hidden || !lyrics?.synced.length) return;
    const lines = body.children;
    for (let i = 0; i < lines.length; i++) {
      lines[i].classList.toggle('active', i === activeLine);
      lines[i].classList.toggle('passed', i < activeLine);
    }
    const current = lines[activeLine];
    if (current) {
      current.scrollIntoView({ block: 'center', behavior: jump ? 'auto' : 'smooth' });
    }
  }
}

/* ── Sleep timer ───────────────────────────────────────────────────── */

function wireSleep() {
  const btn = $('#np-sleep');
  const dot = $('#sleep-dot');

  const paint = () => {
    const s = P.sleepState();
    btn.setAttribute('aria-pressed', String(s.active));
    dot.hidden = !s.active;
    btn.title = s.active
      ? (s.endOfTrack ? 'Stops at end of track' : `Stops in ${Math.ceil(s.remainingMs / 60000)} min`)
      : 'Sleep timer';
  };

  P.player.addEventListener('sleep', paint);
  paint();

  btn.addEventListener('click', () => {
    const s = P.sleepState();
    const scrim = el('div', { class: 'scrim' });
    const box = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });
    const close = () => { scrim.remove(); box.remove(); };
    scrim.addEventListener('click', close);

    const choice = (label, sub, fn) => el('button', {
      class: 'modal-row', type: 'button',
      onclick: () => { fn(); close(); paint(); },
    }, el('strong', {}, label), sub ? el('span', {}, sub) : null);

    box.append(
      el('div', { class: 'modal-head' },
        el('h2', {}, 'Sleep timer'),
        el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: close },
          svg(ICONS.x, 18))),
      el('div', { class: 'modal-list' },
        ...[5, 15, 30, 45, 60].map((m) =>
          choice(`${m} minutes`, null, () => {
            P.setSleepTimer({ minutes: m });
            toast(`Music stops in ${m} minutes`, 'ok');
          })),
        choice('End of this track', null, () => {
          P.setSleepTimer({ endOfTrack: true });
          toast('Music stops when this track ends', 'ok');
        }),
        s.active ? choice('Turn off timer', null, () => {
          P.clearSleepTimer();
          toast('Sleep timer off');
        }) : null,
      ),
    );
    document.body.append(scrim, box);
  });
}

/* ── Queue drawer ──────────────────────────────────────────────────── */

function wireQueue() {
  const drawer = $('#queue-drawer');
  const scrim = $('#scrim');
  const list = $('#queue-list');
  const countLabel = $('#queue-count');

  const close = () => { drawer.hidden = true; scrim.hidden = true; };
  const open = () => { drawer.hidden = false; scrim.hidden = false; paint(); };

  function paint() {
    if (drawer.hidden) return;
    const items = P.queueView();
    const upNext = items.length - Math.max(0, P.state.pos) - 1;
    countLabel.textContent = items.length
      ? `${items.length} track${items.length === 1 ? '' : 's'} · ${Math.max(0, upNext)} up next`
      : '';

    if (!items.length) {
      list.replaceChildren(el('p', { class: 'modal-hint' }, 'The queue is empty.'));
      return;
    }

    list.replaceChildren(...items.map(({ track, orderPos, current }) => {
      const row = el('div', {
        class: `queue-row${current ? ' playing' : ''}`,
        dataset: { trackId: track.id },
      });

      row.append(el('button', {
        class: 'queue-main', type: 'button',
        onclick: () => P.playAt(orderPos),
      },
        V.smartArt(track, track.id || track.title, 'queue-art'),
        el('span', { class: 'queue-meta' },
          el('span', { class: 'queue-title' }, track.title),
          el('span', { class: 'queue-sub' }, track.artist || 'Unknown artist'),
        ),
        current ? el('span', { class: 'queue-now' }, '▶') : null,
      ));

      // Up/down rather than drag: it works the same with a thumb on a phone
      // as with a mouse, and it cannot drop a track somewhere unintended.
      const move = (to) => { P.moveInQueue(orderPos, to); paint(); };
      row.append(el('div', { class: 'queue-tools' },
        el('button', {
          class: 'icon-btn', type: 'button', 'aria-label': `Move ${track.title} up`,
          disabled: orderPos === 0, onclick: () => move(orderPos - 1),
        }, svg('M12 6.6 18.4 13l-1.4 1.4L12 9.4 7 14.4 5.6 13z', 18)),
        el('button', {
          class: 'icon-btn', type: 'button', 'aria-label': `Move ${track.title} down`,
          disabled: orderPos === items.length - 1, onclick: () => move(orderPos + 1),
        }, svg('M5.6 11 7 9.6l5 5 5-5 1.4 1.4-6.4 6.4z', 18)),
        el('button', {
          class: 'icon-btn', type: 'button', 'aria-label': `Remove ${track.title} from queue`,
          disabled: current,
          onclick: () => { P.removeFromQueue(orderPos); paint(); },
        }, svg(ICONS.x, 16)),
      ));

      return row;
    }));
  }

  $('#np-queue').addEventListener('click', () => (drawer.hidden ? open() : close()));
  $('#queue-close').addEventListener('click', close);
  scrim.addEventListener('click', close);
  $('#queue-clear').addEventListener('click', () => { P.clearQueue(); paint(); });

  P.player.addEventListener('queue', paint);
  P.player.addEventListener('track', paint);
}

/* ── Connection pill ───────────────────────────────────────────────── */

function wireHealth() {
  const pill = $('#net-chip');
  const paint = () => {
    const label = {
      ok: 'Online', slow: 'Slow', blocked: 'No Archive', offline: 'Offline', probing: 'Checking',
    }[health.state] || 'Unknown';
    $('#net-label').textContent = label;
    pill.dataset.state = health.state;
    pill.title = health.latency ? `${label} · ${health.latency} ms` : label;
  };

  bus.addEventListener('health', paint);
  paint();

  pill.addEventListener('click', () => navigate('#/settings'));
  $('#settings-shortcut').addEventListener('click', () => navigate('#/settings'));

  A.ping().then(
    (ms) => diag.log('ok', `archive.org reachable in ${ms} ms`),
    (err) => diag.log('warn', `archive.org unreachable at startup: ${err.message}`),
  );
}

/* ── Keyboard ──────────────────────────────────────────────────────── */

function wireKeys() {
  addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (typing) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    switch (e.key) {
      case ' ': e.preventDefault(); P.toggle(); break;
      case 'Escape': if (npOpen) closeNowPlaying(); break;
      case 'ArrowRight': if (e.shiftKey) P.next(false); else P.seek(P.state.time + 10); break;
      case 'ArrowLeft': if (e.shiftKey) P.prev(); else P.seek(P.state.time - 10); break;
      case 'ArrowUp': e.preventDefault(); P.setVolume(P.state.volume + 0.05); break;
      case 'ArrowDown': e.preventDefault(); P.setVolume(P.state.volume - 0.05); break;
      case 'm': P.setMuted(!P.state.muted); break;
      case 's': P.toggleShuffle(); break;
      case 'r': P.cycleRepeat(); break;
      case '/': e.preventDefault(); navigate('#/search'); setTimeout(V.focusSearch, 60); break;
      default: break;
    }
  });
}

/* ── Service worker ────────────────────────────────────────────────── */

function wireServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;

  const register = () => {
    navigator.serviceWorker.register('sw.js').then(
      (reg) => {
        diag.log('ok', 'offline support active');
        // Some environments (locked-down browsers, automation) resolve the
        // registration as undefined rather than rejecting.
        reg?.addEventListener?.('updatefound', () => {
          const sw = reg.installing;
          sw?.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              toast('Update ready — reopen the app to apply', '', 6000);
            }
          });
        });
      },
      (err) => diag.log('warn', `offline support unavailable: ${err.message}`),
    );
  };

  // boot() is async, so `load` has usually already fired by the time we get
  // here — waiting for it again would mean never registering at all.
  if (document.readyState === 'complete') register();
  else addEventListener('load', register, { once: true });
}

/* ── Install prompt ────────────────────────────────────────────────── */

function wireInstall() {
  if (isNativeApp) return;
  let deferred = null;

  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    // Offer it once, unobtrusively, rather than taking up permanent chrome.
    setTimeout(() => {
      if (!deferred) return;
      const t = toast('Add Void to your home screen', '', 9000);
      t?.addEventListener('click', async () => {
        deferred.prompt();
        await deferred.userChoice;
        deferred = null;
      });
    }, 4000);
  });

  addEventListener('appinstalled', () => {
    deferred = null;
    toast('Void Music installed', 'ok');
  });
}

/* ── Boot ──────────────────────────────────────────────────────────── */

async function boot() {
  await loadSettings();

  A.config.mirrors = String(getSetting('mirrors') || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  A.config.preferLowBitrate = Boolean(getSetting('preferLowBitrate'));

  applyTheme();
  P.hydrate();
  await V.refreshMarks();

  initNative();
  wireTransport();
  wireLyrics();
  wireSleep();
  wireQueue();
  wireHealth();
  wireKeys();
  wireInstall();
  wireServiceWorker();
  initScrobbler();

  if (!location.hash) location.hash = '#/home';
  route();

  persist().then((ok) => diag.log(ok ? 'ok' : 'warn',
    ok ? 'storage marked persistent' : 'storage may be evicted under pressure'));
}

boot().catch((err) => {
  document.body.innerHTML = `<div style="padding:2rem;font:15px system-ui;color:#f1eefb">
    <h1 style="font-size:20px">Void Music failed to start</h1>
    <p style="color:#9d98bd">${err.message}</p></div>`;
});
