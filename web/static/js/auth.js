// Auth screen: cozy login/register card.
import { api } from './api.js';
import { el } from './ui.js';

export function renderAuth(root, onAuthed) {
  let mode = 'login';

  const title = el('h1.brand', null,
    el('span.brand-mark', null, '✓'),
    ' panomim',
  );

  const userInput = el('input.input', { type: 'text', autocomplete: 'username', placeholder: 'kullanıcı adı', spellcheck: 'false' });
  const passInput = el('input.input', { type: 'password', autocomplete: 'current-password', placeholder: 'parola' });
  const pass2 = el('input.input', { type: 'password', autocomplete: 'new-password', placeholder: 'parola (tekrar)' });
  const error = el('div.form-error');
  const submit = el('button.btn.primary.wide', { type: 'submit' }, 'Giriş yap');
  const switcher = el('button.link', { type: 'button' });

  const form = el('form.auth-form',
    { onsubmit: async e => {
        e.preventDefault();
        error.textContent = '';
        submit.disabled = true;
        try {
          if (mode === 'register' && passInput.value !== pass2.value) {
            throw new Error('parolalar eşleşmiyor');
          }
          if (mode === 'login') await api.login(userInput.value.trim(), passInput.value);
          else await api.register(userInput.value.trim(), passInput.value);
          onAuthed(api.user);
        } catch (err) {
          error.textContent = err.message || 'bir şeyler ters gitti';
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
    submit.textContent = reg ? 'Hesap oluştur' : 'Giriş yap';
    switcher.textContent = reg
      ? 'hesabın var mı? giriş yap'
      : 'hesabın yok mu? kaydol';
    error.textContent = '';
  }
  switcher.addEventListener('click', () => setMode(mode === 'login' ? 'register' : 'login'));
  setMode('login');

  const card = el('div.auth-card', title, form, switcher);
  const page = el('div.auth-page', card);
  clearRoot(root);
  root.append(page);
  userInput.focus();
}

function clearRoot(root) {
  while (root.firstChild) root.removeChild(root.firstChild);
}
