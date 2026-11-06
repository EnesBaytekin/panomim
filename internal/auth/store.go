package auth

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"strings"
	"time"
)

// User is the public shape of an account.
type User struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
}

type Store struct{ DB *sql.DB }

var (
	ErrUserExists   = errors.New("auth: username taken")
	ErrBadCredentials = errors.New("auth: bad credentials")
)

func (s *Store) CreateUser(username, passwordHash string) (*User, error) {
	res, err := s.DB.Exec(`INSERT INTO users (username, password_hash, created_at) VALUES (?,?,?)`,
		username, passwordHash, time.Now().Unix())
	if err != nil {
		if isUniqueErr(err) {
			return nil, ErrUserExists
		}
		return nil, err
	}
	id, _ := res.LastInsertId()
	return &User{ID: id, Username: username}, nil
}

func (s *Store) UserByName(username string) (int64, string, error) {
	var id int64
	var hash string
	err := s.DB.QueryRow(`SELECT id, password_hash FROM users WHERE username = ?`, username).Scan(&id, &hash)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, "", ErrBadCredentials
	}
	return id, hash, err
}

func (s *Store) UserByID(id int64) (*User, error) {
	u := &User{}
	err := s.DB.QueryRow(`SELECT id, username FROM users WHERE id = ?`, id).Scan(&u.ID, &u.Username)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrBadCredentials
	}
	return u, err
}

func (s *Store) SetLastBoard(userID, boardID int64) error {
	_, err := s.DB.Exec(`UPDATE users SET last_board_id = ? WHERE id = ?`, boardID, userID)
	return err
}

func (s *Store) LastBoard(userID int64) (int64, error) {
	var id sql.NullInt64
	err := s.DB.QueryRow(`SELECT last_board_id FROM users WHERE id = ?`, userID).Scan(&id)
	if err != nil || !id.Valid {
		return 0, err
	}
	return id.Int64, nil
}

// --- refresh token sessions -------------------------------------------------

type RefreshSession struct {
	ID       int64
	UserID   int64
	FamilyID string
	DeviceID string
	Expires  time.Time
}

// StoreRefresh persists a new refresh token hash. familyID ties a login
// session's rotated tokens together (for reuse detection).
func (s *Store) StoreRefresh(userID int64, tokenHash, familyID, deviceID, userAgent string, expires time.Time) error {
	_, err := s.DB.Exec(`INSERT INTO refresh_tokens
		(user_id, token_hash, family_id, device_id, user_agent, expires_at, created_at)
		VALUES (?,?,?,?,?,?,?)`,
		userID, tokenHash, familyID, deviceID, userAgent, expires.Unix(), time.Now().Unix())
	return err
}

// LookupRefresh finds an unexpired, unrevoked session by token hash.
func (s *Store) LookupRefresh(tokenHash string) (*RefreshSession, error) {
	rs := &RefreshSession{}
	var exp int64
	var revoked sql.NullInt64
	err := s.DB.QueryRow(`SELECT id, user_id, family_id, device_id, expires_at, revoked_at
		FROM refresh_tokens WHERE token_hash = ?`, tokenHash).
		Scan(&rs.ID, &rs.UserID, &rs.FamilyID, &rs.DeviceID, &exp, &revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if revoked.Valid {
		// reuse of an already rotated token -> kill the whole family
		s.RevokeFamily(rs.FamilyID)
		return nil, nil
	}
	if time.Now().Unix() >= exp {
		return nil, nil
	}
	rs.Expires = time.Unix(exp, 0)
	return rs, nil
}

// RotateRefresh revokes the old token; the replacement is stored by the caller
// within the same family.
func (s *Store) RotateRefresh(oldID int64) error {
	_, err := s.DB.Exec(`UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?`, time.Now().Unix(), oldID)
	return err
}

func (s *Store) RevokeFamily(familyID string) error {
	_, err := s.DB.Exec(`UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL`,
		time.Now().Unix(), familyID)
	return err
}

func (s *Store) RevokeByTokenHash(tokenHash string) error {
	_, err := s.DB.Exec(`UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ?`, time.Now().Unix(), tokenHash)
	return err
}

func (s *Store) RevokeAllForUser(userID int64) error {
	_, err := s.DB.Exec(`UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
		time.Now().Unix(), userID)
	return err
}

// NewFamilyID creates an identifier for a login session chain.
func NewFamilyID() string {
	b := make([]byte, 12)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func isUniqueErr(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}
