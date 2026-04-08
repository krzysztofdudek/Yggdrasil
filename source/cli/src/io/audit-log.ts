import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import type { AuditEntry } from '../model/drift.js';

const AUDIT_LOG_FILE = '.audit-log.jsonl';

/**
 * Append an audit entry to the JSONL audit log.
 * Creates the file if it doesn't exist. Never reads or parses existing content.
 */
export async function appendAuditEntry(yggRoot: string, entry: AuditEntry): Promise<void> {
  const filePath = path.join(yggRoot, AUDIT_LOG_FILE);
  const line = JSON.stringify(entry) + '\n';
  await appendFile(filePath, line, 'utf-8');
}
