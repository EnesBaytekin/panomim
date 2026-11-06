// Package config holds application configuration resolved from flags and environment.
//
// Every setting can come from a TODOER_* environment variable (handy for
// Docker/systemd deployments) and from a command-line flag. Flags win when both
// are present: env values are installed as the flag defaults.
package config

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Config carries every runtime knob for the server.
type Config struct {
	Addr        string // listen address for HTTP/HTTPS
	DataDir     string // sqlite db, certs, uploads
	HTTP        bool   // serve plain HTTP (dev)
	CertFile    string // explicit TLS certificate (PEM)
	KeyFile     string // explicit TLS key (PEM)
	HTTPSDomain string // enable Let's Encrypt autocert for this domain
	Dev         bool   // serve web/static from disk instead of embedded assets
	DevDir      string // static dir for -dev
	AccessTTL   time.Duration
	RefreshTTL  time.Duration
}

// Parse reads flags (with environment-provided defaults) and validates the result.
func Parse() (*Config, error) {
	home, _ := os.UserHomeDir()
	defaultData := filepath.Join(home, ".local", "share", "todoer")

	c := &Config{}
	flag.StringVar(&c.Addr, "addr", envStr("TODOER_ADDR", ":8443"), "listen address (env: TODOER_ADDR)")
	flag.StringVar(&c.DataDir, "data", envStr("TODOER_DATA", defaultData), "data directory (db, certs) (env: TODOER_DATA)")
	flag.BoolVar(&c.HTTP, "http", envBool("TODOER_HTTP", false), "serve plain HTTP instead of TLS (dev only) (env: TODOER_HTTP)")
	flag.StringVar(&c.CertFile, "cert", os.Getenv("TODOER_CERT"), "TLS certificate PEM (defaults to auto-generated self-signed) (env: TODOER_CERT)")
	flag.StringVar(&c.KeyFile, "key", os.Getenv("TODOER_KEY"), "TLS key PEM (env: TODOER_KEY)")
	flag.StringVar(&c.HTTPSDomain, "https-domain", os.Getenv("TODOER_HTTPS_DOMAIN"), "domain for Let's Encrypt autocert (enables public HTTPS) (env: TODOER_HTTPS_DOMAIN)")
	flag.BoolVar(&c.Dev, "dev", envBool("TODOER_DEV", false), "serve web assets from disk for development (env: TODOER_DEV)")
	flag.StringVar(&c.DevDir, "dev-dir", envStr("TODOER_DEV_DIR", "web/static"), "static dir used with -dev (env: TODOER_DEV_DIR)")
	flag.Parse()

	// token lifetimes: env-only knobs (rarely needed on the CLI)
	c.AccessTTL = envDuration("TODOER_ACCESS_TTL", 15*time.Minute)
	c.RefreshTTL = envDuration("TODOER_REFRESH_TTL", 15*24*time.Hour)

	if c.DataDir == "" {
		return nil, fmt.Errorf("data directory must not be empty")
	}
	if !c.HTTP && c.HTTPSDomain == "" && (c.CertFile == "") != (c.KeyFile == "") {
		return nil, fmt.Errorf("-cert and -key must be given together")
	}
	return c, nil
}

func envStr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func envBool(key string, def bool) bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	switch v {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	case "":
		return def
	default:
		// unparseable values fall back to the default rather than failing startup
		return def
	}
}

func envDuration(key string, def time.Duration) time.Duration {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	if d, err := time.ParseDuration(v); err == nil && d > 0 {
		return d
	}
	if secs, err := strconv.Atoi(v); err == nil && secs > 0 {
		return time.Duration(secs) * time.Second
	}
	return def
}
