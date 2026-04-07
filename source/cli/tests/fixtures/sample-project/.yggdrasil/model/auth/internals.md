# Internals

## Logic

JWT token signing uses HMAC-SHA256 with rotating keys.
Session invalidation uses a denylist stored in Redis.
