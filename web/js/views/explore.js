import { h, spinner, infinite } from '../dom.js';
import { api } from '../api.js';
import { grid } from '../components.js';
import { go } from '../router.js';

export default function exploreView(_params, outlet) {
  const searchBar = h('button.search-trigger', {
    type: 'button', onClick: () => go('/search'),
  }, 'Search');
  const tiles = h('div.grid');
  const sentinel = h('div.sentinel');
  const status = h('div.feed-status', {}, spinner());

  outlet.append(h('div.page', {}, h('div.explore-head', {}, searchBar), tiles, sentinel, status));

  let maxId = null;
  let loading = false;
  let done = false;
  let alive = true;

  async function loadMore() {
    if (loading || done || !alive) return;
    loading = true;
    try {
      const page = await api.explore(maxId);
      if (!alive) return;
      status.replaceChildren();
      for (const post of page.posts) tiles.append(grid([post]).firstChild);
      maxId = page.next_max_id;
      done = !maxId;
    } catch (err) {
      if (!alive) return;
      done = true;
      status.replaceChildren(h('div.error-box', {}, h('p', {}, err.message)));
    } finally {
      loading = false;
    }
  }

  const stopWatching = infinite(sentinel, loadMore);
  loadMore();

  return { destroy() { alive = false; stopWatching(); } };
}
