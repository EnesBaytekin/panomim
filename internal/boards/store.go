// Package boards implements todo boards and their sharing model.
package boards

import (
	"database/sql"
	"errors"
	"sort"
	"time"
)

type Role string

const (
	RoleOwner  Role = "owner"
	RoleEditor Role = "editor"
	RoleViewer Role = "viewer"
)

type Board struct {
	ID          int64  `json:"id"`
	OwnerID     int64  `json:"ownerId"`
	OwnerName   string `json:"ownerName,omitempty"`
	Name        string `json:"name"`
	Role        Role   `json:"role"` // caller's effective role
	SharedCount int    `json:"sharedCount"`
	CreatedAt   int64  `json:"createdAt"`
	UpdatedAt   int64  `json:"updatedAt"`
}

type Member struct {
	UserID   int64  `json:"userId"`
	Username string `json:"username"`
	Role     Role   `json:"role"`
	Online   bool   `json:"online"`
}

var (
	ErrNotFound  = errors.New("boards: not found")
	ErrForbidden = errors.New("boards: forbidden")
	ErrExists    = errors.New("boards: already shared with user")
)

type Store struct{ DB *sql.DB }

// PresenceChecker lets the board layer ask the realtime hub who is online
// without importing it (wired in server assembly).
type PresenceChecker interface {
	OnlineUsers(boardID int64) []int64
}

func (s *Store) Create(ownerID int64, name string) (*Board, error) {
	now := time.Now().Unix()
	res, err := s.DB.Exec(`INSERT INTO boards (owner_id, name, created_at, updated_at) VALUES (?,?,?,?)`,
		ownerID, name, now, now)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return &Board{ID: id, OwnerID: ownerID, Name: name, Role: RoleOwner, CreatedAt: now, UpdatedAt: now}, nil
}

// List returns the boards a user owns or is a member of, newest activity first.
func (s *Store) List(userID int64) ([]Board, error) {
	rows, err := s.DB.Query(`
		SELECT b.id, b.owner_id, b.name, b.created_at, b.updated_at,
		       u.username,
		       CASE WHEN b.owner_id = ? THEN 'owner'
		            ELSE COALESCE((SELECT role FROM board_members m WHERE m.board_id = b.id AND m.user_id = ?), '')
		       END AS role,
		       (SELECT COUNT(*) FROM board_members m2 WHERE m2.board_id = b.id) AS shared
		FROM boards b
		JOIN users u ON u.id = b.owner_id
		WHERE b.owner_id = ? OR EXISTS (SELECT 1 FROM board_members m3 WHERE m3.board_id = b.id AND m3.user_id = ?)
		ORDER BY b.updated_at DESC`, userID, userID, userID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Board
	for rows.Next() {
		var b Board
		var role string
		if err := rows.Scan(&b.ID, &b.OwnerID, &b.Name, &b.CreatedAt, &b.UpdatedAt, &b.OwnerName, &role, &b.SharedCount); err != nil {
			return nil, err
		}
		b.Role = Role(role)
		out = append(out, b)
	}
	return out, rows.Err()
}

// Get fetches one board including members. roleOf gives the caller's role;
// when roleOf is empty the caller has no access and ErrForbidden is returned.
func (s *Store) Get(boardID, userID int64, presence PresenceChecker) (*Board, []Member, error) {
	b := &Board{}
	var role string
	err := s.DB.QueryRow(`
		SELECT b.id, b.owner_id, b.name, b.created_at, b.updated_at, u.username,
		       CASE WHEN b.owner_id = ? THEN 'owner'
		            ELSE COALESCE((SELECT m.role FROM board_members m WHERE m.board_id = b.id AND m.user_id = ?), '')
		       END
		FROM boards b JOIN users u ON u.id = b.owner_id WHERE b.id = ?`,
		userID, userID, boardID).Scan(&b.ID, &b.OwnerID, &b.Name, &b.CreatedAt, &b.UpdatedAt, &b.OwnerName, &role)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, ErrNotFound
	}
	if err != nil {
		return nil, nil, err
	}
	if role == "" {
		return nil, nil, ErrForbidden
	}
	b.Role = Role(role)

	members, err := s.Members(boardID)
	if err != nil {
		return nil, nil, err
	}
	if presence != nil {
		online := map[int64]bool{}
		for _, id := range presence.OnlineUsers(boardID) {
			online[id] = true
		}
		for i := range members {
			members[i].Online = online[members[i].UserID]
		}
	}
	return b, members, nil
}

func (s *Store) Members(boardID int64) ([]Member, error) {
	rows, err := s.DB.Query(`
		SELECT u.id, u.username, 'owner' FROM boards b
		JOIN users u ON u.id = b.owner_id WHERE b.id = ?
		UNION ALL
		SELECT u.id, u.username, m.role FROM board_members m
		JOIN users u ON u.id = m.user_id WHERE m.board_id = ?`, boardID, boardID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Member
	for rows.Next() {
		var m Member
		if err := rows.Scan(&m.UserID, &m.Username, &m.Role); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// owner first, then members alphabetically
	sort.Slice(out, func(i, j int) bool {
		oi, oj := out[i].Role == RoleOwner, out[j].Role == RoleOwner
		if oi != oj {
			return oi
		}
		return out[i].Username < out[j].Username
	})
	return out, nil
}

// RoleOf returns the caller's effective role on a board ("" = no access).
func (s *Store) RoleOf(boardID, userID int64) (Role, error) {
	var ownerID int64
	err := s.DB.QueryRow(`SELECT owner_id FROM boards WHERE id = ?`, boardID).Scan(&ownerID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if ownerID == userID {
		return RoleOwner, nil
	}
	var role string
	err = s.DB.QueryRow(`SELECT role FROM board_members WHERE board_id = ? AND user_id = ?`, boardID, userID).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrForbidden
	}
	return Role(role), err
}

func (s *Store) Rename(boardID int64, name string) (int64, error) {
	now := time.Now().Unix()
	res, err := s.DB.Exec(`UPDATE boards SET name = ?, updated_at = ? WHERE id = ?`, name, now, boardID)
	if err != nil {
		return 0, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return 0, ErrNotFound
	}
	return now, nil
}

func (s *Store) Delete(boardID int64) error {
	_, err := s.DB.Exec(`DELETE FROM boards WHERE id = ?`, boardID)
	return err
}

func (s *Store) Touch(boardID int64) error {
	_, err := s.DB.Exec(`UPDATE boards SET updated_at = ? WHERE id = ?`, time.Now().Unix(), boardID)
	return err
}

// Name returns a board's name, or ErrNotFound if it doesn't exist.
func (s *Store) Name(boardID int64) (string, error) {
	var name string
	err := s.DB.QueryRow(`SELECT name FROM boards WHERE id = ?`, boardID).Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return name, err
}

// --- sharing -----------------------------------------------------------------

// userIDByName resolves a username (empty when missing).
func (s *Store) userIDByName(username string) (int64, error) {
	var id int64
	err := s.DB.QueryRow(`SELECT id FROM users WHERE username = ?`, username).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	return id, err
}

// ShareTarget validates a share request and returns the target user id and the
// board's name. It does NOT add the member — sharing now requires the recipient's
// approval, so the actual membership insert happens on acceptance (see the
// notifications package). ErrExists means the target is the owner or is already a
// member (or already has a pending request, checked by the handler).
func (s *Store) ShareTarget(boardID int64, username string, role Role) (targetID int64, boardName string, err error) {
	if role != RoleEditor && role != RoleViewer {
		return 0, "", errors.New("boards: role must be editor or viewer")
	}
	uid, err := s.userIDByName(username)
	if err != nil {
		return 0, "", err
	}
	var ownerID int64
	if err := s.DB.QueryRow(`SELECT owner_id, name FROM boards WHERE id = ?`, boardID).Scan(&ownerID, &boardName); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, "", ErrNotFound
		}
		return 0, "", err
	}
	if uid == ownerID {
		return 0, "", ErrExists // owner already has the board
	}
	var one int
	err = s.DB.QueryRow(`SELECT 1 FROM board_members WHERE board_id = ? AND user_id = ?`, boardID, uid).Scan(&one)
	if err == nil {
		return 0, "", ErrExists // already a member
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, "", err
	}
	return uid, boardName, nil
}

func (s *Store) Unshare(boardID, userID int64) error {
	res, err := s.DB.Exec(`DELETE FROM board_members WHERE board_id = ? AND user_id = ?`, boardID, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// SetMemberRole changes an existing member's role (owner-only). ErrNotFound when
// the user is not a member of the board.
func (s *Store) SetMemberRole(boardID, userID int64, role Role) error {
	if role != RoleEditor && role != RoleViewer {
		return errors.New("boards: role must be editor or viewer")
	}
	res, err := s.DB.Exec(`UPDATE board_members SET role = ? WHERE board_id = ? AND user_id = ?`,
		string(role), boardID, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
