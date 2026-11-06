// Package friends implements the social graph: friend requests and friendships,
// plus the boards two friends have in common.
package friends

import (
	"database/sql"
	"errors"
	"time"
)

type Friend struct {
	UserID      int64  `json:"userId"`
	Username    string `json:"username"`
	SharedCount int    `json:"sharedCount"`
}

type FriendRequest struct {
	ID        int64  `json:"id"`
	UserID    int64  `json:"userId"` // the other party
	Username  string `json:"username"`
	CreatedAt int64  `json:"createdAt"`
	Direction string `json:"direction"` // "incoming" | "outgoing"
}

type SharedBoard struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	OwnerID    int64  `json:"ownerId"`
	OwnerName  string `json:"ownerName"`
	MyRole     string `json:"myRole"`
	FriendRole string `json:"friendRole"`
}

var (
	ErrNotFound   = errors.New("friends: no such user")
	ErrSelf       = errors.New("friends: cannot add yourself")
	ErrAlready    = errors.New("friends: already friends")
	ErrPending    = errors.New("friends: request already pending")
	ErrBadRequest = errors.New("friends: request not found")
	ErrNotFriend  = errors.New("friends: not friends")
)

type Store struct{ DB *sql.DB }

func (s *Store) userIDByName(username string) (int64, error) {
	var id int64
	err := s.DB.QueryRow(`SELECT id FROM users WHERE username = ?`, username).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	return id, err
}

// SendRequest sends a friend request to username. If the other party already
// sent one to us, the two are made friends immediately (autoAccept = true).
func (s *Store) SendRequest(fromID int64, username string) (autoAccept bool, err error) {
	toID, err := s.userIDByName(username)
	if err != nil {
		return false, err
	}
	if toID == fromID {
		return false, ErrSelf
	}

	if ok, err := s.areFriends(fromID, toID); err != nil {
		return false, err
	} else if ok {
		return false, ErrAlready
	}

	// Outgoing request already pending?
	var one int
	err = s.DB.QueryRow(`SELECT 1 FROM friend_requests WHERE from_user_id = ? AND to_user_id = ?`, fromID, toID).Scan(&one)
	if err == nil {
		return false, ErrPending
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}

	// They already asked us → accept that instead of creating a duplicate.
	err = s.DB.QueryRow(`SELECT 1 FROM friend_requests WHERE from_user_id = ? AND to_user_id = ?`, toID, fromID).Scan(&one)
	if err == nil {
		return true, s.makeFriends(fromID, toID)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}

	_, err = s.DB.Exec(`INSERT INTO friend_requests (from_user_id, to_user_id, created_at) VALUES (?,?,?)`,
		fromID, toID, time.Now().Unix())
	if err != nil {
		return false, err
	}
	return false, nil
}

// AcceptRequest turns a pending incoming request into a mutual friendship.
func (s *Store) AcceptRequest(userID, requestID int64) error {
	var fromID, toID int64
	err := s.DB.QueryRow(`SELECT from_user_id, to_user_id FROM friend_requests WHERE id = ?`, requestID).Scan(&fromID, &toID)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrBadRequest
	}
	if err != nil {
		return err
	}
	if toID != userID {
		return ErrBadRequest // only the recipient may accept
	}
	return s.makeFriends(fromID, toID)
}

// DeclineRequest removes a pending request. Works for the recipient (decline)
// and the sender (cancel) alike.
func (s *Store) DeclineRequest(userID, requestID int64) error {
	res, err := s.DB.Exec(`DELETE FROM friend_requests WHERE id = ? AND (from_user_id = ? OR to_user_id = ?)`,
		requestID, userID, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrBadRequest
	}
	return nil
}

// ListRequests returns incoming and outgoing pending requests.
func (s *Store) ListRequests(userID int64) (incoming, outgoing []FriendRequest, err error) {
	incoming, err = s.requestsWhere(true, userID)
	if err != nil {
		return nil, nil, err
	}
	outgoing, err = s.requestsWhere(false, userID)
	if err != nil {
		return nil, nil, err
	}
	return incoming, outgoing, nil
}

// requestsWhere lists requests where the caller is the recipient (incoming) or
// the sender (outgoing). The query is assembled from two constant fragments.
func (s *Store) requestsWhere(incoming bool, userID int64) ([]FriendRequest, error) {
	joinColumn := "fr.to_user_id" // outgoing: the other user is the recipient
	where := `fr.from_user_id = ?`
	dir := "outgoing"
	if incoming {
		joinColumn = "fr.from_user_id"
		where = `fr.to_user_id = ?`
		dir = "incoming"
	}
	rows, err := s.DB.Query(`
		SELECT fr.id, u.id, u.username, fr.created_at
		FROM friend_requests fr
		JOIN users u ON u.id = `+joinColumn+`
		WHERE `+where+`
		ORDER BY fr.created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []FriendRequest
	for rows.Next() {
		var r FriendRequest
		if err := rows.Scan(&r.ID, &r.UserID, &r.Username, &r.CreatedAt); err != nil {
			return nil, err
		}
		r.Direction = dir
		out = append(out, r)
	}
	return out, rows.Err()
}

// ListFriends returns the caller's friends with the count of boards they share.
func (s *Store) ListFriends(userID int64) ([]Friend, error) {
	rows, err := s.DB.Query(`
		SELECT u.id, u.username,
		       (SELECT COUNT(*) FROM boards b
		         WHERE (b.owner_id = f.friend_id OR EXISTS (SELECT 1 FROM board_members m WHERE m.board_id = b.id AND m.user_id = f.friend_id))
		           AND (b.owner_id = f.user_id OR EXISTS (SELECT 1 FROM board_members m2 WHERE m2.board_id = b.id AND m2.user_id = f.user_id))
		       ) AS shared
		FROM friends f JOIN users u ON u.id = f.friend_id
		WHERE f.user_id = ?
		ORDER BY u.username COLLATE NOCASE`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Friend
	for rows.Next() {
		var f Friend
		if err := rows.Scan(&f.UserID, &f.Username, &f.SharedCount); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// SharedBoards lists every board both users can access, with each one's role.
func (s *Store) SharedBoards(meID, friendID int64) ([]SharedBoard, error) {
	if ok, err := s.areFriends(meID, friendID); err != nil {
		return nil, err
	} else if !ok {
		return nil, ErrNotFriend
	}
	rows, err := s.DB.Query(`
		SELECT b.id, b.owner_id, b.name, u.username,
		       CASE WHEN b.owner_id = ? THEN 'owner' ELSE COALESCE((SELECT m.role FROM board_members m WHERE m.board_id = b.id AND m.user_id = ?), '') END,
		       CASE WHEN b.owner_id = ? THEN 'owner' ELSE COALESCE((SELECT m2.role FROM board_members m2 WHERE m2.board_id = b.id AND m2.user_id = ?), '') END
		FROM boards b JOIN users u ON u.id = b.owner_id
		WHERE (b.owner_id = ? OR EXISTS (SELECT 1 FROM board_members m3 WHERE m3.board_id = b.id AND m3.user_id = ?))
		  AND (b.owner_id = ? OR EXISTS (SELECT 1 FROM board_members m4 WHERE m4.board_id = b.id AND m4.user_id = ?))
		ORDER BY b.updated_at DESC`,
		meID, meID, friendID, friendID, meID, meID, friendID, friendID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SharedBoard
	for rows.Next() {
		var b SharedBoard
		if err := rows.Scan(&b.ID, &b.OwnerID, &b.Name, &b.OwnerName, &b.MyRole, &b.FriendRole); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (s *Store) areFriends(a, b int64) (bool, error) {
	var one int
	err := s.DB.QueryRow(`SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?`, a, b).Scan(&one)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return false, err
}

func (s *Store) makeFriends(a, b int64) error {
	now := time.Now().Unix()
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM friend_requests WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)`,
		a, b, b, a); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?,?,?)`, a, b, now); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?,?,?)`, b, a, now); err != nil {
		return err
	}
	return tx.Commit()
}
