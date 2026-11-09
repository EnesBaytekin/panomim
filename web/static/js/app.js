// App shell: sidebar (boards), header (presence, actions), tabs, wiring.
import { api } from './api.js';
import { el, clear, toast, confirmDialog, promptDialog, avatar, popover, debounce, forgetAvatar, getAvatarURL, fetchAvatar } from './ui.js';
import { store, on, emit, canEdit, myRole, nodeChildren, markSeen, hasSeen, boardChanged } from './store.js';
import { initListView } from './listview.js';
import * as mm from './mindmap.js';
import { connectBoard, disconnect, resync } from './ws.js';
import { openFriends } from './friends.js';
import { undo, redo, canUndo, canRedo, resetUndo } from './undo.js';
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
let boardChangesTimer = null;

export async function renderApp(container) {
  root = container;
  clear(root);
  buildShell();
  wireStore();
  await loadBoards();
  refreshFriendBadge();
  if (friendBadgeTimer) clearInterval(friendBadgeTimer);
  friendBadgeTimer = setInterval(refreshFriendBadge, 30000);
  if (boardChangesTimer) clearInterval(boardChangesTimer);
  boardChangesTimer = setInterval(() => loadBoards(true), 15000);

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
  }, currentTheme() === 'dark' ? '☾' : '☀');
  const langBtn = el('button.icon-btn.lang-btn', {
    title: t('app.lang'),
    onclick: toggleLang,
  }, getLang() === 'tr' ? 'TR' : 'EN');

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

  // mindmap toolbar (inside content, above canvas) — split into two side-by-side
  // panels: note actions (mode + add) and zoom; each panel hides wholly when it
  // does not apply, and on mobile the zoom panel wraps below as its own bar.
  const toolbar = el('div.mm-toolbar', { id: 'mm-toolbar' },
    el('div.tb-panel', { id: 'mm-tb-main' },
      el('span.tb-group.tb-mode', { dataset: { group: 'mode' } },
        el('button.btn.small', { id: 'mm-edit-toggle', onclick: toggleEditMode }, t('app.editMode')),
      ),
      el('span.tb-group', { dataset: { group: 'actions' } },
        el('button.btn.small', { id: 'mm-select-toggle', title: t('app.selectModeOn'), onclick: () => mm.toggleSelectMode() }, t('app.selectMode')),
        el('button.btn.small', { id: 'mm-area-toggle', title: t('app.areaSelectHint'), onclick: () => mm.toggleAreaSelect() }, t('app.areaSelect')),
        el('button.btn.small', { id: 'mm-undo', title: t('app.undo'), onclick: doUndo }, '↶'),
        el('button.btn.small', { id: 'mm-redo', title: t('app.redo'), onclick: doRedo }, '↷'),
        el('button.btn.small.primary', { id: 'mm-add', title: t('app.newNote'), onclick: () => mm.addNoteCentered() }, t('app.addNote')),
      ),
    ),
    el('div.tb-panel', { dataset: { group: 'zoom' } },
      el('span.tb-group', { dataset: { group: 'zoom' } },
        el('button.btn.small', { title: t('app.zoomOut'), onclick: () => mm.zoomBy(1 / 1.2) }, '−'),
        el('button.zoom-label', { id: 'mm-zoom-label', title: t('app.zoomReset'), onclick: () => mm.resetZoom() }, '100%'),
        el('button.btn.small', { title: t('app.zoomIn'), onclick: () => mm.zoomBy(1.2) }, '+'),
        el('button.btn.small', { title: t('app.fitTitle'), onclick: () => mm.fit() }, t('app.fit')),
      ),
    ),
  );
  mm.bindToolbar({
    onModeChange: updateEditModeUI,
    onSelectModeChange: updateSelectModeUI,
    onAreaSelectChange: updateAreaSelectUI,
  });
  wireKeys();

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

async function loadBoards(silent = false) {
  try {
    store.boards = await api.get('/api/boards');
    // Boards we've never seen get "seen up to now" so only future changes
    // (after this first look) light up their dot.
    for (const b of store.boards) if (!hasSeen(b.id)) markSeen(b.id, b.updatedAt);
    renderBoardList();
  } catch (e) {
    if (!silent) toast(e.message, 'error');
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
    boardChanged(b, currentId) && el('span.board-changed', { title: t('app.boardChanged') }),
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
    el('button.menu-item', { onclick: () => { close(); exportDialog(); } }, t('app.export')),
    el('button.menu-item', { onclick: () => { close(); importMarkdown(); } }, t('app.import')),
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
// Dışa aktarım: ağaç, iç içe madde işaretleri olarak yazılır; bir notun ek
// alanları altına `- [tür] değer` satırları olarak konur. İçe aktarım aynı
// formatı okur; link/tarih/saat/görsel gibi alanlar uygulamadaki ek alanlara
// dönüştürülür. Her iki panel de monospace bir metin kutusuyla çalışır.

const FIELD_ICON = { text: '✎', date: '📅', time: '🕑', datetime: '📅', link: '🔗', image: '🖼' };
const FIELD_LABEL = { text: 'field.note', date: 'field.date', time: 'field.time', datetime: 'field.datetime', link: 'field.link', image: 'field.image' };

function mdEscape(t) { return (t || '').replace(/\s+/g, ' ').trim(); }

// A note's displayed title comes from its title, or (when empty) its first
// non-empty text field — mirroring mindmap.js so export reads like the UI.
function noteTitleField(node) {
  if (node.title) return null;
  return node.fields.find(f => f.type === 'text' && (f.value || '').trim()) || null;
}
function noteMainText(node) {
  return node.title || (noteTitleField(node)?.value || '');
}
function noteBodyFields(node) {
  const title = noteTitleField(node);
  return node.fields.filter(f => f !== title && (f.type !== 'text' || (f.value || '').trim()));
}

function fieldLine(f) {
  if (f.type === 'image') return `[image] file:${f.value}`;
  if (f.type === 'link') return `[${f.value}](${f.value})`;
  return `[${f.type}] ${mdEscape(f.value)}`;
}

/** Build the board's markdown: nodes as `- [ ]`/`- [x]` lines, fields as
 *  indented `- [type] value` lines. Returns '' when the board is empty. */
function buildMarkdown() {
  const b = store.board?.board;
  if (!b) return '';
  const lines = [];
  const walk = (id, depth) => {
    for (const n of nodeChildren(id)) {
      lines.push(`${'  '.repeat(depth)}- [${n.done ? 'x' : ' '}] ${mdEscape(noteMainText(n)) || t('list.untitled')}`);
      for (const f of noteBodyFields(n)) lines.push(`${'  '.repeat(depth + 1)}- ${fieldLine(f)}`);
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return lines.length ? lines.join('\n') + '\n' : '';
}

/** Build the board in the user's own pattern (the "custom" format): notes are
 *  prefixed note/checked lines, fields are indented lines matching the field
 *  patterns. Mirrors buildMarkdown's shape. Returns '' when the board is empty. */
function buildCustom(cfg) {
  const b = store.board?.board;
  if (!b) return '';
  const noteP = cfg.notePrefix || '';
  const doneP = cfg.donePrefix || '';
  const indent = cfg.indent ?? '    ';
  const fieldOf = f => {
    const p = cfg.fields[f.type];
    if (!p || !(p.prefix || '').length) return null; // no pattern → skip the field
    return p.prefix + (f.type === 'image' ? `file:${f.value}` : f.value) + (p.suffix || '');
  };
  const lines = [];
  const walk = (id, depth) => {
    for (const n of nodeChildren(id)) {
      const prefix = n.done && doneP ? doneP : noteP;
      lines.push(indent.repeat(depth) + prefix + (mdEscape(noteMainText(n)) || t('list.untitled')));
      for (const f of noteBodyFields(n)) {
        const line = fieldOf(f);
        if (line) lines.push(indent.repeat(depth + 1) + line);
      }
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return lines.length ? lines.join('\n') + '\n' : '';
}

/** Export dialog: pick Markdown or Custom (own pattern) — same format toggle as
 *  import — then copy or download the generated text. */
function exportDialog() {
  const b = store.board?.board;
  if (!b) return;

  const formatMd = el('button.btn.small', { onclick: () => setFormat('md') }, t('md.formatMarkdown'));
  const formatCustom = el('button.btn.small', { onclick: () => setFormat('custom') }, t('md.formatCustom'));

  const notePat = customNoteInputs();
  const fieldPat = customFieldInputs();
  const noteWrap = el('div.import-note-patterns', null, el('div.dim', null, t('md.customNoteHint')), notePat.grid);
  const advanced = el('details.import-advanced', null,
    el('summary', null, t('md.advanced')),
    el('div.import-advanced-body', null, el('div.dim', null, t('md.customHint')), fieldPat.grid),
  );

  const ta = mdTextarea('', true);
  const overlay = el('div.modal-overlay', { onclick: e => { if (e.target === overlay) overlay.remove(); } },
    el('div.modal.md-modal',
      el('h3.modal-title', null, t('md.exportTitle')),
      el('div.import-settings',
        el('div.import-formats', null,
          el('span.modal-label', null, t('md.formatLabel')),
          formatMd,
          formatCustom,
        ),
        noteWrap,
        advanced,
      ),
      el('div.md-readonly-note', null, t('md.readonly')),
      ta,
      el('div.modal-actions',
        el('button.btn.ghost', { onclick: () => overlay.remove() }, t('common.close')),
        el('button.btn', { onclick: () => copyMarkdown(ta.value) }, t('md.copy')),
        el('button.btn.primary', { onclick: () => downloadMarkdown(ta.value, b.name) }, t('md.download')),
      ),
    ),
  );
  document.body.append(overlay);

  let format = 'md';
  function setFormat(f) {
    format = f;
    formatMd.classList.toggle('active', f === 'md');
    formatCustom.classList.toggle('active', f === 'custom');
    noteWrap.hidden = f !== 'custom';
    advanced.hidden = f !== 'custom';
    update();
  }
  function update() {
    ta.value = format === 'custom'
      ? buildCustom(customConfig(notePat.cfg, fieldPat.cfg))
      : buildMarkdown();
  }
  overlay.querySelectorAll('.pattern-grid input').forEach(inp => inp.addEventListener('input', update));
  setFormat('md');
  if (!store.nodes.size) toast(t('app.noNotesToExport'), 'error');
}

function copyMarkdown(md) {
  const done = () => toast(t('md.copied'), 'ok');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(md).then(done).catch(() => legacyCopy(md, done));
  } else legacyCopy(md, done);
}

function legacyCopy(text, done) {
  const ta = el('textarea', { style: 'position:fixed;left:-9999px;top:0' });
  ta.value = text;
  document.body.append(ta);
  ta.focus();
  ta.select();
  try { document.execCommand('copy'); done(); } catch { /* ignore */ }
  ta.remove();
}

function downloadMarkdown(md, name) {
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `${mdEscape(name) || 'pano'}.md` });
  document.body.append(a);
  a.click();
  a.remove();
}

// --- custom (own-pattern) import ------------------------------------------------

const CUSTOM_DEFAULTS = {
  notePrefix: '- ',
  donePrefix: '+ ',
  indent: '    ',
  fields: {
    text: { prefix: '* ', suffix: '' },
    date: { prefix: '[', suffix: ']' },
    time: { prefix: '[', suffix: ']' },
    datetime: { prefix: '[', suffix: ']' },
    link: { prefix: '-- ', suffix: '' },
  },
};

function patternInput(v) {
  return el('input.input.small.pattern-input', { value: v, spellcheck: false, autocapitalize: 'off' });
}

/** Note-level custom pattern inputs (shown directly in custom mode). */
function customNoteInputs() {
  const cfg = {
    notePrefix: patternInput(CUSTOM_DEFAULTS.notePrefix),
    donePrefix: patternInput(CUSTOM_DEFAULTS.donePrefix),
    indent: patternInput(CUSTOM_DEFAULTS.indent),
  };
  const row = (label, pfx, sfx) => [el('span.pat-label', null, label), pfx, sfx ?? el('span')];
  const grid = el('div.pattern-grid', null,
    el('span'), el('span.pat-head', null, t('md.prefix')), el('span.pat-head', null, t('md.suffix')),
    ...row(t('md.customNotePrefix'), cfg.notePrefix),
    ...row(t('md.customDonePrefix'), cfg.donePrefix),
    ...row(t('md.customIndent'), cfg.indent),
  );
  return { grid, cfg };
}

/** Field-level custom pattern inputs (shown inside the "advanced" section). */
function customFieldInputs() {
  const p = v => ({ prefix: patternInput(v.prefix), suffix: patternInput(v.suffix) });
  const cfg = {
    fields: {
      text: p(CUSTOM_DEFAULTS.fields.text), date: p(CUSTOM_DEFAULTS.fields.date),
      time: p(CUSTOM_DEFAULTS.fields.time), datetime: p(CUSTOM_DEFAULTS.fields.datetime),
      link: p(CUSTOM_DEFAULTS.fields.link),
    },
  };
  const row = (label, pfx, sfx) => [el('span.pat-label', null, label), pfx, sfx ?? el('span')];
  const grid = el('div.pattern-grid', null,
    el('span'), el('span.pat-head', null, t('md.prefix')), el('span.pat-head', null, t('md.suffix')),
    ...row(t('md.fieldNote'), cfg.fields.text.prefix, cfg.fields.text.suffix),
    ...row(t('md.fieldDate'), cfg.fields.date.prefix, cfg.fields.date.suffix),
    ...row(t('md.fieldTime'), cfg.fields.time.prefix, cfg.fields.time.suffix),
    ...row(t('md.fieldDatetime'), cfg.fields.datetime.prefix, cfg.fields.datetime.suffix),
    ...row(t('md.fieldLink'), cfg.fields.link.prefix, cfg.fields.link.suffix),
  );
  return { grid, cfg };
}

function customConfig(noteCfg, fieldCfg) {
  const read = p => ({ prefix: p.prefix.value, suffix: p.suffix.value });
  return {
    notePrefix: noteCfg.notePrefix.value,
    donePrefix: noteCfg.donePrefix.value,
    indent: noteCfg.indent.value,
    fields: {
      text: read(fieldCfg.fields.text), date: read(fieldCfg.fields.date), time: read(fieldCfg.fields.time),
      datetime: read(fieldCfg.fields.datetime), link: read(fieldCfg.fields.link),
    },
  };
}

/** Parse "own pattern" text into the same tree shape parseMarkdown returns.
 *  A line starting with the note/checked prefix is a note; an indented line that
 *  matches a field pattern attaches to the note one level above it. */
function parseCustom(text, cfg) {
  const roots = [];
  const stack = [{ depth: -1, node: { fields: [], children: roots } }];
  const noteP = cfg.notePrefix || '';
  const doneP = cfg.donePrefix || '';
  const indent = cfg.indent ?? '    ';
  const matchers = [
    ['text', cfg.fields.text], ['date', cfg.fields.date], ['time', cfg.fields.time],
    ['datetime', cfg.fields.datetime], ['link', cfg.fields.link],
  ].filter(([, f]) => f && (f.prefix || '').length > 0)
    .map(([type, f]) => ({ type, prefix: f.prefix, suffix: f.suffix || '' }));

  const depthOf = line => {
    if (!indent) return 0;
    let d = 0;
    while (line.startsWith(indent)) { line = line.slice(indent.length); d++; }
    return d;
  };
  const strip = line => {
    if (!indent) return line;
    while (line.startsWith(indent)) line = line.slice(indent.length);
    return line;
  };
  const fieldFor = rest => {
    for (const m of matchers) {
      if (!rest.startsWith(m.prefix)) continue;
      let v = rest.slice(m.prefix.length);
      if (m.suffix) { const i = v.indexOf(m.suffix); if (i >= 0) v = v.slice(0, i); }
      v = v.trim();
      if (v) return { type: m.type, value: v };
    }
    return null;
  };

  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const depth = depthOf(raw);
    const rest = strip(raw);
    let title = null, done = false;
    if (noteP && rest.startsWith(noteP)) { title = rest.slice(noteP.length); done = false; }
    else if (doneP && rest.startsWith(doneP)) { title = rest.slice(doneP.length); done = true; }
    if (title != null) {
      title = mdEscape(title);
      if (!title) continue;
      while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
      const node = { title, done, fields: [], children: [] };
      stack[stack.length - 1].node.children.push(node);
      stack.push({ depth, node });
      continue;
    }
    const field = fieldFor(rest);
    if (field) {
      while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
      const owner = stack[stack.length - 1];
      if (owner.depth >= 0) owner.node.fields.push(field);
    }
  }
  return roots;
}

/** In-page modal tree for picking an import parent — minimalist, titles only,
 *  collapsed by default, expand via the side arrows. */
function openParentPicker(onChoose) {
  const collapsed = new Set(
    [...store.nodes.values()].filter(n => nodeChildren(n.id).length).map(n => n.id),
  );
  const list = el('div.parent-tree');
  const overlay = el('div.modal-overlay', { onclick: e => { if (e.target === overlay) overlay.remove(); } });
  const close = () => overlay.remove();

  const render = () => {
    clear(list);
    list.append(el('button.tree-item', {
      onclick: () => { onChoose(null); close(); },
    }, el('span.tree-arrow.spacer'), el('span.tree-title.root', null, t('md.parentRoot'))));
    const walk = (nodes, depth) => {
      for (const n of nodes) {
        const kids = nodeChildren(n.id);
        const isCollapsed = collapsed.has(n.id);
        const arrow = kids.length
          ? el('span.tree-arrow', {
              onclick: e => {
                e.stopPropagation();
                if (collapsed.has(n.id)) collapsed.delete(n.id); else collapsed.add(n.id);
                render();
              },
            }, isCollapsed ? '▸' : '▾')
          : el('span.tree-arrow.spacer');
        list.append(el('button.tree-item', {
          style: `--d:${depth}`,
          onclick: () => { onChoose(n.id); close(); },
        }, arrow, el('span.tree-title', null, noteMainText(n) || t('list.untitled'))));
        if (!isCollapsed) walk(kids, depth + 1);
      }
    };
    walk(nodeChildren(null), 0);
  };
  render();

  overlay.append(el('div.modal.parent-modal',
    el('h3.modal-title', null, t('md.parentPickerTitle')),
    list,
    el('div.modal-actions', el('button.btn.ghost', { onclick: close }, t('common.cancel'))),
  ));
  document.body.append(overlay);
}

/** A free area to the right of the existing content — imports land there. */
function freeOrigin() {
  if (!store.nodes.size) return { x: 200, y: 200 };
  let maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of store.nodes.values()) {
    maxX = Math.max(maxX, n.x + (n.w || 220));
    minY = Math.min(minY, n.y);
    maxY = Math.max(maxY, n.y + (n.h || 220));
  }
  return { x: maxX + 260, y: (minY + maxY) / 2 - 120 };
}

/** Lay a tree out radially: each depth sits on its own ring, and every ring is
 *  sized from how many notes live on that depth, so they never pile onto each
 *  other (a 35-root import spreads wide instead of overlapping on one tiny
 *  circle). Roots form the inner ring; children fan out inside their parent's
 *  angular wedge, one ring per depth. Returns [{node,parent,x,y}]. */
function radialLayout(roots, cx, cy) {
  const out = [];
  const leafCount = n => n.children.length ? n.children.reduce((s, c) => s + leafCount(c), 0) : 1;

  // Count notes per depth so each ring can be sized to its own population.
  const depthCount = [];
  const countDepth = (nodes, d) => {
    depthCount[d] = (depthCount[d] || 0) + nodes.length;
    for (const n of nodes) if (n.children.length) countDepth(n.children, d + 1);
  };
  countDepth(roots, 0);

  // Ring radius per depth: wide enough for its node count to fit around the
  // circumference, and always outside the previous ring so levels don't collide.
  const W = 220;            // default note width (see NOTE_W in mindmap.js)
  const GAP = 64;           // min breathing room between neighbouring notes
  const RING = 300;         // min radial distance between successive rings
  const STEP = (W + GAP) / (Math.PI * 2);
  const radius = [];
  for (let d = 0; d < depthCount.length; d++) {
    const byCount = depthCount[d] * STEP;
    const byPrev = d ? radius[d - 1] + RING : 0;
    radius[d] = Math.max(byCount, byPrev);
  }

  const place = (nodes, a0, wedge, depth, parent) => {
    const totalLeaves = nodes.reduce((s, n) => s + leafCount(n), 0) || 1;
    let a = a0;
    for (const n of nodes) {
      const w = (leafCount(n) / totalLeaves) * wedge;
      const mid = a + w / 2;
      const r = radius[depth];
      out.push({ node: n, parent, x: Math.round(cx + r * Math.cos(mid)), y: Math.round(cy + r * Math.sin(mid)) });
      if (n.children.length) place(n.children, a, w, depth + 1, n);
      a += w;
    }
  };
  place(roots, 0, Math.PI * 2, 0, null);
  return out;
}

function importMarkdown() {
  const b = store.board?.board;
  if (!b) return;
  if (!canEdit()) { toast(t('app.noEditPerm'), 'error'); return; }

  const formatMd = el('button.btn.small', { onclick: () => setFormat('md') }, t('md.formatMarkdown'));
  const formatCustom = el('button.btn.small', { onclick: () => setFormat('custom') }, t('md.formatCustom'));

  // parent is picked from an in-page modal tree, not a dropdown
  let parentId = null;
  const parentLabel = id => id == null ? t('md.parentRoot') : (noteMainText(store.nodes.get(id)) || t('list.untitled'));
  const parentBtn = el('button.import-parent', {
    onclick: () => openParentPicker(id => { parentId = id; parentBtn.textContent = parentLabel(id); }),
  }, parentLabel(null));

  const notePat = customNoteInputs();
  const fieldPat = customFieldInputs();
  const noteWrap = el('div.import-note-patterns', null, el('div.dim', null, t('md.customNoteHint')), notePat.grid);
  const advanced = el('details.import-advanced', null,
    el('summary', null, t('md.advanced')),
    el('div.import-advanced-body', null,
      el('div.dim', null, t('md.customHint')),
      fieldPat.grid,
    ),
  );

  const overlay = el('div.modal-overlay', { onclick: e => { if (e.target === overlay) overlay.remove(); } },
    el('div.modal.md-modal',
      el('h3.modal-title', null, t('md.importTitle')),
      el('div.import-settings',
        el('div.import-formats', null,
          el('span.modal-label', null, t('md.formatLabel')),
          formatMd,
          formatCustom,
        ),
        el('label.modal-label', null, t('md.parentLabel')),
        parentBtn,
        noteWrap,
        advanced,
      ),
      el('div.md-body',
        el('div.md-col',
          el('label.modal-label', null, t('md.pasteLabel')),
          mdTextarea(),
          el('button.btn.small.md-file', { onclick: () => pickMarkdownFile(text => setText(text)) }, t('md.chooseFile')),
        ),
        el('div.md-col',
          el('div.md-prev-head', null, t('md.preview'), el('span.dim.md-count')),
          el('div.md-preview'),
        ),
      ),
      el('div.modal-actions',
        el('button.btn.ghost', { onclick: () => overlay.remove() }, t('common.cancel')),
        el('button.btn.primary', { onclick: doImport }, t('md.import')),
      ),
    ),
  );
  document.body.append(overlay);

  const ta = overlay.querySelector('textarea.md-text');
  const preview = overlay.querySelector('.md-preview');
  const countEl = overlay.querySelector('.md-count');
  const importBtn = overlay.querySelector('.btn.primary');
  let format = 'md';
  let current = [];

  function setFormat(f) {
    format = f;
    formatMd.classList.toggle('active', f === 'md');
    formatCustom.classList.toggle('active', f === 'custom');
    noteWrap.hidden = f !== 'custom';
    advanced.hidden = f !== 'custom';
    update();
  }

  function setText(text) { ta.value = text; update(); }

  function update() {
    current = format === 'custom' ? parseCustom(ta.value, customConfig(notePat.cfg, fieldPat.cfg)) : parseMarkdown(ta.value);
    clear(preview);
    if (!current.length) {
      preview.append(el('div.dim', null, ta.value.trim() ? t('md.nothing') : t('md.previewHint')));
      countEl.textContent = '';
      importBtn.disabled = true;
      return;
    }
    const { tree, nodes, fields } = renderPreview(current);
    preview.append(tree);
    countEl.textContent = `· ${nodes} ${t('md.nodes')} · ${fields} ${t('md.fields')}`;
    importBtn.disabled = false;
  }

  ta.addEventListener('input', update);
  // re-parse live when any custom pattern box changes (fixes: editing a prefix
  // without touching the text area used to leave preview/import stale)
  overlay.querySelectorAll('.pattern-grid input').forEach(inp => inp.addEventListener('input', update));
  setFormat('md');

  async function doImport() {
    if (!current.length) return;
    importBtn.disabled = true;
    const origin = freeOrigin();
    const laid = radialLayout(current, origin.x, origin.y);
    const idByNode = new Map();
    let created = 0, failed = 0;
    toast(t('app.importing', { n: current.length }));
    for (const { node, parent, x, y } of laid) {
      try {
        const p = parent ? idByNode.get(parent) : parentId;
        const n = await api.post(`/api/boards/${b.id}/nodes`, {
          parentId: p, title: (node.title || '').slice(0, 500), x, y,
        });
        idByNode.set(node, n.id);
        created++;
        if (node.done) { try { await api.patch(`/api/nodes/${n.id}/done`, { done: true }); } catch {} }
        for (const f of node.fields) {
          try { await api.post(`/api/nodes/${n.id}/fields`, { type: f.type, value: f.value }); } catch {}
        }
      } catch { failed++; }
    }
    await resync();
    overlay.remove();
    toast(failed ? t('app.importResultFail', { ok: created, fail: failed }) : t('app.importResult', { n: created }), failed ? 'error' : 'ok');
  }
}

function pickMarkdownFile(cb) {
  const inp = el('input', { type: 'file', accept: '.md,.markdown,.txt,text/markdown,text/plain' });
  inp.onchange = async () => {
    const file = inp.files[0];
    if (!file) return;
    try { cb(await file.text()); } catch (e) { toast(e.message, 'error'); }
  };
  inp.click();
}

function mdTextarea(value = '', readonly = false) {
  const ta = el('textarea.md-text', { spellcheck: false, ...(readonly ? {} : { placeholder: t('md.pastePlaceholder') }) });
  if (readonly) ta.setAttribute('readonly', '');
  ta.value = value;
  return ta;
}

/** Parse markdown into a node tree: {title, done, fields:[{type,value}], children[]}.
 *  Nodes are `- [ ] title`, `- [x] title`, plain bullets or `#` headings;
 *  fields are indented `- [type] value` lines (text/date/time/datetime/link/image).
 *  Images only round-trip when exported as `file:<id>`. */
function parseMarkdown(text) {
  const roots = [];
  const stack = [{ depth: -1, node: { fields: [], children: roots } }];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ');
    if (!line.trim() || line.trim() === '---') continue;
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      const title = mdEscape(heading[1]);
      if (!title) continue;
      stack.length = 1; // headings are top-level nodes
      const node = { title, done: false, fields: [], children: [] };
      stack[0].node.children.push(node);
      stack.push({ depth: 0, node });
      continue;
    }
    const bullet = line.match(/^(\s*)(?:[-*+]\s+|\d+[.)]\s+)(.*)$/);
    if (!bullet) continue;
    const depth = Math.floor(bullet[1].length / 2);
    let rest = bullet[2];
    let done = false;
    const cb = rest.match(/^\[([ xX])\]\s*(.*)$/);
    if (cb) { done = cb[1].toLowerCase() === 'x'; rest = cb[2]; }
    const field = rest.match(/^\[(text|date|time|datetime|link|image)\]\s+(.*)$/);
    // find the parent by popping entries at or deeper than this depth
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack[stack.length - 1];
    if (field) {
      const value = field[2].trim();
      if (!value) continue;
      if (field[1] === 'image') {
        const fid = value.match(/^file:(\d+)$/);
        if (!fid) continue; // external image URL — not representable as a file field
        parent.node.fields.push({ type: 'image', value: fid[1] });
      } else {
        parent.node.fields.push({ type: field[1], value });
      }
      continue;
    }
    // standard markdown link `[text](url)` → a link field
    const link = rest.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const url = link[2].trim();
      if (url) parent.node.fields.push({ type: 'link', value: url });
      continue;
    }
    const title = mdEscape(rest);
    if (!title) continue;
    const node = { title, done, fields: [], children: [] };
    parent.node.children.push(node);
    stack.push({ depth, node });
  }
  return roots;
}

/** Render a preview of the parsed tree (nodes + fields, indented). */
function renderPreview(roots) {
  const tree = el('div.md-preview-tree');
  let nodes = 0, fields = 0;
  const render = (list, depth) => {
    for (const it of list) {
      nodes++;
      tree.append(el('div.md-prev-node', { style: `--d:${depth}` },
        el('span.md-prev-chk', null, it.done ? '☑' : '☐'),
        el('span.md-prev-title', null, it.title || t('list.untitled')),
      ));
      for (const f of it.fields) {
        fields++;
        tree.append(el('div.md-prev-field', { style: `--d:${depth + 1}` },
          el('span.md-prev-ico', null, FIELD_ICON[f.type] || '•'),
          el('span.md-prev-type', null, t(FIELD_LABEL[f.type] || 'field.note')),
          el('span.md-prev-val', { title: f.value }, f.type === 'image' ? `#${f.value}` : f.value),
        ));
      }
      render(it.children, depth + 1);
    }
  };
  render(roots, 0);
  return { tree, nodes, fields };
}

async function openBoard(id) {
  if (store.board?.board?.id === id) return;
  try {
    store.board = await api.get(`/api/boards/${id}`);
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  markSeen(id, store.board?.board?.updatedAt);
  store.nodes.clear();
  store.selections.clear();
  store.editMode = false;
  resetUndo();
  try {
    const nodes = await api.get(`/api/boards/${id}/nodes`);
    store.nodes.clear();
    for (const n of nodes) store.nodes.set(n.id, n);
  } catch (e) { toast(e.message, 'error'); }
  try {
    store.prefs = { tab: 'list', panX: null, panY: null, zoom: 1, collapsed: [], ...(await api.get(`/api/boards/${id}/prefs`)) };
  } catch { store.prefs = { tab: 'list', panX: null, panY: null, zoom: 1, collapsed: [] }; }
  // First open: collapse every parent so the tree starts tidy (per-user).
  // Once flagged, the user's own expand/collapse state is respected thereafter.
  if (!store.prefs.collapsedInit) {
    store.prefs.collapsed = [...store.nodes.values()]
      .filter(n => nodeChildren(n.id).length)
      .map(n => n.id);
    store.prefs.collapsedInit = true;
    savePrefsDebounced();
  }
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
  const mainPanel = document.getElementById('mm-tb-main');
  const editing = on_ && canEdit();
  if (btn) {
    btn.textContent = editing ? t('app.editMode') : t('app.viewMode');
    btn.classList.toggle('active', editing);
    btn.closest('.tb-group')?.classList.toggle('hidden', !canEdit());
  }
  addBtn?.closest('.tb-group')?.classList.toggle('hidden', !editing);
  mainPanel?.classList.toggle('hidden', !canEdit());
  updateSelectModeUI();
  refreshUndoUI();
}

function updateSelectModeUI(on_ = mm.isSelectMode()) {
  const btn = document.getElementById('mm-select-toggle');
  btn?.classList.toggle('active', on_);
  updateAreaSelectUI();
}

function updateAreaSelectUI(on_ = mm.isAreaSelectMode()) {
  const btn = document.getElementById('mm-area-toggle');
  if (!btn) return;
  btn.classList.toggle('active', on_);
  btn.hidden = !mm.isSelectMode();
}

async function doUndo() {
  try { await undo(); } catch (e) { toast(e.message, 'error'); }
}

async function doRedo() {
  try { await redo(); } catch (e) { toast(e.message, 'error'); }
}

function refreshUndoUI() {
  const u = document.getElementById('mm-undo');
  const r = document.getElementById('mm-redo');
  if (u) u.disabled = !canUndo();
  if (r) r.disabled = !canRedo();
}

let keysWired = false;
function wireKeys() {
  if (keysWired) return;
  keysWired = true;
  document.addEventListener('keydown', e => {
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && e.shiftKey) { e.preventDefault(); doRedo(); }
    else if (k === 'z') { e.preventDefault(); doUndo(); }
    else if (k === 'y') { e.preventDefault(); doRedo(); }
  });
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
      }, avatar({ userId: u.userId, username: u.username }, 'md'),
        el('span.presence-username', null, u.username),
      ),
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
  const suggest = el('div.user-suggest');
  const searchWrap = el('div.share-search', userInput, suggest);
  const roleSel = el('select.input', null,
    el('option', { value: 'viewer' }, t('common.role.viewer')),
    el('option', { value: 'editor' }, t('common.role.editor')),
  );

  // Live search: as the owner types a username, list matching users to pick from.
  const runSearch = debounce(async () => {
    const q = userInput.value.trim();
    if (q.length < 3) { clear(suggest); return; }
    try {
      const users = await api.get('/api/users/search?q=' + encodeURIComponent(q));
      clear(suggest);
      if (!users.length) {
        suggest.append(el('div.user-suggest-empty', null, t('friends.noUsersFound')));
        return;
      }
      for (const u of users) {
        suggest.append(el('button.user-suggest-item', {
          onclick: () => { userInput.value = u.username; clear(suggest); },
        },
          avatar({ userId: u.userId, username: u.username }, 'sm'),
          el('span', null, u.username),
        ));
      }
    } catch (e) { /* dropdown is best-effort */ }
  }, 200);
  userInput.addEventListener('input', runSearch);
  userInput.addEventListener('blur', () => { setTimeout(() => clear(suggest), 150); });

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
        searchWrap,
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
  on('history', refreshUndoUI);
  // Remote selection hints are handled per-view (mindmap renderSelections,
  // listview renderRemoteHints) — a full 'nodes replace' here used to rebuild
  // the whole board on every collaborator cursor move.
  // friends panel "open this board" navigation (avoids a circular app.js import)
  on('open-board', id => openBoard(id));
  // friend requests/friends changed → refresh the sidebar badge
  on('friends-changed', () => refreshFriendBadge());
}
