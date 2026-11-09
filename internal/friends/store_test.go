package friends

import (
	"database/sql"
	"errors"
	"testing"

	"panomim/internal/db"
)

func testSetup(t *testing.T) *Store {
	t.Helper()
	d, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	if err := db.Migrate(d); err != nil {
		t.Fatal(err)
	}
	for _, u := range []string{"alice", "bob", "carol", "dave"} {
		d.Exec(`INSERT INTO users (username, password_hash, created_at) VALUES (?, 'h', 1)`, u)
	}
	return &Store{DB: d}
}

func userID(t *testing.T, s *Store, name string) int64 {
	t.Helper()
	var id int64
	if err := s.DB.QueryRow(`SELECT id FROM users WHERE username = ?`, name).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestRequestAcceptFlow(t *testing.T) {
	s := testSetup(t)
	alice, bob := userID(t, s, "alice"), userID(t, s, "bob")

	_, auto, err := s.SendRequest(alice, "bob")
	if err != nil || auto {
		t.Fatalf("send: auto=%v err=%v", auto, err)
	}

	in, out, err := s.ListRequests(bob)
	if err != nil {
		t.Fatal(err)
	}
	if len(in) != 1 || len(out) != 0 {
		t.Fatalf("bob: incoming=%d outgoing=%d", len(in), len(out))
	}
	if in[0].Username != "alice" || in[0].Direction != "incoming" {
		t.Fatalf("bob incoming: %+v", in[0])
	}
	bobInID := in[0].ID

	in, out, _ = s.ListRequests(alice)
	if len(in) != 0 || len(out) != 1 || out[0].Username != "bob" {
		t.Fatalf("alice: in=%d out=%d", len(in), len(out))
	}

	// accepting duplicates must fail (alice can't accept bob's incoming — she has none)
	if _, err := s.AcceptRequest(alice, bobInID); err == nil {
		t.Fatal("alice must not be able to accept bob's request")
	}

	if _, err := s.AcceptRequest(bob, bobInID); err != nil {
		t.Fatal(err)
	}

	friends, err := s.ListFriends(alice)
	if err != nil || len(friends) != 1 || friends[0].Username != "bob" {
		t.Fatalf("alice friends: %+v err=%v", friends, err)
	}
	// mutual
	friends, _ = s.ListFriends(bob)
	if len(friends) != 1 || friends[0].Username != "alice" {
		t.Fatalf("bob friends: %+v", friends)
	}
}

func TestSendRequestMutualAutoAccept(t *testing.T) {
	s := testSetup(t)
	alice, bob := userID(t, s, "alice"), userID(t, s, "bob")

	if _, _, err := s.SendRequest(alice, "bob"); err != nil {
		t.Fatal(err)
	}
	// bob sending back to alice auto-accepts (mutual add)
	_, auto, err := s.SendRequest(bob, "alice")
	if err != nil || !auto {
		t.Fatalf("reverse send: auto=%v err=%v", auto, err)
	}
	if ok, _ := s.areFriends(alice, bob); !ok {
		t.Fatal("should be friends after mutual request")
	}
	// no pending requests remain
	in, out, _ := s.ListRequests(alice)
	if len(in)+len(out) != 0 {
		t.Fatalf("requests should be cleared, in=%d out=%d", len(in), len(out))
	}
}

func TestSendRequestEdgeCases(t *testing.T) {
	s := testSetup(t)
	alice := userID(t, s, "alice")

	if _, _, err := s.SendRequest(alice, "alice"); !errors.Is(err, ErrSelf) {
		t.Fatalf("self: %v", err)
	}
	if _, _, err := s.SendRequest(alice, "nobody"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	if _, _, err := s.SendRequest(alice, "bob"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.SendRequest(alice, "bob"); !errors.Is(err, ErrPending) {
		t.Fatalf("duplicate: %v", err)
	}
}

func TestDeclineRequest(t *testing.T) {
	s := testSetup(t)
	alice, bob := userID(t, s, "alice"), userID(t, s, "bob")

	if _, _, err := s.SendRequest(alice, "bob"); err != nil {
		t.Fatal(err)
	}
	in, _, _ := s.ListRequests(bob)
	if err := s.DeclineRequest(bob, in[0].ID); err != nil {
		t.Fatal(err)
	}
	if ok, _ := s.areFriends(alice, bob); ok {
		t.Fatal("decline must not create friendship")
	}
	in, _, _ = s.ListRequests(bob)
	if len(in) != 0 {
		t.Fatal("request should be gone after decline")
	}
}

func TestSharedBoards(t *testing.T) {
	s := testSetup(t)
	alice, bob := userID(t, s, "alice"), userID(t, s, "bob")

	// alice owns board 1 and shares it with bob (viewer)
	s.DB.Exec(`INSERT INTO boards (owner_id, name, created_at, updated_at) VALUES (?, 'a-board', 1, 1)`, alice)
	s.DB.Exec(`INSERT INTO board_members (board_id, user_id, role, created_at) VALUES (1, ?, 'viewer', 1)`, bob)

	// bob owns board 2, not shared with alice
	s.DB.Exec(`INSERT INTO boards (owner_id, name, created_at, updated_at) VALUES (?, 'b-board', 1, 1)`, bob)

	// not friends yet → error
	if _, err := s.SharedBoards(alice, bob); !errors.Is(err, ErrNotFriend) {
		t.Fatalf("expected ErrNotFriend, got %v", err)
	}

	// become friends
	if _, _, err := s.SendRequest(alice, "bob"); err != nil {
		t.Fatal(err)
	}
	in, _, _ := s.ListRequests(bob)
	if _, err := s.AcceptRequest(bob, in[0].ID); err != nil {
		t.Fatal(err)
	}

	boards, err := s.SharedBoards(alice, bob)
	if err != nil {
		t.Fatal(err)
	}
	if len(boards) != 1 || boards[0].Name != "a-board" {
		t.Fatalf("shared boards: %+v", boards)
	}
	if boards[0].MyRole != "owner" || boards[0].FriendRole != "viewer" {
		t.Fatalf("roles: %+v", boards[0])
	}
	// members are attached (alice owner + bob viewer)
	if len(boards[0].Members) != 2 {
		t.Fatalf("expected 2 members, got %d: %+v", len(boards[0].Members), boards[0].Members)
	}
	if boards[0].Members[0].Username != "alice" || boards[0].Members[0].Role != "owner" {
		t.Fatalf("owner member first: %+v", boards[0].Members[0])
	}
	if boards[0].Members[1].Username != "bob" || boards[0].Members[1].Role != "viewer" {
		t.Fatalf("viewer member: %+v", boards[0].Members[1])
	}
}

func TestRemoveFriend(t *testing.T) {
	s := testSetup(t)
	alice, bob := userID(t, s, "alice"), userID(t, s, "bob")

	// removing a non-friend must error
	if err := s.RemoveFriend(alice, bob); !errors.Is(err, ErrNotFriend) {
		t.Fatalf("expected ErrNotFriend, got %v", err)
	}

	// become friends, then remove from alice's side
	if _, _, err := s.SendRequest(alice, "bob"); err != nil {
		t.Fatal(err)
	}
	in, _, _ := s.ListRequests(bob)
	if _, err := s.AcceptRequest(bob, in[0].ID); err != nil {
		t.Fatal(err)
	}
	if ok, _ := s.areFriends(alice, bob); !ok {
		t.Fatal("should be friends before removal")
	}

	if err := s.RemoveFriend(alice, bob); err != nil {
		t.Fatal(err)
	}
	// mutual removal: both directions gone
	if ok, _ := s.areFriends(alice, bob); ok {
		t.Fatal("friendship should be gone")
	}
	if ok, _ := s.areFriends(bob, alice); ok {
		t.Fatal("friendship should be gone (reverse)")
	}
	// removing again errors
	if err := s.RemoveFriend(alice, bob); !errors.Is(err, ErrNotFriend) {
		t.Fatalf("expected ErrNotFriend after removal, got %v", err)
	}
}

func TestSearchUsers(t *testing.T) {
	s := testSetup(t)
	alice := userID(t, s, "alice")

	// "a" matches carol + dave (alice excluded), sorted alphabetically
	got, err := s.SearchUsers(alice, "a", 8)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Username != "carol" || got[1].Username != "dave" {
		t.Fatalf("search 'a': %+v", got)
	}

	// case-insensitive substring
	got, _ = s.SearchUsers(alice, "BOB", 8)
	if len(got) != 1 || got[0].Username != "bob" {
		t.Fatalf("search 'BOB': %+v", got)
	}

	// limit clamps to 50 and empty query returns everyone except caller
	got, _ = s.SearchUsers(alice, "", 50)
	if len(got) != 3 {
		t.Fatalf("empty search should return 3 users, got %d", len(got))
	}

	// no matches
	got, _ = s.SearchUsers(alice, "zzz", 8)
	if len(got) != 0 {
		t.Fatalf("no-match search: %+v", got)
	}
}
