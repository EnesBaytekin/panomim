package boards

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"panomim/internal/auth"
	"panomim/internal/httpx"
	"panomim/internal/notifications"
)

type Handlers struct {
	Store         *Store
	Presence      PresenceChecker                            // may be nil
	Notify        func(boardID int64, event map[string]any)  // realtime fan-out, wired by server
	Notifications *notifications.Store                       // per-user notifications, wired by server
}

func (h *Handlers) notify(r *http.Request, typ string, data map[string]any) {
	if h.Notify == nil {
		return
	}
	data["type"] = typ
	data["actor"] = httpx.ClientID(r)
	h.Notify(IDFrom(r.Context()), data)
}

// notifyMembers sends a board-change notification to every member except the
// actor. Best-effort: notification failures never fail the board operation.
func (h *Handlers) notifyMembers(r *http.Request, boardID int64, boardName, typ string) {
	if h.Notifications == nil {
		return
	}
	actorID := auth.UserFrom(r.Context()).ID
	members, err := h.Store.Members(boardID)
	if err != nil {
		return
	}
	for _, m := range members {
		if m.UserID == actorID {
			continue
		}
		h.Notifications.Notify(notifications.Notification{
			UserID: m.UserID, Type: typ, ActorID: actorID,
			BoardID: boardID, BoardName: boardName,
		})
	}
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
	ts, err := h.Store.Rename(IDFrom(r.Context()), req.Name)
	if err != nil {
		httpx.Err(w, 500, "rename failed")
		return
	}
	h.notify(r, "board_renamed", map[string]any{"id": IDFrom(r.Context()), "name": req.Name, "updatedAt": ts})
	h.notifyMembers(r, IDFrom(r.Context()), req.Name, notifications.TypeBoardRenamed)
	httpx.JSON(w, 200, map[string]bool{"ok": true})
}

func (h *Handlers) Delete(w http.ResponseWriter, r *http.Request) {
	id := IDFrom(r.Context())
	name, _ := h.Store.Name(id) // capture before delete for the notification
	members, _ := h.Store.Members(id)
	if err := h.Store.Delete(id); err != nil {
		httpx.Err(w, 500, "delete failed")
		return
	}
	h.notify(r, "board_deleted", map[string]any{"id": id})
	// tell other members (not the owner/actor) the board is gone
	if h.Notifications != nil {
		actorID := auth.UserFrom(r.Context()).ID
		for _, m := range members {
			if m.UserID == actorID {
				continue
			}
			h.Notifications.Notify(notifications.Notification{
				UserID: m.UserID, Type: notifications.TypeBoardDeleted, ActorID: actorID,
				BoardID: id, BoardName: name,
			})
		}
	}
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
	boardID := IDFrom(r.Context())
	actor := auth.UserFrom(r.Context())
	targetID, boardName, err := h.Store.ShareTarget(boardID, req.Username, req.Role)
	if errors.Is(err, ErrNotFound) {
		httpx.Err(w, 404, "no such user")
		return
	}
	if err == ErrExists {
		httpx.Err(w, 409, "already shared with this user")
		return
	}
	if err != nil {
		httpx.Err(w, 500, "share failed")
		return
	}
	if h.Notifications != nil {
		if pending, _ := h.Notifications.HasPendingShare(targetID, boardID); pending {
			httpx.Err(w, 409, "request already pending")
			return
		}
		// Approval flow: create a pending request instead of adding the member.
		h.Notifications.Notify(notifications.Notification{
			UserID: targetID, Type: notifications.TypeBoardShare, ActorID: actor.ID,
			BoardID: boardID, BoardName: boardName, Role: string(req.Role),
		})
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "pending": true})
}

func (h *Handlers) Unshare(w http.ResponseWriter, r *http.Request) {
	uid, err := strconv.ParseInt(r.PathValue("userID"), 10, 64)
	if err != nil {
		httpx.Err(w, 400, "invalid user id")
		return
	}
	boardID := IDFrom(r.Context())
	name, _ := h.Store.Name(boardID)
	if err := h.Store.Unshare(boardID, uid); err != nil {
		httpx.Err(w, 404, "member not found")
		return
	}
	h.notify(r, "members_changed", map[string]any{"id": boardID})
	if h.Notifications != nil {
		actorID := auth.UserFrom(r.Context()).ID
		h.Notifications.Notify(notifications.Notification{
			UserID: uid, Type: notifications.TypeBoardRemoved, ActorID: actorID,
			BoardID: boardID, BoardName: name,
		})
	}
	httpx.JSON(w, 200, map[string]bool{"ok": true})
}

type memberRoleReq struct {
	Role Role `json:"role"`
}

// SetMemberRole changes an existing member's role directly (owner-only). Unlike
// Share this does not go through the approval flow — the member already exists.
func (h *Handlers) SetMemberRole(w http.ResponseWriter, r *http.Request) {
	uid, err := strconv.ParseInt(r.PathValue("userID"), 10, 64)
	if err != nil {
		httpx.Err(w, 400, "invalid user id")
		return
	}
	var req memberRoleReq
	if err := httpx.Body(r, &req); err != nil {
		httpx.Err(w, 400, "invalid body")
		return
	}
	if err := h.Store.SetMemberRole(IDFrom(r.Context()), uid, req.Role); err != nil {
		if errors.Is(err, ErrNotFound) {
			httpx.Err(w, 404, "member not found")
			return
		}
		httpx.Err(w, 500, "update role failed")
		return
	}
	h.notify(r, "members_changed", map[string]any{"id": IDFrom(r.Context())})
	httpx.JSON(w, 200, map[string]bool{"ok": true})
}
