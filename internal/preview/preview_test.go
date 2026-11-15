package preview

import (
	"net"
	"net/url"
	"testing"
)

func TestIsPublicIP(t *testing.T) {
	cases := map[string]bool{
		"8.8.8.8":         true,
		"93.184.216.34":   true,
		"127.0.0.1":       false,
		"10.0.0.1":        false,
		"172.16.0.1":      false,
		"192.168.1.1":     false,
		"169.254.169.254": false, // link-local (cloud metadata)
		"0.0.0.0":         false,
		"224.0.0.1":       false, // multicast
		"::1":             false,
		"fd00::1":         false, // ULA
		"fe80::1":         false, // link-local
		"2606:4700::1111": true,
	}
	for ip, want := range cases {
		if got := isPublicIP(parseIP(ip)); got != want {
			t.Errorf("isPublicIP(%s) = %v, want %v", ip, got, want)
		}
	}
}

func TestGuardURL(t *testing.T) {
	refuse := []string{
		"http://localhost:8080/x",
		"http://127.0.0.1/",
		"http://[::1]/",
		"http://10.0.0.5/",
		"http://192.168.1.111:8443/",
		"http://169.254.169.254/latest/meta-data/",
		"ftp://example.com/file",
		"file:///etc/passwd",
	}
	for _, raw := range refuse {
		u, err := url.Parse(raw)
		if err != nil {
			t.Fatalf("parse %q: %v", raw, err)
		}
		if err := guardURL(u); err == nil {
			t.Errorf("guardURL(%q) should be refused", raw)
		}
	}
	// public host passes the guard without a network call in these tests (the
	// DNS check is exercised only when we cannot avoid it).
	u, _ := url.Parse("https://example.com/path")
	if err := guardURL(u); err != nil {
		t.Errorf("guardURL(public) should pass, got %v", err)
	}
}

func TestParseHTML(t *testing.T) {
	page := `<html><head>
		<title>Fallback Title</title>
		<meta property="og:title" content="Open Graph Title">
		<meta name="description" content="A description of the page.">
		<meta property="og:image" content="/img/hero.png">
		<meta property="og:site_name" content="Example">
	</head><body></body></html>`
	base, _ := url.Parse("https://example.com/articles/1")
	m, err := parseHTML(page, base)
	if err != nil {
		t.Fatalf("parseHTML: %v", err)
	}
	if m.Title != "Open Graph Title" {
		t.Errorf("title = %q, want Open Graph Title", m.Title)
	}
	if m.Description != "A description of the page." {
		t.Errorf("description = %q", m.Description)
	}
	if m.SiteName != "Example" {
		t.Errorf("siteName = %q", m.SiteName)
	}
	if m.Image != "https://example.com/img/hero.png" {
		t.Errorf("image = %q, want absolute URL", m.Image)
	}
	if m.Host != "example.com" {
		t.Errorf("host = %q", m.Host)
	}
}

func TestParseHTMLNoMeta(t *testing.T) {
	page := `<html><head><title>Just a Title</title></head><body></body></html>`
	base, _ := url.Parse("https://x.example/page")
	m, err := parseHTML(page, base)
	if err != nil {
		t.Fatalf("parseHTML: %v", err)
	}
	if m.Title != "Just a Title" {
		t.Errorf("title = %q", m.Title)
	}
	if m.Description != "" || m.Image != "" {
		t.Errorf("expected empty description/image, got %q/%q", m.Description, m.Image)
	}
}

func parseIP(s string) (ip net.IP) {
	ip = net.ParseIP(s)
	return ip
}
