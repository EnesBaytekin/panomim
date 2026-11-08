// List view — a cozy VSCode-style tree of todos.
import { api } from './api.js';
import { el, toast, confirmDialog, popover } from './ui.js';
import { store, on, nodeChildren, isCollapsed, setCollapsed, canEdit, upsertNode, removeNodes, isDescendant } from './store.js';
import { fieldChips, openFieldEditor } from './fields.js';
import { pushAction, patchAction, deleteAction, createTitleAction, markCreated, consumeCreate } from './undo.js';
import { t } from './i18n.js';

let rootEl = null;
let editingId = null;   // node being inline-renamed
let editingIsNew = false;
const expandedFields = new Set(); // node ids whose fields are expanded (client-side per-user only)

export function initListView(container) {
  rootEl = container;
  on('nodes', () => render());
  on('board', () => render());
  on('prefs', () => render());
  on('selection', () => renderRemoteHints());
  render();
}

function render() {
  if (!rootEl) return;
  const scrollTop = rootEl.scrollTop;
  clear(rootEl);

  if (!store.nodes.size) {
    rootEl.append(emptyState());
    return;
  }

  const tree = el('div.tree');
  for (const root of nodeChildren(null)) {
    tree.append(renderNode(root, 0));
  }
  rootEl.append(tree);

  if (canEdit()) {
    rootEl.append(
      el('button.tree-add-root', {
        onclick: () => { createRoot(); },
        title: t('list.newRootTitle'),
      }, el('span.plus', null, '+'), t('list.addTask')),
    );
  }
  renderRemoteHints();
  rootEl.scrollTop = scrollTop;
}

/** Colour rows for remote users' current selections — a style-only pass, no DOM
 *  rebuild, so collaborator cursor moves stay cheap on large boards. */
function renderRemoteHints() {
  if (!rootEl) return;
  rootEl.querySelectorAll('.tree-row').forEach(r => r.style.removeProperty('--sel-color'));
  for (const [uid, selId] of store.selections) {
    const u = store.presence.get(uid);
    if (!u) continue;
    rootEl.querySelector(`.tree-row[data-id="${selId}"]`)?.style.setProperty('--sel-color', u.color);
  }
}

function emptyState() {
  return el('div.empty-state',
    el('div.empty-art', null, '🗒️'),
    el('h2', null, t('list.emptyTitle')),
    el('p', null, t('list.emptyHint')),
    canEdit() && el('button.btn.primary', { onclick: () => createRoot() }, t('list.emptyCTA')),
  );
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function renderNode(node, depth) {
  const kids = nodeChildren(node.id);
  const collapsed = isCollapsed(node.id);
  const hasFields = !!(node.fields && node.fields.length);
  const fieldsExpanded = expandedFields.has(node.id);
  const row = el('div.tree-row', {
    dataset: { id: node.id, depth },
    style: `--depth:${depth}`,
  });

  const chevron = kids.length
    ? el('button.chevron', {
        class: 'chevron' + (collapsed ? ' collapsed' : ''),
        onclick: e => { e.stopPropagation(); setCollapsed(node.id, !collapsed); },
        title: collapsed ? t('list.showChildren') : t('list.hideChildren'),
      }, '▸')
    : el('span.chevron.spacer');

  const title = editingId === node.id
    ? titleEditor(node)
    : el('span.tree-title', {
        onclick: () => { selectNode(node.id); if (hasFields) toggleFields(node.id); },
        ondblclick: () => { if (canEdit()) startEdit(node.id); },
      }, node.title || (el('span.dim', null, t('list.untitled'))));

  // title + fields live in one vertical body; fields are collapsed by default
  // (title-only) and expand downward on click — a per-user, client-side toggle.
  const body = el('span.tree-body', null,
    title,
    fieldsExpanded && hasFields && el('span.tree-fields', null, fieldChips(node)),
  );

  row.append(chevron, checkToggle(node), body);
  if (canEdit()) wireDrag(row, node);

  // far-right cluster: field indicator (always visible when fields exist),
  // then the ⋯ menu and the drag grip (both revealed on hover).
  const fieldIcon = hasFields
    ? el('button.field-toggle' + (fieldsExpanded ? '.open' : ''), {
        title: fieldsExpanded ? t('list.collapseFields') : t('list.expandFields'),
        onclick: e => { e.stopPropagation(); toggleFields(node.id); },
      }, '≡')
    : null;
  row.append(el('span.row-tail', null,
    fieldIcon,
    el('button.icon-btn', {
      title: t('list.menu'),
      onclick: e => { e.stopPropagation(); rowMenu(node, e.currentTarget); },
    }, '⋯'),
    canEdit() && el('span.drag-grip', { title: t('list.dragToMove'), dataset: { grip: '1' } }, '⠿'),
  ));

  const frag = document.createDocumentFragment();
  frag.append(row);
  if (kids.length && !collapsed) {
    const kidBox = el('div.tree-kids');
    for (const k of kids) kidBox.append(renderNode(k, depth + 1));
    frag.append(kidBox);
  }
  return frag;
}

function toggleFields(id) {
  if (expandedFields.has(id)) expandedFields.delete(id);
  else expandedFields.add(id);
  render();
}

function checkToggle(node) {
  return el('button.check', {
    class: 'check' + (node.done ? ' done' : ''),
    title: node.done ? t('list.markUndone') : t('list.markDone'),
    onclick: async e => {
      e.stopPropagation();
      const next = !node.done;
      try {
        if (canEdit()) pushAction(patchAction(node.id, { done: node.done }, { done: next }));
        mergeNode(await api.patch(`/api/nodes/${node.id}/done`, { done: next }));
      } catch (err) { toast(err.message, 'error'); }
    },
  }, '✓');
}

/** The single "⋯" row menu — mirrors the mindmap note menu (add field, rename,
 *  add child, make root, delete) so the icons and options match. */
function rowMenu(node, anchor) {
  const { pop, close } = popover(anchor, { placement: 'bottom-end' });
  const items = canEdit() ? [
    el('button.menu-item', { onclick: () => { close(); openFieldEditor(node.id, anchor); } }, t('mm.fields')),
    el('button.menu-item', { onclick: () => { close(); startEdit(node.id); } }, t('mm.rename')),
    el('button.menu-item', { onclick: () => { close(); addChild(node); } }, t('mm.addChild')),
    node.parentId != null && el('button.menu-item', {
      onclick: async () => {
        close();
        try {
          pushAction(patchAction(node.id, { parentId: node.parentId }, { parentId: 0 }));
          upsertNode(await api.patch(`/api/nodes/${node.id}`, { parentId: 0 }));
        } catch (e) { toast(e.message, 'error'); }
      },
    }, t('mm.makeRoot')),
    el('button.menu-item.danger', { onclick: () => { close(); deleteNode(node); } }, t('mm.delete')),
  ] : [
    el('button.menu-item', { onclick: () => { close(); openFieldEditor(node.id, anchor); } }, t('list.viewFields')),
  ];
  pop.append(...items.filter(Boolean));
}

function titleEditor(node) {
  const input = el('input.tree-edit', {
    value: editingIsNew ? '' : node.title,
    placeholder: t('list.placeholder'),
    onclick: e => e.stopPropagation(),
  });
  // Focused synchronously by focusEditor() right after render() attaches the
  // input — a deferred rAF/setTimeout focus does not open the soft keyboard on
  // mobile (especially iOS), which made "add note" look broken there.
  const commit = async () => {
    const val = input.value.trim();
    const id = node.id;
    const isNew = editingIsNew;
    editingId = null; editingIsNew = false;
    if (!val) {
      if (isNew) {
        consumeCreate(id); // discard the create marker
        try { await api.del(`/api/nodes/${id}`); removeLocal(id); } catch {}
      }
      render();
      return;
    }
    try {
      const meta = consumeCreate(id);
      if (meta) pushAction(createTitleAction(id, meta, val));
      else pushAction(patchAction(id, { title: node.title ?? '' }, { title: val }));
      mergeNode(await api.patch(`/api/nodes/${id}`, { title: val }));
    } catch (e) {
      toast(e.message, 'error');
      render();
    }
  };
  const cancel = () => {
    const id = node.id, isNew = editingIsNew;
    editingId = null; editingIsNew = false;
    if (isNew) api.del(`/api/nodes/${id}`).then(removeLocal).catch(() => {});
    render();
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', () => commit());
  return input;
}

function startEdit(nodeId) {
  editingId = nodeId;
  editingIsNew = false;
  render();
  focusEditor();
}

/** Focus the active inline editor (called right after render, synchronously). */
function focusEditor() {
  const input = rootEl?.querySelector('.tree-edit');
  if (!input) return;
  try { input.focus({ preventScroll: true }); } catch { input.focus(); }
  try { input.select(); } catch { /* no-op */ }
}

/** Create a new root and open it for editing. */
async function createRoot() {
  try {
    // cascade position so notes don't stack on the mindmap corkboard
    const roots = nodeChildren(null).length;
    const node = await api.post(`/api/boards/${currentBoardId()}/nodes`, {
      title: '', x: roots * 36, y: roots * 36,
    });
    mergeNode(node);
    markCreated(node); // first title commit folds "create" + "title" into one undo
    editingId = node.id;
    editingIsNew = true;
    render();
    focusEditor();
  } catch (e) { toast(e.message, 'error'); }
}

async function addChild(parent) {
  try {
    // below-right of the parent, same convention as the mindmap view
    const sibs = nodeChildren(parent.id).length;
    const node = await api.post(`/api/boards/${currentBoardId()}/nodes`, {
      parentId: parent.id, title: '',
      x: Math.round(parent.x + 40 + sibs * 24),
      y: Math.round(parent.y + (parent.h || 130) + 30),
    });
    mergeNode(node);
    markCreated(node); // first title commit folds "create" + "title" into one undo
    editingId = node.id;
    editingIsNew = true;
    setCollapsed(parent.id, false);
    render();
    focusEditor();
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteNode(node) {
  const kids = nodeChildren(node.id);
  let count = kids.length;
  if (count > 0) {
    // count the full subtree for an honest warning
    const countAll = list => list.reduce((acc, k) => acc + 1 + countAll(nodeChildren(k.id)), 0);
    count = countAll(kids);
    const ok = await confirmDialog({
      title: t('list.deleteTitle', { title: node.title || t('list.untitled') }),
      body: t('list.deleteWithChildren', { n: count }),
      confirmText: t('list.deleteAll'),
      danger: true,
    });
    if (!ok) return;
    pushAction(deleteAction(node)); // subtree delete is reversible via restore
    await api.del(`/api/nodes/${node.id}?withChildren=1`);
  } else {
    const ok = await confirmDialog({
      title: t('list.deleteTitle', { title: node.title || t('list.untitled') }),
      confirmText: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    pushAction(deleteAction(node)); // leaf delete is reversible
    await api.del(`/api/nodes/${node.id}`);
  }
  removeLocal(node.id);
}

function selectNode(id) {
  // local + broadcast
  import('./ws.js').then(({ sendSelect }) => sendSelect(id));
  rootEl.querySelector('.tree-row.selected')?.classList.remove('selected');
  rootEl.querySelector(`.tree-row[data-id="${id}"]`)?.classList.add('selected');
}

// --- local store helpers ------------------------------------------------

let currentBoardId = () => store.board?.board?.id;

function mergeNode(node) {
  upsertNode(node); // emits 'nodes' → list view and mindmap both re-render
}

function removeLocal(id) {
  // remove subtree locally
  const doomed = [id];
  const walk = pid => {
    for (const n of store.nodes.values()) {
      if (n.parentId === pid) { doomed.push(n.id); walk(n.id); }
    }
  };
  walk(id);
  removeNodes(doomed); // emits 'nodes' → both views update
  if (editingId && doomed.includes(editingId)) { editingId = null; editingIsNew = false; }
}

// --- drag & drop (file-manager style reordering) -----------------------------
// Mouse: drag from anywhere on the row (5px threshold keeps click/dblclick).
// Touch: drag from the grip handle only, so vertical scrolling stays native.
// Drop zones: upper edge → before, lower edge → after, middle → inside as child.

let drag = null;          // { id, pointerId, startX, startY, started, ghost, drop }
let lastPointer = null;   // { x, y } while dragging (for edge auto-scroll)
let scrollRaf = 0;

function wireDrag(row, node) {
  row.addEventListener('pointerdown', e => {
    if (!canEdit() || drag) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (e.target.closest('button, input, select, a, .tree-edit')) return;
    const fromGrip = !!e.target.closest('.drag-grip');
    if (e.pointerType === 'touch' && !fromGrip) return; // touch drags come from the grip

    drag = { id: node.id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, started: false, ghost: null, drop: null };
    const move = ev => {
      if (!drag || drag.pointerId !== ev.pointerId) return;
      if (!drag.started) {
        if (Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) < 5) return;
        startDrag(drag);
      }
      moveDrag(ev, drag);
    };
    const up = ev => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (drag && drag.started) finishDrag(ev, drag);
      drag = null;
      lastPointer = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}

function startDrag(d) {
  d.started = true;
  const node = store.nodes.get(d.id);
  d.ghost = el('div.drag-ghost', null, '🗒 ' + (node?.title || t('list.untitled')));
  document.body.append(d.ghost);
  document.body.classList.add('noselect');
  rootEl.querySelector(`.tree-row[data-id="${d.id}"]`)?.classList.add('drag-src');
}

function moveDrag(ev, d) {
  lastPointer = { x: ev.clientX, y: ev.clientY };
  if (d.ghost) {
    d.ghost.style.left = ev.clientX + 14 + 'px';
    d.ghost.style.top = ev.clientY - 10 + 'px';
  }
  updateDropMark(ev.clientX, ev.clientY, d);
  kickAutoScroll();
}

function updateDropMark(x, y, d) {
  clearDropMarks();
  d.drop = null;
  const under = document.elementFromPoint(x, y)?.closest('.tree-row');
  if (!under) return;
  const targetId = Number(under.dataset.id);
  if (targetId === d.id || isDescendant(targetId, d.id)) return; // never into own subtree
  const r = under.getBoundingClientRect();
  let mode;
  if (y < r.top + r.height * 0.3) mode = 'before';
  else if (y > r.bottom - r.height * 0.3) mode = 'after';
  else mode = 'inside';
  d.drop = { id: targetId, mode };
  under.classList.add(mode === 'inside' ? 'drop-into' : mode === 'before' ? 'drop-before' : 'drop-after');
}

function clearDropMarks() {
  rootEl.querySelectorAll('.drop-before, .drop-after, .drop-into')
    .forEach(elN => elN.classList.remove('drop-before', 'drop-after', 'drop-into'));
}

function kickAutoScroll() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    if (!drag || !drag.started || !lastPointer) return;
    const r = rootEl.getBoundingClientRect();
    const margin = 52;
    let dy = 0;
    if (lastPointer.y < r.top + margin) dy = -Math.min(18, Math.ceil((r.top + margin - lastPointer.y) / 5));
    else if (lastPointer.y > r.bottom - margin) dy = Math.min(18, Math.ceil((lastPointer.y - (r.bottom - margin)) / 5));
    if (dy) {
      rootEl.scrollTop += dy;
      if (drag) updateDropMark(lastPointer.x, lastPointer.y, drag);
      kickAutoScroll();
    }
  });
}

async function finishDrag(ev, d) {
  clearDropMarks();
  document.body.classList.remove('noselect');
  d.ghost?.remove();
  rootEl.querySelector('.drag-src')?.classList.remove('drag-src');
  const drop = d.drop;
  if (!drop) { render(); return; }
  const node = store.nodes.get(d.id);
  const target = store.nodes.get(drop.id);
  if (!node || !target) { render(); return; }
  try {
    if (drop.mode === 'inside') {
      if (node.parentId === target.id) return; // already a direct child
      setCollapsed(target.id, false); // show the new child right away
      pushAction(patchAction(d.id, { parentId: node.parentId ?? 0 }, { parentId: target.id }));
      const updated = await api.patch(`/api/nodes/${d.id}`, { parentId: target.id });
      upsertNode(updated);
    } else {
      const newParentId = target.parentId ?? null;
      const sibs = nodeChildren(newParentId).filter(s => s.id !== d.id);
      const idx = sibs.findIndex(s => s.id === target.id);
      let pos;
      if (drop.mode === 'before') {
        const prev = sibs[idx - 1];
        pos = prev ? (prev.position + target.position) / 2 : target.position - 10;
      } else {
        const next = sibs[idx + 1];
        pos = next ? (target.position + next.position) / 2 : target.position + 10;
      }
      const sameParent = (node.parentId ?? null) === newParentId;
      const body = sameParent ? { position: pos } : { parentId: newParentId ?? 0, position: pos };
      const updated = await api.patch(`/api/nodes/${d.id}`, body);
      upsertNode(updated);
    }
  } catch (e) {
    toast(e.message, 'error');
    render();
  }
}
