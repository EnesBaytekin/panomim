// Tiny DOM + UI helpers.
import { api } from './api.js';
import { t } from './i18n.js';

/** Create element: el('div.note', {onclick}, children...)
 *  Tolerant: if the 2nd argument is not a plain attrs object (e.g. an element),
 *  it is treated as the first child — so el('div.card', title, body) works. */
export function el(spec, ...args) {
  const [tag, ...classes] = spec.split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');
  let attrs = args[0];
  if (attrs != null && typeof attrs === 'object' && !(attrs instanceof Node) && !Array.isArray(attrs)) {
    args = args.slice(1);
  } else {
    attrs = null;
  }
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'style') node.setAttribute('style', v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k in node && k !== 'type' && k !== 'value' && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of args.flat(9)) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export const AVATAR_COLORS = ['#e07a5f', '#4f8ef7', '#2a9d8f', '#e76f51', '#9b5de5', '#f4a261', '#43aa8b', '#f94144', '#577590', '#b5179e'];

export function colorForUser(id) {
  return AVATAR_COLORS[Math.abs(Number(id)) % AVATAR_COLORS.length];
}

export function initials(name) {
  const parts = (name || '?').trim().split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

export function avatar(user, size = 'md') {
  const span = el(`span.avatar.${size}`, {
    style: `--c:${colorForUser(user.userId ?? user.id)}`,
    title: user.username,
  }, initials(user.username));
  const id = user.userId ?? user.id;
  return id == null ? span : withPhoto(span, id);
}

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''));
  if (isNaN(d)) return iso;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

let toastHost;
export function toast(msg, kind = 'info') {
  if (!toastHost) {
    toastHost = el('div.toasts');
    document.body.append(toastHost);
  }
  const t = el(`div.toast.${kind}`, null, msg);
  toastHost.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, 3200);
}

/** Confirmation modal; resolves true/false. opts = {title, body, confirmText, danger} */
export function confirmDialog({ title, body, confirmText = t('common.ok'), danger = false }) {
  return new Promise(resolve => {
    const close = val => { overlay.remove(); resolve(val); };
    const overlay = el('div.modal-overlay', { onclick: e => { if (e.target === overlay) close(false); } },
      el('div.modal',
        el('h3.modal-title', null, title),
        body && el('div.modal-body', null, body),
        el('div.modal-actions',
          el('button.btn.ghost', { onclick: () => close(false) }, t('common.cancel')),
          el(`button.btn.${danger ? 'danger' : 'primary'}`, { onclick: () => close(true) }, confirmText),
        ),
      ),
    );
    document.body.append(overlay);
    overlay.querySelector('.btn:last-child').focus();
  });
}

/** Small popover anchored to a rect; closes on outside click. Returns content container. */
export function popover(anchor, { placement = 'bottom-start', onClose } = {}) {
  const pop = el('div.popover');
  const close = () => {
    pop.remove();
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('resize', close);
    onClose?.();
  };
  const outside = e => { if (!pop.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  // On mobile, focusing an input inside the popover opens the on-screen keyboard,
  // which fires a resize — closing here would drop focus and dismiss the keyboard.
  // Only close on resize when focus has actually left the popover.
  window.addEventListener('resize', () => { if (!pop.contains(document.activeElement)) close(); });
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.visibility = 'hidden';
  requestAnimationFrame(() => {
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let x = placement.includes('end') ? r.right - pw : r.left;
    let y = placement.startsWith('top') ? r.top - ph - 8 : r.bottom + 8;
    x = Math.max(8, Math.min(x, innerWidth - pw - 8));
    y = Math.max(8, Math.min(y, innerHeight - ph - 8));
    pop.style.left = x + 'px';
    pop.style.top = y + 'px';
    pop.style.visibility = '';
    pop.classList.add('show');
  });
  return { pop, close };
}

export function debounce(fn, ms) {
  let t;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  wrapped.flush = (...args) => { clearTimeout(t); fn(...args); };
  return wrapped;
}

/** Small form modal with a single text input; resolves the string or null.
 *  Replaces browser prompt() for board naming etc. */
export function promptDialog({ title, label, placeholder = '', value = '', confirmText = t('common.ok') } = {}) {
  return new Promise(resolve => {
    const close = val => { overlay.remove(); resolve(val); };
    const input = el('input.input', { type: 'text', placeholder, value, maxlength: 120 });
    const submit = () => close(input.value.trim());
    const overlay = el('div.modal-overlay', { onclick: e => { if (e.target === overlay) close(null); } },
      el('div.modal',
        el('h3.modal-title', null, title),
        label && el('div.modal-body', null, label),
        el('div.modal-field', null, input),
        el('div.modal-actions',
          el('button.btn.ghost', { onclick: () => close(null) }, t('common.cancel')),
          el('button.btn.primary', { onclick: submit }, confirmText),
        ),
      ),
    );
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    document.body.append(overlay);
    input.focus();
    input.select();
  });
}

// --- profile photos ---------------------------------------------------------
// Avatars are fetched once per user as blobs (img tags cannot send bearer
// headers) and cached as object URLs; every avatar(user) element reuses them.

const avatarURLs = new Map();    // userId -> objectURL
const avatarMisses = new Set();  // userId with no photo (avoid refetch spam)
const avatarFetches = new Map(); // userId -> Promise<objectURL|null>

export function getAvatarURL(userId) {
  return userId == null ? undefined : avatarURLs.get(userId);
}

/** Kick off (or join) an avatar fetch; resolves the object URL or null. */
export function fetchAvatar(userId) {
  if (userId == null || avatarMisses.has(userId)) return Promise.resolve(null);
  if (avatarURLs.has(userId)) return Promise.resolve(avatarURLs.get(userId));
  if (avatarFetches.has(userId)) return avatarFetches.get(userId);
  const p = (async () => {
    try {
      const res = await fetch(`/api/users/${userId}/avatar`, {
        headers: { Authorization: 'Bearer ' + api.token },
      });
      if (!res.ok) return null;
      const blob = await res.blob();
      if (!blob.size) { avatarMisses.add(userId); return null; } // 204: no photo
      const url = URL.createObjectURL(blob);
      avatarURLs.set(userId, url);
      return url;
    } catch { return null; }
    finally { avatarFetches.delete(userId); }
  })();
  avatarFetches.set(userId, p);
  return p;
}

/** Drop a cached avatar (after upload/removal) so the next render refetches. */
export function forgetAvatar(userId) {
  const url = avatarURLs.get(userId);
  if (url) URL.revokeObjectURL(url);
  avatarURLs.delete(userId);
  avatarMisses.delete(userId);
}

function withPhoto(span, userId) {
  const url = getAvatarURL(userId);
  if (url) {
    span.classList.add('photo');
    span.style.backgroundImage = `url(${url})`;
    span.textContent = '';
    return span;
  }
  fetchAvatar(userId).then(u => {
    if (u && span.isConnected) {
      span.classList.add('photo');
      span.style.backgroundImage = `url(${u})`;
      span.textContent = '';
    }
  });
  return span;
}
