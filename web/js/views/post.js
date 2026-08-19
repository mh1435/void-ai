import { h, spinner, ago, count, richText, emptyState } from '../dom.js';
import { api } from '../api.js';
import { postCard, avatar, username } from '../components.js';
import { icon } from '../icons.js';
import { toast } from '../toast.js';

export default function postView({ id }, outlet) {
  const page = h('div.page page-narrow', {}, spinner());
  outlet.append(page);
  let alive = true;

  (async () => {
    let post;
    try {
      // /p/<shortcode> links have letters; media ids are digits and underscores.
      post = /^[0-9_]+$/.test(id) ? await api.post(id) : await api.byShortcode(id);
    } catch (err) {
      if (!alive) return;
      page.replaceChildren(emptyState(icon('comment').innerHTML, 'Cannot open this post', err.message));
      return;
    }
    if (!alive) return;

    const commentList = h('div.comments');
    const status = h('div.feed-status', {}, spinner());

    page.replaceChildren(
      postCard(post, { compactCaption: false }),
      h('h2.section-title', {}, 'Comments'),
      commentList,
      status,
      composer(post.id, commentList),
    );

    try {
      const { comments } = await api.comments(post.id);
      if (!alive) return;
      status.replaceChildren();
      if (!comments.length) {
        commentList.append(h('p.end-note', {}, 'No comments yet.'));
      } else {
        commentList.append(...comments.map(commentRow));
      }
    } catch (err) {
      if (!alive) return;
      status.replaceChildren(h('p.end-note', {}, err.message));
    }
  })();

  return { destroy() { alive = false; } };
}

function commentRow(comment) {
  return h('div.comment', {},
    avatar(comment.user, 32),
    h('div.comment-body', {},
      h('div', {}, username(comment.user), ' ', richText(comment.text)),
      h('div.comment-meta', {},
        h('time', {}, ago(comment.created_at)),
        comment.like_count ? h('span', {}, `${count(comment.like_count)} likes`) : null,
      ),
    ),
  );
}

function composer(mediaId, list) {
  const input = h('input.composer-input', {
    type: 'text', placeholder: 'Add a comment…', 'aria-label': 'Add a comment',
  });
  const send = h('button.composer-send', { type: 'submit', disabled: true }, 'Post');

  input.addEventListener('input', () => { send.disabled = !input.value.trim(); });

  const form = h('form.composer', {
    onSubmit: async (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      send.disabled = true;
      input.disabled = true;
      try {
        const comment = await api.addComment(mediaId, text);
        list.prepend(commentRow(comment));
        input.value = '';
      } catch (err) {
        toast(err.message);
      } finally {
        input.disabled = false;
        send.disabled = !input.value.trim();
        input.focus();
      }
    },
  }, input, send);

  return form;
}
