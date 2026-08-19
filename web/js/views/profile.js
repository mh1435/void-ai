import { h, spinner, count, richText, clear, emptyState, infinite } from '../dom.js';
import { api } from '../api.js';
import { avatar, grid } from '../components.js';
import { icon } from '../icons.js';
import { toast } from '../toast.js';
import { state } from '../state.js';

export default function profileView({ username: handle }, outlet) {
  const page = h('div.page');
  outlet.append(page);
  page.append(spinner());

  let alive = true;
  let stopWatching = () => {};

  (async () => {
    let data;
    try {
      data = await api.user(handle);
    } catch (err) {
      if (!alive) return;
      page.replaceChildren(emptyState(icon('search').innerHTML, 'Not found', err.message));
      return;
    }
    if (!alive) return;

    const { user, posts } = data;
    const tiles = h('div.grid');
    const sentinel = h('div.sentinel');
    const status = h('div.feed-status');

    page.replaceChildren(
      profileHeader(user),
      user.is_private && !user.followed_by_viewer && user.username !== state.username
        ? emptyState(icon('lock').innerHTML, 'This account is private',
            'Follow this account to see their photos and videos.')
        : h('div', {}, tiles, sentinel, status),
    );

    tiles.append(...posts.map((post) => grid([post]).firstChild));

    // The profile endpoint pages by cursor; the user-feed endpoint pages by
    // max_id. Once we start paging we switch to the latter.
    let maxId = null;
    let loading = false;
    let done = posts.length === 0;

    async function loadMore() {
      if (loading || done || !alive) return;
      loading = true;
      status.replaceChildren(spinner());
      try {
        const next = await api.userFeed(user.id, maxId);
        if (!alive) return;
        status.replaceChildren();
        const fresh = next.posts.filter((p) => !tiles.querySelector(`a[href="/post/${p.id}"]`));
        tiles.append(...fresh.map((post) => grid([post]).firstChild));
        maxId = next.next_max_id;
        done = !maxId;
      } catch (err) {
        if (!alive) return;
        done = true;
        status.replaceChildren(h('p.end-note', {}, err.message));
      } finally {
        loading = false;
      }
    }

    stopWatching = infinite(sentinel, loadMore);
  })();

  return { destroy() { alive = false; stopWatching(); } };
}

function profileHeader(user) {
  const isSelf = user.username === state.username;
  let following = user.followed_by_viewer;
  let requested = user.requested_by_viewer;

  const followBtn = h('button.btn', { type: 'button' });
  const paint = () => {
    followBtn.textContent = requested ? 'Requested' : (following ? 'Following' : 'Follow');
    followBtn.className = `btn ${following || requested ? 'btn-quiet' : 'btn-primary'}`;
  };
  paint();

  followBtn.addEventListener('click', async () => {
    const before = { following, requested };
    following = !following;
    requested = false;
    paint();
    followBtn.disabled = true;
    try {
      const result = await api.follow(user.id, following);
      following = result.following;
      requested = result.requested;
    } catch (err) {
      ({ following, requested } = before);
      toast(err.message);
    } finally {
      followBtn.disabled = false;
      paint();
    }
  });

  return h('header.profile', {},
    h('div.profile-top', {},
      avatar(user, 86, { ring: true }),
      h('div.profile-stats', {},
        stat(user.counts.posts, 'posts'),
        stat(user.counts.followers, 'followers'),
        stat(user.counts.following, 'following'),
      ),
    ),
    h('div.profile-bio', {},
      h('div.profile-name', {}, user.full_name || user.username,
        user.is_verified ? h('span.verified', { html: icon('verified').innerHTML }) : null),
      user.biography ? h('p.bio', {}, richText(user.biography)) : null,
      user.external_url
        ? h('a.link', { href: user.external_url, target: '_blank', rel: 'noopener noreferrer' },
            user.external_url.replace(/^https?:\/\//, ''))
        : null,
    ),
    isSelf ? null : h('div.profile-actions', {}, followBtn),
  );
}

function stat(value, label) {
  return h('div.stat', {}, h('strong', {}, count(value)), h('span', {}, label));
}
