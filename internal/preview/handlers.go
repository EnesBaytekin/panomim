// Package preview exposes the link-preview HTTP endpoints.
package preview

import (
	"net/http"
	"net/url"
	"strings"

	"panomim/internal/httpx"
)

type Handlers struct{}

// Meta resolves a pasted URL into a preview card. The endpoint is authed (any
// member) so the SSRF-fetching surface stays behind a login.
func (h *Handlers) Meta(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimSpace(r.URL.Query().Get("url"))
	if raw == "" {
		httpx.Err(w, 400, "url required")
		return
	}
	if len(raw) > 2048 {
		httpx.Err(w, 400, "url too long")
		return
	}
	meta, err := Fetch(raw)
	if err != nil {
		// Unsafe targets are a 400; unresolvable/no-metadata a 422; network
		// failures a 502. Clients treat any non-200 as "no preview".
		switch err {
		case ErrUnsafe:
			httpx.Err(w, 400, "unsupported link")
		case ErrNoPreview:
			httpx.Err(w, 422, "no preview")
		default:
			httpx.Err(w, 502, "could not fetch preview")
		}
		return
	}
	httpx.JSON(w, 200, meta)
}

// Image proxies a thumbnail back through our origin. The image URL is validated
// with the same SSRF guard before fetching.
func (h *Handlers) Image(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimSpace(r.URL.Query().Get("url"))
	if raw == "" {
		httpx.Err(w, 400, "url required")
		return
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		httpx.Err(w, 400, "invalid url")
		return
	}
	data, ctype, err := FetchImage(raw)
	if err != nil {
		httpx.Err(w, 404, "image unavailable")
		return
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.WriteHeader(http.StatusOK)
	w.Write(data)
}
