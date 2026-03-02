# Requires Auth

Nodes carrying this aspect enforce that the user is authenticated before allowing access.

## API

- Protected routes must use auth middleware to verify JWT.
- Unauthenticated requests return 401 with clear message.
- Token is read from `Authorization: Bearer <token>` header.
- JWT payload includes `user_id` and `plan` (free|pro).

## Web

- Protected pages redirect to Login when no valid session.
- AuthContext provides `user` and `token`; null means unauthenticated.
- API client attaches token to requests when available.
- Protected routes: `/dashboard`, `/expenses`, `/categories`, `/budgets`, `/reports`, `/settings`.

## Public vs protected

- Public: Landing, Login, Register — no auth required.
- Protected: all other routes except auth endpoints.
