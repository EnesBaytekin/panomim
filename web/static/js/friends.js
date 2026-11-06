// Friends system: request/accept flow, friends list, shared boards and the
// share-to-friend flow. Rendered as a modal overlay with internal screens.
import { api } from './api.js';
import { el, clear, toast, avatar } from './ui.js';
import { emit } from './store.js';
import { t } from './i18n.js';

function roleLabel(role) {
  return t('common.role.' + role) || role;
}

export function openFriends() {
  const overlay = el('div.modal-overlay', { onclick: e => { if (e.target === overlay) overlay.remove(); } },
    el('div.modal.wide.friends-modal'),
  );
  document.body.append(overlay);
  showFriends(overlay.querySelector('.friends-modal'), overlay);
}

/** Main screen: add-by-username, incoming/outgoing requests, friend list. */
function showFriends(body, overlay) {
  clear(body);
  body.append(el('h3.modal-title', null, t('friends.title')));

  const addInput = el('input.input', { placeholder: t('auth.username'), maxlength: 32, autocapitalize: 'off', autocomplete: 'off' });
  const addBtn = el('button.btn.primary', {
    onclick: async () => {
      const uname = addInput.value.trim();
      if (!uname) return;
      addBtn.disabled = true;
      try {
        const res = await api.post('/api/friends/requests', { username: uname });
        addInput.value = '';
        toast(res.autoAccepted ? t('friends.autoAccepted', { name: uname }) : t('friends.requestSent', { name: uname }), 'ok');
        await refresh();
      } catch (e) { toast(e.message, 'error'); }
      finally { addBtn.disabled = false; }
    },
  }, t('friends.add'));
  addInput.addEventListener('keydown', e => { if (e.key === 'Enter') addBtn.click(); });
  body.append(el('div.friends-add', addInput, addBtn));

  const list = el('div.friends-body');
  body.append(list);

  async function refresh() {
    clear(list);
    const reqs = await api.get('/api/friends/requests');
    const friends = await api.get('/api/friends');
    renderRequests(list, reqs, refresh);
    renderFriends(list, friends, body, overlay);
  }

  body.append(el('div.modal-actions',
    el('button.btn.ghost', { onclick: () => overlay.remove() }, t('common.close')),
  ));
  refresh().catch(e => toast(e.message, 'error'));
}

function renderRequests(list, reqs, refresh) {
  if (!reqs.incoming.length && !reqs.outgoing.length) return;

  list.append(el('div.friends-section', null, t('friends.requests')));
  for (const r of reqs.incoming) {
    list.append(el('div.friend-row',
      avatar({ userId: r.userId, username: r.username }, 'md'),
      el('span.friend-name', null, r.username, el('span.friend-sub', null, t('friends.wantsToAdd'))),
      el('div.friend-actions',
        el('button.btn.small.primary', {
          onclick: async () => {
            try { await api.post(`/api/friends/requests/${r.id}/accept`); toast(t('friends.added', { name: r.username }), 'ok'); refresh(); }
            catch (e) { toast(e.message, 'error'); }
          },
        }, t('friends.accept')),
        el('button.btn.small.ghost', {
          onclick: async () => {
            try { await api.del(`/api/friends/requests/${r.id}`); refresh(); }
            catch (e) { toast(e.message, 'error'); }
          },
        }, t('friends.decline')),
      ),
    ));
  }
  for (const r of reqs.outgoing) {
    list.append(el('div.friend-row',
      avatar({ userId: r.userId, username: r.username }, 'md'),
      el('span.friend-name', null, r.username, el('span.friend-sub', null, t('friends.pending'))),
      el('div.friend-actions',
        el('button.btn.small.ghost', {
          onclick: async () => {
            try { await api.del(`/api/friends/requests/${r.id}`); refresh(); }
            catch (e) { toast(e.message, 'error'); }
          },
        }, t('friends.cancel')),
      ),
    ));
  }
}

function renderFriends(list, friends, body, overlay) {
  if (friends.length) {
    list.append(el('div.friends-section', null, t('friends.myFriends', { n: friends.length })));
    for (const f of friends) {
      list.append(el('div.friend-row',
        avatar({ userId: f.userId, username: f.username }, 'md'),
        el('span.friend-name', null, f.username,
          f.sharedCount > 0 && el('span.friend-sub', null, t('friends.sharedCount', { n: f.sharedCount }))),
        el('div.friend-actions',
          el('button.btn.small', { onclick: () => showFriend(body, overlay, f) }, t('friends.open')),
        ),
      ));
    }
  } else {
    list.append(el('div.board-empty', null, t('friends.empty')));
  }
}

/** Friend detail: shared boards + "share a board". */
async function showFriend(body, overlay, friend) {
  clear(body);
  body.append(el('div.friends-head',
    el('button.icon-btn', { title: t('friends.back'), onclick: () => showFriends(body, overlay) }, '←'),
    el('h3.modal-title', null, friend.username),
    avatar({ userId: friend.userId, username: friend.username }, 'lg'),
  ));

  const sharedList = el('div.friends-body');
  body.append(sharedList);

  let boards = [];
  try { boards = await api.get(`/api/friends/${friend.userId}/boards`); }
  catch (e) { toast(e.message, 'error'); }

  if (boards.length) {
    sharedList.append(el('div.friends-section', null, t('friends.sharedBoards')));
    for (const b of boards) {
      sharedList.append(el('div.friend-row.board-row',
        el('span.board-name', null, b.name, el('span.friend-sub', null, roleText(b, friend.username))),
        el('div.friend-actions',
          el('button.btn.small', { onclick: () => { overlay.remove(); emit('open-board', b.id); } }, t('friends.open')),
        ),
      ));
    }
  } else {
    sharedList.append(el('div.board-empty', null, t('friends.noShared')));
  }

  body.append(el('div.modal-actions',
    el('button.btn.ghost', { onclick: () => showFriends(body, overlay) }, t('common.back')),
    el('button.btn.primary', { onclick: () => showShare(body, overlay, friend) }, t('friends.share')),
  ));
}

function roleText(b, friendName) {
  return t('friends.roles', { mine: roleLabel(b.myRole), friend: friendName, theirs: roleLabel(b.friendRole) });
}

/** Step 1 of sharing: pick one of my (owned) boards. */
async function showShare(body, overlay, friend) {
  clear(body);
  body.append(el('div.friends-head',
    el('button.icon-btn', { title: t('friends.back'), onclick: () => showFriend(body, overlay, friend) }, '←'),
    el('h3.modal-title', null, t('friends.shareTitle', { name: friend.username })),
  ));

  const list = el('div.friends-body');
  body.append(list);

  let boards = [];
  try { boards = (await api.get('/api/boards')).filter(b => b.role === 'owner'); }
  catch (e) { toast(e.message, 'error'); }

  if (!boards.length) {
    list.append(el('div.board-empty', null, t('friends.noOwnedBoards')));
  } else {
    list.append(el('div.friends-section', null, t('friends.pickBoard')));
    for (const b of boards) {
      list.append(el('button.friend-row.board-row', {
        onclick: () => showShareRole(body, overlay, friend, b),
      },
        el('span.board-name', null, b.name,
          b.sharedCount > 0 && el('span.friend-sub', null, t('app.sharedWithCount', { n: b.sharedCount }))),
        el('span', null, '›'),
      ));
    }
  }

  body.append(el('div.modal-actions',
    el('button.btn.ghost', { onclick: () => showFriend(body, overlay, friend) }, t('common.back')),
  ));
}

/** Step 2: choose a role and confirm. */
function showShareRole(body, overlay, friend, board) {
  clear(body);
  body.append(el('div.friends-head',
    el('button.icon-btn', { title: t('friends.back'), onclick: () => showShare(body, overlay, friend) }, '←'),
    el('h3.modal-title', null, t('friends.shareToTitle', { name: board.name, friend: friend.username })),
  ));

  const roleSel = el('select.input', null,
    el('option', { value: 'viewer' }, t('common.role.viewer')),
    el('option', { value: 'editor' }, t('common.role.editor')),
  );

  body.append(el('div.friends-body',
    el('p.dim', null, t('friends.shareConfirmBody', { name: board.name, friend: friend.username })),
    el('label.modal-label', null, t('friends.role')),
    roleSel,
  ));

  body.append(el('div.modal-actions',
    el('button.btn.ghost', { onclick: () => showFriend(body, overlay, friend) }, t('common.cancel')),
    el('button.btn.primary', {
      onclick: async () => {
        try {
          await api.post(`/api/boards/${board.id}/share`, { username: friend.username, role: roleSel.value });
          toast(t('friends.shared', { board: board.name, friend: friend.username }), 'ok');
          showFriend(body, overlay, friend);
        } catch (e) { toast(e.message, 'error'); }
      },
    }, t('friends.share')),
  ));
}
