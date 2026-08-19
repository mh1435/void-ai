import { h } from '../dom.js';
import { api } from '../api.js';
import { state, setSession } from '../state.js';
import { go } from '../router.js';

export default function loginView(_params, outlet) {
  const shell = h('div.auth');
  outlet.append(shell);

  if (state.gateRequired && !state.gateOpen) renderGate(shell);
  else renderLogin(shell);

  return {};
}

function brand() {
  return h('div.auth-brand', {},
    h('h1.wordmark', {}, 'Loop'),
    h('p.auth-tagline', {}, 'Your own Instagram client'),
  );
}

function field(label, props) {
  const input = h('input.field-input', { ...props, id: props.name });
  return {
    input,
    el: h('label.field', { for: props.name },
      h('span.field-label', {}, label),
      input,
    ),
  };
}

function errorBox() {
  return h('p.auth-error', { role: 'alert', hidden: true });
}

function showError(box, message) {
  box.textContent = message;
  box.hidden = !message;
}

// --------------------------------------------------------------------------
// step 1 — the deployment's own access code (only if ACCESS_CODE is set)
// --------------------------------------------------------------------------

function renderGate(shell) {
  const code = field('Access code', { name: 'code', type: 'password', autocomplete: 'off', required: true });
  const error = errorBox();
  const submit = h('button.btn btn-primary btn-block', { type: 'submit' }, 'Unlock');

  shell.replaceChildren(h('div.auth-card', {},
    brand(),
    h('p.auth-note', {}, 'This server is private. Enter its access code to continue.'),
    h('form', {
      onSubmit: async (event) => {
        event.preventDefault();
        showError(error, '');
        submit.disabled = true;
        try {
          await api.gate(code.input.value);
          state.gateOpen = true;
          renderLogin(shell);
        } catch (err) {
          showError(error, err.message);
        } finally {
          submit.disabled = false;
        }
      },
    }, code.el, error, submit),
  ));
  code.input.focus();
}

// --------------------------------------------------------------------------
// step 2 — the Instagram account itself
// --------------------------------------------------------------------------

function renderLogin(shell) {
  const user = field('Username', {
    name: 'username', type: 'text', autocomplete: 'username',
    autocapitalize: 'off', spellcheck: 'false', required: true,
  });
  const pass = field('Password', {
    name: 'password', type: 'password', autocomplete: 'current-password', required: true,
  });
  const error = errorBox();
  const submit = h('button.btn btn-primary btn-block', { type: 'submit' }, 'Log in');

  shell.replaceChildren(h('div.auth-card', {},
    brand(),
    h('form', {
      onSubmit: async (event) => {
        event.preventDefault();
        showError(error, '');
        submit.disabled = true;
        submit.textContent = 'Logging in…';
        try {
          const result = await api.login(user.input.value.trim(), pass.input.value);
          if (result.status === 'two_factor') {
            renderTwoFactor(shell, result);
            return;
          }
          await finish();
        } catch (err) {
          showError(error, err.message);
        } finally {
          submit.disabled = false;
          submit.textContent = 'Log in';
        }
      },
    }, user.el, pass.el, error, submit),
    h('p.auth-fineprint', {},
      'Your password is sent to Instagram to create a session and is never ',
      'stored on this server. The session cookie stays server-side; your ',
      'browser only holds an opaque id.'),
  ));
  user.input.focus();
}

// --------------------------------------------------------------------------
// step 3 — two-factor, if the account has it on
// --------------------------------------------------------------------------

function renderTwoFactor(shell, info) {
  const code = field('Verification code', {
    name: 'code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code',
    maxlength: '8', required: true,
  });
  const error = errorBox();
  const submit = h('button.btn btn-primary btn-block', { type: 'submit' }, 'Confirm');

  const where = info.method === 'app'
    ? 'your authenticator app'
    : (info.method === 'sms' ? 'the SMS Instagram just sent' : 'your two-factor method');

  shell.replaceChildren(h('div.auth-card', {},
    brand(),
    h('p.auth-note', {}, `Enter the code from ${where}.`),
    h('form', {
      onSubmit: async (event) => {
        event.preventDefault();
        showError(error, '');
        submit.disabled = true;
        try {
          await api.twoFactor(info.username, info.identifier, code.input.value);
          await finish();
        } catch (err) {
          showError(error, err.message);
        } finally {
          submit.disabled = false;
        }
      },
    }, code.el, error, submit),
  ));
  code.input.focus();
}

async function finish() {
  setSession(await api.session());
  go('/', { replace: true });
}
