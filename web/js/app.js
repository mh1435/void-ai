import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { api, onAuthError } from './api.js';
import { state, setSession } from './state.js';
import { defineRoute, mount, render, go, back } from './router.js';
import { toast } from './toast.js';

const outlet = document.getElementById('outlet');

// --------------------------------------------------------------------------
// routes — every view is loaded on demand so the first paint is small
// --------------------------------------------------------------------------

defineRoute('/', () => import('./views/feed.js'));
defineRoute('/explore', () => import('./views/explore.js'));
defineRoute('/reels', () => import('./views/reels.js'));
defineRoute('/search', () => import('./views/search.js'));
defineRoute('/activity', () => import('./views/activity.js'));
defineRoute('/settings', () => import('./views/settings.js'));
defineRoute('/u/:username', () => import('./views/profile.js'));
defineRoute('/post/:id', () => import('./views/post.js'));
defineRoute('/story/:id', () => import('./views/story.js'));
defineRoute('/tag/:name', () => import('./views/tag.js'));

// --------------------------------------------------------------------------
// chrome
// --------------------------------------------------------------------------

const TABS = [
  { path: '/', key: 'home', icon: 'home', active: 'homeFilled', label: 'Home' },
  { path: '/explore', key: 'explore', icon: 'search', active: 'searchFilled', label: 'Explore' },
  { path: '/reels', key: 'reels', icon: 'reels', active: 'reelsFilled', label: 'Reels' },
  { path: '/activity', key: 'activity', icon: 'heart', active: 'heartFilled', label: 'Activity' },
];

// Routes that get a back button and a title instead of the wordmark.
const DETAIL_TITLES = {
  '/post/': 'Post',
  '/u/': '',
  '/tag/': '',
  '/search': 'Search',
  '/settings': 'Settings',
  '/activity': 'Activity',
  '/explore': 'Explore',
};

function buildChrome() {
  const title = h('div.topbar-title');
  const leading = h('div.topbar-leading');
  const trailing = h('div.topbar-trailing');
  const topbar = h('header.topbar', {}, leading, title, trailing);

  const nav = h('nav.tabbar', {},
    ...TABS.map((tab) => h('button.tab', {
      type: 'button',
      'data-tab': tab.key,
      'aria-label': tab.label,
      onClick: () => go(tab.path),
    }, icon(tab.icon))),
    h('button.tab', {
      type: 'button', 'data-tab': 'me', 'aria-label': 'Profile',
      onClick: () => go(`/u/${state.username}`),
    }, h('span.tab-avatar')),
  );

  document.body.prepend(topbar);
  document.body.append(nav);

  function paint(path) {
    const isRoot = path === '/';
    const isDetail = !isRoot && !['/explore', '/reels', '/activity'].includes(path);

    topbar.classList.toggle('hidden', path.startsWith('/reels') || path.startsWith('/story/'));
    nav.classList.toggle('hidden', path.startsWith('/story/'));

    clear(leading);
    clear(title);
    clear(trailing);

    if (isRoot) {
      title.append(h('span.wordmark', {}, 'Loop'));
      title.classList.add('lead');
      trailing.append(h('button.icon-btn', {
        type: 'button', 'aria-label': 'Settings', onClick: () => go('/settings'),
      }, icon('settings')));
    } else {
      title.classList.remove('lead');
      if (isDetail) {
        leading.append(h('button.icon-btn', {
          type: 'button', 'aria-label': 'Back', onClick: () => back('/'),
        }, icon('back')));
      }
      const label = path.startsWith('/u/') ? `@${decodeURIComponent(path.slice(3))}`
        : path.startsWith('/tag/') ? `#${decodeURIComponent(path.slice(5))}`
        : Object.entries(DETAIL_TITLES).find(([prefix]) => path.startsWith(prefix))?.[1] || '';
      title.append(label);
    }

    for (const button of nav.querySelectorAll('.tab')) {
      const tab = TABS.find((t) => t.key === button.dataset.tab);
      const on = tab
        ? (tab.path === '/' ? isRoot : path.startsWith(tab.path))
        : path === `/u/${state.username}`;
      button.classList.toggle('on', on);
      if (tab) clear(button).append(icon(on ? tab.active : tab.icon));
    }
  }

  document.addEventListener('loop:navigate', (event) => paint(event.detail.path));
  paint(location.pathname);
}

// --------------------------------------------------------------------------
// boot
// --------------------------------------------------------------------------

async function boot() {
  let session;
  try {
    session = await api.session();
  } catch (err) {
    document.body.classList.remove('booting');
    outlet.append(h('div.auth', {}, h('div.auth-card', {},
      h('h1.wordmark', {}, 'Loop'),
      h('p.auth-error', {}, err.message),
      h('button.btn btn-primary btn-block', {
        type: 'button', onClick: () => location.reload(),
      }, 'Retry'),
    )));
    return;
  }

  setSession(session);
  document.body.classList.remove('booting');

  if (!state.authenticated || (state.gateRequired && !state.gateOpen)) {
    const { default: loginView } = await import('./views/login.js');
    loginView({}, outlet);
    return;
  }

  // Install this before the first render: a session can already be expired,
  // and then the very first request is the one that needs handling.
  onAuthError(() => {
    toast('Instagram signed this session out.');
    setTimeout(() => { location.href = '/'; }, 1200);
  });

  buildChrome();
  mount(outlet);
  await render(location.pathname);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* offline shell is optional */ });
  }
}

boot();
