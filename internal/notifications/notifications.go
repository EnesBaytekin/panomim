// Package notifications implements the per-user notification inbox: friend and
// board-share requests, their acceptances, and board change notices. It writes
// rows to the notifications table and pushes live events to the recipient.
package notifications

import (
	"database/sql"
	"errors"
	"log"
	"net/http"
	"strconv"
	"time"

	"panomim/internal/auth"
	"panomim/internal/httpx"
)

// Notification types.
const (
	TypeFriendRequest = "friend_request"
	TypeFriendAccept  = "friend_accept"
	TypeBoardShare    = "board_share"
	TypeBoardShareAcc = "board_share_accept"
	TypeBoardRenamed  = "board_renamed"
	TypeBoardDeleted  = "board_deleted"
	TypeBoardRemoved  = "board_removed"
)

// Notification is one inbox entry. Display names are snapshotted at creation so
// a later board rename/delete does not blank an already-sent message.
type Notification struct {
	ID        int64  `json:"id"`
	Type      string `json:"type"`
	ActorID   int64  `json:"actorId,omitempty"`
	ActorName string `json:"actorName,omitempty"`
	BoardID   int64  `json:"boardId,omitempty"`
	BoardName string `json:"boardName,omitempty"`
	Role      string `json:"role,omitempty"`
	CreatedAt int64  `json:"createdAt"`

	UserID int64 `json:"-"` // recipient; never serialized
}

var ErrNotFound = errors.New("notifications: not found")

// Store persists notifications and fans them out to a user's live connections.
type Store struct {
	DB          *sql.DB
	Push        func(userID int64, msg map[string]any)   // wired to realtime.Hub.NotifyUser
	BoardNotify func(boardID int64, msg map[string]any)  // wired to realtime.Hub.Broadcast
}

// Create inserts a notification, resolving actor/board display names from the
// database when they are not supplied. Returns the persisted row.
func (s *Store) Create(n Notification) (*Notification, error) {
	actorName := n.ActorName
	if actorName == "" && n.ActorID > 0 {
		_ = s.DB.QueryRow(`SELECT username FROM users WHERE id = ?`, n.ActorID).Scan(&actorName)
	}
	boardName := n.BoardName
	if boardName == "" && n.BoardID > 0 {
		_ = s.DB.QueryRow(`SELECT name FROM boards WHERE id = ?`, n.BoardID).Scan(&boardName)
	}
	now := time.Now().Unix()
	res, err := s.DB.Exec(
		`INSERT INTO notifications (user_id, type, actor_id, actor_name, board_id, board_name, role, created_at)
		 VALUES (?,?,?,?,?,?,?,?)`,
		n.UserID, n.Type, n.ActorID, actorName, n.BoardID, boardName, n.Role, now)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return &Notification{
		ID: id, Type: n.Type, ActorID: n.ActorID, ActorName: actorName,
		BoardID: n.BoardID, BoardName: boardName, Role: n.Role, CreatedAt: now,
	}, nil
}

// Notify persists n and pushes it to the recipient in realtime. Best-effort: it
// must never fail the caller's primary operation, so errors are only logged.
func (s *Store) Notify(n Notification) {
	row, err := s.Create(n)
	if err != nil {
		log.Printf("notify: %v", err)
		return
	}
	if s.Push != nil {
		s.Push(n.UserID, map[string]any{"type": "notification", "notification": row})
	}
}

// List returns the caller's newest notifications.
func (s *Store) List(userID int64, limit int) ([]Notification, error) {
	if limit <= 0 || limit > 200 {
		limit = 100
	}
	rows, err := s.DB.Query(`
		SELECT id, type, actor_id, actor_name, board_id, board_name, role, created_at
		FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Notification
	for rows.Next() {
		var n Notification
		if err := rows.Scan(&n.ID, &n.Type, &n.ActorID, &n.ActorName, &n.BoardID, &n.BoardName, &n.Role, &n.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// Count returns the number of unread notifications (used for the badge).
func (s *Store) Count(userID int64) (int, error) {
	var n int
	err := s.DB.QueryRow(`SELECT COUNT(*) FROM notifications WHERE user_id = ?`, userID).Scan(&n)
	return n, err
}

// Delete removes one of the caller's notifications.
func (s *Store) Delete(userID, id int64) error {
	res, err := s.DB.Exec(`DELETE FROM notifications WHERE id = ? AND user_id = ?`, id, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteAll clears the caller's inbox.
func (s *Store) DeleteAll(userID int64) error {
	_, err := s.DB.Exec(`DELETE FROM notifications WHERE user_id = ?`, userID)
	return err
}

// HasPendingShare reports whether a board_share request is already pending for
// this user+board (idempotency guard so a re-share doesn't stack duplicates).
func (s *Store) HasPendingShare(userID, boardID int64) (bool, error) {
	var one int
	err := s.DB.QueryRow(`SELECT 1 FROM notifications WHERE user_id = ? AND board_id = ? AND type = ?`,
		userID, boardID, TypeBoardShare).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// get fetches one notification including its recipient id.
func (s *Store) get(id int64) (*Notification, error) {
	var n Notification
	err := s.DB.QueryRow(`
		SELECT id, user_id, type, actor_id, actor_name, board_id, board_name, role, created_at
		FROM notifications WHERE id = ?`, id).
		Scan(&n.ID, &n.UserID, &n.Type, &n.ActorID, &n.ActorName, &n.BoardID, &n.BoardName, &n.Role, &n.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &n, nil
}

// AcceptShare approves a pending board-share: it adds the recipient to the
// board, removes the request, and notifies the sharer of the acceptance.
func (s *Store) AcceptShare(userID, id int64) error {
	n, err := s.get(id)
	if err != nil {
		return err
	}
	if n.UserID != userID || n.Type != TypeBoardShare {
		return ErrNotFound
	}
	// The board must still exist (owner may have deleted it while pending).
	var one int
	if err := s.DB.QueryRow(`SELECT 1 FROM boards WHERE id = ?`, n.BoardID).Scan(&one); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	role := n.Role
	if role != "viewer" && role != "editor" {
		role = "viewer"
	}
	if _, err := s.DB.Exec(`INSERT INTO board_members (board_id, user_id, role, created_at) VALUES (?,?,?,?)
		ON CONFLICT(board_id, user_id) DO UPDATE SET role = excluded.role`,
		n.BoardID, userID, role, time.Now().Unix()); err != nil {
		return err
	}
	if _, err := s.DB.Exec(`DELETE FROM notifications WHERE id = ?`, id); err != nil {
		return err
	}
	s.Notify(Notification{
		UserID: n.ActorID, Type: TypeBoardShareAcc, ActorID: userID,
		BoardID: n.BoardID, BoardName: n.BoardName, Role: role,
	})
	// Let everyone online in that board refresh its member list (the new member
	// just joined).
	if s.BoardNotify != nil {
		s.BoardNotify(n.BoardID, map[string]any{"type": "members_changed", "id": n.BoardID})
	}
	return nil
}

// DeclineShare dismisses a pending board-share without adding the board.
func (s *Store) DeclineShare(userID, id int64) error {
	n, err := s.get(id)
	if err != nil {
		return err
	}
	if n.UserID != userID || n.Type != TypeBoardShare {
		return ErrNotFound
	}
	_, err = s.DB.Exec(`DELETE FROM notifications WHERE id = ?`, id)
	return err
}

// DismissFriendRequest removes a friend_request notification from `toID`'s inbox
// once the request from `fromID` is resolved (accepted), so a stale "wants to add
// you" does not linger after the two are already friends.
func (s *Store) DismissFriendRequest(toID, fromID int64) {
	_, _ = s.DB.Exec(`DELETE FROM notifications WHERE user_id = ? AND type = ? AND actor_id = ?`,
		toID, TypeFriendRequest, fromID)
}

// --- handlers -----------------------------------------------------------------

type Handlers struct {
	Store *Store
}

func (h *Handlers) List(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	list, err := h.Store.List(u.ID, 100)
	if err != nil {
		httpx.Err(w, 500, "list notifications failed")
		return
	}
	if list == nil {
		list = []Notification{}
	}
	httpx.JSON(w, 200, list)
}

func (h *Handlers) Delete(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		httpx.Err(w, 400, "invalid id")
		return
	}
	if err := h.Store.Delete(u.ID, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			httpx.Err(w, 404, "notification not found")
			return
		}
		httpx.Err(w, 500, "delete failed")
		return
	}
	httpx.JSON(w, 200, map[string]bool{"ok": true})
}

func (h *Handlers) DeleteAll(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	if err := h.Store.DeleteAll(u.ID); err != nil {
		httpx.Err(w, 500, "clear failed")
		return
	}
	httpx.JSON(w, 200, map[string]bool{"ok": true})
}

func (h *Handlers) Accept(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		httpx.Err(w, 400, "invalid id")
		return
	}
	if err := h.Store.AcceptShare(u.ID, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			httpx.Err(w, 404, "request not found")
			return
		}
		httpx.Err(w, 500, "accept failed")
		return
	}
	httpx.JSON(w, 200, map[string]bool{"ok": true})
}

func (h *Handlers) Decline(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		httpx.Err(w, 400, "invalid id")
		return
	}
	if err := h.Store.DeclineShare(u.ID, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			httpx.Err(w, 404, "request not found")
			return
		}
		httpx.Err(w, 500, "decline failed")
		return
	}
	httpx.JSON(w, 200, map[string]bool{"ok": true})
}
