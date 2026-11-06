// Package server wires every module into the HTTP router.
package server

import (
	"io/fs"
	"log"
	"net/http"
	"path"
	"strings"
	"time"

	"panomim/internal/auth"
	"panomim/internal/boards"
	"panomim/internal/friends"
	"panomim/internal/httpx"
	"panomim/internal/nodes"
	"panomim/internal/prefs"
	"panomim/internal/realtime"
	"panomim/web"
)

// Deps carries the assembled services.
type Deps struct {
	Auth    *auth.Service
	Boards  *boards.Handlers
	Nodes   *nodes.Handlers
	Friends *friends.Handlers
	Prefs   *prefs.Store
	WS      *realtime.Handlers
	Hub     *realtime.Hub
	DevDir  string // when set, serve static files from disk (dev mode)
}

// Router builds the full application mux.
func Router(d Deps) http.Handler {
	mux := http.NewServeMux()

	// --- auth (rate limited) ---
	mux.Handle("POST /api/auth/register", rateLimit(http.HandlerFunc(d.Auth.Register)))
	mux.Handle("POST /api/auth/login", rateLimit(http.HandlerFunc(d.Auth.Login)))
	mux.Handle("POST /api/auth/refresh", rateLimit(http.HandlerFunc(d.Auth.Refresh)))
	mux.Handle("POST /api/auth/logout", rateLimit(http.HandlerFunc(d.Auth.Logout)))
	mux.Handle("POST /api/auth/password", rateLimit(d.Auth.RequireAuth(http.HandlerFunc(d.Auth.ChangePassword))))
	mux.Handle("PUT /api/me/avatar", d.Auth.RequireAuth(http.HandlerFunc(d.Auth.PutAvatar)))
	mux.Handle("GET /api/users/{userID}/avatar", d.Auth.RequireAuth(http.HandlerFunc(d.Auth.GetAvatar)))

	// --- authenticated API ---
	authed := func(pattern string, h http.Handler) {
		mux.Handle(pattern, d.Auth.RequireAuth(h))
	}
	authed("GET /api/me", http.HandlerFunc(d.Auth.Me))
	authed("PUT /api/me/last-board", http.HandlerFunc(d.Auth.SetLastBoard))

	authed("GET /api/friends", http.HandlerFunc(d.Friends.ListFriends))
	authed("GET /api/friends/requests", http.HandlerFunc(d.Friends.ListRequests))
	authed("POST /api/friends/requests", http.HandlerFunc(d.Friends.SendRequest))
	authed("POST /api/friends/requests/{requestID}/accept", http.HandlerFunc(d.Friends.AcceptRequest))
	authed("DELETE /api/friends/requests/{requestID}", http.HandlerFunc(d.Friends.DeclineRequest))
	authed("GET /api/friends/{userID}/boards", http.HandlerFunc(d.Friends.SharedBoards))

	authed("GET /api/boards", http.HandlerFunc(d.Boards.List))
	authed("POST /api/boards", http.HandlerFunc(d.Boards.Create))

	board := d.Boards.Access
	authed("GET /api/boards/{boardID}", board(RoleViewer)(http.HandlerFunc(d.Boards.Get)))
	authed("PATCH /api/boards/{boardID}", board(RoleOwner)(http.HandlerFunc(d.Boards.Rename)))
	authed("DELETE /api/boards/{boardID}", board(RoleOwner)(http.HandlerFunc(d.Boards.Delete)))
	authed("POST /api/boards/{boardID}/share", board(RoleOwner)(http.HandlerFunc(d.Boards.Share)))
	authed("DELETE /api/boards/{boardID}/members/{userID}", board(RoleOwner)(http.HandlerFunc(d.Boards.Unshare)))

	authed("GET /api/boards/{boardID}/nodes", board(RoleViewer)(http.HandlerFunc(d.Nodes.List)))
	authed("POST /api/boards/{boardID}/nodes", board(RoleEditor)(http.HandlerFunc(d.Nodes.Create)))
	authed("GET /api/boards/{boardID}/prefs", board(RoleViewer)(http.HandlerFunc(d.Prefs.Get)))
	authed("PUT /api/boards/{boardID}/prefs", board(RoleViewer)(http.HandlerFunc(d.Prefs.Put)))

	nodeAcc := d.Nodes.NodeAccess
	fieldAcc := d.Nodes.FieldAccess
	authed("PATCH /api/nodes/{nodeID}/done", nodeAcc(RoleViewer)(http.HandlerFunc(d.Nodes.SetDone)))
	authed("PATCH /api/nodes/{nodeID}", nodeAcc(RoleEditor)(http.HandlerFunc(d.Nodes.Patch)))
	authed("DELETE /api/nodes/{nodeID}", nodeAcc(RoleEditor)(http.HandlerFunc(d.Nodes.Delete)))
	authed("POST /api/nodes/{nodeID}/fields", nodeAcc(RoleEditor)(http.HandlerFunc(d.Nodes.CreateField)))
	authed("POST /api/nodes/{nodeID}/fields/order", nodeAcc(RoleEditor)(http.HandlerFunc(d.Nodes.ReorderFields)))
	authed("PATCH /api/fields/{fieldID}", fieldAcc(RoleEditor)(http.HandlerFunc(d.Nodes.PatchField)))
	authed("DELETE /api/fields/{fieldID}", fieldAcc(RoleEditor)(http.HandlerFunc(d.Nodes.DeleteField)))
	authed("POST /api/boards/{boardID}/files", board(RoleEditor)(http.HandlerFunc(d.Nodes.Upload)))
	authed("GET /api/files/{fileID}", d.Nodes.FileAccess(RoleViewer)(http.HandlerFunc(d.Nodes.ServeFile)))

	// --- realtime ---
	authed("GET /api/ws/ticket", http.HandlerFunc(d.WS.Ticket))
	mux.Handle("GET /api/ws", http.HandlerFunc(d.WS.ServeWS))

	// --- static frontend ---
	mux.Handle("/", staticHandler(d.DevDir))

	return securityHeaders(logRequests(mux))
}

// Role re-export for route wiring readability.
const (
	RoleViewer = boards.RoleViewer
	RoleEditor = boards.RoleEditor
	RoleOwner  = boards.RoleOwner
)

func rateLimit(next http.Handler) http.Handler {
	return auth.RateLimit(next)
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		if strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Path != "/api/ws" {
			log.Printf("%s %s (%s)", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
		}
	})
}

// securityHeaders applies the baseline protection to every response.
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "same-origin")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		h.Set("Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "+
				"img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'")
		if r.TLS != nil {
			h.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
		}
		next.ServeHTTP(w, r)
	})
}

// staticHandler serves the embedded SPA; unknown extension-less paths fall
// back to index.html so client-side routing works.
func staticHandler(devDir string) http.Handler {
	if devDir != "" {
		fsDisk := http.StripPrefix("/", http.FileServer(http.Dir(devDir)))
		return spaWrap(fsDisk)
	}
	sub, err := fs.Sub(web.Static, "static")
	if err != nil {
		panic(err)
	}
	fileServer := http.StripPrefix("/", http.FileServer(http.FS(sub)))
	return spaWrap(fileServer)
}

func spaWrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := path.Clean(r.URL.Path)
		if p == "/" || !strings.Contains(path.Base(p), ".") {
			serveIndex(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func serveIndex(w http.ResponseWriter, r *http.Request) {
	if devIndex != "" {
		http.ServeFile(w, r, devIndex)
		return
	}
	data, err := web.Static.ReadFile("static/index.html")
	if err != nil {
		httpx.Err(w, 500, "index missing")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(data)
}

// devIndex is set in dev mode so index.html is served from disk too.
var devIndex string

// SetDevDir enables disk-backed static serving.
func SetDevDir(dir string) { devIndex = path.Join(dir, "index.html") }
