package prefs

import (
	"encoding/json"
	"net/http"

	"todoer/internal/auth"
	"todoer/internal/boards"
	"todoer/internal/httpx"
)

// Get returns the caller's stored prefs for {boardID}.
func (s *Store) Get(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	raw, err := s.GetPrefs(u.ID, boards.IDFrom(r.Context()))
	if err != nil {
		httpx.Err(w, 500, "prefs lookup failed")
		return
	}
	httpx.JSON(w, 200, raw)
}

// Put stores the caller's prefs for {boardID}.
func (s *Store) Put(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	defer r.Body.Close()
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 20*1024))
	var raw json.RawMessage
	if err := dec.Decode(&raw); err != nil {
		httpx.Err(w, 400, "invalid JSON")
		return
	}
	if err := s.PutPrefs(u.ID, boards.IDFrom(r.Context()), raw); err != nil {
		httpx.Err(w, 400, "prefs rejected")
		return
	}
	httpx.JSON(w, 200, map[string]bool{"ok": true})
}
