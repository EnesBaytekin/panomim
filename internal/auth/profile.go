package auth

import (
	"bytes"
	"io"
	"net/http"
	"strconv"

	"panomim/internal/httpx"
)

// maxAvatarBytes caps the uploaded profile photo (profil fotoğrafı boyut sınırı).
const maxAvatarBytes = 2 << 20 // 2 MiB

type passwordChangeReq struct {
	CurrentPassword string `json:"currentPassword"`
	NewPassword     string `json:"newPassword"`
}

// ChangePassword verifies the current password, stores the new hash and
// revokes every refresh session (other devices are logged out); the current
// device receives a fresh session via the response cookies.
func (s *Service) ChangePassword(w http.ResponseWriter, r *http.Request) {
	u := UserFrom(r.Context())
	if u == nil {
		httpx.Err(w, 401, "unauthorized")
		return
	}
	var c passwordChangeReq
	if err := httpx.Body(r, &c); err != nil {
		httpx.Err(w, 400, "invalid request body")
		return
	}
	if len(c.NewPassword) < 8 {
		httpx.Err(w, 400, "new password must be at least 8 characters")
		return
	}
	hash, err := s.Store.PasswordHashByID(u.ID)
	if err != nil {
		httpx.Err(w, 500, "lookup failure")
		return
	}
	if err := VerifyPassword(hash, c.CurrentPassword); err != nil {
		httpx.Err(w, 401, "mevcut parola hatalı")
		return
	}
	newHash, err := HashPassword(c.NewPassword)
	if err != nil {
		httpx.Err(w, 500, "hash failure")
		return
	}
	if err := s.Store.SetPassword(u.ID, newHash); err != nil {
		httpx.Err(w, 500, "update failed")
		return
	}
	// every existing refresh family dies; current device re-issues below
	if err := s.Store.RevokeAllForUser(u.ID); err != nil {
		httpx.Err(w, 500, "revoke failed")
		return
	}
	s.issueSession(w, r, u)
}

// PutAvatar accepts raw image bytes (PNG/JPEG/GIF/WEBP) and stores them as
// the caller's profile photo. An empty body removes the photo.
func (s *Service) PutAvatar(w http.ResponseWriter, r *http.Request) {
	u := UserFrom(r.Context())
	if u == nil {
		httpx.Err(w, 401, "unauthorized")
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxAvatarBytes))
	if err != nil {
		httpx.Err(w, 413, "photo too large (max 2 MiB)")
		return
	}
	if len(data) == 0 {
		if err := s.Store.SetAvatar(u.ID, "", nil); err != nil {
			httpx.Err(w, 500, "update failed")
			return
		}
		httpx.JSON(w, 200, map[string]any{"ok": true, "removed": true})
		return
	}
	mime := sniffImage(data)
	if mime == "" {
		httpx.Err(w, 400, "desteklenmeyen görsel türü (PNG, JPEG, GIF, WEBP)")
		return
	}
	if err := s.Store.SetAvatar(u.ID, mime, data); err != nil {
		httpx.Err(w, 500, "update failed")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "mime": mime})
}

// GetAvatar serves a user's profile photo to any authenticated user.
func (s *Service) GetAvatar(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("userID"), 10, 64)
	if err != nil {
		httpx.Err(w, 400, "invalid user id")
		return
	}
	mime, data, err := s.Store.Avatar(id)
	if err != nil {
		// 204 (not 404): img-side fetches run for every visible user and a
		// 404 would spam the browser console as a network error
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Cache-Control", "private, max-age=60")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// sniffImage detects supported raster image types by magic bytes; SVG is
// deliberately rejected (script injection risk when served cross-user).
func sniffImage(b []byte) string {
	switch {
	case bytes.HasPrefix(b, []byte("\x89PNG\r\n\x1a\n")):
		return "image/png"
	case bytes.HasPrefix(b, []byte("\xff\xd8\xff")):
		return "image/jpeg"
	case bytes.HasPrefix(b, []byte("GIF87a")), bytes.HasPrefix(b, []byte("GIF89a")):
		return "image/gif"
	case len(b) > 12 && bytes.Equal(b[0:4], []byte("RIFF")) && bytes.Equal(b[8:12], []byte("WEBP")):
		return "image/webp"
	}
	return ""
}
