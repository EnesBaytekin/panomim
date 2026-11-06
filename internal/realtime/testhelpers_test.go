package realtime

import (
	"context"
	"encoding/json"
	"time"

	"github.com/coder/websocket"
)

func contextTimeout(d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), d)
}

func contextTimeout2(d time.Duration) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	_ = cancel
	return ctx
}

func jsonUnmarshal(data []byte, v any) error { return json.Unmarshal(data, v) }

func writeJSON(t interface {
	Helper()
	Fatalf(string, ...any)
}, conn *websocket.Conn, msg map[string]any) {
	t.Helper()
	b, _ := json.Marshal(msg)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, b); err != nil {
		t.Fatalf("write: %v", err)
	}
}
