package auth

import (
	"context"
	"net/http"
	"regexp"
	"strings"
	"time"

	"panomim/internal/httpx"
)

const refreshCookie = "panomim_rt"

type Service struct {
	Store  *Store
	Tokens *TokenManager
	TTL    time.Duration // refresh lifetime (15 days)
	Secure bool          // Secure cookie flag (true under HTTPS)
}

type credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
	DeviceID string `json:"deviceId"`
}

var (
	usernameRe = regexp.MustCompile(`^[a-zA-Z0-9_.-]{3,32}$`)
	ctxKeyUser = ctxKey{}
)

type ctxKey struct{}

// --- handlers ---------------------------------------------------------------

// Register creates an account and immediately logs the user in.
func (s *Service) Register(w http.ResponseWriter, r *http.Request) {
	var c credentials
	if err := httpx.Body(r, &c); err != nil {
		httpx.Err(w, 400, "invalid request body")
		return
	}
	if !usernameRe.MatchString(c.Username) {
		httpx.Err(w, 400, "username must be 3-32 chars: letters, digits, . _ -")
		return
	}
	if len(c.Password) < 8 {
		httpx.Err(w, 400, "password must be at least 8 characters")
		return
	}
	hash, err := HashPassword(c.Password)
	if err != nil {
		httpx.Err(w, 500, "hash failure")
		return
	}
	user, err := s.Store.CreateUser(c.Username, hash)
	if err == ErrUserExists {
		httpx.Err(w, 409, "username already taken")
		return
	}
	if err != nil {
		httpx.Err(w, 500, "could not create account")
		return
	}
	s.issueSession(w, r, user)
}

// Login verifies credentials and issues a fresh token family.
func (s *Service) Login(w http.ResponseWriter, r *http.Request) {
	var c credentials
	if err := httpx.Body(r, &c); err != nil {
		httpx.Err(w, 400, "invalid request body")
		return
	}
	id, hash, err := s.Store.UserByName(c.Username)
	if err == ErrBadCredentials {
		httpx.Err(w, 401, "wrong username or password")
		return
	}
	if err != nil {
		httpx.Err(w, 500, "lookup failure")
		return
	}
	if err := VerifyPassword(hash, c.Password); err != nil {
		httpx.Err(w, 401, "wrong username or password")
		return
	}
	user, err := s.Store.UserByID(id)
	if err != nil {
		httpx.Err(w, 500, "lookup failure")
		return
	}
	s.issueSession(w, r, user)
}

// Refresh rotates the refresh token cookie and returns a new access token.
// Reuse of an already-rotated token revokes the whole session family.
func (s *Service) Refresh(w http.ResponseWriter, r *http.Request) {
	ck, err := r.Cookie(refreshCookie)
	if err != nil || ck.Value == "" {
		httpx.Err(w, 401, "no refresh token")
		return
	}
	sess, err := s.Store.LookupRefresh(HashToken(ck.Value))
	if err != nil {
		httpx.Err(w, 500, "session lookup failed")
		return
	}
	if sess == nil {
		clearCookie(w, s.Secure)
		httpx.Err(w, 401, "session expired")
		return
	}
	user, err := s.Store.UserByID(sess.UserID)
	if err != nil {
		httpx.Err(w, 401, "account missing")
		return
	}
	// rotate: revoke old, store new in same family
	if err := s.Store.RotateRefresh(sess.ID); err != nil {
		httpx.Err(w, 500, "rotation failed")
		return
	}
	s.setRefreshCookie(w, r, user.ID, sess.FamilyID, sess.DeviceID)
	s.writeTokens(w, user)
}

// Logout revokes the presented refresh token and clears the cookie.
func (s *Service) Logout(w http.ResponseWriter, r *http.Request) {
	if ck, err := r.Cookie(refreshCookie); err == nil && ck.Value != "" {
		s.Store.RevokeByTokenHash(HashToken(ck.Value))
	}
	clearCookie(w, s.Secure)
	httpx.JSON(w, 200, map[string]bool{"ok": true})
}

// Me returns the authenticated user plus their last opened board.
func (s *Service) Me(w http.ResponseWriter, r *http.Request) {
	u := UserFrom(r.Context())
	if u == nil {
		httpx.Err(w, 401, "unauthorized")
		return
	}
	lastBoard, _ := s.Store.LastBoard(u.ID)
	httpx.JSON(w, 200, map[string]any{"id": u.ID, "username": u.Username, "lastBoardId": lastBoard})
}

type lastBoardReq struct {
	BoardID int64 `json:"boardId"`
}

// SetLastBoard remembers which board the user was viewing (device-agnostic).
func (s *Service) SetLastBoard(w http.ResponseWriter, r *http.Request) {
	u := UserFrom(r.Context())
	if u == nil {
		httpx.Err(w, 401, "unauthorized")
		return
	}
	var req lastBoardReq
	if err := httpx.Body(r, &req); err != nil {
		httpx.Err(w, 400, "invalid body")
		return
	}
	if err := s.Store.SetLastBoard(u.ID, req.BoardID); err != nil {
		httpx.Err(w, 500, "could not save")
		return
	}
	httpx.JSON(w, 200, map[string]bool{"ok": true})
}

// --- session helpers --------------------------------------------------------

func (s *Service) issueSession(w http.ResponseWriter, r *http.Request, u *User) {
	s.setRefreshCookie(w, r, u.ID, NewFamilyID(), deviceOf(r))
	s.writeTokens(w, u)
}

func (s *Service) writeTokens(w http.ResponseWriter, u *User) {
	access, exp, err := s.Tokens.NewAccessToken(u.ID, u.Username)
	if err != nil {
		httpx.Err(w, 500, "token signing failed")
		return
	}
	httpx.JSON(w, 200, map[string]any{
		"accessToken":   access,
		"expiresAt":     exp.UnixMilli(),
		"user":          u,
	})
}

func (s *Service) setRefreshCookie(w http.ResponseWriter, r *http.Request, userID int64, familyID, deviceID string) {
	raw, hash, err := NewRefreshToken()
	if err != nil {
		httpx.Err(w, 500, "token generation failed")
		return
	}
	expires := time.Now().Add(s.TTL)
	if err := s.Store.StoreRefresh(userID, hash, familyID, deviceID, r.UserAgent(), expires); err != nil {
		httpx.Err(w, 500, "session storage failed")
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     refreshCookie,
		Value:    raw,
		Path:     "/api/auth", // only auth endpoints ever need it
		Expires:  expires,
		MaxAge:   int(s.TTL / time.Second),
		HttpOnly: true,
		Secure:   s.Secure,
		SameSite: http.SameSiteStrictMode,
	})
}

func clearCookie(w http.ResponseWriter, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     refreshCookie,
		Value:    "",
		Path:     "/api/auth",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteStrictMode,
	})
}

func deviceOf(r *http.Request) string {
	if d := r.Header.Get("X-Device-Id"); d != "" && len(d) <= 128 {
		return d
	}
	return ""
}

// --- middleware --------------------------------------------------------------

// RequireAuth validates the bearer JWT and stores the user in context.
func (s *Service) RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := r.Header.Get("Authorization")
		if !strings.HasPrefix(h, "Bearer ") {
			httpx.Err(w, 401, "missing bearer token")
			return
		}
		claims, err := s.Tokens.ParseAccessToken(strings.TrimPrefix(h, "Bearer "))
		if err != nil {
			httpx.Err(w, 401, "invalid or expired token")
			return
		}
		u := &User{ID: claims.UserID, Username: claims.Username}
		ctx := context.WithValue(r.Context(), ctxKeyUser, u)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// UserFrom extracts the authenticated user from a request context.
func UserFrom(ctx context.Context) *User {
	u, _ := ctx.Value(ctxKeyUser).(*User)
	return u
}
