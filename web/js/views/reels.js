import { h, spinner, count, richText, clear, infinite } from '../dom.js';
import { api } from '../api.js';
import { avatar, username } from '../components.js';
import { registerVideo, releaseVideo, isMuted, toggleMuted } from '../media.js';
import { icon } from '../icons.js';
import { toast } from '../toast.js';
import { go } from '../router.js';

export default function reelsView(_params, outlet) {
  const rail = h('div.reels');
  const sentinel = h('div.sentinel reels-sentinel');
  const status = h('div.reels-status', {}, spinner());
  outlet.append(h('div.page page-full', {}, rail, sentinel, status));
  document.body.classList.add('immersive');

  let maxId = null;
  let loading = false;
  let done = false;
  let alive = true;
  const mounted = [];

  async function loadMore() {
    if (loading || done || !alive) return;
    loading = true;
    try {
      const page = await api.reels(maxId);
      if (!alive) return;
      status.replaceChildren();
      for (const post of page.posts) {
        const card = reelCard(post);
        mounted.push(card);
        rail.append(card.el);
      }
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

  return {
    destroy() {
      alive = false;
      stopWatching();
      mounted.forEach((card) => card.destroy());
      document.body.classList.remove('immersive');
    },
  };
}

function reelCard(post) {
  const video = h('video.reel-video', {
    src: post.video,
    poster: post.thumb,
    playsinline: true,
    loop: true,
    muted: true,
    preload: 'none',
  });
  registerVideo(video);

  let liked = post.liked;
  let likes = post.like_count;
  const likeBtn = h('button.reel-action', { type: 'button', 'aria-label': 'Like' });
  const likeCount = h('span.reel-count', {}, count(likes));

  const paint = () => {
    clear(likeBtn).append(icon(liked ? 'heartFilled' : 'heart', liked ? 'liked' : ''), likeCount);
    likeCount.textContent = count(likes);
  };
  paint();

  likeBtn.addEventListener('click', async () => {
    const before = { liked, likes };
    liked = !liked;
    likes = Math.max(0, likes + (liked ? 1 : -1));
    paint();
    try {
      await api.like(post.id, liked);
    } catch (err) {
      ({ liked, likes } = before);
      paint();
      toast(err.message);
    }
  });

  const soundBtn = h('button.reel-action', { type: 'button', 'aria-label': 'Sound' });
  const paintSound = () => clear(soundBtn).append(icon(isMuted() ? 'mute' : 'unmute'));
  paintSound();
  document.addEventListener('loop:mute', paintSound);
  soundBtn.addEventListener('click', () => toggleMuted());

  // Tapping the video itself is the fastest way to unmute, so do that too.
  video.addEventListener('click', () => { if (isMuted()) toggleMuted(); else video.paused ? video.play() : video.pause(); });

  const el = h('section.reel', {},
    video,
    h('div.reel-shade'),
    h('div.reel-side', {},
      likeBtn,
      h('button.reel-action', {
        type: 'button', 'aria-label': 'Comments',
        onClick: () => go(`/post/${post.id}`),
      }, icon('comment'), h('span.reel-count', {}, count(post.comment_count))),
      soundBtn,
    ),
    h('div.reel-info', {},
      h('div.reel-user', {},
        avatar(post.user, 32),
        username(post.user),
      ),
      post.caption ? h('p.reel-caption', {}, richText(post.caption)) : null,
      post.audio ? h('p.reel-audio', {},
        `♪ ${post.audio.title}${post.audio.artist ? ` · ${post.audio.artist}` : ''}`) : null,
    ),
  );

  return {
    el,
    destroy() {
      document.removeEventListener('loop:mute', paintSound);
      releaseVideo(video);
    },
  };
}
