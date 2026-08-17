/* Bootstrap: routing, play-bar wiring, keyboard shortcuts, install prompt. */

import * as P from './player.js';
import * as V from './views.js';
import * as A from './archive.js';
import { likes, loadSettings, getSetting, setSetting, persist } from './store.js';
import { health, bus, diag } from './net.js';
import { $, el, fmtTime, toast, artNode, svg, ICONS } from './ui.js';
import './demo.js'; // registers the generated-audio provider

/* ── Routing ───────────────────────────────────────────────────────── */

const ROUTES = [
  [/^#\/home$/,                 () => V.renderHome()],
  [/^#\/search$/,               () => V.renderSearch('')],
  [/^#\/search\/(.+)$/,         (m) => V.renderSearch(decodeURIComponent(m[1]))],
  [/^#\/collection\/(.+)$/,     (m) => V.renderCollection(decodeURIComponent(m[1]))],
  [/^#\/item\/(.+)$/,           (m) => V.renderItem(decodeURIComponent(m[1]))],
  [/^#\/library$/,              () => V.renderLibrary()],
  [/^#\/liked$/,                () => V.renderLiked()],
  [/^#\/offline$/,              () => V.renderOffline()],
  [/^#\/imported$/,             () => V.renderImported()],
  [/^#\/playlist\/(.+)$/,       (m) => V.renderPlaylist(decodeURIComponent(m[1]))],
  [/^#\/settings$/,             () => V.renderSettings()],
];

/** Which nav item lights up for a given route. */
function navKeyFor(hash) {
  if (hash.startsWith('#/search')) return 'search';
  if (hash.startsWith('#/settings')) return 'settings';
  if (/^#\/(library|liked|offline|imported|playlist)/.test(hash)) return 'library';
  if (/^#\/(collection|item)/.test(hash)) return '';
  return 'home';
}

let navDepth = 0;

export function navigate(hash) {
  if (location.hash === hash) {
    route();
    return;
  }
  navDepth++;
  location.hash = hash;
}

V.setNavigator(navigate);

function route() {
  const hash = location.hash || '#/home';
  const key = navKeyFor(hash);

  document.querySelectorAll('[data-nav]').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === key);
  });

  // Keep the search box in step with the URL.
  const input = $('#search-input');
  const m = hash.match(/^#\/search\/(.+)$/);
  if (m) {
    const q = decodeURIComponent(m[1]);
    if (input.value !== q) input.value = q;
  } else if (hash === '#/search') {
    input.value = '';
  }
  $('#search-clear').hidden = !input.value;
  $('#back-btn').disabled = navDepth === 0;

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

/* ── Search box ────────────────────────────────────────────────────── */

let searchTimer = null;

function wireSearch() {
  const form = $('#search-form');
  const input = $('#search-input');
  const clear = $('#search-clear');

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearTimeout(searchTimer);
    const q = input.value.trim();
    navigate(q ? `#/search/${encodeURIComponent(q)}` : '#/search');
    input.blur();
  });

  input.addEventListener('input', () => {
    clear.hidden = !input.value;
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (!q) return;
    // Debounce so a fast typist doesn't fire a request per keystroke.
    searchTimer = setTimeout(() => {
      navigate(`#/search/${encodeURIComponent(q)}`);
    }, 450);
  });

  clear.addEventListener('click', () => {
    input.value = '';
    clear.hidden = true;
    input.focus();
    navigate('#/search');
  });
}

/* ── Play bar ──────────────────────────────────────────────────────── */

let seeking = false;

function wirePlaybar() {
  const bar = $('#playbar');
  const seek = $('#seek');
  const vol = $('#vol');

  $('#btn-play').addEventListener('click', () => P.toggle());
  $('#btn-next').addEventListener('click', () => P.next(false));
  $('#btn-prev').addEventListener('click', () => P.prev());

  $('#btn-shuffle').addEventListener('click', (e) => {
    const on = P.toggleShuffle();
    e.currentTarget.setAttribute('aria-pressed', String(on));
    toast(on ? 'Shuffle on' : 'Shuffle off');
  });

  $('#btn-repeat').addEventListener('click', (e) => {
    const mode = P.cycleRepeat();
    e.currentTarget.dataset.mode = mode;
    e.currentTarget.setAttribute('aria-label',
      mode === 'off' ? 'Repeat off' : mode === 'all' ? 'Repeat all' : 'Repeat one');
    toast(mode === 'off' ? 'Repeat off' : mode === 'all' ? 'Repeat all' : 'Repeat one');
  });

  seek.addEventListener('input', () => {
    seeking = true;
    const dur = P.state.duration || 0;
    $('#t-cur').textContent = fmtTime((seek.value / 1000) * dur);
    seek.style.setProperty('--fill', `${seek.value / 10}%`);
  });
  seek.addEventListener('change', () => {
    P.seekFraction(seek.value / 1000);
    seeking = false;
  });

  vol.value = 100;
  vol.style.setProperty('--fill', '100%');
  vol.addEventListener('input', () => {
    P.setVolume(vol.value / 100);
    vol.style.setProperty('--fill', `${vol.value}%`);
  });

  $('#btn-mute').addEventListener('click', () => {
    P.setMuted(!P.state.muted);
  });

  $('#pb-like').addEventListener('click', async (e) => {
    if (!P.state.track) return;
    const on = await likes.toggle(P.state.track);
    e.currentTarget.setAttribute('aria-pressed', String(on));
    await V.refreshMarks();
    toast(on ? 'Saved to Liked' : 'Removed from Liked', on ? 'ok' : '');
  });

  P.player.addEventListener('track', async (e) => {
    const t = e.detail.track;
    bar.dataset.empty = 'false';
    $('#pb-title').textContent = t.title;
    $('#pb-artist').textContent = t.artist;
    $('#t-dur').textContent = fmtTime(t.duration);

    const art = artNode(t.cover, '♪', 'pb-art');
    art.id = 'pb-art';
    $('#pb-art').replaceWith(art);

    $('#pb-like').setAttribute('aria-pressed', String(await likes.has(t.id)));
    document.title = `${t.title} — ${t.artist} · Void Music`;
  });

  P.player.addEventListener('status', (e) => {
    const s = e.detail;
    bar.dataset.state = s.loading ? 'loading' : s.playing ? 'playing' : 'paused';
    $('#btn-play').setAttribute('aria-label', s.playing ? 'Pause' : 'Play');
    $('#btn-shuffle').setAttribute('aria-pressed', String(s.shuffle));
    $('#btn-repeat').dataset.mode = s.repeat;

    vol.value = Math.round((s.muted ? 0 : s.volume) * 100);
    vol.style.setProperty('--fill', `${vol.value}%`);
    $('#vol-waves').style.opacity = s.muted || s.volume === 0 ? '0.25' : '1';
  });

  P.player.addEventListener('time', (e) => {
    const { time, duration } = e.detail;
    $('#t-cur').textContent = fmtTime(time);
    $('#t-dur').textContent = fmtTime(duration);
    if (!seeking && duration) {
      const pct = (time / duration) * 1000;
      seek.value = String(pct);
      seek.style.setProperty('--fill', `${pct / 10}%`);
    }
  });

  P.player.addEventListener('error', (e) => {
    toast(`Skipping “${e.detail.track.title}” — ${e.detail.error?.message || 'could not play'}`, 'err', 4500);
  });

  P.player.addEventListener('blocked', () => {
    toast('Tap play to start — your browser blocks autoplay until you interact', 'warn', 5000);
  });

  P.player.addEventListener('ended', () => {
    document.title = 'Void Music';
  });
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
    list.replaceChildren(...items.map(({ track, orderPos, current }) => {
      const row = el('div', {
        class: `track${current ? ' playing' : ''}`,
        dataset: { trackId: track.id },
        tabindex: '0', role: 'button',
        onclick: () => { P.state.pos = orderPos; P.playTrack(track); },
      },
        el('div', { class: 'track-idx' }, current ? '▶' : String(orderPos + 1)),
        el('div', { class: 'track-main' },
          el('div', { class: 'track-title' }, track.title),
          el('div', { class: 'track-sub' }, track.artist),
        ),
        el('div', { class: 'track-actions' },
          el('button', {
            class: 'icon-btn keep-mobile', type: 'button', 'aria-label': 'Remove from queue',
            onclick: (e) => { e.stopPropagation(); P.removeFromQueue(orderPos); },
          }, svg(ICONS.x, 18)),
        ),
      );
      return row;
    }));
  }

  $('#btn-queue').addEventListener('click', () => (drawer.hidden ? open() : close()));
  $('#queue-close').addEventListener('click', close);
  $('#scrim').addEventListener('click', close);
  $('#queue-clear').addEventListener('click', () => { P.clearQueue(); paint(); });

  P.player.addEventListener('queue', paint);
  P.player.addEventListener('track', paint);
}

/* ── Connection chip ───────────────────────────────────────────────── */

function wireHealth() {
  const paint = () => {
    const label = {
      ok: 'Connected',
      slow: 'Slow connection',
      blocked: 'Archive unreachable',
      offline: 'Offline',
      probing: 'Checking…',
    }[health.state] || 'Unknown';
    $('#net-label').textContent = label;
    $('#net-dot').dataset.state = health.state;
    $('#net-dot-mini').dataset.state = health.state;
    $('#net-chip').title = health.latency ? `${label} · ${health.latency} ms` : label;
  };

  bus.addEventListener('health', paint);
  paint();

  $('#net-chip').addEventListener('click', () => navigate('#/settings'));
  $('#mini-net').addEventListener('click', () => navigate('#/settings'));

  // One quiet probe at startup so the chip means something before you search.
  A.ping().then(
    (ms) => diag.log('ok', `archive.org reachable in ${ms} ms`),
    (err) => diag.log('warn', `archive.org unreachable at startup: ${err.message}`),
  );
}

/* ── Keyboard shortcuts ────────────────────────────────────────────── */

function wireKeys() {
  addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (typing) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    switch (e.key) {
      case ' ':      e.preventDefault(); P.toggle(); break;
      case 'ArrowRight': if (e.shiftKey) { P.next(false); } else { P.seek(P.state.time + 10); } break;
      case 'ArrowLeft':  if (e.shiftKey) { P.prev(); } else { P.seek(P.state.time - 10); } break;
      case 'ArrowUp':    e.preventDefault(); P.setVolume(P.state.volume + 0.05); break;
      case 'ArrowDown':  e.preventDefault(); P.setVolume(P.state.volume - 0.05); break;
      case 'm': P.setMuted(!P.state.muted); break;
      case 's': P.toggleShuffle(); break;
      case 'r': P.cycleRepeat(); break;
      case '/': e.preventDefault(); $('#search-input').focus(); break;
      default: break;
    }
  });
}

/* ── Install prompt ────────────────────────────────────────────────── */

function wireInstall() {
  let deferred = null;
  const btn = $('#install-btn');

  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    btn.hidden = false;
  });

  btn.addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    const { outcome } = await deferred.userChoice;
    deferred = null;
    btn.hidden = true;
    if (outcome === 'accepted') toast('Installed — look for Void on your home screen', 'ok');
  });

  addEventListener('appinstalled', () => {
    btn.hidden = true;
    toast('Void Music installed', 'ok');
  });
}

/* ── Service worker ────────────────────────────────────────────────── */

function wireServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // file:// has no service-worker support; skip rather than throwing.
  if (location.protocol === 'file:') return;

  const register = () => {
    navigator.serviceWorker.register('sw.js').then(
      (reg) => {
        diag.log('ok', 'offline support active');
        reg.addEventListener('updatefound', () => {
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

/* ── Boot ──────────────────────────────────────────────────────────── */

async function boot() {
  await loadSettings();

  A.config.mirrors = String(getSetting('mirrors') || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  A.config.preferLowBitrate = Boolean(getSetting('preferLowBitrate'));

  P.hydrate();
  await V.refreshMarks();

  wireSearch();
  wirePlaybar();
  wireQueue();
  wireHealth();
  wireKeys();
  wireInstall();
  wireServiceWorker();

  $('#back-btn').addEventListener('click', () => {
    if (navDepth > 0) { navDepth--; history.back(); }
  });

  if (!location.hash) location.hash = '#/home';
  route();

  // Best-effort: ask the browser to keep our offline audio around.
  persist().then((ok) => diag.log(ok ? 'ok' : 'warn',
    ok ? 'storage marked persistent' : 'storage may be evicted under pressure'));
}

boot().catch((err) => {
  document.body.innerHTML = `<div style="padding:2rem;font:15px system-ui;color:#eceafa">
    <h1 style="font-size:20px">Void Music failed to start</h1>
    <p style="color:#9c98be">${err.message}</p></div>`;
});
