// App shell: sidebar (boards), header (presence, actions), tabs, wiring.
import { api } from './api.js';
import { el, clear, toast, confirmDialog, promptDialog, avatar, popover, debounce, forgetAvatar, getAvatarURL, fetchAvatar } from './ui.js';
import { store, on, emit, canEdit, myRole, nodeChildren } from './store.js';
import { initListView } from './listview.js';
import * as mm from './mindmap.js';
import { connectBoard, disconnect, resync } from './ws.js';
import { openFriends } from './friends.js';
import { t, toggleTheme, toggleLang, currentTheme, getLang } from './i18n.js';

let root = null;
let sidebarEl = null;
let boardListMine = null;
let boardListShared = null;
let contentEl = null;
let tabBarEl = null;
let presenceEl = null;
let boardTitleEl = null;
let drawerOverlay = null;
let pendingFriendCount = 0;   // incoming friend requests (for the sidebar badge)
let friendBadgeTimer = null;

export async function renderApp(container) {
  root = container;
  clear(root);
  buildShell();
  wireStore();
  await loadBoards();
  refreshFriendBadge();
  if (friendBadgeTimer) clearInterval(friendBadgeTimer);
  friendBadgeTimer = setInterval(refreshFriendBadge, 30000);

  const lastId = store.user?.lastBoardId;
  const initial = store.boards.find(b => b.id === lastId) || store.boards[0];
  if (initial) openBoard(initial.id);
  else renderNoBoard();
}

function buildShell() {
  const themeBtn = el('button.icon-btn', {
    'data-theme-toggle': '1',
    title: t('app.theme'),
    onclick: toggleTheme,
  }, currentTheme() === 'light' ? '☾' : '☀');
  const langBtn = el('button.icon-btn.lang-btn', {
    title: t('app.lang'),
    onclick: toggleLang,
  }, getLang() === 'tr' ? 'EN' : 'TR');

  sidebarEl = el('aside.sidebar',
    el('div.sidebar-head',
      el('span.brand', null, el('span.brand-mark', null, '✓'), 'panomim'),
      langBtn,
      themeBtn,
    ),
    el('div.sidebar-section',
      el('div.sidebar-row',
        el('span.section-title', null, t('app.myBoards')),
        canCreateBoards() && el('button.icon-btn', { title: t('app.newBoard'), onclick: () => newBoard() }, '+'),
      ),
      boardListMine = el('div.board-list'),
      el('div.sidebar-row',
        el('span.section-title', null, t('app.sharedWithMe')),
      ),
      boardListShared = el('div.board-list'),
    ),
    el('div.sidebar-foot', userFoot()),
  );

  presenceEl = el('div.presence-bar', { title: t('app.activeUsers'), onclick: () => presenceDropdown() });
  boardTitleEl = el('h2.board-title', null, '…');

  const boardMenuBtn = el('button.icon-btn', { title: t('app.boardMenu'), onclick: e => boardMenu(e.currentTarget) }, '⋯');

  tabBarEl = el('div.tabs',
    el('button.tab.active', { dataset: { tab: 'list' }, onclick: () => switchTab('list') }, t('app.tabList')),
    el('button.tab', { dataset: { tab: 'mindmap' }, onclick: () => switchTab('mindmap') }, t('app.tabMindmap')),
  );

  // mindmap toolbar (inside content, above canvas) — grouped so unrelated
  // controls never dangle; each group hides wholly when it does not apply
  const toolbar = el('div.mm-toolbar', { id: 'mm-toolbar' },
    el('span.tb-group.tb-mode', { dataset: { group: 'mode' } },
      el('button.btn.small', { id: 'mm-edit-toggle', onclick: toggleEditMode }, t('app.editMode')),
    ),
    el('span.tb-group', { dataset: { group: 'actions' } },
      el('button.btn.small.primary', { id: 'mm-add', title: t('app.newNote'), onclick: () => mm.addNoteCentered() }, t('app.addNote')),
    ),
    el('span.tb-group', { dataset: { group: 'zoom' } },
      el('button.btn.small', { title: t('app.zoomOut'), onclick: () => mm.zoomBy(1 / 1.2) }, '−'),
      el('button.zoom-label', { id: 'mm-zoom-label', title: t('app.zoomReset'), onclick: () => mm.resetZoom() }, '100%'),
      el('button.btn.small', { title: t('app.zoomIn'), onclick: () => mm.zoomBy(1.2) }, '+'),
      el('button.btn.small', { title: t('app.fit'), onclick: () => mm.fit() }, t('app.fit')),
    ),
  );
  mm.bindToolbar({
    onModeChange: updateEditModeUI,
  });

  contentEl = el('main.content',
    el('header.content-head',
      el('button.hamburger', { onclick: toggleDrawer, 'aria-label': t('app.menu') }, '☰'),
      boardTitleEl,
      boardMenuBtn,
      presenceEl,
    ),
    tabBarEl,
    el('div.views',
      el('div.view.list-view', { dataset: { view: 'list' } }),
      el('div.view.mindmap-view', { dataset: { view: 'mindmap' } }, toolbar),
    ),
  );

  drawerOverlay = el('div.drawer-overlay', { onclick: toggleDrawer });

  root.append(drawerOverlay, sidebarEl, contentEl);

  // views
  initListView(contentEl.querySelector('.list-view'));
  mm.initMindmap(contentEl.querySelector('.mindmap-view'));

  switchTab(store.prefs.tab === 'mindmap' ? 'mindmap' : 'list');
}

function canCreateBoards() { return !!store.user; }

function roleName(role) {
  return t('common.role.' + role) || role;
}

function userFoot() {
  const u = store.user;
  const friendsBtn = el('button.user-chip.user-friends', {
    title: pendingFriendCount ? t('app.pendingRequests', { n: pendingFriendCount }) : t('app.friendsLabel'),
    onclick: () => openFriends(),
  },
    el('span.user-friends-ico', null, '👥'),
    el('span.user-name', null, t('app.friendsLabel')),
    el('span.flex-spacer'),
    pendingFriendCount > 0 && el('span.user-badge', null, pendingFriendCount),
  );
  const chip = el('button.user-chip', { title: t('app.profile'), onclick: e => profileMenu(e.currentTarget) },
    avatar({ userId: u.id, username: u.username }),
    el('span.user-name', null, u.username),
  );
  return el('div.user-foot', friendsBtn, chip);
}

/** Pull the incoming-request count and refresh the sidebar badge. */
async function refreshFriendBadge() {
  try {
    const reqs = await api.get('/api/friends/requests');
    pendingFriendCount = (reqs.incoming || []).length;
  } catch { pendingFriendCount = 0; }
  renderUserFoot();
}

// --- profile ----------------------------------------------------------------

/** Bottom-left profile popover: photo, password change, logout. */
function profileMenu(anchor) {
  const u = store.user;
  const { pop, close } = popover(anchor, { placement: 'top-start' });
  const bigAvatar = avatar({ userId: u.id, username: u.username }, 'lg');
  bigAvatar.title = t('app.photoTip');
  bigAvatar.addEventListener('click', () => { close(); showAvatarLarge(u, { editable: true }); });
  pop.append(
    el('div.profile-head', null, bigAvatar,
      el('div.profile-id', null,
        el('div.profile-name', null, u.username),
        el('div.profile-sub', null, t('app.clickForPhoto')),
      ),
    ),
    el('button.menu-item', { onclick: () => { close(); passwordDialog(); } }, t('app.changePassword')),
    el('button.menu-item', { onclick: () => { close(); doLogout(); } }, t('app.signOut')),
  );
}

/** Large in-page avatar popup. Editable = self (offers "edit" to pick a photo). */
function showAvatarLarge(user, { editable = false } = {}) {
  const overlay = el('div.modal-overlay', { onclick: e => { if (e.target === overlay) overlay.remove(); } },
    el('div.modal.avatar-modal',
      avatar(user, 'xl'),
      el('div.profile-name', null, user.username),
      editable && el('div.modal-actions',
        el('button.btn.ghost', { onclick: () => overlay.remove() }, t('common.close')),
        el('button.btn.primary', { onclick: () => { overlay.remove(); chooseAvatar(user); } }, t('app.edit')),
      ),
      !editable && el('div.modal-actions',
        el('button.btn.ghost', { onclick: () => overlay.remove() }, t('common.close')),
      ),
    ),
  );
  document.body.append(overlay);
}

/** Pick a photo file and upload it as the current user's avatar. */
function chooseAvatar(user) {
  const fileBtn = el('input', {
    type: 'file',
    accept: 'image/png,image/jpeg,image/gif,image/webp',
    style: 'display:none',
  });
  document.body.append(fileBtn);
  fileBtn.onchange = async () => {
    fileBtn.remove();
    const file = fileBtn.files[0];
    if (!file) return;
    if (file.size > 2 << 20) { toast(t('app.photoTooBig'), 'error'); return; }
    try {
      const buf = await file.arrayBuffer();
      const res = await api.req('PUT', '/api/me/avatar', buf, { raw: true, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
      forgetAvatar(user.id ?? user.userId);
      if (res.removed) return;
      toast(t('app.photoUpdated'));
      renderUserFoot();
      renderPresence();
    } catch (e) { toast(e.message, 'error'); }
  };
  fileBtn.click();
}

function renderUserFoot() {
  const foot = root?.querySelector('.sidebar-foot');
  if (foot) { clear(foot); foot.append(userFoot()); }
}

/** Password change modal: current, new, confirm. */
function passwordDialog() {
  const cur = el('input.input', { type: 'password', placeholder: t('app.currentPassword'), autocomplete: 'current-password' });
  const next = el('input.input', { type: 'password', placeholder: t('app.newPassword'), autocomplete: 'new-password' });
  const again = el('input.input', { type: 'password', placeholder: t('app.newPasswordAgain'), autocomplete: 'new-password' });
  const overlay = el('div.modal-overlay', { onclick: e => { if (e.target === overlay) overlay.remove(); } },
    el('div.modal',
      el('h3.modal-title', null, t('app.passwordTitle')),
      el('div.modal-field', null, cur, next, again),
      el('div.modal-actions',
        el('button.btn.ghost', { onclick: () => overlay.remove() }, t('common.cancel')),
        el('button.btn.primary', {
          onclick: async () => {
            if (next.value.length < 8) { toast(t('app.passwordTooShort'), 'error'); return; }
            if (next.value !== again.value) { toast(t('app.passwordsMismatch'), 'error'); return; }
            try {
              await api.post('/api/auth/password', { currentPassword: cur.value, newPassword: next.value });
              overlay.remove();
              toast(t('app.passwordUpdated'));
            } catch (e) { toast(e.message, 'error'); }
          },
        }, t('common.save')),
      ),
    ),
  );
  document.body.append(overlay);
  cur.focus();
}

async function doLogout() {
  await disconnect();
  await api.logout();
  location.reload();
}

// --- boards ------------------------------------------------------------------

async function loadBoards() {
  try {
    store.boards = await api.get('/api/boards');
    renderBoardList();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function renderBoardList() {
  clear(boardListMine);
  clear(boardListShared);
  const mine = [], shared = [];
  for (const b of store.boards) (b.role === 'owner' ? mine : shared).push(b);
  const current = store.board?.board?.id;

  if (!mine.length && !shared.length) {
    boardListMine.append(el('div.board-empty', null, t('app.noBoardsYet')));
  }
  for (const b of mine) boardListMine.append(boardItem(b, current));
  for (const b of shared) boardListShared.append(boardItem(b, current));
  if (!shared.length) boardListShared.append(el('div.board-empty', null, t('app.none')));
}

function boardItem(b, currentId) {
  const item = el('button.board-item' + (b.id === currentId ? '.active' : ''), {
    onclick: () => { openBoard(b.id); closeDrawer(); },
    title: b.name + (b.role !== 'owner' ? ` (${t('app.sharedBy', { name: b.ownerName })})` : ''),
  },
    el('span.board-name', null, b.name),
    b.role === 'owner' && b.sharedCount > 0 && el('span.share-badge', { title: t('app.sharedWithCount', { n: b.sharedCount }) }, '👥' + b.sharedCount),
    b.role !== 'owner' && el('span.share-badge', { title: t('app.yourRole', { role: roleName(b.role) }) }, b.role === 'editor' ? '✎' : '👁'),
  );
  return item;
}

async function newBoard() {
  const name = await promptDialog({ title: t('app.newBoardTitle'), placeholder: t('app.boardName'), confirmText: t('common.create') });
  if (!name) return;
  try {
    const b = await api.post('/api/boards', { name });
    await loadBoards();
    openBoard(b.id);
    closeDrawer();
  } catch (e) { toast(e.message, 'error'); }
}

function boardMenu(anchor) {
  if (!store.board) return;
  const b = store.board.board;
  const { pop, close } = popover(anchor);
  const owner = b.role === 'owner';
  const items = [
    owner && el('button.menu-item', { onclick: async () => {
      close();
      const n = await promptDialog({ title: t('app.renameBoard'), value: b.name, confirmText: t('common.save') });
      if (n && n !== b.name) {
        try { await api.patch(`/api/boards/${b.id}`, { name: n }); store.board.board.name = n; await loadBoards(); renderBoardHeader(); }
        catch (e) { toast(e.message, 'error'); }
      }
    } }, '✎  ' + t('app.renameBoard')),
    el('button.menu-item', { onclick: () => { close(); openShareDialog(); } }, t('app.share')),
    el('button.menu-item', { onclick: () => { close(); exportMarkdown(); } }, t('app.exportMd')),
    el('button.menu-item', { onclick: () => { close(); importMarkdown(); } }, t('app.importMd')),
    el('button.menu-item', { onclick: async () => {
      close();
      if (owner) {
        const ok = await confirmDialog({ title: t('app.deleteBoardTitle', { name: b.name }), body: t('app.deleteBoardBody'), confirmText: t('app.deleteBoard'), danger: true });
        if (!ok) return;
        try { await api.del(`/api/boards/${b.id}`); store.board = null; await disconnect(); await loadBoards(); renderBoardList(); renderNoBoard(); } catch (e) { toast(e.message, 'error'); }
      } else {
        const ok = await confirmDialog({ title: t('app.leaveBoardTitle', { name: b.name }), body: t('app.leaveBoardBody'), confirmText: t('app.leave'), danger: true });
        if (!ok) return;
        try { await api.del(`/api/boards/${b.id}/members/${api.user.id}`); store.board = null; await disconnect(); await loadBoards(); renderNoBoard(); } catch (e) { toast(e.message, 'error'); }
      }
    } }, owner ? t('app.deleteBoardMenu') : t('app.leaveBoardMenu'), owner ? '' : ''),
    !owner && el('span.menu-note', null, t('app.yourRole', { role: roleName(b.role) })),
  ].filter(Boolean); // koşullu öğeler false döner — append metne çevirir
  pop.append(...items);
}

// --- markdown export / import -------------------------------------------------
// Dışa aktarım: ağaç, iç içe madde işaretleri olarak yazılır (`- [x]` done).
// İçe aktarım: aynı format ayrıştırılır; mevcut verilere dokunmadan her üst
// seviye madde yeni bir kök not olarak eklenir.

function mdEscape(t) { return (t || '').replace(/\s+/g, ' ').trim(); }

function exportMarkdown() {
  const b = store.board?.board;
  if (!b) return;
  const lines = [];
  const walk = (id, depth) => {
    for (const n of nodeChildren(id)) {
      lines.push(`${'  '.repeat(depth)}- [${n.done ? 'x' : ' '}] ${mdEscape(n.title)}`);
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  if (!lines.length) { toast(t('app.noNotesToExport'), 'error'); return; }
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/markdown;charset=utf-8' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `${mdEscape(b.name) || 'pano'}.md` });
  document.body.append(a);
  a.click();
  a.remove();
}

async function importMarkdown() {
  const b = store.board?.board;
  if (!b) return;
  if (!canEdit()) { toast(t('app.noEditPerm'), 'error'); return; }
  const inp = el('input', { type: 'file', accept: '.md,.markdown,.txt,text/markdown,text/plain' });
  inp.onchange = async () => {
    const file = inp.files[0];
    if (!file) return;
    const items = parseMarkdownOutline(await file.text());
    if (!items.length) { toast(t('app.noMarkdownItems'), 'error'); return; }
    let created = 0, failed = 0;
    const walk = async (list, parentId, x, y) => {
      let i = 0;
      for (const it of list) {
        try {
          const node = await api.post(`/api/boards/${b.id}/nodes`, {
            parentId, title: it.title.slice(0, 500), x: x + (parentId ? 250 : 0), y: y + i * 46,
          });
          created++;
          if (it.done) {
            try { await api.patch(`/api/nodes/${node.id}/done`, { done: true }); } catch {}
          }
          if (it.children.length) await walk(it.children, node.id, node.x, node.y - i * 0);
        } catch { failed++; }
        i++;
      }
    };
    toast(t('app.importing', { n: items.length }));
    await walk(items, null, 60, 60);
    await resync(); // single refresh: imported nodes land with server positions
    toast(failed ? t('app.importResultFail', { ok: created, fail: failed }) : t('app.importResult', { n: created }), failed ? 'error' : 'ok');
  };
  inp.click();
}

/** Parse a markdown outline into {title, done, children[]} roots.
 *  Understands -, *, +, numbered lists, [x]/[ ] checkboxes and # headings;
 *  indentation (2 spaces or 1 tab per level) builds the hierarchy. */
function parseMarkdownOutline(text) {
  const roots = [];
  const stack = [{ depth: -1, children: roots }];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim() === '---') continue;
    const heading = raw.match(/^#{1,6}\s+(.*)$/);
    const m = raw.match(/^(\s*)(?:[-*+]\s+|\d+[.)]\s+)?(.*)$/);
    const title = mdEscape(heading ? heading[1] : m[2].replace(/^\[([ xX])\]\s*/, ''));
    if (!title) continue;
    const indent = heading ? 0 : m[1].replace(/\t/g, '  ').length;
    const depth = Math.min(Math.floor(indent / 2), stack.length - 1);
    const done = !heading && /^\s*[-*+]\s+\[[xX]\]/.test(raw);
    while (stack.length > depth + 1) stack.pop();
    const item = { title, done, children: [] };
    stack[stack.length - 1].children.push(item);
    stack.push({ depth, children: item.children });
  }
  return roots;
}

async function openBoard(id) {
  if (store.board?.board?.id === id) return;
  try {
    store.board = await api.get(`/api/boards/${id}`);
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  store.nodes.clear();
  store.selections.clear();
  store.editMode = false;
  try {
    const nodes = await api.get(`/api/boards/${id}/nodes`);
    store.nodes.clear();
    for (const n of nodes) store.nodes.set(n.id, n);
  } catch (e) { toast(e.message, 'error'); }
  try {
    store.prefs = { tab: 'list', panX: null, panY: null, zoom: 1, collapsed: [], ...(await api.get(`/api/boards/${id}/prefs`)) };
  } catch {}
  emit('nodes', 'replace');
  emit('board');
  emit('prefs');
  mm.applyPrefs();

  renderBoardHeader();
  renderBoardList();
  connectBoard(id);
  api.put('/api/me/last-board', { boardId: id }).catch(() => {});
  mm.setEditMode(false, { silent: true });
  updateEditModeUI(false);
  switchTab(store.prefs.tab === 'mindmap' ? 'mindmap' : 'list');
}

function renderBoardHeader() {
  const b = store.board?.board;
  if (!b) { boardTitleEl.textContent = ''; return; }
  clear(boardTitleEl);
  const chip = b.role !== 'owner'
    && el('span.role-chip', { title: t('app.sharedBy', { name: b.ownerName }) }, roleName(b.role));
  boardTitleEl.append(b.name);
  if (chip) boardTitleEl.append(' ', chip);
}

function renderNoBoard() {
  clear(boardTitleEl);
  boardTitleEl.append(t('app.welcome'));
  const view = contentEl.querySelector('.list-view');
  clear(view);
  view.append(el('div.empty-state',
    el('div.empty-art', null, '🧷'),
    el('h2', null, t('app.pickBoard')),
    el('p', null, t('app.pickBoardHint')),
    el('button.btn.primary', { onclick: () => newBoard() }, t('app.newBoardCTA')),
  ));
  const mv = contentEl.querySelector('.mindmap-view');
  mv.querySelector('.mm-canvas')?.remove();
}

// --- tabs & toolbar -----------------------------------------------------------

function switchTab(tab) {
  store.prefs.tab = tab;
  tabBarEl.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  contentEl.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.dataset.view === tab));
  contentEl.querySelector('.mm-toolbar').style.display = tab === 'mindmap' ? '' : 'none';
  updateEditModeUI(store.editMode);
  if (tab === 'mindmap') {
    // re-measure notes now that the view is visible; center only if no saved view
    setTimeout(() => {
      mm.remeasure();
      if (store.prefs.panX == null && store.prefs.panY == null) mm.fit();
    }, 30);
    savePrefsDebounced();
  }
}

const savePrefsDebounced = debounce(() => {
  const id = store.board?.board?.id;
  if (id == null) return;
  api.put(`/api/boards/${id}/prefs`, store.prefs).catch(() => {});
}, 600);

function toggleEditMode() {
  if (!canEdit()) { toast(t('app.noEditPerm'), 'error'); return; }
  const next = !store.editMode;
  mm.setEditMode(next);
  updateEditModeUI(next);
}

function updateEditModeUI(on_ = store.editMode) {
  const btn = document.getElementById('mm-edit-toggle');
  const addBtn = document.getElementById('mm-add');
  const editing = on_ && canEdit();
  if (btn) {
    btn.textContent = editing ? t('app.viewMode') : t('app.editMode');
    btn.classList.toggle('active', editing);
    btn.closest('.tb-group')?.classList.toggle('hidden', !canEdit());
  }
  addBtn?.closest('.tb-group')?.classList.toggle('hidden', !editing);
}

// --- presence -------------------------------------------------------------------

function renderPresence() {
  clear(presenceEl);
  const users = [...store.presence.values()];
  const shown = users.slice(0, 5);
  for (const u of shown) {
    const chip = el('span.presence-avatar', { style: `--c:${u.color}`, title: u.username }, u.username.slice(0, 2).toUpperCase());
    if (u.userId != null) {
      // profile photo when available (ui.js fetches & caches blobs)
      const url = getAvatarURL(u.userId);
      if (url) { chip.classList.add('photo'); chip.style.backgroundImage = `url(${url})`; chip.textContent = ''; }
      else fetchAvatar(u.userId).then(p => {
        if (p && chip.isConnected) { chip.classList.add('photo'); chip.style.backgroundImage = `url(${p})`; chip.textContent = ''; }
      });
    }
    presenceEl.append(chip);
  }
  if (users.length > 5) {
    presenceEl.append(el('span.presence-more', { title: users.map(u => u.username).join(', ') }, '+', users.length - 5));
  }
  presenceEl.classList.toggle('offline', !store.online);
  presenceEl.title = store.online ? t('app.onlineCount', { n: users.length }) : t('app.reconnecting');
}

/** Mini dropdown of everyone currently in this board; click a user for a large view. */
function presenceDropdown() {
  const users = [...store.presence.values()];
  if (!users.length) return;
  const { pop, close } = popover(presenceEl, { placement: 'bottom-end' });
  pop.append(
    el('div.pop-title', null, t('app.inBoard', { n: users.length })),
    ...users.map(u =>
      el('button.menu-item.presence-user', {
        onclick: () => { close(); showAvatarLarge(u, { editable: false }); },
      }, avatar({ userId: u.userId, username: u.username }, 'md'), el('span', null, u.username)),
    ),
  );
}

// --- share dialog ----------------------------------------------------------------

function openShareDialog() {
  const b = store.board?.board;
  if (!b) return;
  const owner = b.role === 'owner';

  const memberList = el('div.share-list');
  const userInput = el('input.input', { placeholder: t('auth.username') });
  const roleSel = el('select.input', null,
    el('option', { value: 'viewer' }, t('common.role.viewer')),
    el('option', { value: 'editor' }, t('common.role.editor')),
  );

  async function refreshMembers() {
    try {
      const detail = await api.get(`/api/boards/${b.id}`);
      store.board = detail;
      clear(memberList);
      for (const m of detail.members) {
        memberList.append(el('div.share-row',
          el('span.presence-avatar', { style: `--c:${m.online ? 'var(--ok)' : 'var(--ink-soft)'}`, title: m.online ? t('app.online') : t('app.offline') }, m.username.slice(0, 2).toUpperCase()),
          el('span.share-name', null, m.username, m.role === 'owner' && el('span.role-chip', null, t('common.role.owner'))),
          m.role === 'owner' && el('span.share-role', null, ''),
          m.role !== 'owner' && owner && el('select.input.small', {
            onchange: async e => {
              try { await api.post(`/api/boards/${b.id}/share`, { username: m.username, role: e.target.value }); refreshMembers(); }
              catch (err) { toast(err.message, 'error'); }
            },
          },
            el('option', { value: 'viewer', selected: m.role === 'viewer' }, t('common.role.viewer')),
            el('option', { value: 'editor', selected: m.role === 'editor' }, t('common.role.editor')),
          ),
          m.role !== 'owner' && owner && el('button.icon-btn', {
            title: t('app.remove'),
            onclick: async () => {
              try { await api.del(`/api/boards/${b.id}/members/${m.userId}`); refreshMembers(); await loadBoards(); }
              catch (err) { toast(err.message, 'error'); }
            },
          }, '✕'),
        ));
      }
    } catch (e) { toast(e.message, 'error'); }
  }

  const overlay = el('div.modal-overlay', { onclick: e => { if (e.target === overlay) overlay.remove(); } },
    el('div.modal.wide',
      el('h3.modal-title', null, t('app.shareTitle', { name: b.name })),
      owner && el('div.share-add',
        userInput,
        roleSel,
        el('button.btn.primary', {
          onclick: async () => {
            const uname = userInput.value.trim();
            if (!uname) return;
            try {
              await api.post(`/api/boards/${b.id}/share`, { username: uname, role: roleSel.value });
              userInput.value = '';
              refreshMembers();
              await loadBoards();
              toast(t('app.memberAdded', { name: uname }), 'ok');
            } catch (err) { toast(err.message, 'error'); }
          },
        }, t('common.add')),
      ),
      memberList,
      el('div.modal-actions',
        el('button.btn.ghost', { onclick: () => overlay.remove() }, t('common.close')),
      ),
    ),
  );
  document.body.append(overlay);
  refreshMembers();
}

// --- drawer (mobile) ---------------------------------------------------------------

function toggleDrawer() {
  sidebarEl.classList.toggle('open');
  drawerOverlay.classList.toggle('show');
}
function closeDrawer() {
  sidebarEl.classList.remove('open');
  drawerOverlay.classList.remove('show');
}

// --- store wiring --------------------------------------------------------------------

function wireStore() {
  on('presence', renderPresence);
  on('board', () => { renderBoardHeader(); renderPresence(); });
  // keep remote selection hints in list view too: listview re-renders on 'selection'
  on('selection', () => emit('nodes', 'replace'));
  // friends panel "open this board" navigation (avoids a circular app.js import)
  on('open-board', id => openBoard(id));
  // friend requests/friends changed → refresh the sidebar badge
  on('friends-changed', () => refreshFriendBadge());
}
