import { h, spinner, ago } from '../dom.js';
import { api } from '../api.js';
import { avatar } from '../components.js';
import { icon } from '../icons.js';
import { back } from '../router.js';
import { pauseAll } from '../media.js';

const PHOTO_MS = 5000;

export default function storyView({ id }, outlet) {
  const stage = h('div.story-stage', {}, spinner());
  outlet.append(h('div.page page-full', {}, stage));
  document.body.classList.add('immersive');

  let alive = true;
  let timer = null;

  (async () => {
    let reel;
    try {
      reel = await api.story(id);
    } catch (err) {
      if (!alive) return;
      stage.replaceChildren(h('div.error-box', {}, h('p', {}, err.message)));
      return;
    }
    if (!alive || !reel.items.length) {
      stage.replaceChildren(h('p.end-note', {}, 'Nothing to show.'));
      return;
    }

    let index = 0;
    const bars = h('div.story-bars', {},
      ...reel.items.map(() => h('span.story-bar', {}, h('i'))));
    const surface = h('div.story-surface');

    stage.replaceChildren(
      bars,
      h('div.story-head', {},
        avatar({ avatar: reel.avatar, username: reel.username }, 32),
        h('span.story-user', {}, reel.username),
        h('time.story-time', {}),
        h('button.icon-btn', { type: 'button', onClick: () => back('/'), 'aria-label': 'Close' },
          icon('close')),
      ),
      surface,
      h('button.story-nav prev', { type: 'button', 'aria-label': 'Previous',
        onClick: () => show(index - 1) }),
      h('button.story-nav next', { type: 'button', 'aria-label': 'Next',
        onClick: () => show(index + 1) }),
    );

    function show(next) {
      clearTimeout(timer);
      if (next < 0) next = 0;
      if (next >= reel.items.length) { back('/'); return; }
      index = next;
      const item = reel.items[index];

      [...bars.children].forEach((bar, i) => {
        bar.classList.toggle('done', i < index);
        bar.classList.toggle('live', i === index);
      });

      stage.querySelector('.story-time').textContent = ago(item.taken_at);

      surface.replaceChildren(item.is_video
        ? h('video.story-media', {
            src: item.video, poster: item.image, playsinline: true,
            autoplay: true, controls: false,
          })
        : h('img.story-media', { src: item.image, alt: '' }));

      const duration = item.is_video ? Math.max(2, item.duration) * 1000 : PHOTO_MS;
      const live = bars.children[index].firstChild;
      live.style.transition = 'none';
      live.style.width = '0%';
      requestAnimationFrame(() => {
        live.style.transition = `width ${duration}ms linear`;
        live.style.width = '100%';
      });
      timer = setTimeout(() => show(index + 1), duration);
    }

    pauseAll();
    show(0);
  })();

  return {
    destroy() {
      alive = false;
      clearTimeout(timer);
      document.body.classList.remove('immersive');
    },
  };
}
