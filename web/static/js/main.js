// Bootstrap: theme first (no flash), then silent session restore,
// then render either the auth screen or the app shell.
import { api } from './api.js';
import { store } from './store.js';
import { renderAuth } from './auth.js';
import { renderApp } from './app.js';
import { initTheme, getLang } from './i18n.js';

const root = document.getElementById('app');

async function loadMe() {
  // /api/me adds lastBoardId on top of the refresh payload's user
  try { store.user = await api.get('/api/me'); }
  catch { store.user = api.user; }
}

function showApp() {
  loadMe().finally(() => renderApp(root));
}

async function boot() {
  initTheme();
  document.documentElement.setAttribute('lang', getLang());
  const alive = await api.ensureRefresh();
  if (alive) showApp();
  else renderAuth(root, showApp);
}

boot();
