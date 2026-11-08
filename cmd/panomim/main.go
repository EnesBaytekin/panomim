// Command panomim runs the self-contained pano & mindmap web app (frontend embedded).
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

	"panomim/internal/auth"
	"panomim/internal/boards"
	"panomim/internal/config"
	"panomim/internal/db"
	"panomim/internal/friends"
	"panomim/internal/nodes"
	"panomim/internal/prefs"
	"panomim/internal/realtime"
	"panomim/internal/server"
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
	migrateLegacyData(cfg.DataDir)
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return fmt.Errorf("data dir: %w", err)
	}

	// --- database ---
	database, err := db.Open(filepath.Join(cfg.DataDir, "panomim.db"))
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
	nodeStore := &nodes.Store{DB: database}
	nh := &nodes.Handlers{
		Store:  nodeStore,
		Boards: bh.Store,
		Emit:   hub.Broadcast,
	}
	fh := &friends.Handlers{Store: &friends.Store{DB: database}}
	deps := server.Deps{
		Auth:    authSvc,
		Boards:  bh,
		Nodes:   nh,
		Friends: fh,
		Prefs:   &prefs.Store{DB: database},
		WS:      &realtime.Handlers{Hub: hub, Boards: bh.Store},
		Hub:     hub,
	}
	if cfg.Dev {
		server.SetDevDir(cfg.DevDir)
		deps.DevDir = cfg.DevDir
	}
	handler := server.Router(deps)

	// Purge soft-deleted notes once a board's editing session has ended.
	startPurgeCleanup(hub, nodeStore)

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		// No IdleTimeout: closing idle keep-alive connections on a fixed delay
		// caused intermittent "Failed to fetch" — a browser can reuse a connection
		// the server has just closed, and non-idempotent requests (upload/rename)
		// are not auto-retried by the browser. Let clients manage connection reuse.
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
	fmt.Printf("\n  ✓ panomim hazır → %s\n  ✓ veri: %s\n\n", url, cfg.DataDir)

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

// startPurgeCleanup hard-deletes soft-deleted notes after a board's editing
// session ends. Soft-deletes are kept only so the deleting client can undo
// within the session; once the last user leaves a board room there is no undo
// stack left to satisfy, so the rows are purged for good.
//
// Two triggers: the room-empty hook (with a short grace for transient reconnects)
// and a periodic sweep that catches boards which emptied before this process
// noticed or while it was down.
func startPurgeCleanup(hub *realtime.Hub, store *nodes.Store) {
	purge := func(boardID int64) {
		if len(hub.OnlineUsers(boardID)) > 0 {
			return // still an active session — undo may need the rows
		}
		n, err := store.PurgeDeleted(boardID)
		if err != nil {
			log.Printf("purge deleted (board %d): %v", boardID, err)
		} else if n > 0 {
			log.Printf("purged %d soft-deleted note(s) from board %d", n, boardID)
		}
	}

	hub.OnRoomEmpty = func(boardID int64) {
		go func() {
			time.Sleep(30 * time.Second) // let transient reconnects settle first
			purge(boardID)
		}()
	}

	go func() {
		for range time.Tick(2 * time.Minute) {
			ids, err := store.DeletedBoards()
			if err != nil {
				continue
			}
			for _, id := range ids {
				purge(id)
			}
		}
	}()
}

// ensureJWTSecret loads (or creates) the token signing secret from the meta
// table so existing sessions stay valid across restarts.
// migrateLegacyData carries pre-rename "todoer" installations over to the new
// panomim names: the default data directory and the sqlite file (with -wal/-shm
// sidecars). Runs before the dir/db are touched, so existing data survives the
// rename untouched.
func migrateLegacyData(dir string) {
	// eski varsayılan dizin → yeni varsayılan dizin (yalnızca varsayılan kullanılıyorsa)
	if home, err := os.UserHomeDir(); err == nil {
		if dir == filepath.Join(home, ".local", "share", "panomim") {
			old := filepath.Join(home, ".local", "share", "todoer")
			if _, err := os.Stat(dir); os.IsNotExist(err) {
				if _, err := os.Stat(old); err == nil {
					if err := os.Rename(old, dir); err != nil {
						log.Printf("eski veri dizini taşınamadı (%s): %v", old, err)
					}
				}
			}
		}
	}
	// eski db dosya adı → yeni
	newDB := filepath.Join(dir, "panomim.db")
	if _, err := os.Stat(newDB); os.IsNotExist(err) {
		for _, ext := range []string{"", "-wal", "-shm"} {
			oldDB := filepath.Join(dir, "todoer.db"+ext)
			if _, err := os.Stat(oldDB); err == nil {
				if err := os.Rename(oldDB, newDB+ext); err != nil {
					log.Printf("eski veritabanı taşınamadı (%s): %v", oldDB, err)
				}
			}
		}
	}
}

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
