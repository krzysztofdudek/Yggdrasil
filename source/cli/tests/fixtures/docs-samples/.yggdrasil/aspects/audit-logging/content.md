# Audit logging

Every function that changes an order must call `audit.emit()` with what changed.
