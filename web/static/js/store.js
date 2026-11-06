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
  emit('nodes', 'replace');
}

export function upsertNode(node) {
  // Mutate in place: live views (drag handlers, menus) keep references to the
  // store object, so replacing it would leave them editing a detached copy.
  const cur = store.nodes.get(node.id);
  if (cur) Object.assign(cur, node);
  else store.nodes.set(node.id, node);
  emit('nodes', 'update:' + node.id);
}

export function removeNodes(ids) {
  const idSet = new Set(ids);
  for (const id of ids) {
    store.nodes.delete(id);
    store.prefs.collapsed = store.prefs.collapsed.filter(c => !idSet.has(c));
  }
  emit('nodes', 'remove', ids);
  emit('nodes', 'replace');
}

export function nodeChildren(id) {
  const out = [];
  for (const n of store.nodes.values()) {
    if (n.parentId === id || (id === null && n.parentId == null)) out.push(n);
  }
  return out.sort((a, b) => a.position - b.position || a.id - b.id);
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
