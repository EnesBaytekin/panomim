package auth

import (
	"database/sql"
	"testing"
	"time"

	"panomim/internal/db"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	d, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	if err := db.Migrate(d); err != nil {
		t.Fatal(err)
	}
	return &Store{DB: d}
}

func timeNowPlus() time.Time { return time.Now().Add(15 * 24 * time.Hour) }
