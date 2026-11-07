// Auth screen: cozy login/register card.
import { api } from './api.js';
import { el } from './ui.js';
import { t, toggleTheme, toggleLang, currentTheme, getLang } from './i18n.js';

export function renderAuth(root, onAuthed) {
  let mode = 'login';

  const title = el('h1.brand', null,
    el('span.brand-mark', null, '✓'),
    ' panomim',
  );

  // language + theme, available before login
  const langBtn = el('button.icon-btn.lang-btn', {
    title: t('app.lang'),
    onclick: toggleLang,
  }, getLang() === 'tr' ? 'TR' : 'EN');
  const themeBtn = el('button.icon-btn', {
    'data-theme-toggle': '1',
    title: t('app.theme'),
    onclick: toggleTheme,
  }, currentTheme() === 'dark' ? '☾' : '☀');
  const controls = el('div.auth-controls', null, langBtn, themeBtn);

  const userInput = el('input.input', { type: 'text', autocomplete: 'username', placeholder: t('auth.username'), spellcheck: 'false' });
  const passInput = el('input.input', { type: 'password', autocomplete: 'current-password', placeholder: t('auth.password') });
  const pass2 = el('input.input', { type: 'password', autocomplete: 'new-password', placeholder: t('auth.passwordAgain') });
  const error = el('div.form-error');
  const submit = el('button.btn.primary.wide', { type: 'submit' }, t('auth.signIn'));
  const switcher = el('button.link', { type: 'button' });

  const form = el('form.auth-form',
    { onsubmit: async e => {
        e.preventDefault();
        error.textContent = '';
        submit.disabled = true;
        try {
          if (mode === 'register' && passInput.value !== pass2.value) {
            throw new Error(t('auth.passwordsMismatch'));
          }
          if (mode === 'login') await api.login(userInput.value.trim(), passInput.value);
          else await api.register(userInput.value.trim(), passInput.value);
          onAuthed(api.user);
        } catch (err) {
          error.textContent = err.message || t('auth.genericError');
        } finally {
          submit.disabled = false;
        }
      } },
    userInput,
    passInput,
    pass2,
    error,
    submit,
  );

  function setMode(m) {
    mode = m;
    const reg = m === 'register';
    pass2.style.display = reg ? '' : 'none';
    passInput.setAttribute('autocomplete', reg ? 'new-password' : 'current-password');
    submit.textContent = reg ? t('auth.signUp') : t('auth.signIn');
    switcher.textContent = reg ? t('auth.haveAccount') : t('auth.noAccount');
    error.textContent = '';
  }
  switcher.addEventListener('click', () => setMode(mode === 'login' ? 'register' : 'login'));
  setMode('login');

  const card = el('div.auth-card', title, controls, form, switcher);
  const page = el('div.auth-page', card);
  clearRoot(root);
  root.append(page);
  userInput.focus();
}

function clearRoot(root) {
  while (root.firstChild) root.removeChild(root.firstChild);
}
