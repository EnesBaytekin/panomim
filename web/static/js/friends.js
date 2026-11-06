// Friends system: request/accept flow, friends list, shared boards and the
// share-to-friend flow. Rendered as a modal overlay with internal screens.
import { api } from './api.js';
import { el, clear, toast, avatar } from './ui.js';
import { emit } from './store.js';

const roleLabel = { owner: 'sahip', editor: 'düzenleyici', viewer: 'görüntüleyici' };

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
  body.append(el('h3.modal-title', null, 'Arkadaşlar'));

  const addInput = el('input.input', { placeholder: 'kullanıcı adı', maxlength: 32, autocapitalize: 'off', autocomplete: 'off' });
  const addBtn = el('button.btn.primary', {
    onclick: async () => {
      const uname = addInput.value.trim();
      if (!uname) return;
      addBtn.disabled = true;
      try {
        const res = await api.post('/api/friends/requests', { username: uname });
        addInput.value = '';
        toast(res.autoAccepted ? `${uname} ile zaten istekleşmiştiniz — arkadaş eklendi` : `${uname} adresine istek gönderildi`, 'ok');
        await refresh();
      } catch (e) { toast(e.message, 'error'); }
      finally { addBtn.disabled = false; }
    },
  }, 'Arkadaş ekle');
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
    el('button.btn.ghost', { onclick: () => overlay.remove() }, 'Kapat'),
  ));
  refresh().catch(e => toast(e.message, 'error'));
}

function renderRequests(list, reqs, refresh) {
  if (!reqs.incoming.length && !reqs.outgoing.length) return;

  list.append(el('div.friends-section', null, 'İstekler'));
  for (const r of reqs.incoming) {
    list.append(el('div.friend-row',
      avatar({ userId: r.userId, username: r.username }, 'md'),
      el('span.friend-name', null, r.username, el('span.friend-sub', null, 'seni arkadaş olarak eklemek istiyor')),
      el('div.friend-actions',
        el('button.btn.small.primary', {
          onclick: async () => {
            try { await api.post(`/api/friends/requests/${r.id}/accept`); toast(`${r.username} ile arkadaş oldunuz`, 'ok'); refresh(); }
            catch (e) { toast(e.message, 'error'); }
          },
        }, 'Kabul et'),
        el('button.btn.small.ghost', {
          onclick: async () => {
            try { await api.del(`/api/friends/requests/${r.id}`); refresh(); }
            catch (e) { toast(e.message, 'error'); }
          },
        }, 'Reddet'),
      ),
    ));
  }
  for (const r of reqs.outgoing) {
    list.append(el('div.friend-row',
      avatar({ userId: r.userId, username: r.username }, 'md'),
      el('span.friend-name', null, r.username, el('span.friend-sub', null, 'istek bekleniyor')),
      el('div.friend-actions',
        el('button.btn.small.ghost', {
          onclick: async () => {
            try { await api.del(`/api/friends/requests/${r.id}`); refresh(); }
            catch (e) { toast(e.message, 'error'); }
          },
        }, 'İptal'),
      ),
    ));
  }
}

function renderFriends(list, friends, body, overlay) {
  if (friends.length) {
    list.append(el('div.friends-section', null, `Arkadaşlarım (${friends.length})`));
    for (const f of friends) {
      list.append(el('div.friend-row',
        avatar({ userId: f.userId, username: f.username }, 'md'),
        el('span.friend-name', null, f.username,
          f.sharedCount > 0 && el('span.friend-sub', null, `${f.sharedCount} ortak pano`)),
        el('div.friend-actions',
          el('button.btn.small', { onclick: () => showFriend(body, overlay, f) }, 'Aç'),
        ),
      ));
    }
  } else {
    list.append(el('div.board-empty', null, 'Henüz arkadaş yok — yukarıdan kullanıcı adıyla ekleyebilirsin.'));
  }
}

/** Friend detail: shared boards + "share a board". */
async function showFriend(body, overlay, friend) {
  clear(body);
  body.append(el('div.friends-head',
    el('button.icon-btn', { title: 'geri', onclick: () => showFriends(body, overlay) }, '←'),
    el('h3.modal-title', null, friend.username),
    avatar({ userId: friend.userId, username: friend.username }, 'lg'),
  ));

  const sharedList = el('div.friends-body');
  body.append(sharedList);

  let boards = [];
  try { boards = await api.get(`/api/friends/${friend.userId}/boards`); }
  catch (e) { toast(e.message, 'error'); }

  if (boards.length) {
    sharedList.append(el('div.friends-section', null, 'Ortak panolar'));
    for (const b of boards) {
      sharedList.append(el('div.friend-row.board-row',
        el('span.board-name', null, b.name, el('span.friend-sub', null, roleText(b, friend.username))),
        el('div.friend-actions',
          el('button.btn.small', { onclick: () => { overlay.remove(); emit('open-board', b.id); } }, 'Aç'),
        ),
      ));
    }
  } else {
    sharedList.append(el('div.board-empty', null, 'Henüz ortak pano yok.'));
  }

  body.append(el('div.modal-actions',
    el('button.btn.ghost', { onclick: () => showFriends(body, overlay) }, 'Geri'),
    el('button.btn.primary', { onclick: () => showShare(body, overlay, friend) }, '👥 Pano paylaş'),
  ));
}

function roleText(b, friendName) {
  const mine = `sen: ${roleLabel[b.myRole] || b.myRole}`;
  const theirs = `${friendName}: ${roleLabel[b.friendRole] || b.friendRole}`;
  return `${mine} · ${theirs}`;
}

/** Step 1 of sharing: pick one of my (owned) boards. */
async function showShare(body, overlay, friend) {
  clear(body);
  body.append(el('div.friends-head',
    el('button.icon-btn', { title: 'geri', onclick: () => showFriend(body, overlay, friend) }, '←'),
    el('h3.modal-title', null, `Pano paylaş → ${friend.username}`),
  ));

  const list = el('div.friends-body');
  body.append(list);

  let boards = [];
  try { boards = (await api.get('/api/boards')).filter(b => b.role === 'owner'); }
  catch (e) { toast(e.message, 'error'); }

  if (!boards.length) {
    list.append(el('div.board-empty', null, 'Sahip olduğun pano yok.'));
  } else {
    list.append(el('div.friends-section', null, 'Bir pano seç'));
    for (const b of boards) {
      list.append(el('button.friend-row.board-row', {
        onclick: () => showShareRole(body, overlay, friend, b),
      },
        el('span.board-name', null, b.name,
          b.sharedCount > 0 && el('span.friend-sub', null, `${b.sharedCount} kişiyle paylaşılıyor`)),
        el('span', null, '›'),
      ));
    }
  }

  body.append(el('div.modal-actions',
    el('button.btn.ghost', { onclick: () => showFriend(body, overlay, friend) }, 'Geri'),
  ));
}

/** Step 2: choose a role and confirm. */
function showShareRole(body, overlay, friend, board) {
  clear(body);
  body.append(el('div.friends-head',
    el('button.icon-btn', { title: 'geri', onclick: () => showShare(body, overlay, friend) }, '←'),
    el('h3.modal-title', null, `“${board.name}” → ${friend.username}`),
  ));

  const roleSel = el('select.input', null,
    el('option', { value: 'viewer' }, 'görüntüleyici'),
    el('option', { value: 'editor' }, 'düzenleyici'),
  );

  body.append(el('div.friends-body',
    el('p.dim', null, `“${board.name}” panosunu ${friend.username} ile paylaşacaksın.`),
    el('label.modal-label', null, 'Rol'),
    roleSel,
  ));

  body.append(el('div.modal-actions',
    el('button.btn.ghost', { onclick: () => showFriend(body, overlay, friend) }, 'Vazgeç'),
    el('button.btn.primary', {
      onclick: async () => {
        try {
          await api.post(`/api/boards/${board.id}/share`, { username: friend.username, role: roleSel.value });
          toast(`${board.name} → ${friend.username} paylaşıldı`, 'ok');
          showFriend(body, overlay, friend);
        } catch (e) { toast(e.message, 'error'); }
      },
    }, 'Paylaş'),
  ));
}
