package realtime

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"panomim/internal/auth"
	"panomim/internal/boards"
	"panomim/internal/db"
)

// spinUp builds a hub + handlers over a fresh in-memory DB with two users.
func spinUp(t *testing.T) (*httptest.Server, *Hub) {
	t.Helper()
	d, err := db.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	if err := db.Migrate(d); err != nil {
		t.Fatal(err)
	}
	d.Exec(`INSERT INTO users (id, username, password_hash, created_at) VALUES (1,'alice','h',1)`)
	d.Exec(`INSERT INTO users (id, username, password_hash, created_at) VALUES (2,'bob','h',1)`)
	d.Exec(`INSERT INTO boards (id, owner_id, name, created_at, updated_at) VALUES (1, 1, 'b', 1, 1)`)
	d.Exec(`INSERT INTO board_members (board_id, user_id, role, created_at) VALUES (1, 2, 'editor', 1)`)

	hub := NewHub()
	h := &Handlers{Hub: hub, Boards: &boards.Store{DB: d}}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws", h.ServeWS)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, hub
}

func dial(t *testing.T, srv *httptest.Server, hub *Hub, userID int64, username, boardID string) *websocket.Conn {
	t.Helper()
	ticket := hub.IssueTicket(userID, username)
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws?board_id=" + boardID + "&ticket=" + ticket
	ctx, cancel := contextTimeout(5 * time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", username, err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	return conn
}

func readMsg(t *testing.T, conn *websocket.Conn) map[string]any {
	t.Helper()
	ctx, cancel := contextTimeout(3 * time.Second)
	defer cancel()
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var m map[string]any
	if err := jsonUnmarshal(data, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return m
}

func TestPresenceAndBroadcast(t *testing.T) {
	srv, hub := spinUp(t)

	alice := dial(t, srv, hub, 1, "alice", "1")
	hello := readMsg(t, alice)
	if hello["type"] != "hello" {
		t.Fatalf("first message must be hello, got %v", hello["type"])
	}
	// alice is alone
	users := hello["users"].([]any)
	if len(users) != 1 {
		t.Fatalf("alice should see only herself, got %d", len(users))
	}

	bob := dial(t, srv, hub, 2, "bob", "1")
	// bob first sees his own hello (alice is already in the room)
	if bh := readMsg(t, bob); bh["type"] != "hello" {
		t.Fatalf("bob's first message must be hello, got %v", bh["type"])
	}
	// alice receives bob's join
	join := readMsg(t, alice)
	if join["type"] != "presence_join" {
		t.Fatalf("alice should see presence_join, got %v", join["type"])
	}

	// presence reflects both users
	if online := hub.OnlineUsers(1); len(online) != 2 {
		t.Fatalf("online users = %v, want 2", online)
	}

	// hub broadcast reaches both
	hub.Broadcast(1, map[string]any{"type": "node_created", "x": 1})
	for _, c := range []*websocket.Conn{alice, bob} {
		m := readMsg(t, c)
		if m["type"] != "node_created" {
			t.Fatalf("expected broadcast, got %v", m["type"])
		}
	}

	// selection is forwarded to the other peer
	writeJSON(t, bob, map[string]any{"type": "select", "nodeId": 42})
	sel := readMsg(t, alice)
	if sel["type"] != "select" || sel["nodeId"] != float64(42) {
		t.Fatalf("selection not forwarded: %v", sel)
	}

	// bob leaves -> alice gets presence_leave
	bob.CloseNow()
	left := readMsg(t, alice)
	if left["type"] != "presence_leave" {
		t.Fatalf("expected presence_leave, got %v", left["type"])
	}
	if online := hub.OnlineUsers(1); len(online) != 1 {
		t.Fatalf("after leave online = %v, want 1", online)
	}
}

func TestTicketSingleUse(t *testing.T) {
	srv, hub := spinUp(t)
	ticket := hub.IssueTicket(1, "alice")
	if _, _, ok := hub.ConsumeTicket(ticket); !ok {
		t.Fatal("first use must succeed")
	}
	if _, _, ok := hub.ConsumeTicket(ticket); ok {
		t.Fatal("second use of ticket must fail")
	}
	_ = srv
}

func TestNonMemberRejected(t *testing.T) {
	srv, hub := spinUp(t)
	d, _ := db.Open(":memory:")
	_ = d
	// user 99 has no membership; ws must fail the upgrade
	ticket := hub.IssueTicket(99, "mallory")
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws?board_id=1&ticket=" + ticket
	conn, resp, err := websocket.Dial(contextTimeout2(3*time.Second), url, nil)
	if err == nil {
		conn.CloseNow()
		t.Fatal("non-member must be rejected")
	}
	if resp != nil && resp.StatusCode != http.StatusForbidden {
		t.Fatalf("want 403, got %d", resp.StatusCode)
	}
	_ = auth.UserFrom
}
