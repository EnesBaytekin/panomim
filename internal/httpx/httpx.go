// Package httpx contains small shared HTTP helpers.
package httpx

import (
	"encoding/json"
	"net/http"
)

// JSON writes v as a JSON response with the given status code.
func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// Err writes a JSON error object {"error": msg}.
func Err(w http.ResponseWriter, status int, msg string) {
	JSON(w, status, map[string]string{"error": msg})
}

// Body decodes a JSON request body into v with a size limit.
func Body(r *http.Request, v any) error {
	defer r.Body.Close()
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20))
	return dec.Decode(v)
}

// ClientID returns the per-tab id (X-Client-Id) used to suppress realtime
// echoes of a client's own mutations.
func ClientID(r *http.Request) string {
	id := r.Header.Get("X-Client-Id")
	if len(id) > 64 {
		return id[:64]
	}
	return id
}
