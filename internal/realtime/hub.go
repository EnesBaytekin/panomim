// Package realtime implements the websocket hub: per-board rooms, presence
// and fan-out of change events produced by REST mutations.
package realtime

import (
	"log"
	"maps"
	"slices"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Client is one connected browser tab.
type Client struct {
	UserID   int64
	Username string
	BoardID  int64
	Color    string // stable color derived from user id
	conn     *websocket.Conn
	hub      *Hub
	closed   bool
	writeMu  sync.Mutex
}

// Hub owns all rooms.
type Hub struct {
	mu      sync.Mutex
	rooms   map[int64]map[*Client]bool
	tickets map[string]ticket
}

type ticket struct {
	userID   int64
	username string
	expires  time.Time
}

func NewHub() *Hub {
	h := &Hub{rooms: map[int64]map[*Client]bool{}, tickets: map[string]ticket{}}
	go h.sweepTickets()
	return h
}

// sweepTickets garbage-collects expired one-time ws tickets every 30s.
func (h *Hub) sweepTickets() {
	for range time.Tick(30 * time.Second) {
		h.mu.Lock()
		now := time.Now()
		for k, t := range h.tickets {
			if now.After(t.expires) {
				delete(h.tickets, k)
			}
		}
		h.mu.Unlock()
	}
}

// IssueTicket mints a 30-second single-use websocket ticket for a user.
func (h *Hub) IssueTicket(userID int64, username string) string {
	tok := randomToken()
	h.mu.Lock()
	h.tickets[tok] = ticket{userID: userID, username: username, expires: time.Now().Add(30 * time.Second)}
	h.mu.Unlock()
	return tok
}

// ConsumeTicket redeems a ticket (single use) and returns its user.
func (h *Hub) ConsumeTicket(tok string) (int64, string, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	t, ok := h.tickets[tok]
	if !ok || time.Now().After(t.expires) {
		return 0, "", false
	}
	delete(h.tickets, tok)
	return t.userID, t.username, true
}

// Join registers a client into its board room and returns prior members.
func (h *Hub) Join(c *Client) []Presence {
	h.mu.Lock()
	room := h.rooms[c.BoardID]
	if room == nil {
		room = map[*Client]bool{}
		h.rooms[c.BoardID] = room
	}
	prior := make([]Presence, 0, len(room))
	for other := range room {
		prior = append(prior, Presence{UserID: other.UserID, Username: other.Username, Color: other.Color})
	}
	room[c] = true
	h.mu.Unlock()
	return prior
}

// Leave removes a client from its room; reports whether it was present.
func (h *Hub) Leave(c *Client) {
	h.mu.Lock()
	room := h.rooms[c.BoardID]
	if room != nil {
		delete(room, c)
		if len(room) == 0 {
			delete(h.rooms, c.BoardID)
		}
	}
	h.mu.Unlock()
}

// Presence is the public identity of an online user.
type Presence struct {
	UserID   int64  `json:"userId"`
	Username string `json:"username"`
	Color    string `json:"color"`
}

// OnlineUsers lists distinct user ids currently in a board room.
func (h *Hub) OnlineUsers(boardID int64) []int64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	room := h.rooms[boardID]
	seen := map[int64]bool{}
	var out []int64
	for c := range room {
		if !seen[c.UserID] {
			seen[c.UserID] = true
			out = append(out, c.UserID)
		}
	}
	return out
}

// Broadcast sends msg to every client in the board room.
func (h *Hub) Broadcast(boardID int64, msg map[string]any) {
	h.broadcast(boardID, msg, nil)
}

// BroadcastExcept sends msg to every client in the room except `skip`
// (used so a joining client doesn't receive its own presence echo).
func (h *Hub) BroadcastExcept(boardID int64, msg map[string]any, skip *Client) {
	h.broadcast(boardID, msg, skip)
}

func (h *Hub) broadcast(boardID int64, msg map[string]any, skip *Client) {
	h.mu.Lock()
	room := h.rooms[boardID]
	clients := slices.Clone(slices.Collect(maps.Keys(room)))
	h.mu.Unlock()
	if len(clients) == 0 {
		return
	}
	for _, c := range clients {
		if c == skip {
			continue
		}
		if err := c.WriteJSON(msg); err != nil {
			log.Printf("ws write: %v", err)
		}
	}
}

// WriteJSON marshals and writes one message, serialized per client.
func (c *Client) WriteJSON(msg map[string]any) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	ctx, cancel := writeCtx()
	defer cancel()
	return c.conn.Write(ctx, websocket.MessageText, mustMarshal(msg))
}
