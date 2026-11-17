// Package preview fetches a remote page's metadata (title, description, image)
// for the link-preview cards shown inside notes. All fetches are server-side so
// the browser's strict CSP can stay "img-src 'self'" — thumbnails are proxied
// back through /api/preview/image instead of loading arbitrary remote hosts.
//
// Fetching a URL the user pasted is an SSRF surface, so every request goes
// through the same guard: http(s) only, and the resolved IP must be a public
// address. Private/loopback/link-local/multicast targets are refused.
package preview

import (
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/html"
)

// Meta is the unfurled link preview: the bits worth showing on a card.
type Meta struct {
	URL         string `json:"url"`
	Host        string `json:"host"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	Image       string `json:"image,omitempty"`
	SiteName    string `json:"siteName,omitempty"`
}

const (
	maxMetaBytes = 2 << 20 // 2 MiB page
	maxImgBytes  = 3 << 20 // 3 MiB thumbnail
	fetchTimeout = 8 * time.Second
)

// client follows redirects, re-validating every hop against the SSRF guard.
var client = &http.Client{
	Timeout: fetchTimeout,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("preview: too many redirects")
		}
		if err := guardURL(req.URL); err != nil {
			return err
		}
		return nil
	},
}

// ErrUnsafe reports a URL pointing at a non-public address.
var ErrUnsafe = errors.New("preview: target is not a public address")

// ErrNoPreview reports a URL that yields nothing worth showing.
var ErrNoPreview = errors.New("preview: no metadata")

// guardURL refuses non-http(s) URLs and any host resolving to a private or
// otherwise non-public address (the classic SSRF guard).
func guardURL(u *url.URL) error {
	if u.Scheme != "http" && u.Scheme != "https" {
		return ErrUnsafe
	}
	host := u.Hostname()
	if host == "" {
		return ErrUnsafe
	}
	if strings.EqualFold(host, "localhost") {
		return ErrUnsafe
	}
	// A literal IP needs no DNS round-trip.
	if ip := net.ParseIP(host); ip != nil {
		if !isPublicIP(ip) {
			return ErrUnsafe
		}
		return nil
	}
	addrs, err := net.LookupIP(host)
	if err != nil {
		return fmt.Errorf("preview: resolve %s: %w", host, err)
	}
	if len(addrs) == 0 {
		return ErrUnsafe
	}
	for _, ip := range addrs {
		if !isPublicIP(ip) {
			return ErrUnsafe
		}
	}
	return nil
}

func isPublicIP(ip net.IP) bool {
	return !ip.IsPrivate() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() &&
		!ip.IsLinkLocalMulticast() && !ip.IsMulticast() && !ip.IsUnspecified()
}

// Fetch retrieves a page and extracts its unfurl metadata. The result is cached
// briefly so re-rendering a note with the same link does not refetch it.
func Fetch(rawURL string) (*Meta, error) {
	u, err := parsePublic(rawURL)
	if err != nil {
		return nil, err
	}
	if v, ok := metaCache.get(u.String()); ok {
		if v == nil {
			return nil, ErrNoPreview
		}
		return v, nil
	}

	meta, err := fetch(u)
	if err != nil {
		return nil, err
	}
	if meta.Title == "" && meta.Description == "" && meta.Image == "" {
		metaCache.put(u.String(), nil)
		return nil, ErrNoPreview
	}
	metaCache.put(u.String(), meta)
	return meta, nil
}

// FetchImage downloads a thumbnail and returns its bytes and mime type.
// Used by the /api/preview/image proxy; same SSRF guard applies.
func FetchImage(rawURL string) ([]byte, string, error) {
	u, err := parsePublic(rawURL)
	if err != nil {
		return nil, "", err
	}
	req, err := http.NewRequest("GET", u.String(), nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "image/*")
	res, err := client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("preview: image fetch status %d", res.StatusCode)
	}
	ctype := res.Header.Get("Content-Type")
	if !strings.HasPrefix(ctype, "image/") {
		return nil, "", ErrNoPreview
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, maxImgBytes))
	if err != nil {
		return nil, "", err
	}
	if len(data) == 0 {
		return nil, "", ErrNoPreview
	}
	return data, ctype, nil
}

func parsePublic(rawURL string) (*url.URL, error) {
	rawURL = strings.TrimSpace(rawURL)
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, ErrUnsafe
	}
	if u.Scheme == "" {
		return nil, ErrUnsafe
	}
	if err := guardURL(u); err != nil {
		return nil, err
	}
	return u, nil
}

func fetch(u *url.URL) (*Meta, error) {
	req, err := http.NewRequest("GET", u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("preview: fetch status %d", res.StatusCode)
	}
	ctype := res.Header.Get("Content-Type")
	mediaType, _, _ := mime.ParseMediaType(ctype)
	if !strings.HasPrefix(mediaType, "text/html") && !strings.HasPrefix(mediaType, "application/xhtml") {
		return nil, ErrNoPreview
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, maxMetaBytes))
	if err != nil {
		return nil, err
	}
	return parseHTML(string(body), res.Request.URL)
}

func parseHTML(page string, base *url.URL) (*Meta, error) {
	doc, err := html.Parse(strings.NewReader(page))
	if err != nil {
		return nil, err
	}
	m := &Meta{URL: base.String(), Host: base.Host}
	var titleSeen bool
	og := map[string]string{}
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			switch n.Data {
			case "title":
				if !titleSeen {
					titleSeen = true
					if txt := textContent(n); txt != "" {
						m.Title = txt
					}
				}
			case "meta":
				key, val := metaAttr(n)
				if key != "" && val != "" && og[key] == "" {
					og[key] = val
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)

	if og["og:title"] != "" {
		m.Title = og["og:title"]
	}
	if og["og:site_name"] != "" {
		m.SiteName = og["og:site_name"]
	}
	desc := og["og:description"]
	if desc == "" {
		desc = og["description"]
	}
	if desc == "" {
		desc = og["twitter:description"]
	}
	m.Description = truncate(strings.Join(strings.Fields(desc), " "), 240)

	img := og["og:image"]
	if img == "" {
		img = og["twitter:image"]
	}
	if img != "" {
		if abs, err := base.Parse(img); err == nil {
			m.Image = abs.String()
		}
	}
	return m, nil
}

// metaAttr reads a <meta> tag's og:*/description key and its content value.
func metaAttr(n *html.Node) (string, string) {
	var key, val string
	for _, a := range n.Attr {
		switch strings.ToLower(a.Key) {
		case "property", "name":
			key = strings.ToLower(a.Val)
		case "content":
			val = a.Val
		}
	}
	switch key {
	case "og:title", "og:description", "og:image", "og:site_name",
		"description", "twitter:title", "twitter:description", "twitter:image":
		return key, val
	}
	return "", ""
}

func textContent(n *html.Node) string {
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(x *html.Node) {
		if x.Type == html.TextNode {
			b.WriteString(x.Data)
		}
		for c := x.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return strings.TrimSpace(b.String())
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return strings.TrimSpace(string(r[:n-1])) + "…"
}

const userAgent = "Mozilla/5.0 (compatible; Panomim/1.0; +https://localhost)"

// --- small TTL cache ---------------------------------------------------------

type cacheEntry struct {
	meta    *Meta
	expires time.Time
}

type ttlCache struct {
	mu    sync.Mutex
	items map[string]cacheEntry
	ttl   time.Duration
}

func (c *ttlCache) get(key string) (*Meta, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.items[key]
	if !ok {
		return nil, false
	}
	if time.Now().After(e.expires) {
		delete(c.items, key)
		return nil, false
	}
	return e.meta, true
}

func (c *ttlCache) put(key string, m *Meta) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.items[key] = cacheEntry{meta: m, expires: time.Now().Add(c.ttl)}
}

var metaCache = &ttlCache{items: map[string]cacheEntry{}, ttl: 30 * time.Minute}
