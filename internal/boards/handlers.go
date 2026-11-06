package boards

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"panomim/internal/auth"
	"panomim/internal/httpx"
)

type Handlers struct {
	Store    *Store
	Presence PresenceChecker                            // may be nil
	Notify   func(boardID int64, event map[string]any)  // realtime fan-out, wired by server
}

func (h *Handlers) notify(r *http.Request, typ string, data map[string]any) {
	if h.Notify == nil {
		return
	}
	data["type"] = typ
	data["actor"] = httpx.ClientID(r)
	h.Notify(IDFrom(r.Context()), data)
}

// Access middleware resolves the caller's role for {boardID} and enforces
// minRole. Downstream handlers read role/board via RoleFrom/IDFrom.
func (h *Handlers) Access(minRole Role) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			u := auth.UserFrom(r.Context())
			if u == nil {
				httpx.Err(w, 401, "unauthorized")
				return
			}
			boardID, err := strconv.ParseInt(r.PathValue("boardID"), 10, 64)
			if err != nil {
				httpx.Err(w, 400, "invalid board id")
				return
			}
			role, err := h.Store.RoleOf(boardID, u.ID)
			if errors.Is(err, ErrNotFound) {
				httpx.Err(w, 404, "board not found")
				return
			}
			if err == ErrForbidden || (role != RoleOwner && !roleAtLeast(role, minRole)) {
				httpx.Err(w, 403, "no access to this board")
				return
			}
			if err != nil {
				httpx.Err(w, 500, "role lookup failed")
				return
			}
			ctx := WithRole(WithBoardID(r.Context(), boardID), role)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func roleAtLeast(role, min Role) bool {
	rank := map[Role]int{RoleViewer: 1, RoleEditor: 2, RoleOwner: 3}
	return rank[role] >= rank[min]
}

// --- handlers ----------------------------------------------------------------

func (h *Handlers) List(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	boards, err := h.Store.List(u.ID)
	if err != nil {
		httpx.Err(w, 500, "list failed")
		return
	}
	if boards == nil {
		boards = []Board{}
	}
	httpx.JSON(w, 200, boards)
}

type nameReq struct {
	Name string `json:"name"`
}

func (h *Handlers) Create(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var req nameReq
	if err := httpx.Body(r, &req); err != nil {
		httpx.Err(w, 400, "invalid body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len(req.Name) > 80 {
		httpx.Err(w, 400, "name must be 1-80 characters")
		return
	}
	b, err := h.Store.Create(u.ID, req.Name)
	if err != nil {
		httpx.Err(w, 500, "create failed")
		return
	}
	httpx.JSON(w, 201, b)
}

func (h *Handlers) Get(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	boardID := IDFrom(r.Context())
	b, members, err := h.Store.Get(boardID, u.ID, h.Presence)
	if errors.Is(err, ErrNotFound) {
		httpx.Err(w, 404, "board not found")
		return
	}
	if err != nil {
		httpx.Err(w, 500, "get failed")
		return
	}
	httpx.JSON(w, 200, map[string]any{"board": b, "members": members})
}

func (h *Handlers) Rename(w http.ResponseWriter, r *http.Request) {
	var req nameReq
	if err := httpx.Body(r, &req); err != nil {
		httpx.Err(w, 400, "invalid body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len(req.Name) > 80 {
		httpx.Err(w, 400, "name must be 1-80 characters")
		return
	}
	if err := h.Store.Rename(IDFrom(r.Context()), req.Name); err != nil {
		httpx.Err(w, 500, "rename failed")
		return
	}
	h.notify(r, "board_renamed", map[string]any{"id": IDFrom(r.Context()), "name": req.Name})
	httpx.JSON(w, 200, map[string]bool{"ok": true})
}

func (h *Handlers) Delete(w http.ResponseWriter, r *http.Request) {
	id := IDFrom(r.Context())
	if err := h.Store.Delete(id); err != nil {
		httpx.Err(w, 500, "delete failed")
		return
	}
	h.notify(r, "board_deleted", map[string]any{"id": id})
	httpx.JSON(w, 200, map[string]bool{"ok": true})
}

type shareReq struct {
	Username string `json:"username"`
	Role     Role   `json:"role"`
}

func (h *Handlers) Share(w http.ResponseWriter, r *http.Request) {
	var req shareReq
	if err := httpx.Body(r, &req); err != nil {
		httpx.Err(w, 400, "invalid body")
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	if req.Username == "" {
		httpx.Err(w, 400, "username required")
		return
	}
	m, err := h.Store.Share(IDFrom(r.Context()), req.Username, req.Role)
	if errors.Is(err, ErrNotFound) {
		httpx.Err(w, 404, "no such user")
		return
	}
	if err == ErrExists {
		httpx.Err(w, 409, "cannot share with the owner")
		return
	}
	if err != nil {
		httpx.Err(w, 500, "share failed")
		return
	}
	h.notify(r, "members_changed", map[string]any{"id": IDFrom(r.Context())})
	httpx.JSON(w, 200, m)
}

func (h *Handlers) Unshare(w http.ResponseWriter, r *http.Request) {
	uid, err := strconv.ParseInt(r.PathValue("userID"), 10, 64)
	if err != nil {
		httpx.Err(w, 400, "invalid user id")
		return
	}
	if err := h.Store.Unshare(IDFrom(r.Context()), uid); err != nil {
		httpx.Err(w, 404, "member not found")
		return
	}
	h.notify(r, "members_changed", map[string]any{"id": IDFrom(r.Context())})
	httpx.JSON(w, 200, map[string]bool{"ok": true})
}
