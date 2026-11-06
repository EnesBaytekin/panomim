// Package nodes implements the todo tree, note fields and file storage.
package nodes

import (
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

type Field struct {
	ID       int64  `json:"id"`
	NodeID   int64  `json:"nodeId"`
	Type     string `json:"type"`
	Value    string `json:"value"`
	Position int    `json:"position"`
}

type Node struct {
	ID        int64    `json:"id"`
	BoardID   int64    `json:"boardId"`
	ParentID  *int64   `json:"parentId"` // nil = root
	Title     string   `json:"title"`
	Position  float64  `json:"position"`
	X         float64  `json:"x"`
	Y         float64  `json:"y"`
	W         float64  `json:"w"` // 0 = auto
	H         float64  `json:"h"` // 0 = auto
	Hue       *int     `json:"hue"`
	Done      bool     `json:"done"`
	Fields    []Field  `json:"fields"`
	CreatedAt int64    `json:"createdAt"`
	UpdatedAt int64    `json:"updatedAt"`
}

var (
	ErrNotFound       = errors.New("nodes: not found")
	ErrCycle          = errors.New("nodes: cannot move a node under its own subtree")
	ErrHasChildren    = errors.New("nodes: has children")
	ErrForbidden      = errors.New("nodes: forbidden")
	ErrTooLarge       = errors.New("nodes: file too large")
	ErrBadType        = errors.New("nodes: bad field type")
)

type Store struct{ DB *sql.DB }

func (s *Store) Node(nodeID int64) (*Node, error) {
	n := &Node{}
	var parent sql.NullInt64
	var hue sql.NullInt64
	var done int64
	err := s.DB.QueryRow(`SELECT id, board_id, parent_id, title, position, x, y, w, h, hue, done, created_at, updated_at
		FROM nodes WHERE id = ?`, nodeID).
		Scan(&n.ID, &n.BoardID, &parent, &n.Title, &n.Position, &n.X, &n.Y, &n.W, &n.H, &hue, &done, &n.CreatedAt, &n.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if parent.Valid {
		v := parent.Int64
		n.ParentID = &v
	}
	if hue.Valid {
		v := int(hue.Int64)
		n.Hue = &v
	}
	n.Done = done != 0
	n.Fields = []Field{}
	return n, nil
}

// ListByBoard returns every node of a board (flat; clients build the tree),
// with each node's fields attached.
func (s *Store) ListByBoard(boardID int64) ([]Node, error) {
	rows, err := s.DB.Query(`SELECT id, board_id, parent_id, title, position, x, y, w, h, hue, done, created_at, updated_at
		FROM nodes WHERE board_id = ? ORDER BY position, id`, boardID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Node{}
	idx := map[int64]int{}
	for rows.Next() {
		n := Node{}
		var parent, hue sql.NullInt64
		var done int64
		if err := rows.Scan(&n.ID, &n.BoardID, &parent, &n.Title, &n.Position, &n.X, &n.Y, &n.W, &n.H, &hue, &done, &n.CreatedAt, &n.UpdatedAt); err != nil {
			return nil, err
		}
		if parent.Valid {
			v := parent.Int64
			n.ParentID = &v
		}
		if hue.Valid {
			v := int(hue.Int64)
			n.Hue = &v
		}
		n.Done = done != 0
		n.Fields = []Field{}
		idx[n.ID] = len(out)
		out = append(out, n)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	frows, err := s.DB.Query(`SELECT f.id, f.node_id, f.type, f.value, f.position
		FROM node_fields f JOIN nodes n ON n.id = f.node_id
		WHERE n.board_id = ? ORDER BY f.node_id, f.position, f.id`, boardID)
	if err != nil {
		return nil, err
	}
	defer frows.Close()
	for frows.Next() {
		var f Field
		if err := frows.Scan(&f.ID, &f.NodeID, &f.Type, &f.Value, &f.Position); err != nil {
			return nil, err
		}
		if i, ok := idx[f.NodeID]; ok {
			out[i].Fields = append(out[i].Fields, f)
		}
	}
	return out, frows.Err()
}

// Create appends a node as the last child of parent (or as the last root).
func (s *Store) Create(boardID int64, parentID *int64, title string, x, y float64) (*Node, error) {
	if parentID != nil {
		p, err := s.Node(*parentID)
		if err != nil {
			return nil, err
		}
		if p.BoardID != boardID {
			return nil, ErrForbidden
		}
	}
	pos, err := s.nextSiblingPosition(boardID, parentID)
	if err != nil {
		return nil, err
	}
	now := time.Now().Unix()
	res, err := s.DB.Exec(`INSERT INTO nodes (board_id, parent_id, title, position, x, y, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?)`, boardID, parentID, title, pos, x, y, now, now)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return s.Node(id)
}

// nextSiblingPosition returns max(position)+10 among siblings (roots when parent nil).
func (s *Store) nextSiblingPosition(boardID int64, parentID *int64) (float64, error) {
	var q string
	var args []any
	if parentID == nil {
		q = `SELECT COALESCE(MAX(position),0) FROM nodes WHERE board_id = ? AND parent_id IS NULL`
		args = []any{boardID}
	} else {
		q = `SELECT COALESCE(MAX(position),0) FROM nodes WHERE parent_id = ?`
		args = []any{*parentID}
	}
	var max float64
	if err := s.DB.QueryRow(q, args...).Scan(&max); err != nil {
		return 0, err
	}
	return max + 10, nil
}

// Update patches provided fields of a node; only non-nil pointers are written.
// When parentID is provided the node is reparented (cycle-safe).
func (s *Store) Update(nodeID int64, patch Patch) (*Node, error) {
	n, err := s.Node(nodeID)
	if err != nil {
		return nil, err
	}
	if patch.ParentID != nil {
		newParent := *patch.ParentID
		if newParent == nodeID {
			return nil, ErrCycle
		}
		if newParent == 0 {
			newParent = 0 // 0 encodes "make root"
		}
		// cycle check: the new parent must not live inside the node's subtree
		var cnt int
		if newParent != 0 {
			if p, err := s.Node(newParent); err != nil {
				return nil, err
			} else if p.BoardID != n.BoardID {
				return nil, ErrForbidden
			}
			if err := s.DB.QueryRow(`
				WITH RECURSIVE sub(id) AS (
					SELECT id FROM nodes WHERE id = ?
					UNION ALL
					SELECT c.id FROM nodes c JOIN sub s ON c.parent_id = s.id
				) SELECT COUNT(*) FROM sub WHERE id = ?`, nodeID, newParent).Scan(&cnt); err != nil {
				return nil, err
			}
			if cnt > 0 {
				return nil, ErrCycle
			}
		}
		var pp *int64
		if newParent != 0 {
			pp = &newParent
		}
		pos, err := s.nextSiblingPosition(n.BoardID, pp)
		if err != nil {
			return nil, err
		}
		if _, err := s.DB.Exec(`UPDATE nodes SET parent_id = ?, position = ?, updated_at = ? WHERE id = ?`,
			pp, pos, time.Now().Unix(), nodeID); err != nil {
			return nil, err
		}
	}
	if patch.Position != nil {
		if _, err := s.DB.Exec(`UPDATE nodes SET position = ?, updated_at = ? WHERE id = ?`,
			*patch.Position, time.Now().Unix(), nodeID); err != nil {
			return nil, err
		}
	}
	if patch.Title != nil {
		if _, err := s.DB.Exec(`UPDATE nodes SET title = ?, updated_at = ? WHERE id = ?`,
			*patch.Title, time.Now().Unix(), nodeID); err != nil {
			return nil, err
		}
	}
	if patch.Done != nil {
		v := 0
		if *patch.Done {
			v = 1
		}
		if _, err := s.DB.Exec(`UPDATE nodes SET done = ?, updated_at = ? WHERE id = ?`,
			v, time.Now().Unix(), nodeID); err != nil {
			return nil, err
		}
	}
	if patch.Hue != nil {
		if _, err := s.DB.Exec(`UPDATE nodes SET hue = ?, updated_at = ? WHERE id = ?`,
			*patch.Hue, time.Now().Unix(), nodeID); err != nil {
			return nil, err
		}
	} else if patch.HueSet {
		if _, err := s.DB.Exec(`UPDATE nodes SET hue = NULL, updated_at = ? WHERE id = ?`,
			time.Now().Unix(), nodeID); err != nil {
			return nil, err
		}
	}
	if patch.X != nil || patch.Y != nil {
		x, y := n.X, n.Y
		if patch.X != nil {
			x = *patch.X
		}
		if patch.Y != nil {
			y = *patch.Y
		}
		if _, err := s.DB.Exec(`UPDATE nodes SET x = ?, y = ?, updated_at = ? WHERE id = ?`,
			x, y, time.Now().Unix(), nodeID); err != nil {
			return nil, err
		}
	}
	if patch.W != nil || patch.H != nil {
		w, h := n.W, n.H
		if patch.W != nil {
			w = *patch.W
		}
		if patch.H != nil {
			h = *patch.H
		}
		if _, err := s.DB.Exec(`UPDATE nodes SET w = ?, h = ?, updated_at = ? WHERE id = ?`,
			w, h, time.Now().Unix(), nodeID); err != nil {
			return nil, err
		}
	}
	return s.Node(nodeID)
}

// Patch carries optional node updates; ParentID=0 means "become root".
type Patch struct {
	ParentID *int64
	Position *float64
	Title    *string
	Done     *bool
	Hue      *int
	HueSet   bool // when true and Hue nil, clears the color
	X, Y     *float64
	W, H     *float64
}

// ChildCount counts direct children.
func (s *Store) ChildCount(nodeID int64) (int, error) {
	var n int
	err := s.DB.QueryRow(`SELECT COUNT(*) FROM nodes WHERE parent_id = ?`, nodeID).Scan(&n)
	return n, err
}

// SubtreeIDs returns the node and all descendant ids.
func (s *Store) SubtreeIDs(nodeID int64) ([]int64, error) {
	rows, err := s.DB.Query(`
		WITH RECURSIVE sub(id) AS (
			SELECT id FROM nodes WHERE id = ?
			UNION ALL
			SELECT c.id FROM nodes c JOIN sub s ON c.parent_id = s.id
		) SELECT id FROM sub`, nodeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// Delete removes a node; cascade FK removes children + fields.
func (s *Store) Delete(nodeID int64) error {
	res, err := s.DB.Exec(`DELETE FROM nodes WHERE id = ?`, nodeID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// TouchBoard bumps the board's updated_at.
func (s *Store) TouchBoard(boardID int64) {
	s.DB.Exec(`UPDATE boards SET updated_at = ? WHERE id = ?`, time.Now().Unix(), boardID)
}

// --- fields -------------------------------------------------------------------

var fieldTypes = map[string]bool{"text": true, "date": true, "time": true, "datetime": true, "link": true, "image": true}

func (s *Store) NodeBelongsToBoard(nodeID, boardID int64) (bool, error) {
	var b int64
	err := s.DB.QueryRow(`SELECT board_id FROM nodes WHERE id = ?`, nodeID).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) {
		return false, ErrNotFound
	}
	return b == boardID, err
}

func (s *Store) CreateField(nodeID int64, ftype, value string) (*Field, error) {
	if !fieldTypes[ftype] {
		return nil, ErrBadType
	}
	var max sql.NullInt64
	if err := s.DB.QueryRow(`SELECT MAX(position) FROM node_fields WHERE node_id = ?`, nodeID).Scan(&max); err != nil {
		return nil, err
	}
	res, err := s.DB.Exec(`INSERT INTO node_fields (node_id, type, value, position, created_at) VALUES (?,?,?,?,?)`,
		nodeID, ftype, value, max.Int64+1, time.Now().Unix())
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return &Field{ID: id, NodeID: nodeID, Type: ftype, Value: value, Position: int(max.Int64) + 1}, nil
}

func (s *Store) Field(id int64) (*Field, error) {
	f := &Field{}
	err := s.DB.QueryRow(`SELECT id, node_id, type, value, position FROM node_fields WHERE id = ?`, id).
		Scan(&f.ID, &f.NodeID, &f.Type, &f.Value, &f.Position)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return f, err
}

func (s *Store) UpdateField(id int64, value string) (*Field, error) {
	res, err := s.DB.Exec(`UPDATE node_fields SET value = ? WHERE id = ?`, value, id)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, ErrNotFound
	}
	return s.Field(id)
}

func (s *Store) DeleteField(id int64) error {
	res, err := s.DB.Exec(`DELETE FROM node_fields WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// --- files ---------------------------------------------------------------------

func (s *Store) SaveFile(boardID, uploaderID int64, name, mime string, data []byte) (string, error) {
	id := newUUID()
	_, err := s.DB.Exec(`INSERT INTO files (id, board_id, uploader_id, name, mime, size, data, created_at)
		VALUES (?,?,?,?,?,?,?,?)`, id, boardID, uploaderID, name, mime, len(data), data, time.Now().Unix())
	if err != nil {
		return "", fmt.Errorf("save file: %w", err)
	}
	return id, nil
}

// FileMeta resolves a file's board (for membership checks) and mime.
type FileMeta struct {
	ID     string
	Board  int64
	Mime   string
	Name   string
	Size   int
}

func (s *Store) FileMeta(id string) (*FileMeta, error) {
	f := &FileMeta{ID: id}
	err := s.DB.QueryRow(`SELECT board_id, mime, name, size FROM files WHERE id = ?`, id).
		Scan(&f.Board, &f.Mime, &f.Name, &f.Size)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return f, err
}

func (s *Store) FileData(id string) ([]byte, error) {
	var data []byte
	err := s.DB.QueryRow(`SELECT data FROM files WHERE id = ?`, id).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return data, err
}

// newUUID returns a random UUIDv4 string.
func newUUID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand must never fail on a healthy system
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
