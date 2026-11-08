// Central application state with a tiny pub/sub bus.

export const store = {
  user: null,
  boards: [],
  board: null,          // {board, members}
  nodes: new Map(),     // id -> node (with fields[])
  prefs: { tab: 'list', panX: 0, panY: 0, zoom: 1, collapsed: [] },
  presence: new Map(),  // userId -> {userId, username, color}
  selections: new Map(),// userId -> nodeId (remote users' selections)
  editMode: false,      // mindmap edit mode
  online: false,
};

const listeners = new Map();

// Cached parentId -> children index. Invalidation is cheap; building is O(N log N)
// and only happens once per change burst, so tree walks (list view render, export,
// subtree ops) stop rescanning + re-sorting all nodes on every level.
let childrenIndex = null;

/** on('nodes', fn) -> unsubscribe */
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export function emit(event, payload) {
  listeners.get(event)?.forEach(fn => fn(payload));
  listeners.get('*')?.forEach(fn => fn(event, payload));
}

/** Replace the whole node set (board load / resync). */
export function setNodes(list) {
  store.nodes.clear();
  for (const n of list) store.nodes.set(n.id, n);
  childrenIndex = null;
  emit('nodes', 'replace');
}

export function upsertNode(node) {
  // Mutate in place: live views (drag handlers, menus) keep references to the
  // store object, so replacing it would leave them editing a detached copy.
  const cur = store.nodes.get(node.id);
  if (cur) {
    // payloads without a fields array (or fields:null) must not wipe the
    // locally known field list
    const fields = Array.isArray(node.fields) ? node.fields : cur.fields;
    Object.assign(cur, node);
    cur.fields = fields ?? [];
  } else {
    store.nodes.set(node.id, { fields: [], ...node });
  }
  childrenIndex = null;
  emit('nodes', 'update:' + node.id);
}

export function removeNodes(ids) {
  const idSet = new Set(ids);
  for (const id of ids) {
    store.nodes.delete(id);
    store.prefs.collapsed = store.prefs.collapsed.filter(c => !idSet.has(c));
  }
  childrenIndex = null;
  emit('nodes', 'remove', ids);
  emit('nodes', 'replace');
}

export function nodeChildren(id) {
  if (childrenIndex == null) {
    const idx = new Map();
    for (const n of store.nodes.values()) {
      const key = n.parentId == null ? null : n.parentId;
      let arr = idx.get(key);
      if (!arr) idx.set(key, arr = []);
      arr.push(n);
    }
    for (const arr of idx.values()) arr.sort((a, b) => a.position - b.position || a.id - b.id);
    childrenIndex = idx;
  }
  return (childrenIndex.get(id) ?? []).slice();
}

export function isDescendant(maybeChild, ancestorId) {
  let cur = store.nodes.get(maybeChild);
  let guard = 0;
  while (cur && cur.parentId != null && guard++ < 10_000) {
    if (cur.parentId === ancestorId) return true;
    cur = store.nodes.get(cur.parentId);
  }
  return false;
}

export function setCollapsed(nodeId, collapsed) {
  const set = new Set(store.prefs.collapsed);
  if (collapsed) set.add(nodeId); else set.delete(nodeId);
  store.prefs.collapsed = [...set];
  emit('prefs');
}

export function isCollapsed(nodeId) {
  return store.prefs.collapsed.includes(nodeId);
}

export function myRole() {
  return store.board?.board?.role || 'viewer';
}

export function canEdit() {
  const r = myRole();
  return r === 'owner' || r === 'editor';
}

// --- "changed" markers for the sidebar board list --------------------------------
// seen maps boardId -> the board.updatedAt value the user last saw. A board whose
// updatedAt has advanced past this (and is not currently open) shows a dot.
const seen = (() => {
  try { return JSON.parse(localStorage.getItem('panomim.seen') || '{}'); } catch { return {}; }
})();

export function markSeen(boardId, updatedAt) {
  if (boardId == null || updatedAt == null) return;
  seen[boardId] = updatedAt;
  try { localStorage.setItem('panomim.seen', JSON.stringify(seen)); } catch {}
}

export function hasSeen(boardId) {
  return seen[boardId] != null;
}

export function boardChanged(b, currentId) {
  if (!b || b.id === currentId) return false;
  const last = seen[b.id];
  if (last == null) return false;
  return (b.updatedAt || 0) > last;
}
