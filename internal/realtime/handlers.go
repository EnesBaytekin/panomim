package realtime

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/coder/websocket"

	"todoer/internal/auth"
	"todoer/internal/boards"
	"todoer/internal/httpx"
)

func randomToken() string {
	b := make([]byte, 24)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func writeCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 5*time.Second)
}

func mustMarshal(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

type Handlers struct {
	Hub     *Hub
	Boards  *boards.Store
}

// Ticket issues a short-lived single-use websocket ticket.
func (h *Handlers) Ticket(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	httpx.JSON(w, 200, map[string]string{"ticket": h.Hub.IssueTicket(u.ID, u.Username)})
}

// ServeWS upgrades and runs the board room loop for one client.
func (h *Handlers) ServeWS(w http.ResponseWriter, r *http.Request) {
	ticketTok := r.URL.Query().Get("ticket")
	boardID, err := strconv.ParseInt(r.URL.Query().Get("board_id"), 10, 64)
	if err != nil {
		httpx.Err(w, 400, "invalid board id")
		return
	}
	userID, username, ok := h.Hub.ConsumeTicket(ticketTok)
	if !ok {
		httpx.Err(w, 401, "invalid or expired ticket")
		return
	}
	// must be a board member (viewer or editor)
	role, err := h.Boards.RoleOf(boardID, userID)
	if err != nil {
		httpx.Err(w, 403, "no access to this board")
		return
	}

	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	client := &Client{
		UserID:   userID,
		Username: username,
		BoardID:  boardID,
		Color:    colorForUser(userID),
		conn:     conn,
		hub:      h.Hub,
	}
	prior := h.Hub.Join(client)

	// 1) tell the newcomer who is already here + their role
	client.WriteJSON(map[string]any{
		"type":   "hello",
		"users":  append(prior, Presence{UserID: userID, Username: username, Color: client.Color}),
		"role":   string(role),
		"you":    Presence{UserID: userID, Username: username, Color: client.Color},
	})
	// 2) tell everyone else that we joined (skip self echo)
	h.Hub.BroadcastExcept(boardID, map[string]any{
		"type":    "presence_join",
		"user":    Presence{UserID: userID, Username: username, Color: client.Color},
	}, client)
	// do not send presence_join to self twice; simpler: clients ignore own userId events.

	defer func() {
		h.Hub.Leave(client)
		h.Hub.Broadcast(boardID, map[string]any{
			"type":    "presence_leave",
			"userId":  userID,
			"user":    Presence{UserID: userID, Username: username, Color: client.Color},
		})
		conn.Close(websocket.StatusNormalClosure, "")
	}()

	// read loop: client->server messages (selection highlights, pings)
	for {
		msgType, data, err := conn.Read(context.Background())
		if err != nil {
			return
		}
		if msgType != websocket.MessageText {
			continue
		}
		var msg map[string]any
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}
		switch msg["type"] {
		case "ping":
			client.WriteJSON(map[string]any{"type": "pong"})
		case "select":
			// share which node this user selected (Google-Docs style highlight)
			h.Hub.Broadcast(boardID, map[string]any{
				"type":     "select",
				"userId":   userID,
				"username": username,
				"color":    client.Color,
				"nodeId":   msg["nodeId"],
			})
		case "cursor":
			h.Hub.Broadcast(boardID, map[string]any{
				"type":   "cursor",
				"userId": userID,
				"color":  client.Color,
				"x":      msg["x"],
				"y":      msg["y"],
			})
		}
	}
}

// colorForUser derives a stable pleasant accent color from a user id.
func colorForUser(id int64) string {
	palette := []string{
		"#e07a5f", "#3d8bfd", "#2a9d8f", "#e76f51", "#9b5de5",
		"#f4a261", "#43aa8b", "#f94144", "#577590", "#b5179e",
	}
	return palette[id%int64(len(palette))]
}
