// Link previews: unfurl a pasted URL via the server (which fetches it safely)
// and render a WhatsApp/Telegram-style card. The image is proxied through our
// origin so the page's strict CSP ("img-src 'self'") stays intact.
import { api } from './api.js';
import { el } from './ui.js';

// url -> fetched metadata (in-memory cache for the session)
const cache = new Map();
// url -> Promise, to coalesce duplicate in-flight requests
const inflight = new Map();

export function previewURL(url) {
  return `/api/preview/image?url=${encodeURIComponent(url)}`;
}

function meta(url) {
  if (cache.has(url)) return cache.get(url);
  if (inflight.has(url)) return inflight.get(url);
  const p = api.get('/api/preview/meta?url=' + encodeURIComponent(url))
    .then(m => { cache.set(url, m); return m; })
    .catch(() => { cache.set(url, null); return null; })
    .finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
}

/** Returns a promise resolving to a preview card element, or null when the URL
 *  has no preview (fetch failed, unsafe, or plain text). Used by the list view
 *  and mindmap; both render the link chip plus the card beneath it. */
export async function linkPreviewCard(field) {
  const url = field.value;
  if (!url) return null;
  const m = await meta(url);
  if (!m || (!m.title && !m.description && !m.image)) return null;

  const media = m.image
    ? el('div.link-preview-media', null,
        el('img.link-preview-img', {
          alt: '', loading: 'lazy',
          onerror: e => e.currentTarget.closest('.link-preview-media')?.remove(),
          src: previewURL(m.image),
        }),
      )
    : null;
  const title = m.title || m.host;
  return el('a.link-preview', {
    href: url, target: '_blank', rel: 'noopener noreferrer', title: url,
  },
    media,
    el('div.link-preview-body',
      title && el('div.link-preview-title', null, title),
      m.description && el('div.link-preview-desc', null, m.description),
      el('div.link-preview-host', null, m.siteName ? `${m.siteName} · ${m.host}` : m.host),
    ),
  );
}
