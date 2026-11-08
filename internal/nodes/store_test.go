package nodes

import (
	"database/sql"
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
	d.Exec(`INSERT INTO users (username, password_hash, created_at) VALUES ('u','h',1)`)
	d.Exec(`INSERT INTO boards (owner_id, name, created_at, updated_at) VALUES (1,'b',1,1)`)
	return &Store{DB: d}
}

func mustNode(t *testing.T, s *Store, id int64) *Node {
	t.Helper()
	n, err := s.Node(id)
	if err != nil {
		t.Fatalf("node %d: %v", id, err)
	}
	return n
}

func TestTreeCRUD(t *testing.T) {
	s := testSetup(t)

	// two roots
	r1, err := s.Create(1, nil, "root-1", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	r2, _ := s.Create(1, nil, "root-2", 0, 0)
	if r1.Position >= r2.Position {
		t.Fatal("roots must get increasing positions")
	}

	// children
	c1, _ := s.Create(1, &r1.ID, "child-1", 0, 0)
	c2, _ := s.Create(1, &r1.ID, "child-2", 0, 0)
	if c1.Position >= c2.Position {
		t.Fatal("siblings must get increasing positions")
	}
	g1, _ := s.Create(1, &c1.ID, "grandchild", 0, 0)

	// multi-root structure
	kids, _ := s.ChildCount(r1.ID)
	if kids != 2 {
		t.Fatalf("root1 kids = %d, want 2", kids)
	}

	// update fields
	up, err := s.Update(r1.ID, Patch{Title: strPtr("renamed"), Done: boolPtr(true), X: fPtr(120), Y: fPtr(80), W: fPtr(240), H: fPtr(100), Hue: intPtr(40)})
	if err != nil {
		t.Fatal(err)
	}
	if up.Title != "renamed" || !up.Done || up.X != 120 || up.W != 240 || *up.Hue != 40 {
		t.Fatalf("bad update: %+v", up)
	}

	// reparent under grandchild must fail (cycle)
	if _, err := s.Update(r1.ID, Patch{ParentID: &g1.ID}); err != ErrCycle {
		t.Fatalf("expected ErrCycle, got %v", err)
	}
	// reparent onto itself must fail
	if _, err := s.Update(r1.ID, Patch{ParentID: &r1.ID}); err != ErrCycle {
		t.Fatalf("self-parent must be ErrCycle, got %v", err)
	}
	// reparent child-2 under root-2 works
	if _, err := s.Update(c2.ID, Patch{ParentID: &r2.ID}); err != nil {
		t.Fatal(err)
	}
	n := mustNode(t, s, c2.ID)
	if n.ParentID == nil || *n.ParentID != r2.ID {
		t.Fatal("reparent failed")
	}
	// move back to root (parentID=0)
	zero := int64(0)
	if _, err := s.Update(c2.ID, Patch{ParentID: &zero}); err != nil {
		t.Fatal(err)
	}
	if n2 := mustNode(t, s, c2.ID); n2.ParentID != nil {
		t.Fatal("parent must be nil after moving to root")
	}
}

func TestDeleteCascade(t *testing.T) {
	s := testSetup(t)
	r, _ := s.Create(1, nil, "root", 0, 0)
	c, _ := s.Create(1, &r.ID, "child", 0, 0)
	g, _ := s.Create(1, &c.ID, "grandchild", 0, 0)

	ids, _ := s.SubtreeIDs(r.ID)
	if len(ids) != 3 {
		t.Fatalf("subtree = %v, want 3 ids", ids)
	}
	if err := s.Delete(r.ID); err != nil {
		t.Fatal(err)
	}
	// soft-delete: rows stay, but the whole subtree is hidden
	if n, _ := s.ListByBoard(1); len(n) != 0 {
		t.Fatalf("ListByBoard returned %d nodes, want 0", len(n))
	}
	if _, err := s.Node(r.ID); err != ErrNotFound {
		t.Fatalf("deleted root must be NotFound, got %v", err)
	}
	if _, err := s.Node(g.ID); err != ErrNotFound {
		t.Fatalf("deleted grandchild must be NotFound, got %v", err)
	}
	// restore brings the subtree back with its hierarchy intact
	got, err := s.Restore(r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("restored = %v, want 3 ids", got)
	}
	if n, _ := s.ListByBoard(1); len(n) != 3 {
		t.Fatalf("after restore ListByBoard returned %d nodes, want 3", len(n))
	}
	if n := mustNode(t, s, g.ID); n.ParentID == nil || *n.ParentID != c.ID {
		t.Fatal("restored grandchild lost its parent")
	}
	// deleting again must fail (already live → ErrNotFound on double delete is
	// exercised below via a fresh delete)
	if err := s.Delete(r.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(r.ID); err != ErrNotFound {
		t.Fatalf("double delete: got %v, want ErrNotFound", err)
	}
}

func TestFields(t *testing.T) {
	s := testSetup(t)
	r, _ := s.Create(1, nil, "n", 0, 0)

	if _, err := s.CreateField(r.ID, "nope", "x"); err != ErrBadType {
		t.Fatal("bad type must be rejected")
	}
	f1, err := s.CreateField(r.ID, "date", "2026-11-06")
	if err != nil {
		t.Fatal(err)
	}
	f2, _ := s.CreateField(r.ID, "image", "file-id-1")
	if f2.Position <= f1.Position {
		t.Fatal("field positions must increase")
	}
	up, _ := s.UpdateField(f1.ID, "2026-12-25")
	if up.Value != "2026-12-25" {
		t.Fatal("field update failed")
	}
	nodes, _ := s.ListByBoard(1)
	if len(nodes[0].Fields) != 2 {
		t.Fatalf("fields not joined: %+v", nodes[0].Fields)
	}
	if err := s.DeleteField(f2.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Field(f2.ID); err != ErrNotFound {
		t.Fatal("deleted field must 404")
	}
}

func TestReorderFields(t *testing.T) {
	s := testSetup(t)
	n, _ := s.Create(1, nil, "n", 0, 0)
	f1, _ := s.CreateField(n.ID, "text", "a")
	f2, _ := s.CreateField(n.ID, "image", "file-1")
	f3, _ := s.CreateField(n.ID, "text", "b")

	// reorder f3, f1, f2
	got, err := s.ReorderFields(n.ID, []int64{f3.ID, f1.ID, f2.ID})
	if err != nil {
		t.Fatal(err)
	}
	want := []int64{f3.ID, f1.ID, f2.ID}
	if len(got.Fields) != 3 {
		t.Fatalf("fields = %d, want 3", len(got.Fields))
	}
	for i, f := range got.Fields {
		if f.ID != want[i] {
			t.Fatalf("order[%d] = %d, want %d", i, f.ID, want[i])
		}
	}

	// a duplicate id must be rejected
	if _, err := s.ReorderFields(n.ID, []int64{f1.ID, f1.ID, f2.ID}); err != ErrBadOrder {
		t.Fatalf("duplicate ids: got %v, want ErrBadOrder", err)
	}
	// a missing id must be rejected
	if _, err := s.ReorderFields(n.ID, []int64{f1.ID, f2.ID}); err != ErrBadOrder {
		t.Fatalf("missing id: got %v, want ErrBadOrder", err)
	}
}

func strPtr(s string) *string    { return &s }
func boolPtr(b bool) *bool       { return &b }
func fPtr(f float64) *float64    { return &f }
func intPtr(i int) *int          { return &i }
