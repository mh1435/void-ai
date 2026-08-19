import { h, spinner } from '../dom.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { icon } from '../icons.js';
import { toast } from '../toast.js';

export default function settingsView(_params, outlet) {
  const health = h('div.health', {}, spinner('Checking the route to Instagram…'));
  let alive = true;

  outlet.append(h('div.page page-narrow', {},
    h('h1.page-title', {}, 'Settings'),

    h('section.card', {},
      h('h2', {}, 'Account'),
      h('p.muted', {}, state.authenticated
        ? `Signed in as @${state.username}.`
        : 'Not signed in.'),
      state.authenticated
        ? h('button.btn btn-danger', {
            type: 'button',
            onClick: async () => {
              try {
                await api.logout();
                location.href = '/';
              } catch (err) { toast(err.message); }
            },
          }, 'Log out')
        : null,
    ),

    h('section.card', {},
      h('h2', {}, 'Connection'),
      h('p.muted', {},
        'Your device only ever talks to this server. This server talks to ',
        'Instagram. If Instagram is blocked where you are, that block ends ',
        'at your device — it does not affect the hop this server makes.'),
      health,
    ),

    h('section.card', {},
      h('h2', {}, 'If this stops working'),
      h('ul.help-list', {},
        h('li', {}, 'If your server\'s domain gets blocked too, point a custom domain at the same deployment — the app does not care what it is called.'),
        h('li', {}, 'If Instagram rate-limits or challenges the server\'s IP, set UPSTREAM_PROXY on the host and redeploy.'),
        h('li', {}, 'If you get signed out repeatedly, Instagram is challenging the login. Confirm it once from the official app, then sign in here again.'),
      ),
    ),
  ));

  (async () => {
    try {
      const result = await api.health();
      if (!alive) return;
      health.replaceChildren(
        h('div.health-row', { class: result.instagram_reachable ? 'good' : 'bad' },
          h('span.health-dot'),
          h('div', {},
            h('strong', {}, result.instagram_reachable
              ? 'Server can reach Instagram'
              : 'Server cannot reach Instagram'),
            h('div.muted', {}, result.detail || ''),
          ),
        ),
        h('div.health-row', { class: result.upstream_proxy ? 'good' : 'neutral' },
          h('span.health-dot'),
          h('div', {},
            h('strong', {}, result.upstream_proxy
              ? 'Going through an upstream proxy'
              : 'Connecting directly'),
          ),
        ),
      );
    } catch (err) {
      if (!alive) return;
      health.replaceChildren(h('div.error-box', {}, h('p', {}, err.message)));
    }
  })();

  return { destroy() { alive = false; } };
}
