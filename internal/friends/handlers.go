package friends

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
	Notifications *notifications.Store // per-user notifications, wired by server
}

// --- requests ---------------------------------------------------------------

func (h *Handlers) ListRequests(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	in, out, err := h.Store.ListRequests(u.ID)
	if err != nil {
		httpx.Err(w, 500, "list requests failed")
		return
	}
	if in == nil {
		in = []FriendRequest{}
	}
	if out == nil {
		out = []FriendRequest{}
	}
	httpx.JSON(w, 200, map[string]any{"incoming": in, "outgoing": out})
}

type sendReq struct {
	Username string `json:"username"`
}

func (h *Handlers) SendRequest(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var req sendReq
	if err := httpx.Body(r, &req); err != nil {
		httpx.Err(w, 400, "invalid body")
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	if req.Username == "" {
		httpx.Err(w, 400, "username required")
		return
	}
	targetID, auto, err := h.Store.SendRequest(u.ID, req.Username)
	switch {
	case errors.Is(err, ErrNotFound):
		httpx.Err(w, 404, "no such user")
		return
	case errors.Is(err, ErrSelf):
		httpx.Err(w, 400, "kendini ekleyemezsin")
		return
	case errors.Is(err, ErrAlready):
		httpx.Err(w, 409, "zaten arkadaşsınız")
		return
	case errors.Is(err, ErrPending):
		httpx.Err(w, 409, "istek zaten gönderildi")
		return
	case err != nil:
		httpx.Err(w, 500, "send request failed")
		return
	}
	if h.Notifications != nil {
		if auto {
			// Reverse request already existed → their earlier request is accepted.
			h.Notifications.Notify(notifications.Notification{
				UserID: targetID, Type: notifications.TypeFriendAccept, ActorID: u.ID,
			})
			h.Notifications.DismissFriendRequest(u.ID, targetID)
		} else {
			h.Notifications.Notify(notifications.Notification{
				UserID: targetID, Type: notifications.TypeFriendRequest, ActorID: u.ID,
			})
		}
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "autoAccepted": auto})
}

func (h *Handlers) AcceptRequest(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id, err := strconv.ParseInt(r.PathValue("requestID"), 10, 64)
	if err != nil {
		httpx.Err(w, 400, "invalid request id")
		return
	}
	fromID, err := h.Store.AcceptRequest(u.ID, id)
	if err != nil {
		if errors.Is(err, ErrBadRequest) {
			httpx.Err(w, 404, "request not found")
			return
		}
		httpx.Err(w, 500, "accept failed")
		return
	}
	if h.Notifications != nil {
		h.Notifications.Notify(notifications.Notification{
			UserID: fromID, Type: notifications.TypeFriendAccept, ActorID: u.ID,
		})
		h.Notifications.DismissFriendRequest(u.ID, fromID)
	}
	httpx.JSON(w, 200, map[string]bool{"ok": true})
}

func (h *Handlers) DeclineRequest(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id, err := strconv.ParseInt(r.PathValue("requestID"), 10, 64)
	if err != nil {
		httpx.Err(w, 400, "invalid request id")
		return
	}
	if err := h.Store.DeclineRequest(u.ID, id); err != nil {
		if errors.Is(err, ErrBadRequest) {
			httpx.Err(w, 404, "request not found")
			return
		}
		httpx.Err(w, 500, "decline failed")
		return
	}
	httpx.JSON(w, 200, map[string]bool{"ok": true})
}

// --- friends ----------------------------------------------------------------

func (h *Handlers) ListFriends(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	friends, err := h.Store.ListFriends(u.ID)
	if err != nil {
		httpx.Err(w, 500, "list friends failed")
		return
	}
	if friends == nil {
		friends = []Friend{}
	}
	httpx.JSON(w, 200, friends)
}

func (h *Handlers) SharedBoards(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	friendID, err := strconv.ParseInt(r.PathValue("userID"), 10, 64)
	if err != nil {
		httpx.Err(w, 400, "invalid user id")
		return
	}
	boards, err := h.Store.SharedBoards(u.ID, friendID)
	if errors.Is(err, ErrNotFriend) {
		httpx.Err(w, 404, "not friends")
		return
	}
	if err != nil {
		httpx.Err(w, 500, "shared boards failed")
		return
	}
	if boards == nil {
		boards = []SharedBoard{}
	}
	httpx.JSON(w, 200, boards)
}

// SearchUsers returns matching usernames for the add-friend autocomplete.
func (h *Handlers) SearchUsers(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		httpx.JSON(w, 200, []UserHit{})
		return
	}
	hits, err := h.Store.SearchUsers(u.ID, q, 8)
	if err != nil {
		httpx.Err(w, 500, "search failed")
		return
	}
	if hits == nil {
		hits = []UserHit{}
	}
	httpx.JSON(w, 200, hits)
}

// RemoveFriend removes a friend from the caller's friend list.
func (h *Handlers) RemoveFriend(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	friendID, err := strconv.ParseInt(r.PathValue("userID"), 10, 64)
	if err != nil {
		httpx.Err(w, 400, "invalid user id")
		return
	}
	if err := h.Store.RemoveFriend(u.ID, friendID); err != nil {
		if errors.Is(err, ErrNotFriend) {
			httpx.Err(w, 404, "not friends")
			return
		}
		httpx.Err(w, 500, "remove friend failed")
		return
	}
	httpx.JSON(w, 200, map[string]bool{"ok": true})
}
