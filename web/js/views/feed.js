import { h, spinner, emptyState, infinite } from '../dom.js';
import { api } from '../api.js';
import { postCard, avatar } from '../components.js';
import { go } from '../router.js';
import { icon } from '../icons.js';

export default function feedView(_params, outlet) {
  const stories = h('div.stories');
  const list = h('div.feed');
  const sentinel = h('div.sentinel');
  const status = h('div.feed-status');

  outlet.append(h('div.page', {}, stories, list, sentinel, status));

  let maxId = null;
  let loading = false;
  let done = false;
  let alive = true;

  async function loadStories() {
    try {
      const { tray } = await api.stories();
      if (!alive || !tray.length) return;
      stories.append(...tray.map((entry) => h('button.story', {
        type: 'button',
        onClick: () => go(`/story/${entry.id}`),
      },
        h('span.story-ring', { class: entry.seen ? 'seen' : '' },
          avatar({ avatar: entry.avatar, username: entry.username }, 62)),
        h('span.story-name', {}, entry.username),
      )));
    } catch { /* stories are decoration; a failure must not kill the feed */ }
  }

  async function loadMore() {
    if (loading || done || !alive) return;
    loading = true;
    status.replaceChildren(spinner());
    try {
      const page = await api.feed(maxId);
      if (!alive) return;
      status.replaceChildren();
      if (!page.posts.length && !list.children.length) {
        list.append(emptyState(icon('home').innerHTML, 'Your feed is empty',
          'Follow some accounts and their posts will show up here.'));
      }
      list.append(...page.posts.map((post) => postCard(post)));
      maxId = page.next_max_id;
      done = !maxId;
      if (done) status.replaceChildren(h('p.end-note', {}, "You're all caught up"));
    } catch (err) {
      if (!alive) return;
      status.replaceChildren(
        h('div.error-box', {},
          h('p', {}, err.message),
          h('button.btn', { type: 'button', onClick: () => { loading = false; loadMore(); } },
            'Try again'),
        ));
      done = true;   // stop the observer from hammering a failing endpoint
    } finally {
      loading = false;
    }
  }

  const stopWatching = infinite(sentinel, loadMore);
  loadStories();
  loadMore();

  return {
    destroy() {
      alive = false;
      stopWatching();
    },
  };
}
