package boards

import "context"

type (
	ctxKeyRole   struct{}
	ctxKeyBoard  struct{}
)

// WithBoardID stores the resolved board id in the context.
func WithBoardID(ctx context.Context, id int64) context.Context {
	return context.WithValue(ctx, ctxKeyBoard{}, id)
}

// WithRole stores the resolved role in the context.
func WithRole(ctx context.Context, role Role) context.Context {
	return context.WithValue(ctx, ctxKeyRole{}, role)
}

// RoleFrom returns the caller's role resolved by the Access middleware.
func RoleFrom(ctx context.Context) Role {
	role, _ := ctx.Value(ctxKeyRole{}).(Role)
	return role
}

// IDFrom returns the board id resolved by the Access middleware.
func IDFrom(ctx context.Context) int64 {
	id, _ := ctx.Value(ctxKeyBoard{}).(int64)
	return id
}
