// Client-side undo/redo for the current board session. Actions are reversible
// closures; the driver resyncs the board after each step so the store always
// reflects the truth (a recreated note gets a fresh id — resync keeps us sane).
import { api } from './api.js';
import { store, emit } from './store.js';
import { resync } from './ws.js';

const undoStack = [];
const redoStack = [];
const MAX = 100;

export function resetUndo() {
  undoStack.length = 0;
  redoStack.length = 0;
  emit('history');
}

export function canUndo() { return undoStack.length > 0; }
export function canRedo() { return redoStack.length > 0; }

export function pushAction(action) {
  if (!action) return;
  undoStack.push(action);
  if (undoStack.length > MAX) undoStack.shift();
  redoStack.length = 0;
  emit('history');
}

export async function undo() {
  const a = undoStack.pop();
  if (!a) return;
  try {
    await a.undo();
    await resync();
    redoStack.push(a);
  } catch (e) {
    undoStack.push(a);
    throw e;
  } finally {
    emit('history');
  }
}

export async function redo() {
  const a = redoStack.pop();
  if (!a) return;
  try {
    await a.redo();
    await resync();
    undoStack.push(a);
  } catch (e) {
    redoStack.push(a);
    throw e;
  } finally {
    emit('history');
  }
}

/** Run several reversible steps as one undo/redo unit (e.g. a bulk edit). */
export function groupAction(items) {
  const list = items.filter(Boolean);
  return {
    undo: async () => { for (let i = list.length - 1; i >= 0; i--) await list[i].undo(); },
    redo: async () => { for (const it of list) await it.redo(); },
  };
}

const boardId = () => store.board?.board?.id;

/** Reversible single-node patch. `before`/`after` are exact API patch payloads. */
export function patchAction(id, before, after) {
  return {
    undo: async () => { await api.patch(`/api/nodes/${id}`, before); },
    redo: async () => { await api.patch(`/api/nodes/${id}`, after); },
  };
}

/** Delete a single node; undo recreates it (new id, same content/position). */
export function deleteAction(node) {
  const bid = boardId();
  let currentId = node.id;
  const snap = {
    parentId: node.parentId ?? null,
    title: node.title ?? '',
    done: !!node.done,
    hue: node.hue ?? null,
    x: node.x ?? 0,
    y: node.y ?? 0,
    w: node.w ?? 0,
    h: node.h ?? 0,
    fields: (node.fields || []).map(f => ({ type: f.type, value: f.value })),
  };
  return {
    undo: async () => {
      const created = await api.post(`/api/boards/${bid}/nodes`, {
        parentId: snap.parentId, title: snap.title, x: Math.round(snap.x), y: Math.round(snap.y),
      });
      currentId = created.id;
      if (snap.done) await api.patch(`/api/nodes/${created.id}/done`, { done: true }).catch(() => {});
      if (snap.hue != null) await api.patch(`/api/nodes/${created.id}`, { hue: snap.hue }).catch(() => {});
      if (snap.w || snap.h) await api.patch(`/api/nodes/${created.id}`, { w: snap.w, h: snap.h }).catch(() => {});
      for (const f of snap.fields) await api.post(`/api/nodes/${created.id}/fields`, { type: f.type, value: f.value }).catch(() => {});
    },
    redo: async () => { await api.del(`/api/nodes/${currentId}`); },
  };
}

/** A note created and given its first title in one go: undo removes the whole
 *  note, redo recreates it with that title. */
export function createTitleAction(id, meta, title) {
  const bid = boardId();
  let currentId = id;
  return {
    undo: async () => { await api.del(`/api/nodes/${currentId}`); },
    redo: async () => {
      const n = await api.post(`/api/boards/${bid}/nodes`, {
        parentId: meta.parentId, title, x: Math.round(meta.x), y: Math.round(meta.y),
      });
      currentId = n.id;
    },
  };
}

/** Field value edit. */
export function fieldPatchAction(id, before, after) {
  return {
    undo: async () => { await api.patch(`/api/fields/${id}`, { value: before }); },
    redo: async () => { await api.patch(`/api/fields/${id}`, { value: after }); },
  };
}

/** Field creation. `id` is the already-known field id (null before first create). */
export function fieldAddAction(nodeId, type, value, id = null) {
  let currentId = id;
  return {
    undo: async () => { if (currentId != null) await api.del(`/api/fields/${currentId}`); },
    redo: async () => { currentId = (await api.post(`/api/nodes/${nodeId}/fields`, { type, value })).id; },
  };
}

/** Field deletion. */
export function fieldDeleteAction(field) {
  const nodeId = field.nodeId;
  let currentId = field.id;
  return {
    undo: async () => {
      currentId = (await api.post(`/api/nodes/${nodeId}/fields`, { type: field.type, value: field.value })).id;
    },
    redo: async () => { await api.del(`/api/fields/${currentId}`); },
  };
}

// --- create + first-title coalescing -------------------------------------------
// A freshly created note starts empty; its first title commit folds the "create"
// and the "title" into ONE action so a single Undo removes the whole note.

const pendingCreates = new Map(); // nodeId -> {x, y, parentId}

export function markCreated(node) {
  pendingCreates.set(node.id, { x: node.x ?? 0, y: node.y ?? 0, parentId: node.parentId ?? null });
}

export function consumeCreate(id) {
  const m = pendingCreates.get(id);
  pendingCreates.delete(id);
  return m;
}
