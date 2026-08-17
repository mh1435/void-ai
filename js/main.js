/* Bootstrap: routing, transport wiring, now playing, keyboard shortcuts. */

import * as P from './player.js';
import * as V from './views.js';
import * as A from './archive.js';
import { likes, loadSettings, getSetting, setSetting, persist } from './store.js';
import { health, bus, diag } from './net.js';
import { $, el, fmtTime, toast, artNode, tintFor } from './ui.js';
import { initNative, isNativeApp } from './native.js';
import './demo.js'; // registers the generated-audio provider

/* ── Routing ───────────────────────────────────────────────────────── */

const ROUTES = [
  [/^#\/home$/,             () => V.renderHome()],
  [/^#\/search$/,           () => V.renderSearch('')],
  [/^#\/search\/(.+)$/,     (m) => V.renderSearch(decodeURIComponent(m[1]))],
  [/^#\/collection\/(.+)$/, (m) => V.renderCollection(decodeURIComponent(m[1]))],
  [/^#\/item\/(.+)$/,       (m) => V.renderItem(decodeURIComponent(m[1]))],
  [/^#\/library$/,          () => V.renderLibrary()],
  [/^#\/offline$/,          () => V.renderOffline()],
  [/^#\/playlist\/(.+)$/,   (m) => V.renderPlaylist(decodeURIComponent(m[1]))],
  [/^#\/settings$/,         () => V.renderSettings()],
];

function navKeyFor(hash) {
  if (hash.startsWith('#/search')) return 'search';
  if (hash.startsWith('#/settings')) return 'settings';
  if (hash.startsWith('#/offline')) return 'offline';
  if (/^#\/(library|playlist)/.test(hash)) return 'library';
  if (/^#\/(collection|item)/.test(hash)) return '';
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

  $('#back-btn').hidden = TOP_LEVEL.test(hash);
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
    swapArt('#np-art', t, 'np-art');

    // Tint the backdrop from the track identity so each song feels distinct
    // even when the item has no cover art to sample.
    $('#np-glow').style.setProperty('--np-tint', tintFor(t.itemId || t.title).solid);

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
  if (!old) return;
  const next = artNode(track.cover, '♪', className);
  next.id = old.id;
  const { c1, c2 } = tintFor(track.itemId || track.title);
  next.style.background = `linear-gradient(140deg, ${c1}, ${c2})`;
  old.replaceWith(next);
}

/* ── Queue drawer ──────────────────────────────────────────────────── */

function wireQueue() {
  const drawer = $('#queue-drawer');
  const scrim = $('#scrim');
  const list = $('#queue-list');

  const close = () => { drawer.hidden = true; scrim.hidden = true; };
  const open = () => { drawer.hidden = false; scrim.hidden = false; paint(); };

  function paint() {
    if (drawer.hidden) return;
    const items = P.queueView();
    if (!items.length) {
      list.replaceChildren(el('p', { class: 'modal-hint' }, 'The queue is empty.'));
      return;
    }
    list.replaceChildren(...items.map(({ track, orderPos, current }) => el('div', {
      class: `track${current ? ' playing' : ''}`,
      dataset: { trackId: track.id },
      tabindex: '0', role: 'button',
      onclick: () => { P.state.pos = orderPos; P.playTrack(track); },
    },
      el('div', { class: 'track-art' }, el('i', { class: 'art-glyph' }, current ? '▶' : '♪')),
      el('div', { class: 'track-main' },
        el('div', { class: 'track-title' }, track.title),
        el('div', { class: 'track-sub' }, track.artist || ''),
      ),
    )));
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

  P.hydrate();
  await V.refreshMarks();

  initNative();
  wireTransport();
  wireQueue();
  wireHealth();
  wireKeys();
  wireInstall();
  wireServiceWorker();

  $('#back-btn').addEventListener('click', () => {
    if (depth > 0) { depth--; history.back(); } else navigate('#/home');
  });

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
