package nodes

import (
	"io"
	"net/http"
	"path"
	"strconv"
	"strings"

	"panomim/internal/auth"
	"panomim/internal/boards"
	"panomim/internal/httpx"
)

// Emit broadcasts a realtime event to a board's websocket room. Wired by the
// server package so this package stays decoupled from the hub.
type Emit func(boardID int64, event map[string]any)

type Handlers struct {
	Store  *Store
	Boards *boards.Store // for file membership checks
	Emit   Emit          // may be nil in tests
}

const maxFileSize = 8 << 20 // 8 MiB

func (h *Handlers) emit(boardID int64, event map[string]any) {
	if h.Emit == nil {
		return
	}
	h.Store.TouchBoard(boardID)
	h.Emit(boardID, event)
}

// --- node handlers (all under BoardAccess) -------------------------------------

func (h *Handlers) List(w http.ResponseWriter, r *http.Request) {
	nodes, err := h.Store.ListByBoard(boards.IDFrom(r.Context()))
	if err != nil {
		httpx.Err(w, 500, "list failed")
		return
	}
	httpx.JSON(w, 200, nodes)
}

type createReq struct {
	ParentID *int64  `json:"parentId"`
	Title    string  `json:"title"`
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
}

func (h *Handlers) Create(w http.ResponseWriter, r *http.Request) {
	var req createReq
	if err := httpx.Body(r, &req); err != nil {
		httpx.Err(w, 400, "invalid body")
		return
	}
	boardID := boards.IDFrom(r.Context())
	if len(req.Title) > 500 {
		httpx.Err(w, 400, "title too long")
		return
	}
	n, err := h.Store.Create(boardID, req.ParentID, req.Title, req.X, req.Y)
	if err != nil {
		httpx.Err(w, 500, "create failed")
		return
	}
	h.emit(boardID, map[string]any{"type": "node_created", "node": n, "actor": httpx.ClientID(r)})
	httpx.JSON(w, 201, n)
}

type patchReq struct {
	ParentID *int64   `json:"parentId"` // 0 = make root
	Position *float64 `json:"position"`
	Title    *string  `json:"title"`
	Done     *bool    `json:"done"`
	Hue      *int     `json:"hue"`
	ClearHue bool     `json:"clearHue"`
	X        *float64 `json:"x"`
	Y        *float64 `json:"y"`
	W        *float64 `json:"w"`
	H        *float64 `json:"h"`
}

func (h *Handlers) Patch(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("nodeID"), 10, 64)
	if err != nil {
		httpx.Err(w, 400, "invalid node id")
		return
	}
	var req patchReq
	if err := httpx.Body(r, &req); err != nil {
		httpx.Err(w, 400, "invalid body")
		return
	}
	boardID := boards.IDFrom(r.Context())
	if ok, err := h.Store.NodeBelongsToBoard(id, boardID); err == ErrNotFound {
		httpx.Err(w, 404, "node not found")
		return
	} else if !ok || err != nil {
		httpx.Err(w, 403, "node not in this board")
		return
	}
	if req.Title != nil && len(*req.Title) > 500 {
		httpx.Err(w, 400, "title too long")
		return
	}
	patch := Patch{
		ParentID: req.ParentID, Position: req.Position, Title: req.Title, Done: req.Done,
		Hue: req.Hue, HueSet: req.ClearHue, X: req.X, Y: req.Y, W: req.W, H: req.H,
	}
	n, err := h.Store.Update(id, patch)
	if err == ErrCycle {
		httpx.Err(w, 400, "cannot move a node under its own subtree")
		return
	}
	if err == ErrForbidden {
		httpx.Err(w, 403, "parent not in this board")
		return
	}
	if err != nil {
		httpx.Err(w, 500, "update failed")
		return
	}
	h.emit(boardID, map[string]any{
		"type": "node_updated", "id": n.ID, "node": n, "actor": httpx.ClientID(r),
	})
	httpx.JSON(w, 200, n)
}

// SetDone toggles the done flag; viewers may do this (check-off only).
func (h *Handlers) SetDone(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Done bool `json:"done"`
	}
	if err := httpx.Body(r, &req); err != nil {
		httpx.Err(w, 400, "invalid body")
		return
	}
	nodeID := NodeIDFrom(r.Context())
	boardID := boards.IDFrom(r.Context())
	n, err := h.Store.Update(nodeID, Patch{Done: &req.Done})
	if err != nil {
		httpx.Err(w, 500, "update failed")
		return
	}
	h.emit(boardID, map[string]any{
		"type": "node_updated", "id": n.ID, "node": n, "actor": httpx.ClientID(r),
	})
	httpx.JSON(w, 200, n)
}

func (h *Handlers) Delete(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("nodeID"), 10, 64)
	if err != nil {
		httpx.Err(w, 400, "invalid node id")
		return
	}
	boardID := boards.IDFrom(r.Context())
	if ok, err := h.Store.NodeBelongsToBoard(id, boardID); err == ErrNotFound {
		httpx.Err(w, 404, "node not found")
		return
	} else if !ok || err != nil {
		httpx.Err(w, 403, "node not in this board")
		return
	}

	kids, err := h.Store.ChildCount(id)
	if err != nil {
		httpx.Err(w, 500, "lookup failed")
		return
	}
	withChildren := r.URL.Query().Get("withChildren") == "1"
	if kids > 0 && !withChildren {
		httpx.JSON(w, 409, map[string]any{"error": "node has children", "childCount": kids})
		return
	}
	ids, err := h.Store.SubtreeIDs(id)
	if err != nil {
		httpx.Err(w, 500, "lookup failed")
		return
	}
	if err := h.Store.Delete(id); err != nil {
		httpx.Err(w, 500, "delete failed")
		return
	}
	h.emit(boardID, map[string]any{"type": "nodes_deleted", "ids": ids, "actor": httpx.ClientID(r)})
	httpx.JSON(w, 200, map[string]any{"ok": true, "deleted": ids})
}

// --- field handlers --------------------------------------------------------------

type fieldReq struct {
	Type  string `json:"type"`
	Value string `json:"value"`
}

func (h *Handlers) CreateField(w http.ResponseWriter, r *http.Request) {
	nodeID, err := strconv.ParseInt(r.PathValue("nodeID"), 10, 64)
	if err != nil {
		httpx.Err(w, 400, "invalid node id")
		return
	}
	var req fieldReq
	if err := httpx.Body(r, &req); err != nil {
		httpx.Err(w, 400, "invalid body")
		return
	}
	boardID := boards.IDFrom(r.Context())
	if ok, err := h.Store.NodeBelongsToBoard(nodeID, boardID); err == ErrNotFound {
		httpx.Err(w, 404, "node not found")
		return
	} else if !ok || err != nil {
		httpx.Err(w, 403, "node not in this board")
		return
	}
	if len(req.Value) > 4000 {
		httpx.Err(w, 400, "value too long")
		return
	}
	f, err := h.Store.CreateField(nodeID, req.Type, req.Value)
	if err == ErrBadType {
		httpx.Err(w, 400, "unsupported field type")
		return
	}
	if err != nil {
		httpx.Err(w, 500, "create failed")
		return
	}
	h.emit(boardID, map[string]any{"type": "field_created", "field": f, "actor": httpx.ClientID(r)})
	httpx.JSON(w, 201, f)
}

// fieldGuard checks the field's node belongs to the active board.
func (h *Handlers) fieldGuard(w http.ResponseWriter, r *http.Request) (*Field, bool) {
	id, err := strconv.ParseInt(r.PathValue("fieldID"), 10, 64)
	if err != nil {
		httpx.Err(w, 400, "invalid field id")
		return nil, false
	}
	f, err := h.Store.Field(id)
	if err == ErrNotFound {
		httpx.Err(w, 404, "field not found")
		return nil, false
	}
	if err != nil {
		httpx.Err(w, 500, "lookup failed")
		return nil, false
	}
	if ok, _ := h.Store.NodeBelongsToBoard(f.NodeID, boards.IDFrom(r.Context())); !ok {
		httpx.Err(w, 403, "field not in this board")
		return nil, false
	}
	return f, true
}

func (h *Handlers) PatchField(w http.ResponseWriter, r *http.Request) {
	f, ok := h.fieldGuard(w, r)
	if !ok {
		return
	}
	var req fieldReq
	if err := httpx.Body(r, &req); err != nil {
		httpx.Err(w, 400, "invalid body")
		return
	}
	if len(req.Value) > 4000 {
		httpx.Err(w, 400, "value too long")
		return
	}
	nf, err := h.Store.UpdateField(f.ID, req.Value)
	if err != nil {
		httpx.Err(w, 500, "update failed")
		return
	}
	h.emit(boards.IDFrom(r.Context()), map[string]any{"type": "field_updated", "field": nf, "actor": httpx.ClientID(r)})
	httpx.JSON(w, 200, nf)
}

func (h *Handlers) DeleteField(w http.ResponseWriter, r *http.Request) {
	f, ok := h.fieldGuard(w, r)
	if !ok {
		return
	}
	if err := h.Store.DeleteField(f.ID); err != nil {
		httpx.Err(w, 500, "delete failed")
		return
	}
	h.emit(boards.IDFrom(r.Context()), map[string]any{
		"type": "field_deleted", "id": f.ID, "nodeId": f.NodeID, "actor": httpx.ClientID(r),
	})
	httpx.JSON(w, 200, map[string]bool{"ok": true})
}

// --- files ------------------------------------------------------------------------

var allowedImageMimes = map[string]bool{
	"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true, "image/svg+xml": true,
}

func (h *Handlers) Upload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxFileSize+1024)
	if err := r.ParseMultipartForm(maxFileSize); err != nil {
		httpx.Err(w, 400, "upload too large (max 8 MiB)")
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		httpx.Err(w, 400, "missing file")
		return
	}
	defer file.Close()
	mime := hdr.Header.Get("Content-Type")
	if !allowedImageMimes[mime] {
		httpx.Err(w, 400, "only png/jpeg/gif/webp/svg images allowed")
		return
	}
	boardID := boards.IDFrom(r.Context())
	data, err := io.ReadAll(file)
	if err != nil {
		httpx.Err(w, 400, "read failed")
		return
	}
	u := auth.UserFrom(r.Context())
	id, err := h.Store.SaveFile(boardID, u.ID, path.Base(hdr.Filename), mime, data)
	if err != nil {
		httpx.Err(w, 500, "save failed")
		return
	}
	httpx.JSON(w, 201, map[string]string{"id": id, "url": "/api/files/" + id})
}

func (h *Handlers) ServeFile(w http.ResponseWriter, r *http.Request) {
	f, err := h.Store.FileMeta(r.PathValue("fileID"))
	if err != nil {
		httpx.Err(w, 404, "not found")
		return
	}
	data, err := h.Store.FileData(f.ID)
	if err != nil {
		httpx.Err(w, 404, "not found")
		return
	}
	w.Header().Set("Content-Type", f.Mime)
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; img-src 'self' data:")
	if strings.Contains(f.Mime, "svg") {
		// serve SVG attachments safely
		w.Header().Set("Content-Disposition", "inline; filename=\""+sanitizeName(f.Name)+"\"; x-content-type-options=nosniff")
	}
	w.WriteHeader(200)
	w.Write(data)
}

func sanitizeName(n string) string {
	return strings.Map(func(r rune) rune {
		if r == '"' || r < 32 {
			return -1
		}
		return r
	}, n)
}
