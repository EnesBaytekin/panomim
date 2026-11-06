package auth

import (
	"strings"
	"testing"
	"time"
)

func TestPasswordHashRoundtrip(t *testing.T) {
	hash, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	if !strings.HasPrefix(hash, "$argon2id$") {
		t.Fatalf("not PHC format: %s", hash)
	}
	if err := VerifyPassword(hash, "correct horse battery staple"); err != nil {
		t.Fatalf("verify correct: %v", err)
	}
	if err := VerifyPassword(hash, "wrong"); err == nil {
		t.Fatal("verify wrong password should fail")
	}
	// two hashes of same password must differ (random salt)
	h2, _ := HashPassword("correct horse battery staple")
	if h2 == hash {
		t.Fatal("hashes must be salted")
	}
}

func TestTokenRoundtrip(t *testing.T) {
	tm := NewTokenManager([]byte("0123456789abcdef0123456789abcdef"), 15*time.Minute)
	tok, exp, err := tm.NewAccessToken(42, "ada")
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	if exp.IsZero() {
		t.Fatal("expiry missing")
	}
	claims, err := tm.ParseAccessToken(tok)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if claims.UserID != 42 || claims.Username != "ada" {
		t.Fatalf("bad claims: %+v", claims)
	}
	if _, err := tm.ParseAccessToken(tok+"x"); err == nil {
		t.Fatal("tampered token must fail")
	}
	// wrong secret must fail
	other := NewTokenManager([]byte("another-secret-another-secret"), 15*time.Minute)
	if _, err := other.ParseAccessToken(tok); err == nil {
		t.Fatal("token from other secret must fail")
	}
}

func TestRefreshRotationAndReuseDetection(t *testing.T) {
	st := testStore(t)
	u, err := st.CreateUser("bob", "hash")
	if err != nil {
		t.Fatal(err)
	}

	raw1, h1, _ := NewRefreshToken()
	fam := NewFamilyID()
	if err := st.StoreRefresh(u.ID, h1, fam, "dev1", "ua", timeNowPlus()); err != nil {
		t.Fatal(err)
	}
	sess, err := st.LookupRefresh(h1)
	if err != nil || sess == nil {
		t.Fatalf("lookup: %v %v", sess, err)
	}
	if err := st.RotateRefresh(sess.ID); err != nil {
		t.Fatal(err)
	}

	// realistic flow: client rotates to a new token in the same family...
	raw2, h2, _ := NewRefreshToken()
	st.StoreRefresh(u.ID, h2, fam, "dev1", "ua", timeNowPlus())

	// ...then an attacker replays the old token -> family must die
	if again, _ := st.LookupRefresh(h1); again != nil {
		t.Fatal("revoked token must not resolve")
	}
	if s2, _ := st.LookupRefresh(h2); s2 != nil {
		t.Fatal("family must be revoked after reuse detection")
	}

	// fresh family keeps working
	raw3, h3, _ := NewRefreshToken()
	fam2 := NewFamilyID()
	st.StoreRefresh(u.ID, h3, fam2, "dev2", "ua", timeNowPlus())
	if s3, _ := st.LookupRefresh(h3); s3 == nil || s3.FamilyID != fam2 {
		t.Fatal("fresh family should resolve")
	}
	_ = raw1
	_ = raw2
	_ = raw3
}

func TestRateLimiter(t *testing.T) {
	l := newLimiter(time.Minute, 3)
	for i := 0; i < 3; i++ {
		if !l.Allow("1.2.3.4") {
			t.Fatalf("hit %d should pass", i+1)
		}
	}
	if l.Allow("1.2.3.4") {
		t.Fatal("4th hit must be blocked")
	}
	if !l.Allow("5.6.7.8") {
		t.Fatal("other ip must pass")
	}
}

func TestUserCRUD(t *testing.T) {
	st := testStore(t)
	u, err := st.CreateUser("alice", "hash")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateUser("ALICE", "hash"); err != ErrUserExists {
		t.Fatalf("expected ErrUserExists, got %v", err)
	}
	id, hash, err := st.UserByName("alice")
	if err != nil || id != u.ID || hash != "hash" {
		t.Fatalf("lookup failed: %v", err)
	}
	if err := st.SetLastBoard(u.ID, 7); err != nil {
		t.Fatal(err)
	}
	if got, _ := st.LastBoard(u.ID); got != 7 {
		t.Fatalf("last board = %d, want 7", got)
	}
}
