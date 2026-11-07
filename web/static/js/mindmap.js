// Mindmap view — a cozy corkboard of sticky notes connected by strings.
// Notes hang on a large pannable/zoomable canvas; edges are gradient cubic
// beziers that thicken & warm from parent (thin) to child (thick).
import { api } from './api.js';
import { el, toast, confirmDialog, colorForUser, debounce } from './ui.js';
import { store, on, nodeChildren, canEdit, isDescendant, setCollapsed, upsertNode, removeNodes } from './store.js';
import { fieldElement, openFieldEditor, pickAndUpload } from './fields.js';
import { sendSelect } from './ws.js';
import { t } from './i18n.js';

const NOTE_W = 220;          // default note width (square side)
const MIN_W = 100, MAX_W = 640;
const MIN_H = 56, MAX_H = 560;  // narrow/short notes allowed; never below content

let viewport = null;  // the clipping container (gets pointer events)
let canvas = null;    // transformed world (notes + svg)
let svg = null;       // edges layer (behind notes)
let notesLayer = null;

let pan = { x: 0, y: 0 };
let zoom = 1;
let editMode = false;
let selectedId = null;
let destroyed = true;
let edgePaths = new Map(); // edgeKey -> {g, path1, path2, grad}

const NOTE_PALETTE = [35, 130, 275, 350, 15, 190]; // soft hues offered in picker

export function initMindmap(container) {
  viewport = container;
  destroyed = false;
  buildDOM();
  on('nodes', ev => onNodesChange(ev));
  on('board', () => { renderAllNotes(); });
  on('selection', () => renderSelections());
  on('presence', () => renderPresenceBar());
  setEditMode(store.editMode, { silent: true });
  renderAllNotes();
  restoreView();
}

export function destroyMindmap() {
  destroyed = true;
}

export function setEditMode(v, { silent } = {}) {
  editMode = v && canEdit();
  store.editMode = editMode;
  canvas?.classList.toggle('edit', editMode);
  viewport?.classList.toggle('viewing', !editMode);
  for (const n of notesLayer?.children ?? []) {
    n.classList.toggle('editable', editMode);
    // rebuild content so the note tools exist ONLY in edit mode — otherwise
    // they would be invisible yet still clickable in view mode
    const node = store.nodes.get(Number(n.dataset.id));
    if (node) renderNoteContent(n, node);
  }
  renderEdges();
  if (!silent) emitToolbar();
}

export function isEditMode() { return editMode; }
export function setSelection(id) { selectedId = id; renderSelections(); }

// --- DOM skeleton ---------------------------------------------------------

let viewportWired = false;

function buildDOM() {
  // remove only a previous canvas — the toolbar lives in the viewport too
  viewport.querySelector('.mm-canvas')?.remove();
  svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'mm-edges');
  notesLayer = el('div.mm-notes');
  canvas = el('div.mm-canvas', null, svg, notesLayer);
  viewport.append(canvas);

  if (viewportWired) return;
  viewportWired = true;
  viewport.addEventListener('wheel', onWheel, { passive: false });
  viewport.addEventListener('pointerdown', onPanStart);
  viewport.addEventListener('dblclick', onDblClick);
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

/** Rebuild the canvas if it left the DOM (e.g. empty-state removed it). */
function ensureDOM() {
  if (destroyed) return false;
  if (!canvas || !canvas.isConnected) buildDOM();
  return true;
}

// --- store -> view ---------------------------------------------------------

function onNodesChange(ev) {
  if (ev === 'replace' || ev === undefined) { renderAllNotes(); return; }
  if (typeof ev !== 'string') { renderAllNotes(); return; }
  const [kind, idStr] = ev.split(':');
  if (kind === 'update') {
    const id = Number(idStr);
    const node = store.nodes.get(id);
    const elNode = notesLayer.querySelector(`.note[data-id="${id}"]`);
    if (node && elNode) { updateNoteEl(elNode, node); scheduleEdges(); }
    else renderAllNotes();
    return;
  }
  renderAllNotes();
}

function renderAllNotes() {
  if (destroyed || !ensureDOM()) return;
  clear(notesLayer);
  for (const node of store.nodes.values()) {
    notesLayer.append(buildNote(node));
  }
  scheduleEdges();
  renderSelections();
}

function buildNote(node) {
  const n = el('div.note', {
    dataset: { id: node.id },
    style: noteStyle(node),
  });
  n.addEventListener('pointerdown', e => onNotePointerDown(e, node, n));
  n.addEventListener('click', () => {
    if (selectedId !== node.id) {
      selectedId = node.id;
      renderSelections();
      sendSelect(node.id);
    }
  });
  renderNoteContent(n, node);
  n.classList.toggle('editable', editMode && canEdit());
  n.classList.toggle('done', !!node.done);
  // auto-measure height for CSS-only height
  requestAnimationFrame(() => { if (!store.nodes.get(node.id)?.h) autoSize(n, node); });
  return n;
}

/** (Re)build a note's content. Always renders the title as the main line; when
 *  the title is empty the first written text field takes its place. Remaining
 *  text fields render as description lines; every other field becomes a chip.
 *  Empty fields render nothing (no more stray "null" text). */
function renderNoteContent(n, node) {
  clear(n);
  const head = el('div.note-head', null,
    el('button.note-check', {
      class: 'note-check' + (node.done ? ' done' : ''),
      title: node.done ? t('mm.markUndone') : t('mm.markDone'),
      onclick: async e => {
        e.stopPropagation();
        const cur = store.nodes.get(node.id) || node; // never trust a stale copy
        try {
          const updated = await api.patch(`/api/nodes/${node.id}/done`, { done: !cur.done });
          mergeNode(updated);
        } catch (err) { toast(err.message, 'error'); }
      },
    }, '✓'),
    el('div.note-title', null, noteMainText(node)),
    el('span.note-tools', null,
      // tools exist only while edit mode is ON (and the user may edit);
      // setEditMode rebuilds note content on toggle so they never linger
      // invisibly under view mode
      store.editMode && canEdit() && el('button.note-btn', {
        title: t('mm.editFields'),
        onclick: e => { e.stopPropagation(); openFieldEditor(node.id, e.currentTarget); },
      }, '+'),
      store.editMode && canEdit() && el('button.note-btn', {
        title: t('mm.menu'),
        onclick: e => { e.stopPropagation(); noteMenu(store.nodes.get(node.id) || node, e.currentTarget); },
      }, '⋯'),
    ),
  );
  n.append(head);

  const body = noteBodyEl(node);
  if (body) n.append(body);

  // single bottom-right resize handle; CSS reveals it only in edit mode
  n.append(el('div.note-resize.rs-se', { title: t('mm.resize') }));
  n.append(el('div.note-link', { title: t('mm.relink') }, '⛓'));
}

function noteTitleField(node) {
  if (node.title) return null;
  return node.fields.find(f => f.type === 'text' && (f.value || '').trim()) || null;
}

function noteMainText(node) {
  return node.title || (noteTitleField(node)?.value || '');
}

/** Fields shown in the note body, in add-order (position order), excluding the
 *  field that stands in for the title when the title is empty. Empty text
 *  fields render nothing. */
function noteBodyFields(node) {
  const title = noteTitleField(node);
  return node.fields.filter(f =>
    f !== title && (f.type !== 'text' || (f.value || '').trim())
  );
}

/** Render the note's fields as one ordered list (text / image / chip mixed),
 *  with drag-to-reorder in edit mode. */
function noteBodyEl(node) {
  const fields = noteBodyFields(node);
  if (!fields.length) return null;
  const list = el('div.note-fields');
  const draggable = editMode && canEdit();
  const items = fields.map(f => {
    const grip = draggable
      ? el('span.field-grip', { draggable: 'true', title: t('mm.reorder') }, '⠿')
      : null;
    return el('div.field-item', { dataset: { fieldId: f.id } }, grip, fieldElement(f));
  });
  list.append(...items);

  if (draggable) {
    let dragId = null;
    for (const item of items) {
      const grip = item.querySelector('.field-grip');
      grip.addEventListener('dragstart', e => {
        dragId = Number(item.dataset.fieldId);
        item.classList.add('dragging');
        try { e.dataTransfer.setData('text/plain', String(dragId)); } catch { /* Safari */ }
        e.dataTransfer.effectAllowed = 'move';
      });
      grip.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        list.querySelectorAll('.drag-over').forEach(x => x.classList.remove('drag-over'));
        dragId = null;
      });
      item.addEventListener('dragover', e => {
        if (dragId == null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        list.querySelectorAll('.drag-over').forEach(x => x.classList.remove('drag-over'));
        item.classList.add('drag-over');
      });
      item.addEventListener('drop', async e => {
        e.preventDefault();
        const targetId = Number(item.dataset.fieldId);
        list.querySelectorAll('.drag-over').forEach(x => x.classList.remove('drag-over'));
        if (dragId == null || targetId === dragId) return;
        await reorderFields(node, dragId, targetId);
      });
    }
  }
  return list;
}

/** Move field `dragId` to just before `targetId` and persist the new order. */
async function reorderFields(node, dragId, targetId) {
  const cur = store.nodes.get(node.id) || node;
  const ids = cur.fields.map(f => f.id);
  const from = ids.indexOf(dragId);
  if (from < 0) return;
  const moved = ids.splice(from, 1)[0];
  const to = ids.indexOf(targetId);
  if (to < 0) return;
  ids.splice(to, 0, moved);
  try {
    const updated = await api.post(`/api/nodes/${node.id}/fields/order`, { ids });
    upsertNode(updated);
  } catch (e) { toast(e.message, 'error'); }
}

function noteStyle(node) {
  const hue = node.hue ?? null;
  return [
    `left:${node.x}px`,
    `top:${node.y}px`,
    `width:${node.w || NOTE_W}px`,
    node.h ? `min-height:${node.h}px` : '',
    hue != null ? `--hue:${hue}` : '',
    `--tilt:${tiltOf(node.id)}deg`,
  ].filter(Boolean).join(';');
}

/** Deterministic playful tilt per note (doodle corkboard feel). */
function tiltOf(id) {
  return (((id * 47) % 9) - 4) * 0.4;
}

function updateNoteEl(elNode, node) {
  elNode.setAttribute('style', noteStyle(node));
  elNode.classList.toggle('done', !!node.done);
  elNode.classList.toggle('editable', editMode && canEdit());
  // don't clobber in-note editing (rename input etc.)
  const ae = document.activeElement;
  const editing = ae && elNode.contains(ae) && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA');
  if (!editing) renderNoteContent(elNode, node);
  if (!node.h) {
    requestAnimationFrame(() => { if (elNode.isConnected) autoSize(elNode, node); });
  } else {
    noteSizes.set(node.id, { w: node.w, h: node.h });
  }
  scheduleEdges();
}

function autoSize(n, node) {
  // store measured height when height is auto (h==0) so edges anchor correctly
  const h = n.offsetHeight;
  const w = n.offsetWidth;
  noteSizes.set(node.id, { w, h });
  scheduleEdges();
}

const noteSizes = new Map(); // id -> {w,h} measured

function noteBox(node) {
  const m = noteSizes.get(node.id) || {};
  return {
    cx: node.x + (node.w || m.w || NOTE_W) / 2,
    cy: node.y + (node.h || m.h || 220) / 2,
  };
}

// --- edges -----------------------------------------------------------------

function scheduleEdges() {
  if (destroyed) return;
  if (!scheduleEdges._raf) {
    scheduleEdges._raf = requestAnimationFrame(() => { scheduleEdges._raf = 0; renderEdges(); });
  }
}

function renderEdges() {
  if (destroyed || !ensureDOM()) return;
  // wipe & redraw (simple + fine for hundreds of notes)
  clear(svg);
  edgePaths.clear();
  const defs = document.createElementNS(svgNS, 'defs');
  svg.append(defs);

  for (const node of store.nodes.values()) {
    if (node.parentId == null) continue;
    const parent = store.nodes.get(node.parentId);
    if (!parent) continue;
    drawEdge(parent, node, defs);
  }
}

const svgNS = 'http://www.w3.org/2000/svg';

function hueColor(hue, l, s) {
  if (hue == null) return `hsl(38 ${s}% ${l}%)`;
  return `hsl(${hue} ${s}% ${l}%)`;
}

function drawEdge(parent, child, defs) {
  const a = noteBox(parent), b = noteBox(child);
  const dx = b.cx - a.cx, dy = b.cy - a.cy;
  const dist = Math.hypot(dx, dy) || 1;
  const sag = Math.min(dist * 0.12, 60);
  // control points: horizontal pull + slight sag (string pinned on board)
  const c1x = a.cx + dx * 0.35, c1y = a.cy + sag * 0.4;
  const c2x = b.cx - dx * 0.35, c2y = b.cy + sag * 0.4;

  // de Casteljau split at t=0.5 → thin parent half + thick child half
  const q0x = (a.cx + c1x) / 2, q0y = (a.cy + c1y) / 2;
  const q1x = (c1x + c2x) / 2, q1y = (c1y + c2y) / 2;
  const q2x = (c2x + b.cx) / 2, q2y = (c2y + b.cy) / 2;
  const r0x = (q0x + q1x) / 2, r0y = (q0y + q1y) / 2;
  const r1x = (q1x + q2x) / 2, r1y = (q1y + q2y) / 2;
  const sx = (r0x + r1x) / 2, sy = (r0y + r1y) / 2;

  const pCol = hueColor(parent.hue, parent.hue == null ? 62 : 58, 42);
  const cCol = hueColor(child.hue, child.hue == null ? 52 : 48, 52);

  const gradId = `g-${parent.id}-${child.id}`;
  const grad = document.createElementNS(svgNS, 'linearGradient');
  grad.setAttribute('id', gradId);
  grad.setAttribute('gradientUnits', 'userSpaceOnUse');
  grad.setAttribute('x1', a.cx); grad.setAttribute('y1', a.cy);
  grad.setAttribute('x2', b.cx); grad.setAttribute('y2', b.cy);
  grad.innerHTML = `<stop offset="0" stop-color="${pCol}"/><stop offset="1" stop-color="${cCol}"/>`;
  defs.append(grad);

  const mk = (d, w, stroke, opacity) => {
    const p = document.createElementNS(svgNS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', stroke);
    p.setAttribute('stroke-width', w);
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('opacity', opacity);
    return p;
  };
  const d1 = `M ${a.cx} ${a.cy} C ${q0x} ${q0y} ${r0x} ${r0y} ${sx} ${sy}`;
  const d2 = `M ${sx} ${sy} C ${r1x} ${r1y} ${q2x} ${q2y} ${b.cx} ${b.cy}`;
  const p1 = mk(d1, 2, `url(#${gradId})`, 0.55);
  const p2 = mk(d2, 4.5, `url(#${gradId})`, 0.85);
  svg.append(p1, p2);
  edgePaths.set(`${parent.id}-${child.id}`, { p1, p2 });
}

// --- pan & zoom -------------------------------------------------------------

function applyTransform() {
  canvas.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
  const zl = document.getElementById('mm-zoom-label');
  if (zl) zl.textContent = Math.round(zoom * 100) + '%';
  saveViewDebounced();
}

const saveViewDebounced = debounce(() => {
  if (currentBoardId() == null) return;
  api.put(`/api/boards/${currentBoardId()}/prefs`, {
    ...store.prefs,
    panX: Math.round(pan.x), panY: Math.round(pan.y), zoom: Math.round(zoom * 1000) / 1000,
  }).catch(() => {});
}, 800);

function restoreView() {
  pan.x = store.prefs.panX ?? 0;
  pan.y = store.prefs.panY ?? 0;
  zoom = store.prefs.zoom ?? 1;
  applyTransform();
  if (!store.prefs.panX && !store.prefs.panY) {
    // first visit: center content
    requestAnimationFrame(() => fitToContent(false));
  }
}

/** Re-apply the current board's saved pan/zoom (after prefs are loaded). */
export function applyPrefs() {
  if (!ensureDOM()) return;
  const p = store.prefs;
  if (p.panX == null && p.panY == null) return; // no saved view yet → center on tab open
  pan.x = p.panX ?? 0;
  pan.y = p.panY ?? 0;
  zoom = p.zoom ?? 1;
  applyTransform();
}

/** Re-measure auto-sized notes; needed once the view becomes visible. */
export function remeasure() {
  if (!notesLayer) return;
  for (const elNode of notesLayer.children) {
    const id = Number(elNode.dataset.id);
    const node = store.nodes.get(id);
    if (!node) continue;
    if (!node.h) {
      noteSizes.set(id, { w: elNode.offsetWidth || node.w || NOTE_W, h: elNode.offsetHeight || 220 });
    } else {
      noteSizes.set(id, { w: node.w, h: node.h });
    }
  }
  scheduleEdges();
}

function fitToContent(animate = true) {
  const nodes = [...store.nodes.values()];
  const vp = viewport.getBoundingClientRect();
  if (!nodes.length) {
    pan = { x: vp.width / 2, y: vp.height / 3 };
    zoom = 1;
    applyTransform();
    return;
  }
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (const n of nodes) {
    const s = noteSizes.get(n.id) || { w: n.w || NOTE_W, h: n.h || 220 };
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + (n.w || s.w)); maxY = Math.max(maxY, n.y + (n.h || s.h));
  }
  const pad = 80;
  const zx = vp.width / (maxX - minX + pad * 2);
  const zy = vp.height / (maxY - minY + pad * 2);
  zoom = clamp(Math.min(zx, zy), 0.2, 1.4);
  pan.x = vp.width / 2 - ((minX + maxX) / 2) * zoom;
  pan.y = vp.height / 2 - ((minY + maxY) / 2) * zoom;
  applyTransform();
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function screenToWorld(sx, sy) {
  const vp = viewport.getBoundingClientRect();
  return { x: (sx - vp.left - pan.x) / zoom, y: (sy - vp.top - pan.y) / zoom };
}

function onWheel(e) {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  zoomAt(e.clientX, e.clientY, factor);
}

function zoomAt(cx, cy, factor) {
  const nz = clamp(zoom * factor, 0.15, 3);
  const vp = viewport.getBoundingClientRect();
  const mx = cx - vp.left, my = cy - vp.top;
  pan.x = mx - (mx - pan.x) * (nz / zoom);
  pan.y = my - (my - pan.y) * (nz / zoom);
  zoom = nz;
  applyTransform();
  emitToolbar();
}

const pointers = new Map(); // active pointers on the viewport (pan & pinch)
let pinch = null;           // pinch gesture anchor {dist, zoom, wx, wy}

function onPanStart(e) {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  if (e.target.closest('.note')) return; // notes handle their own drags
  if (e.target.closest('.mm-toolbar')) return; // toolbar buttons need their clicks
  try { viewport.setPointerCapture(e.pointerId); } catch { /* synthetic pointers */ }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const move = ev => {
    const prev = pointers.get(ev.pointerId);
    if (!prev) return;
    if (pointers.size >= 2) {
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      applyPinch();
      return;
    }
    pan.x += ev.clientX - prev.x;
    pan.y += ev.clientY - prev.y;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    applyTransform();
  };
  const up = ev => {
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) {
      viewport.removeEventListener('pointermove', move);
      viewport.removeEventListener('pointerup', up);
      viewport.removeEventListener('pointercancel', up);
    }
  };
  viewport.addEventListener('pointermove', move);
  viewport.addEventListener('pointerup', up);
  viewport.addEventListener('pointercancel', up);
}

/** Two-finger pinch-zoom + pan. The world point under the gesture's midpoint
 *  stays under the midpoint while fingers spread/pinch. */
function applyPinch() {
  const [a, b] = [...pointers.values()];
  if (!a || !b) return;
  const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const vp = viewport.getBoundingClientRect();
  if (!pinch) {
    pinch = {
      dist,
      zoom,
      wx: (mid.x - vp.left - pan.x) / zoom,
      wy: (mid.y - vp.top - pan.y) / zoom,
    };
  }
  const nz = clamp(pinch.zoom * (dist / pinch.dist), 0.15, 3);
  pan.x = (mid.x - vp.left) - pinch.wx * nz;
  pan.y = (mid.y - vp.top) - pinch.wy * nz;
  zoom = nz;
  applyTransform();
  emitToolbar();
}

function onDblClick(e) {
  if (!canEdit() || !editMode) return;
  if (e.target.closest('.note')) return;
  const w = screenToWorld(e.clientX, e.clientY);
  createNote({ x: w.x - NOTE_W / 2, y: w.y - 40 });
}

// --- note interactions --------------------------------------------------------

function onNotePointerDown(e, node, elNode) {
  // checkbox & buttons handle themselves
  if (e.target.closest('.note-check, .note-btn')) return;
  select(node.id);

  const linkHandle = e.target.closest('.note-link');
  const resizeHandle = e.target.closest('.note-resize');

  if (editMode && canEdit() && linkHandle) return startRelink(e, node);
  if (editMode && canEdit() && resizeHandle) return startResize(e, node, elNode);
  if (editMode && canEdit()) return startMove(e, node, elNode);
  // view mode: no repositioning; click already selects
}

function startMove(e, node, elNode) {
  e.preventDefault();
  const start = screenToWorld(e.clientX, e.clientY);
  const orig = { x: node.x, y: node.y };
  elNode.classList.add('dragging');
  try { elNode.setPointerCapture(e.pointerId); } catch { /* synthetic pointers */ }
  let moved = false;
  const move = ev => {
    const cur = screenToWorld(ev.clientX, ev.clientY);
    const nx = orig.x + (cur.x - start.x);
    const ny = orig.y + (cur.y - start.y);
    if (!moved && Math.hypot(cur.x - start.x, cur.y - start.y) * zoom < 3) return;
    moved = true;
    node.x = nx; node.y = ny;
    elNode.style.left = nx + 'px';
    elNode.style.top = ny + 'px';
    scheduleEdges();
  };
  const up = async () => {
    elNode.classList.remove('dragging');
    elNode.removeEventListener('pointermove', move);
    elNode.removeEventListener('pointerup', up);
    elNode.removeEventListener('pointercancel', up);
    if (moved) {
      try { mergeNode(await api.patch(`/api/nodes/${node.id}`, { x: node.x, y: node.y })); }
      catch (err) { toast(err.message, 'error'); }
    }
  };
  elNode.addEventListener('pointermove', move);
  elNode.addEventListener('pointerup', up);
  elNode.addEventListener('pointercancel', up);
}

function startResize(e, node, elNode) {
  e.preventDefault();
  e.stopPropagation();
  const start = { x: e.clientX, y: e.clientY };
  const orig = { w: node.w || NOTE_W, h: node.h || elNode.offsetHeight };
  // true content height, independent of the current min-height — measured once
  // so the note can be shrunk back after having been grown (the old code read
  // scrollHeight mid-drag, which made the min "sticky" at the grown size).
  const prevMin = elNode.style.minHeight;
  elNode.style.minHeight = '0px';
  const contentH = Math.max(MIN_H, elNode.scrollHeight);
  elNode.style.minHeight = prevMin;
  try { elNode.setPointerCapture(e.pointerId); } catch { /* synthetic pointers */ }
  const move = ev => {
    const dx = (ev.clientX - start.x) / zoom;
    const dy = (ev.clientY - start.y) / zoom;
    // bottom-right only: grow/shrink width and height, clamped to content.
    const w = Math.max(MIN_W, Math.min(MAX_W, orig.w + dx));
    const h = Math.max(contentH, Math.min(MAX_H, orig.h + dy));
    node.w = Math.round(w);
    node.h = Math.round(h);
    elNode.style.width = node.w + 'px';
    elNode.style.minHeight = node.h + 'px';
    noteSizes.set(node.id, { w: node.w, h: node.h });
    scheduleEdges();
  };
  const up = async () => {
    elNode.removeEventListener('pointermove', move);
    elNode.removeEventListener('pointerup', up);
    elNode.removeEventListener('pointercancel', up);
    try { mergeNode(await api.patch(`/api/nodes/${node.id}`, { w: node.w, h: node.h })); }
    catch (err) { toast(err.message, 'error'); }
  };
  elNode.addEventListener('pointermove', move);
  elNode.addEventListener('pointerup', up);
  elNode.addEventListener('pointercancel', up);
}

// reparent: drag the chain handle onto another note
function startRelink(e, node) {
  e.preventDefault();
  e.stopPropagation();
  const ghost = document.createElementNS(svgNS, 'path');
  ghost.setAttribute('fill', 'none');
  ghost.setAttribute('stroke', 'var(--accent)');
  ghost.setAttribute('stroke-width', '2.5');
  ghost.setAttribute('stroke-dasharray', '6 5');
  ghost.classList.add('mm-ghost');
  svg.append(ghost);

  let target = null;
  const onMove = ev => {
    const w = screenToWorld(ev.clientX, ev.clientY);
    const b = noteBox(node);
    const mx = (b.cx + w.x) / 2, my = (b.cy + w.y) / 2;
    ghost.setAttribute('d', `M ${b.cx} ${b.cy} Q ${mx} ${my - 30} ${w.x} ${w.y}`);
    const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.note');
    const cand = under ? Number(under.dataset.id) : null;
    if (cand !== target) {
      notesLayer.querySelector('.relink-target')?.classList.remove('relink-target');
      target = null;
      if (cand && cand !== node.id && !isDescendant(cand, node.id)) {
        target = cand;
        under.classList.add('relink-target');
      }
    }
  };
  const cleanup = () => {
    ghost.remove();
    notesLayer.querySelector('.relink-target')?.classList.remove('relink-target');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  const onUp = async () => {
    cleanup();
    if (target == null) {
      // dropped on empty board → make root
      try { mergeNode(await api.patch(`/api/nodes/${node.id}`, { parentId: 0 })); }
      catch (err) { toast(err.message, 'error'); }
      return;
    }
    try { mergeNode(await api.patch(`/api/nodes/${node.id}`, { parentId: target })); }
    catch (err) { toast(err.message, 'error'); }
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function select(id) {
  if (selectedId !== id) {
    selectedId = id;
    renderSelections();
    sendSelect(id);
  }
}

// --- selection & presence visuals ----------------------------------------------

function renderSelections() {
  notesLayer?.querySelectorAll('.note').forEach(n => {
    n.classList.remove('remote-selected');
    n.querySelector('.remote-tag')?.remove();
  });
  for (const [uid, nodeId] of store.selections) {
    const u = store.presence.get(uid);
    if (!u) continue;
    const n = notesLayer?.querySelector(`.note[data-id="${nodeId}"]`);
    if (!n) continue;
    n.classList.add('remote-selected');
    n.style.setProperty('--remote-color', u.color);
    n.append(el('span.remote-tag', { style: `--remote-color:${u.color}` }, u.username));
  }
  // also hint in list view happens there via its own render
}

function renderPresenceBar() {
  // handled by app shell; here for remote selections cleanup
  for (const uid of [...store.selections.keys()]) {
    if (!store.presence.has(uid)) store.selections.delete(uid);
  }
  renderSelections();
}

// --- note CRUD ------------------------------------------------------------------

export async function createNote({ x, y, parentId } = {}) {
  try {
    const node = await api.post(`/api/boards/${currentBoardId()}/nodes`, {
      title: '', x: Math.round(x ?? 0), y: Math.round(y ?? 0), parentId,
    });
    mergeNode(node);
    if (parentId != null) {
      // ensure parent is expanded
      setCollapsed(parentId, false);
    }
    selectedId = node.id;
    // open the title input right away so "add note" is immediately typeable
    startTitleEdit(node);
    return node;
  } catch (e) {
    toast(e.message, 'error');
    return null;
  }
}

async function addChildNote(parent) {
  const b = noteBox(parent);
  // cascade below-right of parent, avoiding exact overlap
  const sibs = nodeChildren(parent.id).length;
  await createNote({ x: b.cx - NOTE_W / 2 + 40 + sibs * 24, y: parent.y + (noteSizes.get(parent.id)?.h || 220) + 30, parentId: parent.id });
}

function noteMenu(node, anchor) {
  const { pop, close } = openPop(anchor);
  const kids = nodeChildren(node.id).length;
  const items = [
    menuItem(t('mm.rename'), () => renameNote(node, close)),
    menuItem(t('mm.addChild'), () => { close(); addChildNote(node); }),
    menuItem(t('mm.fields'), () => { close(); openFieldEditor(node.id, anchor); }),
    menuItem(t('mm.color'), () => colorPicker(node, close)),
    node.parentId != null && menuItem(t('mm.makeRoot'), async () => {
      close();
      try { mergeNode(await api.patch(`/api/nodes/${node.id}`, { parentId: 0 })); }
      catch (e) { toast(e.message, 'error'); }
    }),
    kids
      ? menuItem(t('mm.deleteSubtree'), async () => {
        close();
        await deleteNoteFlow(node);
      }, 'danger')
      : menuItem(t('mm.delete'), async () => {
        close();
        await deleteNoteFlow(node);
      }, 'danger'),
    kids > 0 && menuItem(t('mm.deleteOnly'), async () => {
      close();
      await deleteOnlyNote(node, false);
    }, 'danger'),
    kids > 0 && menuItem(t('mm.deleteKeepChildren'), async () => {
      close();
      await deleteOnlyNote(node, true);
    }, 'danger'),
  ];
  pop.append(...items.filter(Boolean)); // koşullu öğeler false döner — append metne çevirir
}

/** Delete just this note: children are reattached to its parent or made roots. */
async function deleteOnlyNote(node, toRoot) {
  const kids = nodeChildren(node.id);
  const parent = node.parentId ? store.nodes.get(node.parentId) : null;
  const dest = toRoot
    ? t('mm.toRoot', { n: kids.length })
    : t('mm.toParent', { n: kids.length, parent: parent?.title || t('mm.root') });
  const ok = await confirmDialog({
    title: t('mm.deleteTitle'),
    body: t('mm.deleteBody', { title: node.title || t('list.untitled'), dest }),
    confirmText: t('common.delete'),
    danger: true,
  });
  if (!ok) return;
  try {
    const targetParent = toRoot ? 0 : (node.parentId ?? 0);
    for (const k of kids) {
      const upd = await api.patch(`/api/nodes/${k.id}`, { parentId: targetParent });
      upsertNode(upd);
    }
    await api.del(`/api/nodes/${node.id}`);
    removeNodes([node.id]);
  } catch (e) { toast(e.message, 'error'); }
}

function openPop(anchor, onClose) {
  // local popover w/o ui.popover import cycle complexities
  const pop = el('div.popover.note-menu');
  const close = () => {
    pop.remove();
    document.removeEventListener('pointerdown', outside, true);
    onClose?.();
  };
  const outside = e => { if (!pop.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.visibility = 'hidden';
  requestAnimationFrame(() => {
    const x = clamp(r.left, 8, innerWidth - pop.offsetWidth - 8);
    const y = clamp(r.bottom + 6, 8, innerHeight - pop.offsetHeight - 8);
    pop.style.left = x + 'px';
    pop.style.top = y + 'px';
    pop.style.visibility = '';
    pop.classList.add('show');
  });
  return { pop, close };
}

function menuItem(label, fn, cls = '') {
  return el(`button.menu-item.${cls}`, { onclick: fn }, label);
}

function renameNote(node, closeMenu) {
  closeMenu();
  startTitleEdit(node);
}

/** Open an inline title input on a note and focus it (used by rename and by
 *  "add note", so a newly created note is immediately typeable). */
function startTitleEdit(node) {
  const noteEl = notesLayer.querySelector(`.note[data-id="${node.id}"]`);
  if (!noteEl) return;
  const titleEl = noteEl.querySelector('.note-title');
  if (!titleEl) return;
  const input = el('input.note-title-edit', { value: node.title });
  titleEl.replaceWith(input);
  try { input.focus({ preventScroll: true }); } catch { input.focus(); }
  input.select();
  const commit = async () => {
    const val = input.value.trim();
    if (val && val !== node.title) {
      try { mergeNode(await api.patch(`/api/nodes/${node.id}`, { title: val })); return; }
      catch (e) { toast(e.message, 'error'); }
    }
    renderAllNotes();
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = node.title; input.blur(); }
  });
  input.addEventListener('blur', commit, { once: true });
  input.addEventListener('pointerdown', e => e.stopPropagation());
}

function colorPicker(node, closeMenu) {
  closeMenu();
  const noteEl = notesLayer.querySelector(`.note[data-id="${node.id}"]`);
  // On close, re-apply the note's real style so a live slider preview never sticks.
  const resetNote = () => { if (noteEl) noteEl.setAttribute('style', noteStyle(store.nodes.get(node.id) || node)); };
  const { pop, close } = openPop(notesLayer.querySelector(`.note[data-id="${node.id}"] .note-tools`) || notesLayer, resetNote);
  const swatches = el('div.color-swatches', null,
    [null, ...NOTE_PALETTE].map(h =>
      el('button.swatch', {
        class: 'swatch' + ((node.hue ?? null) === h ? ' active' : ''),
        style: h == null ? 'background:var(--note-default)' : `background:hsl(${h} var(--note-sat) var(--note-lum))`,
        dataset: { hue: h ?? '' },
        title: h == null ? t('mm.defaultColor') : t('mm.hue', { h }),
        onclick: async () => {
          try {
            const patch = h == null ? { clearHue: true } : { hue: h };
            mergeNode(await api.patch(`/api/nodes/${node.id}`, patch));
            close();
          } catch (e) { toast(e.message, 'error'); }
        },
      }),
    ),
  );
  const slider = el('input.hue-slider', {
    type: 'range', min: 0, max: 359, value: node.hue ?? 35,
    oninput: e => {
      swatches.querySelectorAll('.swatch.active').forEach(s => s.classList.remove('active'));
      const h = Number(e.target.value);
      colorPreview.style.background = `hsl(${h} var(--note-sat) var(--note-lum))`;
      // live-preview the dragged color straight on the note paper
      if (noteEl) noteEl.style.setProperty('--hue', h);
    },
    onchange: async e => {
      try { mergeNode(await api.patch(`/api/nodes/${node.id}`, { hue: Number(e.target.value) })); close(); }
      catch (err) { toast(err.message, 'error'); resetNote(); }
    },
  });
  const colorPreview = el('span.hue-preview', { style: `background:hsl(${node.hue ?? 35} var(--note-sat) var(--note-lum))` });
  pop.append(el('div.pop-title', null, t('mm.colorTitle')), swatches,
    el('div.hue-row', null, slider, colorPreview));
}

async function deleteNoteFlow(node) {
  const kids = nodeChildren(node.id);
  let count = kids.length;
  const countAll = list => list.reduce((acc, k) => acc + 1 + countAll(nodeChildren(k.id)), 0);
  if (count > 0) count = countAll(kids);
  const ok = await confirmDialog({
    title: t('mm.deleteTitle'),
    body: count > 0
      ? t('mm.deleteSubtreeBody', { title: node.title || t('list.untitled'), n: count })
      : t('mm.deleteSingleBody', { title: node.title || t('list.untitled') }),
    confirmText: count > 0 ? t('list.deleteAll') : t('common.delete'),
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/api/nodes/${node.id}${count > 0 ? '?withChildren=1' : ''}`);
    const doomed = [node.id];
    const walk = pid => { for (const n of nodeChildren(pid)) { doomed.push(n.id); walk(n.id); } };
    walk(node.id);
    removeNodes(doomed); // emits → mindmap + list view both update
  } catch (e) { toast(e.message, 'error'); }
}

function mergeNode(node) {
  // store.upsertNode mutates in place AND emits → list view stays in sync
  upsertNode(node);
}

function currentBoardId() { return store.board?.board?.id; }

// --- toolbar (exported to app shell) --------------------------------------------

let toolbarApi = null;
export function bindToolbar(apiObj) { toolbarApi = apiObj; }
function emitToolbar() { toolbarApi?.onModeChange?.(editMode); }

export function zoomBy(factor) {
  const vp = viewport.getBoundingClientRect();
  zoomAt(vp.left + vp.width / 2, vp.top + vp.height / 2, factor);
}

/** Reset zoom to 100% around the viewport center. */
export function resetZoom() {
  const vp = viewport.getBoundingClientRect();
  zoomAt(vp.left + vp.width / 2, vp.top + vp.height / 2, 1 / zoom);
}

export function fit() { fitToContent(true); }

export function addNoteCentered() {
  const vp = viewport.getBoundingClientRect();
  const w = screenToWorld(vp.left + vp.width / 2 - NOTE_W / 2 + (store.nodes.size % 5) * 26, vp.top + vp.height / 2 - 60 + (store.nodes.size % 3) * 24);
  return createNote({ x: w.x, y: w.y });
}

export function addChildToSelected() {
  if (selectedId == null) return addNoteCentered();
  const parent = store.nodes.get(selectedId);
  if (!parent) return addNoteCentered();
  const b = noteBox(parent);
  const sibs = nodeChildren(parent.id).length;
  return createNote({
    x: b.cx - NOTE_W / 2 + 40 + sibs * 24,
    y: parent.y + (noteSizes.get(parent.id)?.h || 220) + 30,
    parentId: parent.id,
  });
}

// re-export for app shell convenience
export { colorForUser };
