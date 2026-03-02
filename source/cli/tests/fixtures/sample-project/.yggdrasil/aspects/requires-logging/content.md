All services must use the structured logger (LoggerService).
Log format: JSON with fields { level, message, context, timestamp, traceId }.
Never log sensitive data (passwords, tokens, PII).
Use appropriate log levels: error for failures, warn for degraded state, info for business events, debug for troubleshooting.
