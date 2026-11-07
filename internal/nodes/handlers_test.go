package nodes

import "testing"

func TestSniffImage(t *testing.T) {
	cases := []struct {
		name string
		data []byte
		want string
	}{
		{"png", []byte("\x89PNG\r\n\x1a\nrest"), "image/png"},
		{"jpeg", []byte("\xff\xd8\xff\xe0rest"), "image/jpeg"},
		{"gif", []byte("GIF89arest"), "image/gif"},
		{"webp", []byte("RIFFxxxxWEBPrest"), "image/webp"},
		{"svg", []byte("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"), "image/svg+xml"},
		{"svg xml prolog", []byte("<?xml version=\"1.0\"?><svg></svg>"), "image/svg+xml"},
		{"svg leading bom", []byte("\xef\xbb\xbf  <svg></svg>"), "image/svg+xml"},
		{"unknown", []byte("this is not an image"), ""},
		{"heic", []byte("\x00\x00\x00\x18ftypheic"), ""},
	}
	for _, c := range cases {
		if got := sniffImage(c.data); got != c.want {
			t.Errorf("%s: sniffImage() = %q, want %q", c.name, got, c.want)
		}
	}
}
