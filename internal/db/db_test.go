package db

import (
	"path/filepath"
	"testing"
)

func TestOpenAndMigrate(t *testing.T) {
	dir := t.TempDir()
	d, err := Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer d.Close()

	if err := Migrate(d); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	// idempotent: second run must succeed
	if err := Migrate(d); err != nil {
		t.Fatalf("migrate twice: %v", err)
	}

	want := []string{"users", "refresh_tokens", "boards", "board_members", "nodes", "node_fields", "files", "user_board_prefs", "user_avatars", "meta"}
	for _, tbl := range want {
		var name string
		if err := d.QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, tbl).Scan(&name); err != nil {
			t.Errorf("table %s missing: %v", tbl, err)
		}
	}
}

func TestForeignKeys(t *testing.T) {
	dir := t.TempDir()
	d, _ := Open(filepath.Join(dir, "t.db"))
	defer d.Close()
	if err := Migrate(d); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`INSERT INTO nodes (board_id, title, created_at, updated_at) VALUES (999,'x',1,1)`); err == nil {
		t.Error("expected FK violation for missing board, got nil")
	}
}

func TestSchemaVersionTracked(t *testing.T) {
	dir := t.TempDir()
	d, _ := Open(filepath.Join(dir, "t.db"))
	defer d.Close()
	if err := Migrate(d); err != nil {
		t.Fatal(err)
	}

	want := 0
	for _, m := range migrations {
		if m.version > want {
			want = m.version
		}
	}
	got, err := schemaVersion(d)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("schema version = %d, want %d", got, want)
	}
}

// TestAddColumnMigrationRunsOnce proves the point of versioned migrations:
// a future ALTER TABLE runs once and is skipped on subsequent startups.
func TestAddColumnMigrationRunsOnce(t *testing.T) {
	dir := t.TempDir()
	d, _ := Open(filepath.Join(dir, "t.db"))
	defer d.Close()
	if err := Migrate(d); err != nil {
		t.Fatal(err)
	}

	future := []migration{
		{version: 100, stmts: []string{
			`ALTER TABLE nodes ADD COLUMN color TEXT NOT NULL DEFAULT ''`,
		}},
	}

	if err := applyMigrations(d, future); err != nil {
		t.Fatalf("apply future: %v", err)
	}

	var name string
	if err := d.QueryRow(`SELECT name FROM pragma_table_info('nodes') WHERE name='color'`).Scan(&name); err != nil {
		t.Fatalf("color column: %v", err)
	}
	if name != "color" {
		t.Fatalf("color column missing, got %q", name)
	}

	// re-run must skip cleanly (no "duplicate column" error)
	if err := applyMigrations(d, future); err != nil {
		t.Fatalf("re-apply future: %v", err)
	}
}
