package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Claims embedded in every access token.
type Claims struct {
	UserID   int64  `json:"uid"`
	Username string `json:"username"`
	jwt.RegisteredClaims
}

// TokenManager signs/verifies access JWTs. The signing secret is generated
// once and persisted in the meta table so sessions survive restarts.
type TokenManager struct {
	secret []byte
	ttl    time.Duration
}

func NewTokenManager(secret []byte, ttl time.Duration) *TokenManager {
	return &TokenManager{secret: secret, ttl: ttl}
}

// NewAccessToken mints a signed 15-minute JWT for the user.
func (tm *TokenManager) NewAccessToken(userID int64, username string) (string, time.Time, error) {
	exp := time.Now().Add(tm.ttl)
	claims := Claims{
		UserID:   userID,
		Username: username,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   fmt.Sprintf("%d", userID),
			ExpiresAt: jwt.NewNumericDate(exp),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			ID:        randomHex(8),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, &claims)
	signed, err := tok.SignedString(tm.secret)
	return signed, exp, err
}

// ParseAccessToken validates a JWT and returns its claims.
func (tm *TokenManager) ParseAccessToken(token string) (*Claims, error) {
	parsed, err := jwt.ParseWithClaims(token, &Claims{}, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method %v", t.Header["alg"])
		}
		return tm.secret, nil
	})
	if err != nil {
		return nil, err
	}
	claims, ok := parsed.Claims.(*Claims)
	if !ok || !parsed.Valid {
		return nil, errors.New("auth: invalid token")
	}
	return claims, nil
}

// NewRefreshToken returns (raw token, sha256 hash). Only the hash is stored;
// a leaked DB dump therefore cannot be replayed as a login session.
func NewRefreshToken() (string, string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", "", err
	}
	tok := base64.RawURLEncoding.EncodeToString(raw)
	return tok, HashToken(tok), nil
}

// HashToken is the storage form of a refresh token.
func HashToken(tok string) string {
	sum := sha256.Sum256([]byte(tok))
	return hex.EncodeToString(sum[:])
}

func randomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}
