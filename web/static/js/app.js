// App shell: sidebar (boards), header (presence, actions), tabs, wiring.
import { api } from './api.js';
import { el, clear, toast, confirmDialog, promptDialog, avatar, popover, debounce, forgetAvatar, getAvatarURL, fetchAvatar } from './ui.js';
import { store, on, emit, canEdit, myRole, nodeChildren } from './store.js';
import { initListView } from './listview.js';
import * as mm from './mindmap.js';
import { connectBoard, disconnect, resync } from './ws.js';

let root = null;
let sidebarEl = null;
let boardListMine = null;
let boardListShared = null;
let contentEl = null;
let tabBarEl = null;
let presenceEl = null;
let boardTitleEl = null;
let drawerOverlay = null;

export async function renderApp(container) {
  root = container;
  clear(root);
  buildShell();
  wireStore();
  await loadBoards();

  const lastId = store.user?.lastBoardId;
  const initial = store.boards.find(b => b.id === lastId) || store.boards[0];
  if (initial) openBoard(initial.id);
  else renderNoBoard();
}

function buildShell() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const themeBtn = el('button.icon-btn', {
    title: 'tema değiştir',
    onclick: toggleTheme,
  }, dark ? '☀' : '☾');

  sidebarEl = el('aside.sidebar',
    el('div.sidebar-head',
      el('span.brand', null, el('span.brand-mark', null, '✓'), 'panomim'),
      themeBtn,
    ),
    el('div.sidebar-section',
      el('div.sidebar-row',
        el('span.section-title', null, 'Panolarım'),
        canCreateBoards() && el('button.icon-btn', { title: 'yeni pano', onclick: () => newBoard() }, '+'),
      ),
      boardListMine = el('div.board-list'),
      el('div.sidebar-row',
        el('span.section-title', null, 'Benimle paylaşılan'),
      ),
      boardListShared = el('div.board-list'),
    ),
    el('div.sidebar-foot', userFoot()),
  );

  presenceEl = el('div.presence-bar', { title: 'bu panoda aktif kullanıcılar', onclick: () => presenceDropdown() });
  boardTitleEl = el('h2.board-title', null, '…');

  const boardMenuBtn = el('button.icon-btn', { title: 'pano menüsü', onclick: e => boardMenu(e.currentTarget) }, '⋯');

  tabBarEl = el('div.tabs',
    el('button.tab.active', { dataset: { tab: 'list' }, onclick: () => switchTab('list') }, '☰ Liste'),
    el('button.tab', { dataset: { tab: 'mindmap' }, onclick: () => switchTab('mindmap') }, '✦ Zihin Haritası'),
  );

  // mindmap toolbar (inside content, above canvas) — grouped so unrelated
  // controls never dangle; each group hides wholly when it does not apply
  const toolbar = el('div.mm-toolbar', { id: 'mm-toolbar' },
    el('span.tb-group.tb-mode', { dataset: { group: 'mode' } },
      el('button.btn.small', { id: 'mm-edit-toggle', onclick: toggleEditMode }, '✏️ Düzenleme modu'),
    ),
    el('span.tb-group', { dataset: { group: 'actions' } },
      el('button.btn.small.primary', { id: 'mm-add', title: 'yeni not ekle', onclick: () => mm.addNoteCentered() }, '+ Not'),
    ),
    el('span.tb-group', { dataset: { group: 'zoom' } },
      el('button.btn.small', { title: 'uzaklaştır', onclick: () => mm.zoomBy(1 / 1.2) }, '−'),
      el('button.zoom-label', { id: 'mm-zoom-label', title: '%100’e dön', onclick: () => mm.resetZoom() }, '100%'),
      el('button.btn.small', { title: 'yaklaştır', onclick: () => mm.zoomBy(1.2) }, '+'),
      el('button.btn.small', { title: 'ekrana sığdır', onclick: () => mm.fit() }, '⤢ Sığdır'),
    ),
  );
  mm.bindToolbar({
    onModeChange: updateEditModeUI,
  });

  contentEl = el('main.content',
    el('header.content-head',
      el('button.hamburger', { onclick: toggleDrawer, 'aria-label': 'menü' }, '☰'),
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

function userFoot() {
  const u = store.user;
  const chip = el('button.user-chip', { title: 'profil', onclick: e => profileMenu(e.currentTarget) },
    avatar({ userId: u.id, username: u.username }),
    el('span.user-name', null, u.username),
  );
  return el('div.user-foot', chip);
}

// --- profile ----------------------------------------------------------------

/** Bottom-left profile popover: photo, password change, logout. */
function profileMenu(anchor) {
  const u = store.user;
  const { pop, close } = popover(anchor, { placement: 'top-start' });
  const bigAvatar = avatar({ userId: u.id, username: u.username }, 'lg');
  bigAvatar.title = 'fotoğrafı görüntüle / değiştir';
  bigAvatar.addEventListener('click', () => { close(); showAvatarLarge(u, { editable: true }); });
  pop.append(
    el('div.profile-head', null, bigAvatar,
      el('div.profile-id', null,
        el('div.profile-name', null, u.username),
        el('div.profile-sub', null, 'fotoğraf için tıkla'),
      ),
    ),
    el('button.menu-item', { onclick: () => { close(); passwordDialog(); } }, '🔑  Parola değiştir'),
    el('button.menu-item', { onclick: () => { close(); doLogout(); } }, '🚪  Çıkış yap'),
  );
}

/** Large in-page avatar popup. Editable = self (offers "edit" to pick a photo). */
function showAvatarLarge(user, { editable = false } = {}) {
  const overlay = el('div.modal-overlay', { onclick: e => { if (e.target === overlay) overlay.remove(); } },
    el('div.modal.avatar-modal',
      avatar(user, 'xl'),
      el('div.profile-name', null, user.username),
      editable && el('div.modal-actions',
        el('button.btn.ghost', { onclick: () => overlay.remove() }, 'Kapat'),
        el('button.btn.primary', { onclick: () => { overlay.remove(); chooseAvatar(user); } }, '✎ Düzenle'),
      ),
      !editable && el('div.modal-actions',
        el('button.btn.ghost', { onclick: () => overlay.remove() }, 'Kapat'),
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
    if (file.size > 2 << 20) { toast('Fotoğraf en fazla 2 MB olabilir', 'error'); return; }
    try {
      const buf = await file.arrayBuffer();
      const res = await api.req('PUT', '/api/me/avatar', buf, { raw: true, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
      forgetAvatar(user.id ?? user.userId);
      if (res.removed) return;
      toast('Profil fotoğrafı güncellendi');
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
  const cur = el('input.input', { type: 'password', placeholder: 'mevcut parola', autocomplete: 'current-password' });
  const next = el('input.input', { type: 'password', placeholder: 'yeni parola (en az 8 karakter)', autocomplete: 'new-password' });
  const again = el('input.input', { type: 'password', placeholder: 'yeni parola (tekrar)', autocomplete: 'new-password' });
  const overlay = el('div.modal-overlay', { onclick: e => { if (e.target === overlay) overlay.remove(); } },
    el('div.modal',
      el('h3.modal-title', null, 'Parola değiştir'),
      el('div.modal-field', null, cur, next, again),
      el('div.modal-actions',
        el('button.btn.ghost', { onclick: () => overlay.remove() }, 'Vazgeç'),
        el('button.btn.primary', {
          onclick: async () => {
            if (next.value.length < 8) { toast('Yeni parola en az 8 karakter olmalı', 'error'); return; }
            if (next.value !== again.value) { toast('Yeni parolalar eşleşmiyor', 'error'); return; }
            try {
              await api.post('/api/auth/password', { currentPassword: cur.value, newPassword: next.value });
              overlay.remove();
              toast('Parola güncellendi; diğer oturumlar kapatıldı');
            } catch (e) { toast(e.message, 'error'); }
          },
        }, 'Kaydet'),
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

// --- theme -------------------------------------------------------------------

export function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'light';
  const next = cur === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('panomim.theme', next);
  document.querySelector('.sidebar-head .icon-btn') && (document.querySelector('.sidebar-head .icon-btn').textContent = next === 'light' ? '☾' : '☀');
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
    boardListMine.append(el('div.board-empty', null, 'henüz pano yok'));
  }
  for (const b of mine) boardListMine.append(boardItem(b, current));
  for (const b of shared) boardListShared.append(boardItem(b, current));
  if (!shared.length) boardListShared.append(el('div.board-empty', null, '(yok)'));
}

function boardItem(b, currentId) {
  const item = el('button.board-item' + (b.id === currentId ? '.active' : ''), {
    onclick: () => { openBoard(b.id); closeDrawer(); },
    title: b.name + (b.role !== 'owner' ? ` (paylaşan: ${b.ownerName})` : ''),
  },
    el('span.board-name', null, b.name),
    b.role === 'owner' && b.sharedCount > 0 && el('span.share-badge', { title: `${b.sharedCount} kişiyle paylaşılmış` }, '👥' + b.sharedCount),
    b.role !== 'owner' && el('span.share-badge', { title: `rolün: ${b.role}` }, b.role === 'editor' ? '✎' : '👁'),
  );
  return item;
}

async function newBoard() {
  const name = await promptDialog({ title: 'Yeni pano', placeholder: 'pano adı', confirmText: 'Oluştur' });
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
      const n = await promptDialog({ title: 'Panoyu yeniden adlandır', value: b.name, confirmText: 'Kaydet' });
      if (n && n !== b.name) {
        try { await api.patch(`/api/boards/${b.id}`, { name: n }); store.board.board.name = n; await loadBoards(); renderBoardHeader(); }
        catch (e) { toast(e.message, 'error'); }
      }
    } }, '✎  Yeniden adlandır'),
    el('button.menu-item', { onclick: () => { close(); openShareDialog(); } }, '👥  Paylaş'),
    el('button.menu-item', { onclick: () => { close(); exportMarkdown(); } }, '⬇  Markdown dışa aktar'),
    el('button.menu-item', { onclick: () => { close(); importMarkdown(); } }, '⬆  Markdown içe aktar'),
    el('button.menu-item', { onclick: async () => {
      close();
      if (owner) {
        const ok = await confirmDialog({ title: `“${b.name}” silinsin mi?`, body: 'Panodaki tüm görevler kalıcı olarak silinir.', confirmText: 'Panoyu sil', danger: true });
        if (!ok) return;
        try { await api.del(`/api/boards/${b.id}`); store.board = null; await disconnect(); await loadBoards(); renderBoardList(); renderNoBoard(); } catch (e) { toast(e.message, 'error'); }
      } else {
        const ok = await confirmDialog({ title: `“${b.name}” panosundan ayrıl`, body: 'Pano listenden kalkar; tekrar davet edilebilirsin.', confirmText: 'Ayrıl', danger: true });
        if (!ok) return;
        try { await api.del(`/api/boards/${b.id}/members/${api.user.id}`); store.board = null; await disconnect(); await loadBoards(); renderNoBoard(); } catch (e) { toast(e.message, 'error'); }
      }
    } }, owner ? '🗑  Panoyu sil…' : '🚪  Panodan ayrıl…', owner ? '' : ''),
    !owner && el('span.menu-note', null, `rolün: ${b.role === 'editor' ? 'düzenleyici' : 'görüntüleyici'}`),
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
  if (!lines.length) { toast('Panoda aktarılacak not yok', 'error'); return; }
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/markdown;charset=utf-8' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `${mdEscape(b.name) || 'pano'}.md` });
  document.body.append(a);
  a.click();
  a.remove();
}

async function importMarkdown() {
  const b = store.board?.board;
  if (!b) return;
  if (!canEdit()) { toast('Bu panoda düzenleme yetkin yok', 'error'); return; }
  const inp = el('input', { type: 'file', accept: '.md,.markdown,.txt,text/markdown,text/plain' });
  inp.onchange = async () => {
    const file = inp.files[0];
    if (!file) return;
    const items = parseMarkdownOutline(await file.text());
    if (!items.length) { toast('Dosyada ayrıştırılabilir madde bulunamadı', 'error'); return; }
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
    toast(`${items.length} kök madde içe aktarılıyor…`);
    await walk(items, null, 60, 60);
    await resync(); // single refresh: imported nodes land with server positions
    toast(failed ? `${created} not eklendi, ${failed} başarısız` : `${created} not eklendi`, failed ? 'error' : 'ok');
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
    && el('span.role-chip', { title: `paylaşan: ${b.ownerName}` }, b.role === 'editor' ? 'düzenleyici' : 'görüntüleyici');
  boardTitleEl.append(b.name);
  if (chip) boardTitleEl.append(' ', chip);
}

function renderNoBoard() {
  clear(boardTitleEl);
  boardTitleEl.append('Hoş geldin ✨');
  const view = contentEl.querySelector('.list-view');
  clear(view);
  view.append(el('div.empty-state',
    el('div.empty-art', null, '🧷'),
    el('h2', null, 'Bir pano seç ya da oluştur'),
    el('p', null, 'Soldaki panelden başlamak istediğin panoyu seç; yoksa hemen bir tane yarat.'),
    el('button.btn.primary', { onclick: () => newBoard() }, '+ Yeni pano'),
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
  if (!canEdit()) { toast('Bu panoda düzenleme yetkin yok', 'error'); return; }
  const next = !store.editMode;
  mm.setEditMode(next);
  updateEditModeUI(next);
}

function updateEditModeUI(on_ = store.editMode) {
  const btn = document.getElementById('mm-edit-toggle');
  const addBtn = document.getElementById('mm-add');
  const editing = on_ && canEdit();
  if (btn) {
    btn.textContent = editing ? '👁 Görüntüleme modu' : '✏️ Düzenleme modu';
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
  presenceEl.title = store.online ? `${users.length} kişi bu panoda` : 'bağlantı koptu, yeniden bağlanılıyor…';
}

/** Mini dropdown of everyone currently in this board; click a user for a large view. */
function presenceDropdown() {
  const users = [...store.presence.values()];
  if (!users.length) return;
  const { pop, close } = popover(presenceEl, { placement: 'bottom-end' });
  pop.append(
    el('div.pop-title', null, `Bu panoda (${users.length})`),
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
  const userInput = el('input.input', { placeholder: 'kullanıcı adı' });
  const roleSel = el('select.input', null,
    el('option', { value: 'viewer' }, 'görüntüleyici'),
    el('option', { value: 'editor' }, 'düzenleyici'),
  );

  async function refreshMembers() {
    try {
      const detail = await api.get(`/api/boards/${b.id}`);
      store.board = detail;
      clear(memberList);
      for (const m of detail.members) {
        memberList.append(el('div.share-row',
          el('span.presence-avatar', { style: `--c:${m.online ? 'var(--ok)' : 'var(--ink-soft)'}`, title: m.online ? 'çevrim içi' : 'çevrim dışı' }, m.username.slice(0, 2).toUpperCase()),
          el('span.share-name', null, m.username, m.role === 'owner' && el('span.role-chip', null, 'sahip')),
          m.role === 'owner' && el('span.share-role', null, ''),
          m.role !== 'owner' && owner && el('select.input.small', {
            onchange: async e => {
              try { await api.post(`/api/boards/${b.id}/share`, { username: m.username, role: e.target.value }); refreshMembers(); }
              catch (err) { toast(err.message, 'error'); }
            },
          },
            el('option', { value: 'viewer', selected: m.role === 'viewer' }, 'görüntüleyici'),
            el('option', { value: 'editor', selected: m.role === 'editor' }, 'düzenleyici'),
          ),
          m.role !== 'owner' && owner && el('button.icon-btn', {
            title: 'kaldır',
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
      el('h3.modal-title', null, `“${b.name}” paylaşımı`),
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
              toast(`${uname} eklendi`, 'ok');
            } catch (err) { toast(err.message, 'error'); }
          },
        }, 'Ekle'),
      ),
      memberList,
      el('div.modal-actions',
        el('button.btn.ghost', { onclick: () => overlay.remove() }, 'Kapat'),
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
}
