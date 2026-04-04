import { describe, it, expect } from 'vitest';
import { mkdir, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendAuditEntry } from '../../../src/io/audit-log.js';
import type { AuditEntry } from '../../../src/model/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: '2026-04-03T14:00:00.000Z',
    node: 'svc/my-service',
    action: 'approved',
    prev: 'aaa111',
    hash: 'bbb222',
    reason: null,
    files: ['src/svc/index.ts'],
    ...overrides,
  };
}

describe('audit-log', () => {
  it('creates file and appends single entry', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-audit-single');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });

    await appendAuditEntry(tmpDir, makeEntry());

    const content = await readFile(path.join(tmpDir, '.audit-log.jsonl'), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.node).toBe('svc/my-service');
    expect(parsed.action).toBe('approved');
    expect(parsed.reason).toBeNull();
    expect(parsed.files).toEqual(['src/svc/index.ts']);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('appends multiple entries (append-only)', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-audit-multi');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });

    await appendAuditEntry(tmpDir, makeEntry({ node: 'svc/a' }));
    await appendAuditEntry(tmpDir, makeEntry({ node: 'svc/b', action: 'acknowledged', reason: 'formatter ran' }));

    const content = await readFile(path.join(tmpDir, '.audit-log.jsonl'), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).node).toBe('svc/a');
    expect(JSON.parse(lines[1]).node).toBe('svc/b');
    expect(JSON.parse(lines[1]).reason).toBe('formatter ran');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes valid JSON per line', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-audit-json');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });

    await appendAuditEntry(tmpDir, makeEntry({ prev: null, action: 'initial' }));

    const content = await readFile(path.join(tmpDir, '.audit-log.jsonl'), 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.prev).toBeNull();
    expect(parsed.action).toBe('initial');

    await rm(tmpDir, { recursive: true, force: true });
  });
});
