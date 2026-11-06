package auth

import (
	"net/http"
	"sync"
	"time"
)

// limiter is a tiny fixed-window rate limiter keyed by string (e.g. IP+route).
// Sufficient for a self-hosted app; protects login/register from brute force.
type limiter struct {
	mu      sync.Mutex
	hits    map[string][]time.Time
	window  time.Duration
	allowed int
}

func newLimiter(window time.Duration, allowed int) *limiter {
	return &limiter{hits: map[string][]time.Time{}, window: window, allowed: allowed}
}

// Allow records a hit for key and reports whether it is within budget.
func (l *limiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	cutoff := now.Add(-l.window)
	kept := l.hits[key][:0]
	for _, t := range l.hits[key] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	l.hits[key] = kept
	if len(kept) >= l.allowed {
		return false
	}
	l.hits[key] = append(kept, now)
	return true
}

// RateLimit wraps a handler with per-IP rate limiting.
func RateLimit(next http.Handler) http.Handler {
	l := newLimiter(time.Minute, 30)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !l.Allow(clientIP(r)) {
			w.Header().Set("Retry-After", "30")
			http.Error(w, "too many requests", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func clientIP(r *http.Request) string {
	host := r.RemoteAddr
	if i := len(host) - 1; i >= 0 {
		for ; i >= 0; i-- {
			if host[i] == ':' {
				break
			}
		}
		if i > 0 {
			return host[:i]
		}
	}
	return host
}
