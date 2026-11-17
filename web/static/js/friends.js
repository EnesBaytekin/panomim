// Friends system: request/accept flow, friends list, shared boards and the
// share-to-friend flow. Rendered as a modal overlay with internal screens.
import { api } from './api.js';
import { el, clear, toast, avatar, confirmDialog, debounce } from './ui.js';
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

  const addInput = el('input.input', { placeholder: t('friends.searchPlaceholder'), maxlength: 32, autocapitalize: 'off', autocomplete: 'off' });
  const suggest = el('div.user-suggest');
  const addBtn = el('button.btn.primary', {
    onclick: async () => {
      const uname = addInput.value.trim();
      if (!uname) return;
      addBtn.disabled = true;
      try {
        await sendRequest(uname);
      } finally { addBtn.disabled = false; }
    },
  }, t('friends.add'));
  addInput.addEventListener('keydown', e => { if (e.key === 'Enter') addBtn.click(); });
  body.append(el('div.friends-add-wrap', el('div.friends-add', addInput, addBtn), suggest));

  // Shared add helper: sends a request by username, clears the input and refreshes.
  async function sendRequest(uname) {
    const res = await api.post('/api/friends/requests', { username: uname });
    addInput.value = '';
    clear(suggest);
    toast(res.autoAccepted ? t('friends.autoAccepted', { name: uname }) : t('friends.requestSent', { name: uname }), 'ok');
    emit('friends-changed');
    await refresh();
  }

  // Autocomplete: as you type, list matching existing users to pick from.
  const runSearch = debounce(async () => {
    const q = addInput.value.trim();
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
          onclick: async () => {
            clear(suggest);
            addInput.value = u.username;
            addBtn.disabled = true;
            try { await sendRequest(u.username); }
            catch (e) { toast(e.message, 'error'); }
            finally { addBtn.disabled = false; }
          },
        },
          avatar({ userId: u.userId, username: u.username }, 'sm'),
          el('span', null, u.username),
        ));
      }
    } catch (e) { /* ignore — dropdown is best-effort */ }
  }, 200);
  addInput.addEventListener('input', runSearch);
  addInput.addEventListener('blur', () => { setTimeout(() => clear(suggest), 150); });

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
            try { await api.post(`/api/friends/requests/${r.id}/accept`); toast(t('friends.added', { name: r.username }), 'ok'); emit('friends-changed'); refresh(); }
            catch (e) { toast(e.message, 'error'); }
          },
        }, t('friends.accept')),
        el('button.btn.small.ghost', {
          onclick: async () => {
            try { await api.del(`/api/friends/requests/${r.id}`); emit('friends-changed'); refresh(); }
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
            try { await api.del(`/api/friends/requests/${r.id}`); emit('friends-changed'); refresh(); }
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
      list.append(el('div.friend-row', {
        onclick: () => showFriend(body, overlay, f),
      },
        avatar({ userId: f.userId, username: f.username }, 'md'),
        el('span.friend-name', null, f.username,
          f.sharedCount > 0 && el('span.friend-sub', null, t('friends.sharedCount', { n: f.sharedCount }))),
        el('div.friend-actions',
          el('button.icon-btn.remove-friend', {
            title: t('friends.removeFriend'),
            onclick: async e => {
              e.stopPropagation();
              const ok = await confirmDialog({
                title: t('friends.removeTitle', { name: f.username }),
                body: t('friends.removeBody', { name: f.username }),
                confirmText: t('friends.remove'),
                danger: true,
              });
              if (!ok) return;
              try {
                await api.del(`/api/friends/${f.userId}`);
                toast(t('friends.removed', { name: f.username }), 'ok');
                emit('friends-changed');
                showFriends(body, overlay);
              } catch (e) { toast(e.message, 'error'); }
            },
          }, '✕'),
        ),
      ));
    }
  } else {
    list.append(el('div.board-empty', null, t('friends.empty')));
  }
}

/** Friend detail: profile photo, shared boards with members + "share a board". */
async function showFriend(body, overlay, friend) {
  clear(body);
  const bigAvatar = avatar({ userId: friend.userId, username: friend.username }, 'lg');
  bigAvatar.title = t('friends.photoTip');
  bigAvatar.addEventListener('click', () => showLargeAvatar(friend));
  body.append(el('div.friends-head',
    el('button.icon-btn', { title: t('friends.back'), onclick: () => showFriends(body, overlay) }, '←'),
    bigAvatar,
    el('div.profile-id',
      el('div.profile-name', null, friend.username),
    ),
  ));

  const sharedList = el('div.friends-body');
  body.append(sharedList);

  let boards = [];
  try { boards = await api.get(`/api/friends/${friend.userId}/boards`); }
  catch (e) { toast(e.message, 'error'); }

  if (boards.length) {
    sharedList.append(el('div.friends-section', null, t('friends.sharedBoards')));
    for (const b of boards) {
      sharedList.append(el('div.shared-board-card',
        el('div.shared-board-head',
          el('span.board-name', null, b.name),
          el('div.friend-actions',
            el('button.btn.small', { onclick: () => { overlay.remove(); emit('open-board', b.id); } }, t('friends.open')),
          ),
        ),
        el('div.shared-board-roles',
          el('span.role-pill', null, t('friends.youRole', { role: roleLabel(b.myRole) })),
          el('span.role-pill', null, t('friends.friendRole', { name: friend.username, role: roleLabel(b.friendRole) })),
        ),
        el('div.shared-board-members', null,
          (b.members || []).map(m => el('span.member-chip', { title: m.username + ' · ' + roleLabel(m.role) },
            avatar({ userId: m.userId, username: m.username }, 'sm'),
            el('span.member-name', null, m.username),
          )),
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

/** Large in-page photo popup for a friend (read-only). */
function showLargeAvatar(friend) {
  const overlay = el('div.modal-overlay', { onclick: e => { if (e.target === overlay) overlay.remove(); } },
    el('div.modal.avatar-modal',
      avatar({ userId: friend.userId, username: friend.username }, 'xl'),
      el('div.profile-name', null, friend.username),
      el('div.modal-actions',
        el('button.btn.ghost', { onclick: () => overlay.remove() }, t('common.close')),
      ),
    ),
  );
  document.body.append(overlay);
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
          toast(t('friends.shareRequested', { board: board.name, friend: friend.username }), 'ok');
          showFriend(body, overlay, friend);
        } catch (e) { toast(e.message, 'error'); }
      },
    }, t('friends.share')),
  ));
}
