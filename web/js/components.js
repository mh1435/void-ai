import { h, ago, count, richText, clear } from './dom.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { registerVideo, isMuted, toggleMuted } from './media.js';
import { go } from './router.js';
import { toast } from './toast.js';

const FALLBACK_AVATAR =
  'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#2a2a2a"/><circle cx="32" cy="25" r="11" fill="#555"/><path d="M10 62c0-13 10-21 22-21s22 8 22 21z" fill="#555"/></svg>`);

export function avatar(user, size = 32, { ring = false } = {}) {
  const img = h('img.avatar-img', {
    src: user.avatar || FALLBACK_AVATAR,
    alt: user.username ? `${user.username}'s profile picture` : '',
    loading: 'lazy',
    width: size,
    height: size,
  });
  img.addEventListener('error', () => { img.src = FALLBACK_AVATAR; });
  const wrap = h('span.avatar', { style: { width: `${size}px`, height: `${size}px` } }, img);
  if (ring) wrap.classList.add('avatar-ring');
  return wrap;
}

export function username(user, { size = 'sm' } = {}) {
  return h('span.username-line', {},
    h('a.username', {
      href: `/u/${user.username}`,
      'data-route': true,
      class: size === 'lg' ? 'username-lg' : '',
    }, user.username),
    user.is_verified ? h('span.verified', { html: icon('verified').innerHTML }) : null,
  );
}

export function userRow(user, options) {
  const { trailing = null } = options || {};
  return h('a.user-row', { href: `/u/${user.username}`, 'data-route': true },
    avatar(user, 44),
    h('div.user-row-text', {},
      h('div.user-row-name', {}, username(user)),
      h('div.user-row-sub', {}, user.full_name || ''),
    ),
    trailing,
  );
}

// --------------------------------------------------------------------------
// media
// --------------------------------------------------------------------------

function slideMedia(slide, { cover = false } = {}) {
  if (slide.video) {
    const video = h('video.media-video', {
      src: slide.video,
      poster: slide.image || '',
      playsinline: true,
      loop: true,
      muted: true,
      preload: 'none',
      class: cover ? 'cover' : '',
    });
    registerVideo(video);
    return video;
  }
  const img = h('img.media-image', {
    src: slide.image,
    alt: slide.alt || '',
    loading: 'lazy',
    decoding: 'async',
    class: cover ? 'cover' : '',
  });
  return img;
}

function carousel(post) {
  const track = h('div.carousel-track', {},
    ...post.slides.map((slide) => h('div.carousel-slide', {}, slideMedia(slide))));
  const dots = h('div.carousel-dots', {},
    ...post.slides.map((_, i) => h('span.dot', { class: i === 0 ? 'on' : '' })));
  const counter = h('div.carousel-count', {}, `1/${post.slides.length}`);

  track.addEventListener('scroll', () => {
    const index = Math.round(track.scrollLeft / track.clientWidth);
    [...dots.children].forEach((dot, i) => dot.classList.toggle('on', i === index));
    counter.textContent = `${index + 1}/${post.slides.length}`;
  }, { passive: true });

  return h('div.carousel', {}, track, counter, dots);
}

/** Instagram crops to between 4:5 and 1.91:1; clamp so nothing runs off-screen. */
function ratio(slide) {
  const { width, height } = slide;
  if (!width || !height) return 1;
  return Math.min(1.91, Math.max(0.8, width / height));
}

function mediaFor(post) {
  const first = post.slides[0] || {};
  const style = { '--ar': String(ratio(first)) };
  if (post.slides.length > 1) {
    const el = carousel(post);
    el.style.setProperty('--ar', String(ratio(first)));
    return el;
  }
  const media = slideMedia(first);
  return h('div.media-single', { style },
    media, first.video ? muteButton() : null);
}

function paintMuteButton(button) {
  clear(button).append(icon(isMuted() ? 'mute' : 'unmute'));
}

// One listener for every mute button on the page. Per-button listeners would
// accumulate on `document` for the lifetime of the tab as you scroll a feed.
document.addEventListener('loop:mute', () => {
  document.querySelectorAll('.mute-btn').forEach(paintMuteButton);
});

function muteButton() {
  const button = h('button.mute-btn', { type: 'button', 'aria-label': 'Toggle sound' });
  paintMuteButton(button);
  button.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggleMuted(); });
  return button;
}

// --------------------------------------------------------------------------
// the post card
// --------------------------------------------------------------------------

export function postCard(post, { compactCaption = true } = {}) {
  let liked = post.liked;
  let saved = post.saved;
  let likes = post.like_count;

  const likeBtn = h('button.action', { type: 'button', 'aria-label': 'Like' });
  const saveBtn = h('button.action', { type: 'button', 'aria-label': 'Save' });
  const likeLabel = h('div.likes');

  const paintLike = () => {
    clear(likeBtn).append(icon(liked ? 'heartFilled' : 'heart', liked ? 'liked' : ''));
    likeBtn.classList.toggle('is-liked', liked);
    clear(likeLabel).append(
      likes ? h('strong', {}, `${count(likes)} ${likes === 1 ? 'like' : 'likes'}`)
            : h('span.muted', {}, 'Be the first to like this'));
  };
  const paintSave = () => {
    clear(saveBtn).append(icon(saved ? 'bookmarkFilled' : 'bookmark'));
  };
  paintLike();
  paintSave();

  async function setLike(next) {
    const before = { liked, likes };
    liked = next;
    likes = Math.max(0, likes + (next ? 1 : -1));
    paintLike();
    try {
      await api.like(post.id, next);
    } catch (err) {
      ({ liked, likes } = before);   // Instagram said no; show the truth again
      paintLike();
      toast(err.message);
    }
  }

  likeBtn.addEventListener('click', () => setLike(!liked));
  saveBtn.addEventListener('click', async () => {
    const before = saved;
    saved = !saved;
    paintSave();
    try {
      await api.save(post.id, saved);
    } catch (err) {
      saved = before;
      paintSave();
      toast(err.message);
    }
  });

  const media = mediaFor(post);
  let lastTap = 0;
  media.addEventListener('click', () => {
    const now = Date.now();
    if (now - lastTap < 300) {          // double-tap to like, as expected
      if (!liked) setLike(true);
      const burst = h('div.heart-burst', { html: icon('heartFilled').innerHTML });
      media.append(burst);
      setTimeout(() => burst.remove(), 800);
    }
    lastTap = now;
  });

  const caption = post.caption
    ? h('div.caption', { class: compactCaption ? 'clamp' : '' },
        h('a.username', { href: `/u/${post.user.username}`, 'data-route': true },
          post.user.username),
        ' ',
        richText(post.caption))
    : null;

  if (caption && compactCaption) {
    caption.addEventListener('click', () => caption.classList.remove('clamp'), { once: true });
  }

  return h('article.post', {},
    h('header.post-head', {},
      h('a.post-head-user', { href: `/u/${post.user.username}`, 'data-route': true },
        avatar(post.user, 34, { ring: true }),
        h('div', {},
          h('div.post-head-name', {}, username(post.user)),
          post.location ? h('div.post-head-loc', {}, post.location) : null,
        ),
      ),
      h('button.icon-btn', { type: 'button', 'aria-label': 'More' }, icon('more')),
    ),
    media,
    h('div.actions', {},
      likeBtn,
      h('button.action', {
        type: 'button', 'aria-label': 'Comments',
        onClick: () => go(`/post/${post.id}`),
      }, icon('comment')),
      h('button.action', {
        type: 'button', 'aria-label': 'Share',
        onClick: () => sharePost(post),
      }, icon('share')),
      h('div.spacer'),
      saveBtn,
    ),
    h('div.post-meta', {},
      likeLabel,
      caption,
      post.comment_count
        ? h('button.link-btn', { type: 'button', onClick: () => go(`/post/${post.id}`) },
            `View all ${count(post.comment_count)} comments`)
        : null,
      h('time.timestamp', {}, ago(post.taken_at)),
    ),
  );
}

async function sharePost(post) {
  // Share the *Instagram* link — the recipient may not be behind the block.
  const url = post.shortcode ? `https://www.instagram.com/p/${post.shortcode}/` : location.href;
  try {
    if (navigator.share) await navigator.share({ url });
    else {
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    }
  } catch { /* user dismissed the share sheet */ }
}

// --------------------------------------------------------------------------
// grids
// --------------------------------------------------------------------------

export function gridTile(post) {
  const slide = post.slides[0] || {};
  const badge = post.type === 'carousel' ? '❏' : (post.video ? '▶' : null);
  return h('a.tile', { href: `/post/${post.id}`, 'data-route': true },
    h('img', { src: slide.image || post.thumb, alt: slide.alt || '', loading: 'lazy' }),
    badge ? h('span.tile-badge', {}, badge) : null,
  );
}

export function grid(posts) {
  return h('div.grid', {}, ...posts.map(gridTile));
}
