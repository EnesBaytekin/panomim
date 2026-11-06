// Bootstrap: theme first (no flash), then silent session restore,
// then render either the auth screen or the app shell.
import { api } from './api.js';
import { store } from './store.js';
import { renderAuth } from './auth.js';
import { renderApp } from './app.js';

const root = document.getElementById('app');

function initTheme() {
  const saved = localStorage.getItem('todoer.theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute('data-theme', saved || (prefersDark ? 'dark' : 'light'));
}

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
  const alive = await api.ensureRefresh();
  if (alive) showApp();
  else renderAuth(root, showApp);
}

boot();
