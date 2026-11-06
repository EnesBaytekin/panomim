package nodes

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"todoer/internal/auth"
	"todoer/internal/boards"
	"todoer/internal/httpx"
)

type ctxNodeID struct{}

// NodeIDFrom returns the node id resolved by NodeAccess/FieldAccess.
func NodeIDFrom(ctx context.Context) int64 {
	id, _ := ctx.Value(ctxNodeID{}).(int64)
	return id
}

func withNode(ctx context.Context, id int64) context.Context {
	return context.WithValue(ctx, ctxNodeID{}, id)
}

var errBadPath = errors.New("bad path param")

// NodeAccess resolves {nodeID} → its board, then enforces minRole.
func (h *Handlers) NodeAccess(minRole boards.Role) func(http.Handler) http.Handler {
	return h.boardGate(func(r *http.Request) (int64, int64, error) {
		nodeID, err := strconv.ParseInt(r.PathValue("nodeID"), 10, 64)
		if err != nil {
			return 0, 0, errBadPath
		}
		n, err := h.Store.Node(nodeID)
		if err != nil {
			return 0, 0, err
		}
		return n.ID, n.BoardID, nil
	}, minRole)
}

// FieldAccess resolves {fieldID} → its node's board, then enforces minRole.
func (h *Handlers) FieldAccess(minRole boards.Role) func(http.Handler) http.Handler {
	return h.boardGate(func(r *http.Request) (int64, int64, error) {
		fieldID, err := strconv.ParseInt(r.PathValue("fieldID"), 10, 64)
		if err != nil {
			return 0, 0, errBadPath
		}
		f, err := h.Store.Field(fieldID)
		if err != nil {
			return 0, 0, err
		}
		n, err := h.Store.Node(f.NodeID)
		if err != nil {
			return 0, 0, err
		}
		return n.ID, n.BoardID, nil
	}, minRole)
}

// FileAccess resolves {fileID} → its board, then enforces minRole.
func (h *Handlers) FileAccess(minRole boards.Role) func(http.Handler) http.Handler {
	return h.boardGate(func(r *http.Request) (int64, int64, error) {
		f, err := h.Store.FileMeta(r.PathValue("fileID"))
		if err != nil {
			return 0, 0, err
		}
		return 0, f.Board, nil
	}, minRole)
}

// boardGate runs resolve → role check → context injection → next.
func (h *Handlers) boardGate(resolve func(*http.Request) (entityID, boardID int64, err error), minRole boards.Role) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			u := auth.UserFrom(r.Context())
			if u == nil {
				httpx.Err(w, 401, "unauthorized")
				return
			}
			entityID, boardID, err := resolve(r)
			if errors.Is(err, ErrNotFound) {
				httpx.Err(w, 404, "not found")
				return
			}
			if errors.Is(err, errBadPath) {
				httpx.Err(w, 400, "invalid id")
				return
			}
			if err != nil {
				httpx.Err(w, 500, "resolve failed")
				return
			}
			role, err := h.Boards.RoleOf(boardID, u.ID)
			if errors.Is(err, boards.ErrForbidden) || (err == nil && role != boards.RoleOwner && !roleAtLeast(role, minRole)) {
				httpx.Err(w, 403, "no access")
				return
			}
			if err != nil {
				httpx.Err(w, 500, "role lookup failed")
				return
			}
			ctx := boards.WithRole(boards.WithBoardID(r.Context(), boardID), role)
			if entityID != 0 {
				ctx = withNode(ctx, entityID)
			}
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func roleAtLeast(role, min boards.Role) bool {
	rank := map[boards.Role]int{boards.RoleViewer: 1, boards.RoleEditor: 2, boards.RoleOwner: 3}
	return rank[role] >= rank[min]
}
