// Notification inbox: bell badge, panel, and accept/decline for board-share
// requests. Items are fetched on load and updated live over the websocket.
import { api } from './api.js';
import { el, clear, toast, popover } from './ui.js';
import { on, emit } from './store.js';
import { t } from './i18n.js';
import { openFriends } from './friends.js';

let items = [];
let bellEl = null;
let badgeEl = null;

function timeAgo(ts) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - (ts || 0)));
  if (s < 60) return t('notif.justNow');
  const m = Math.floor(s / 60);
  if (m < 60) return t('notif.minutesAgo', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('notif.hoursAgo', { n: h });
  return t('notif.daysAgo', { n: Math.floor(h / 24) });
}

function bodyText(n) {
  const v = { name: n.actorName || '?', board: n.boardName || '?' };
  switch (n.type) {
    case 'friend_request': return t('notif.friendRequest', v);
    case 'friend_accept': return t('notif.friendAccept', v);
    case 'board_share': return t('notif.boardShare', { ...v, role: t('common.role.' + (n.role || 'viewer')) });
    case 'board_share_accept': return t('notif.boardShareAccept', v);
    case 'board_renamed': return t('notif.boardRenamed', v);
    case 'board_deleted': return t('notif.boardDeleted', v);
    case 'board_removed': return t('notif.boardRemoved', v);
    default: return '';
  }
}

function updateBadge() {
  if (!badgeEl) return;
  badgeEl.hidden = items.length === 0;
  badgeEl.textContent = items.length > 99 ? '99+' : String(items.length);
}

function addItem(n) {
  if (items.some(x => x.id === n.id)) return;
  items.unshift(n);
  updateBadge();
}

function removeItem(id) {
  items = items.filter(x => x.id !== id);
  updateBadge();
}

export async function refreshNotifications() {
  try {
    items = await api.get('/api/notifications');
  } catch { items = []; }
  updateBadge();
}

export function initNotifications() {
  refreshNotifications();
  // live push from the websocket (see ws.js "notification" case)
  on('notification', n => { addItem(n); toast(bodyText(n), 'info'); });
}

/** Bell button (placed in the header). Opens the panel on click. */
export function bellButton() {
  badgeEl = el('span.bell-badge', { hidden: true });
  bellEl = el('button.icon-btn.bell-btn', {
    title: t('notif.title'),
    onclick: e => openPanel(e.currentTarget),
  }, '🔔', badgeEl);
  return bellEl;
}

function openPanel(anchor) {
  const { pop } = popover(anchor, { placement: 'bottom-end' });
  pop.classList.add('notif-panel');
  renderPanel(pop);
  // keep fresh as actions happen
}

function renderPanel(pop) {
  clear(pop);
  pop.append(el('div.pop-title', null, t('notif.title')));

  if (!items.length) {
    pop.append(el('div.notif-empty', null, t('notif.empty')));
    return;
  }

  const list = el('div.notif-list');
  for (const n of items) list.append(renderItem(n, pop));
  pop.append(list);

  pop.append(el('button.btn.ghost.small.notif-clear', {
    onclick: async () => {
      try { await api.del('/api/notifications'); items = []; updateBadge(); renderPanel(pop); }
      catch (e) { toast(e.message, 'error'); }
    },
  }, t('notif.clearAll')));
}

function renderItem(n, pop) {
  const del = e => {
    if (e) e.stopPropagation();
    api.del(`/api/notifications/${n.id}`).then(() => { removeItem(n.id); renderPanel(pop); }).catch(err => toast(err.message, 'error'));
  };

  const row = el('div.notif-item' + (n.type === 'board_share' ? '.actionable' : ''));
  const text = el('div.notif-text', null, bodyText(n), el('span.notif-time', null, timeAgo(n.createdAt)));
  const delBtn = el('button.icon-btn.tiny.notif-del', { title: t('common.delete'), onclick: del }, '✕');

  if (n.type === 'board_share') {
    row.append(text,
      el('div.notif-actions',
        el('button.btn.small.primary', {
          onclick: async () => {
            try {
              await api.post(`/api/notifications/${n.id}/accept`);
              toast(t('notif.accepted'), 'ok');
              removeItem(n.id);
              emit('boards-changed');   // refresh the sidebar "shared with me" list
              renderPanel(pop);
            } catch (e) { toast(e.message, 'error'); }
          },
        }, t('notif.accept')),
        el('button.btn.small.ghost', {
          onclick: async () => {
            try {
              await api.post(`/api/notifications/${n.id}/decline`);
              toast(t('notif.declined'), 'ok');
              removeItem(n.id);
              renderPanel(pop);
            } catch (e) { toast(e.message, 'error'); }
          },
        }, t('notif.decline')),
        delBtn,
      ));
  } else {
    row.append(text, delBtn);
    if (n.type === 'friend_request') {
      row.addEventListener('click', () => openFriends());
      row.classList.add('clickable');
    }
  }
  return row;
}
