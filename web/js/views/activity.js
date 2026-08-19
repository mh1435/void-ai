import { h, spinner, ago, emptyState } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';

export default function activityView(_params, outlet) {
  const page = h('div.page', {}, spinner());
  outlet.append(page);
  let alive = true;

  (async () => {
    try {
      const { items } = await api.activity();
      if (!alive) return;
      if (!items.length) {
        page.replaceChildren(emptyState(icon('heart').innerHTML, 'No activity yet',
          'Likes, comments and follows show up here.'));
        return;
      }
      page.replaceChildren(
        h('h1.page-title', {}, 'Activity'),
        ...items.map((item) => h('div.activity-row', { class: item.new ? 'fresh' : '' },
          item.avatar ? h('img.activity-avatar', { src: item.avatar, alt: '', loading: 'lazy' }) : null,
          h('div.activity-text', {},
            h('span', {}, item.text),
            h('time', {}, ago(item.timestamp)),
          ),
          item.media ? h('img.activity-thumb', { src: item.media, alt: '', loading: 'lazy' }) : null,
        )),
      );
    } catch (err) {
      if (!alive) return;
      page.replaceChildren(emptyState(icon('heart').innerHTML, 'Cannot load activity', err.message));
    }
  })();

  return { destroy() { alive = false; } };
}
