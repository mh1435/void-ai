import { h, spinner, count, emptyState } from '../dom.js';
import { api } from '../api.js';
import { grid } from '../components.js';
import { icon } from '../icons.js';

export default function tagView({ name }, outlet) {
  const page = h('div.page', {}, spinner());
  outlet.append(page);
  let alive = true;

  (async () => {
    try {
      const data = await api.tag(name);
      if (!alive) return;
      page.replaceChildren(
        h('header.tag-head', {},
          h('div.hash-icon big', {}, '#'),
          h('div', {},
            h('h1', {}, `#${data.name}`),
            h('p.muted', {}, `${count(data.count)} posts`),
          ),
        ),
        data.posts.length
          ? grid(data.posts)
          : emptyState(icon('grid').innerHTML, 'No posts', 'Nothing to show for this hashtag.'),
      );
    } catch (err) {
      if (!alive) return;
      page.replaceChildren(emptyState(icon('search').innerHTML, 'Cannot load', err.message));
    }
  })();

  return { destroy() { alive = false; } };
}
