// Package db opens and migrates the SQLite database.
package db

import (
	"database/sql"
	"fmt"
	"time"

	_ "modernc.org/sqlite" // pure-Go SQLite driver
)

// Open creates the data directory if needed and returns a tuned DB handle.
func Open(path string) (*sql.DB, error) {
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=synchronous(NORMAL)", path)
	d, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// SQLite is a single-writer database; serialize writes through one connection
	// and allow concurrent reads on extra connections.
	d.SetMaxOpenConns(8)
	d.SetMaxIdleConns(8)
	d.SetConnMaxLifetime(0)
	if err := d.Ping(); err != nil {
		d.Close()
		return nil, err
	}
	return d, nil
}

// Migrate applies schema migrations idempotently, newest first-come order.
func Migrate(d *sql.DB) error {
	if _, err := d.Exec(`PRAGMA journal_mode=WAL`); err != nil {
		return err
	}
	if _, err := d.Exec(`PRAGMA foreign_keys=ON`); err != nil {
		return err
	}
	if _, err := d.Exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`); err != nil {
		return err
	}
	for _, m := range migrations {
		if _, err := d.Exec(m); err != nil {
			return fmt.Errorf("migration: %w", err)
		}
	}
	return nil
}

var migrations = []string{
	// 1 — users & sessions
	`CREATE TABLE IF NOT EXISTS users (
		id            INTEGER PRIMARY KEY,
		username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
		password_hash TEXT NOT NULL,
		last_board_id INTEGER,
		created_at    INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS refresh_tokens (
		id           INTEGER PRIMARY KEY,
		user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		token_hash   TEXT NOT NULL UNIQUE,
		family_id    TEXT NOT NULL,
		device_id    TEXT NOT NULL DEFAULT '',
		user_agent   TEXT NOT NULL DEFAULT '',
		expires_at   INTEGER NOT NULL,
		revoked_at   INTEGER,
		created_at   INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id)`,
	`CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens(family_id)`,

	// 2 — boards & sharing
	`CREATE TABLE IF NOT EXISTS boards (
		id         INTEGER PRIMARY KEY,
		owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		name       TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS board_members (
		board_id  INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
		user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		role      TEXT NOT NULL CHECK(role IN ('viewer','editor')),
		created_at INTEGER NOT NULL,
		PRIMARY KEY (board_id, user_id)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_members_user ON board_members(user_id)`,

	// 3 — todo tree
	`CREATE TABLE IF NOT EXISTS nodes (
		id         INTEGER PRIMARY KEY,
		board_id   INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
		parent_id  INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
		title      TEXT NOT NULL DEFAULT '',
		position   REAL NOT NULL DEFAULT 0,
		x          REAL NOT NULL DEFAULT 0,
		y          REAL NOT NULL DEFAULT 0,
		w          REAL NOT NULL DEFAULT 0, -- 0 = auto width (fixed), height always auto unless set
		h          REAL NOT NULL DEFAULT 0, -- 0 = auto height
		hue        INTEGER,                 -- NULL = default paper color
		done       INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_nodes_board ON nodes(board_id)`,
	`CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id)`,

	// 4 — extra note fields
	`CREATE TABLE IF NOT EXISTS node_fields (
		id         INTEGER PRIMARY KEY,
		node_id    INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
		type       TEXT NOT NULL CHECK(type IN ('text','date','time','datetime','link','image')),
		value      TEXT NOT NULL DEFAULT '',
		position   INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_fields_node ON node_fields(node_id)`,

	// 5 — image/file storage
	`CREATE TABLE IF NOT EXISTS files (
		id          TEXT PRIMARY KEY,
		board_id    INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
		uploader_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		name        TEXT NOT NULL,
		mime        TEXT NOT NULL,
		size        INTEGER NOT NULL,
		data        BLOB NOT NULL,
		created_at  INTEGER NOT NULL
	)`,

	// 6 — per-user board preferences (pan/zoom, tab, collapsed nodes)
	`CREATE TABLE IF NOT EXISTS user_board_prefs (
		user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		board_id   INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
		prefs      TEXT NOT NULL DEFAULT '{}',
		updated_at INTEGER NOT NULL,
		PRIMARY KEY (user_id, board_id)
	)`,
}

// Now returns the current unix time used for all timestamp columns.
func Now() int64 { return time.Now().Unix() }
