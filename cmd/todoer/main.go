// Command todoer runs the self-contained todo web app (frontend embedded).
package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"golang.org/x/crypto/acme/autocert"

	"todoer/internal/auth"
	"todoer/internal/boards"
	"todoer/internal/config"
	"todoer/internal/db"
	"todoer/internal/nodes"
	"todoer/internal/prefs"
	"todoer/internal/realtime"
	"todoer/internal/server"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	cfg, err := config.Parse()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return fmt.Errorf("data dir: %w", err)
	}

	// --- database ---
	database, err := db.Open(filepath.Join(cfg.DataDir, "todoer.db"))
	if err != nil {
		return fmt.Errorf("db open: %w", err)
	}
	defer database.Close()
	if err := db.Migrate(database); err != nil {
		return fmt.Errorf("db migrate: %w", err)
	}

	// --- jwt secret (persisted so sessions survive restarts) ---
	secret, err := ensureJWTSecret(database)
	if err != nil {
		return err
	}

	// --- services ---
	hub := realtime.NewHub()
	usersStore := &auth.Store{DB: database}
	authSvc := &auth.Service{
		Store:  usersStore,
		Tokens: auth.NewTokenManager(secret, cfg.AccessTTL),
		TTL:    cfg.RefreshTTL,
		Secure: !cfg.HTTP,
	}
	bh := &boards.Handlers{
		Store:    &boards.Store{DB: database},
		Presence: hub,
		Notify:   hub.Broadcast,
	}
	nh := &nodes.Handlers{
		Store:  &nodes.Store{DB: database},
		Boards: bh.Store,
		Emit:   hub.Broadcast,
	}
	deps := server.Deps{
		Auth:   authSvc,
		Boards: bh,
		Nodes:  nh,
		Prefs:  &prefs.Store{DB: database},
		WS:     &realtime.Handlers{Hub: hub, Boards: bh.Store},
		Hub:    hub,
	}
	if cfg.Dev {
		server.SetDevDir(cfg.DevDir)
		deps.DevDir = cfg.DevDir
	}
	handler := server.Router(deps)

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	// --- listener (plain http | autocert | self-signed/explicit tls) ---
	scheme := "https"
	var ln net.Listener
	switch {
	case cfg.HTTP:
		scheme = "http"
		ln, err = net.Listen("tcp", cfg.Addr)
		if err != nil {
			return err
		}
	case cfg.HTTPSDomain != "":
		mgr := &autocert.Manager{
			Prompt:     autocert.AcceptTOS,
			HostPolicy: autocert.HostWhitelist(cfg.HTTPSDomain),
			Cache:      autocert.DirCache(filepath.Join(cfg.DataDir, "autocert")),
		}
		go http.ListenAndServe(":80", mgr.HTTPHandler(nil)) // ACME http-01
		srv.TLSConfig = mgr.TLSConfig()
		ln = tls.NewListener(mustListen(cfg.Addr), srv.TLSConfig)
	default:
		var cert tls.Certificate
		if cfg.CertFile != "" {
			cert, err = server.LoadExplicitTLS(cfg.CertFile, cfg.KeyFile)
		} else {
			cert, err = server.EnsureSelfSigned(cfg.DataDir)
		}
		if err != nil {
			return fmt.Errorf("tls: %w", err)
		}
		srv.TLSConfig = &tls.Config{
			Certificates: []tls.Certificate{cert},
			MinVersion:   tls.VersionTLS12,
			CipherSuites: preferredCiphers,
		}
		ln = tls.NewListener(mustListen(cfg.Addr), srv.TLSConfig)
	}

	// --- run ---
	errCh := make(chan error, 1)
	go func() { errCh <- srv.Serve(ln) }()
	url := fmt.Sprintf("%s://%s", scheme, displayHost(cfg.Addr))
	fmt.Printf("\n  ✓ todoer hazır → %s\n  ✓ veri: %s\n\n", url, cfg.DataDir)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	select {
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-stop:
		fmt.Println("\n  kapatılıyor…")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	return srv.Shutdown(ctx)
}

func mustListen(addr string) net.Listener {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatal(err)
	}
	return ln
}

// ensureJWTSecret loads (or creates) the token signing secret from the meta
// table so existing sessions stay valid across restarts.
func ensureJWTSecret(d *sql.DB) ([]byte, error) {
	var secret string
	err := d.QueryRow(`SELECT value FROM meta WHERE key = 'jwt_secret'`).Scan(&secret)
	switch {
	case err == nil:
		return hex.DecodeString(secret)
	case errors.Is(err, sql.ErrNoRows):
		raw := make([]byte, 32)
		if _, err := rand.Read(raw); err != nil {
			return nil, err
		}
		secret = hex.EncodeToString(raw)
		if _, err := d.Exec(`INSERT INTO meta (key, value) VALUES ('jwt_secret', ?)`, secret); err != nil {
			return nil, err
		}
		return raw, nil
	default:
		return nil, err
	}
}

func displayHost(addr string) string {
	if len(addr) > 0 && addr[0] == ':' {
		return "localhost" + addr
	}
	return addr
}

// preferredCiphers: modern AEAD suites only.
var preferredCiphers = []uint16{
	tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
	tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305,
	tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
	tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
	tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305,
	tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
}
