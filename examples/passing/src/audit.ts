interface AuditEvent {
  operation: string;
  timestamp: string;
  entityId: string;
  [key: string]: unknown;
}

export function emitAudit(event: AuditEvent): void {
  // In production this would write to an audit log, message queue, etc.
  process.stdout.write(JSON.stringify({ type: 'audit', ...event }) + '\n');
}
