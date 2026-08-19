import { h, spinner, count, emptyState } from '../dom.js';
import { api } from '../api.js';
import { userRow } from '../components.js';
import { icon } from '../icons.js';
import { go } from '../router.js';

const RECENT_KEY = 'loop:recent-searches';

export default function searchView(_params, outlet) {
  const input = h('input.search-input', {
    type: 'search', placeholder: 'Search', autocomplete: 'off',
    autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Search Instagram',
  });
  const results = h('div.results');
  outlet.append(h('div.page', {},
    h('div.search-head', {}, input),
    results,
  ));

  input.focus();

  let controller = null;
  let timer = null;
  let alive = true;

  function showRecents() {
    const recents = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    results.replaceChildren();
    if (!recents.length) {
      results.append(emptyState(icon('search').innerHTML, 'Search Instagram',
        'Find people and hashtags by name.'));
      return;
    }
    results.append(
      h('div.results-head', {},
        h('h2', {}, 'Recent'),
        h('button.link-btn', {
          type: 'button',
          onClick: () => { localStorage.removeItem(RECENT_KEY); showRecents(); },
        }, 'Clear all'),
      ),
      ...recents.map((entry) => h('a.user-row', { href: entry.href, 'data-route': true },
        h('span.recent-icon', { html: icon('search').innerHTML }),
        h('div.user-row-text', {}, h('div.user-row-name', {}, entry.label)),
      )),
    );
  }

  function remember(label, href) {
    const recents = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
      .filter((entry) => entry.href !== href);
    recents.unshift({ label, href });
    localStorage.setItem(RECENT_KEY, JSON.stringify(recents.slice(0, 8)));
  }

  async function run(query) {
    controller?.abort();
    controller = new AbortController();
    results.replaceChildren(spinner());
    try {
      const { users, hashtags } = await api.search(query, controller.signal);
      if (!alive) return;
      results.replaceChildren();
      if (!users.length && !hashtags.length) {
        results.append(emptyState(icon('search').innerHTML, 'No results', `Nothing matched “${query}”.`));
        return;
      }
      results.append(
        ...users.map((user) => {
          const row = userRow(user, {
            trailing: user.is_private ? h('span.pill', {}, 'Private') : null,
          });
          row.addEventListener('click', () => remember(user.username, `/u/${user.username}`));
          return row;
        }),
        ...hashtags.map((tag) => h('a.user-row', {
          href: `/tag/${tag.name}`, 'data-route': true,
          onClick: () => remember(`#${tag.name}`, `/tag/${tag.name}`),
        },
          h('span.hash-icon', {}, '#'),
          h('div.user-row-text', {},
            h('div.user-row-name', {}, `#${tag.name}`),
            h('div.user-row-sub', {}, `${count(tag.count)} posts`),
          ),
        )),
      );
    } catch (err) {
      if (err.name === 'AbortError' || !alive) return;
      results.replaceChildren(h('div.error-box', {}, h('p', {}, err.message)));
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const query = input.value.trim();
    if (!query) { controller?.abort(); showRecents(); return; }
    // Typing is fast and Instagram's search endpoint is rate-limited; wait.
    timer = setTimeout(() => run(query), 320);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const query = input.value.trim();
    if (query.startsWith('#')) go(`/tag/${query.slice(1)}`);
    else if (query.startsWith('@')) go(`/u/${query.slice(1)}`);
  });

  showRecents();

  return { destroy() { alive = false; controller?.abort(); clearTimeout(timer); } };
}
