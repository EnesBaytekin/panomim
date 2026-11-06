// Field editor popover — shared by list view and mindmap.
import { api, fileURL } from './api.js';
import { el, popover, fmtDate, debounce, toast } from './ui.js';
import { store, upsertNode, canEdit } from './store.js';

/** img whose src resolves through the authenticated blob loader
 *  (<img> can't send the bearer header, so direct /api/files src 401s). */
function fileImg(fileId, cls, alt) {
  const img = el('img' + (cls ? '.' + cls : ''), { alt, loading: 'lazy' });
  fileURL(fileId).then(u => { if (u) img.src = u; });
  return img;
}

const FIELD_TYPES = [
  ['text', '✎', 'Not'],
  ['date', '📅', 'Tarih'],
  ['time', '🕑', 'Saat'],
  ['datetime', '📅', 'Tarih & Saat'],
  ['link', '🔗', 'Bağlantı'],
  ['image', '🖼', 'Görsel'],
];

const iconOf = t => (FIELD_TYPES.find(f => f[0] === t) || ['?', '•'])[1];

/** Render a compact chip list of a node's fields (read view).
 *  Empty text fields are hidden (they render as blank-looking chips).
 *  opts.skipText: drop text fields entirely (mindmap renders them as note body). */
export function fieldChips(node, opts = {}) {
  return node.fields
    .filter(f => f.type !== 'text' || (f.value || '').trim())
    .filter(f => !(opts.skipText && f.type === 'text'))
    .map(f => {
    if (f.type === 'image') {
      return fileImg(f.value, 'field-img', 'görsel');
    }
    let text = f.value;
    if (f.type === 'date') text = fmtDate(f.value);
    if (f.type === 'link') text = safeHost(f.value) || f.value;
    if (f.type === 'datetime') text = f.value.replace('T', ' ');
    return f.type === 'link'
      ? el('a.field-chip', { href: f.value, target: '_blank', rel: 'noopener noreferrer', title: f.value }, iconOf(f.type), ' ', text)
      : el('span.field-chip', { title: f.value }, iconOf(f.type), ' ', text);
  });
}

function safeHost(url) {
  try { return new URL(url).host; } catch { return ''; }
}

/** Render a single field as a note-body element: a text line, an image, or a
 *  chip (date/time/datetime/link). Used by the mindmap's ordered field list. */
export function fieldElement(f) {
  if (f.type === 'text') {
    return el('div.note-desc-line', null, f.value);
  }
  if (f.type === 'image') {
    return fileImg(f.value, 'field-img', 'görsel');
  }
  let text = f.value;
  if (f.type === 'date') text = fmtDate(f.value);
  if (f.type === 'link') text = safeHost(f.value) || f.value;
  if (f.type === 'datetime') text = f.value.replace('T', ' ');
  return f.type === 'link'
    ? el('a.field-chip', { href: f.value, target: '_blank', rel: 'noopener noreferrer', title: f.value }, iconOf(f.type), ' ', text)
    : el('span.field-chip', { title: f.value }, iconOf(f.type), ' ', text);
}

/** Open the edit popover for a node. */
export function openFieldEditor(nodeId, anchor) {
  const node = store.nodes.get(nodeId);
  if (!node) return;
  const { pop, close } = popover(anchor);

  function rerender() {
    const n = store.nodes.get(nodeId);
    if (!n) { close(); return; }
    clear(pop);
    pop.append(
      el('div.pop-title', null, 'Alanlar'),
      el('div.fields-list', null, n.fields.map(f => fieldRow(n, f, rerender))),
      addRow(n, rerender),
    );
  }
  rerender();
  return close;
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function fieldRow(node, f, rerender) {
  const save = debounce(async value => {
    try {
      const nf = await api.patch(`/api/fields/${f.id}`, { value });
      applyFieldLocal(nf);
    } catch (e) { toast(e.message, 'error'); }
  }, 600);

  let input;
  if (f.type === 'image') {
    input = el('div.field-image-edit',
      fileImg(f.value, '', ''),
      canEdit() && el('button.btn.tiny.ghost', {
        onclick: async () => {
          if (await removeField(f)) rerender();
        },
      }, 'Kaldır'),
    );
  } else {
    const type = f.type === 'datetime' ? 'datetime-local' : f.type === 'date' ? 'date' : f.type === 'time' ? 'time' : f.type === 'link' ? 'url' : 'text';
    input = el('input.input.small', {
      type, value: f.value,
      oninput: e => save(e.target.value),
      onkeydown: e => { if (e.key === 'Enter') e.target.blur(); },
      disabled: !canEdit(),
    });
    if (f.type === 'link' && f.value) {
      input = el('div.field-link-row', input,
        el('a.btn.tiny.ghost', { href: f.value, target: '_blank', rel: 'noopener noreferrer' }, '↗'));
    }
  }
  return el('div.field-row', null,
    el('span.field-icon', null, iconOf(f.type)),
    input,
    canEdit() && f.type !== 'image' && el('button.icon-btn.tiny', {
      title: 'Alanı sil', onclick: async () => { if (await removeField(f)) rerender(); },
    }, '✕'),
  );
}

async function removeField(f) {
  try {
    await api.del(`/api/fields/${f.id}`);
    const node = store.nodes.get(f.nodeId);
    if (node) {
      node.fields = node.fields.filter(x => x.id !== f.id);
      upsertNode(node); // triggers views
    }
    return true;
  } catch (e) { toast(e.message, 'error'); return false; }
}

function applyFieldLocal(nf) {
  const node = store.nodes.get(nf.nodeId);
  if (!node) return;
  const i = node.fields.findIndex(f => f.id === nf.id);
  if (i >= 0) node.fields[i] = nf;
  upsertNode(node);
}

function addRow(node, rerender) {
  if (!canEdit()) return null;
  const sel = el('select.input.small', null,
    FIELD_TYPES.map(([v, , label]) => el('option', { value: v }, label)));
  return el('div.field-add',
    sel,
    el('button.btn.small.primary', {
      onclick: async () => {
        const type = sel.value;
        if (type === 'image') {
          pickAndUpload(node.id).then(ok => ok && rerender());
          return;
        }
        try {
          const defaultValue = { text: '', date: new Date().toISOString().slice(0, 10), time: '09:00', datetime: new Date().toISOString().slice(0, 16), link: 'https://' }[type] || '';
          const f = await api.post(`/api/nodes/${node.id}/fields`, { type, value: defaultValue });
          const n = store.nodes.get(node.id);
          n.fields.push(f);
          upsertNode(n);
          rerender();
        } catch (e) { toast(e.message, 'error'); }
      },
    }, '+ Ekle'),
  );
}

export async function pickAndUpload(nodeId) {
  return new Promise(resolve => {
    const inp = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml' });
    inp.onchange = async () => {
      const file = inp.files[0];
      if (!file) return resolve(false);
      const fd = new FormData();
      fd.append('file', file);
      try {
        const res = await api.post(`/api/boards/${store.board.board.id}/files`, fd);
        const f = await api.post(`/api/nodes/${nodeId}/fields`, { type: 'image', value: res.id });
        const n = store.nodes.get(nodeId);
        n.fields.push(f);
        upsertNode(n);
        resolve(true);
      } catch (e) {
        toast(e.message, 'error');
        resolve(false);
      }
    };
    inp.click();
  });
}
