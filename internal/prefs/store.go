// Package prefs stores per-user, per-board UI preferences (pan/zoom, active
// tab, collapsed nodes) plus the user's last opened board.
package prefs

import (
	"database/sql"
	"encoding/json"
	"time"

	"panomim/internal/auth"
)

type Store struct {
	DB     *sql.DB
	Users  *auth.Store
}

// GetPrefs returns the stored prefs JSON (empty object when none).
func (s *Store) GetPrefs(userID, boardID int64) (json.RawMessage, error) {
	var raw string
	err := s.DB.QueryRow(`SELECT prefs FROM user_board_prefs WHERE user_id = ? AND board_id = ?`,
		userID, boardID).Scan(&raw)
	if err == sql.ErrNoRows {
		return json.RawMessage(`{}`), nil
	}
	if err != nil {
		return nil, err
	}
	return json.RawMessage(raw), nil
}

// PutPrefs upserts the prefs blob.
func (s *Store) PutPrefs(userID, boardID int64, raw json.RawMessage) error {
	if !json.Valid(raw) || len(raw) > 16*1024 {
		return ErrBadPrefs
	}
	_, err := s.DB.Exec(`INSERT INTO user_board_prefs (user_id, board_id, prefs, updated_at) VALUES (?,?,?,?)
		ON CONFLICT(user_id, board_id) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at`,
		userID, boardID, string(raw), time.Now().Unix())
	return err
}

type ErrBadPrefsError struct{}

func (ErrBadPrefsError) Error() string { return "prefs: invalid payload" }
var ErrBadPrefs = ErrBadPrefsError{}
