import { describe, it, expect } from 'vitest';
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readDriftState,
  writeDriftState,
  readNodeDriftState,
  writeNodeDriftState,
  garbageCollectDriftState,
} from '../../../src/io/drift-state-store.js';
import type { DriftState } from '../../../src/model/drift.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('drift-state-store', () => {
  it('reads existing drift state from per-node directory format', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-read');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });

    // Write per-node JSON files
    const state: DriftState = {
      'orders/order-service': { hash: 'abc123def456', files: { 'src/orders/order.service.ts': 'abc123def456' } },
      'auth/auth-api': { hash: 'fff789', files: { 'src/auth/auth.controller.ts': 'fff789' } },
    };
    await writeDriftState(tmpDir, state);

    const result = await readDriftState(tmpDir);

    expect(result['orders/order-service']).toEqual({
      hash: 'abc123def456',
      files: { 'src/orders/order.service.ts': 'abc123def456' },
    });
    expect(result['auth/auth-api']).toEqual({
      hash: 'fff789',
      files: { 'src/auth/auth.controller.ts': 'fff789' },
    });

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty when file does not exist', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-none');
    await mkdir(tmpDir, { recursive: true });

    const state = await readDriftState(tmpDir);

    expect(Object.keys(state)).toHaveLength(0);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writeDriftState creates/updates per-node files correctly', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-write');
    await mkdir(tmpDir, { recursive: true });

    const state: DriftState = {
      'test/node': { hash: 'abc123', files: { 'src/test.ts': 'abc123' } },
    };

    await writeDriftState(tmpDir, state);

    // Per-node file should exist
    const content = await readFile(path.join(tmpDir, '.drift-state', 'test', 'node.json'), 'utf-8');
    expect(content).toContain('abc123');

    const readBack = await readDriftState(tmpDir);
    expect(readBack['test/node']).toEqual({ hash: 'abc123', files: { 'src/test.ts': 'abc123' } });

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('handles drift state with empty object', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-empty');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, '.drift-state'), '{}\n', 'utf-8');

    const state = await readDriftState(tmpDir);
    expect(Object.keys(state)).toHaveLength(0);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('handles drift-state file with no entries key', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-no-entries');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, '.drift-state'), 'some_other_field: true\n', 'utf-8');

    const state = await readDriftState(tmpDir);
    expect(Object.keys(state)).toHaveLength(0);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('handles completely empty drift-state file', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-empty-file');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, '.drift-state'), '', 'utf-8');

    const state = await readDriftState(tmpDir);
    expect(Object.keys(state)).toHaveLength(0);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty when .drift-state is a file instead of directory', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-file-fallback');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, '.drift-state'),
      `orders/order-service:
  hash: 28f3c41611792a2e0cc8a4fdffc9b2294aa49d46
  files:
    src/orders/order.service.ts: 28f3c41611792a2e0cc8a4fdffc9b2294aa49d46
`,
      'utf-8',
    );

    const state = await readDriftState(tmpDir);
    expect(Object.keys(state)).toHaveLength(0);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('write and read roundtrip', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-roundtrip');
    await mkdir(tmpDir, { recursive: true });

    const state: DriftState = {
      'multi/svc': { hash: 'sha256abc123', files: { 'src/multi.ts': 'sha256abc123' } },
      'other/node': { hash: 'sha256def456', files: { 'src/other.ts': 'sha256def456' } },
    };

    await writeDriftState(tmpDir, state);
    const readBack = await readDriftState(tmpDir);
    expect(readBack['multi/svc']).toEqual({
      hash: 'sha256abc123',
      files: { 'src/multi.ts': 'sha256abc123' },
    });
    expect(readBack['other/node']).toEqual({
      hash: 'sha256def456',
      files: { 'src/other.ts': 'sha256def456' },
    });

    await rm(tmpDir, { recursive: true, force: true });
  });

  // --- Per-node drift state tests ---

  it('writeNodeDriftState creates file at correct nested path', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-per-node-write');
    await mkdir(tmpDir, { recursive: true });

    const nodeState = { hash: 'abc123', files: { 'src/test.ts': 'abc123' } };
    await writeNodeDriftState(tmpDir, 'cli/commands/aspects', nodeState);

    const content = await readFile(
      path.join(tmpDir, '.drift-state', 'cli', 'commands', 'aspects.json'),
      'utf-8',
    );
    const parsed = JSON.parse(content);
    expect(parsed).toEqual(nodeState);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('readNodeDriftState reads per-node file correctly', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-per-node-read');
    const stateDir = path.join(tmpDir, '.drift-state', 'cli', 'commands');
    await mkdir(stateDir, { recursive: true });

    const nodeState = { hash: 'def456', files: { 'src/cmd.ts': 'def456' }, mtimes: { 'src/cmd.ts': 1234567890 } };
    await writeFile(path.join(stateDir, 'aspects.json'), JSON.stringify(nodeState), 'utf-8');

    const result = await readNodeDriftState(tmpDir, 'cli/commands/aspects');
    expect(result).toEqual(nodeState);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('readNodeDriftState returns undefined for missing file', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-per-node-missing');
    await mkdir(tmpDir, { recursive: true });

    const result = await readNodeDriftState(tmpDir, 'nonexistent/node');
    expect(result).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('readDriftState reads from per-node directory (multiple files)', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-per-node-dir');
    const dir1 = path.join(tmpDir, '.drift-state', 'cli', 'commands');
    const dir2 = path.join(tmpDir, '.drift-state', 'cli', 'core');
    await mkdir(dir1, { recursive: true });
    await mkdir(dir2, { recursive: true });

    const state1 = { hash: 'aaa', files: { 'src/a.ts': 'aaa' } };
    const state2 = { hash: 'bbb', files: { 'src/b.ts': 'bbb' } };
    await writeFile(path.join(dir1, 'aspects.json'), JSON.stringify(state1), 'utf-8');
    await writeFile(path.join(dir2, 'loader.json'), JSON.stringify(state2), 'utf-8');

    const result = await readDriftState(tmpDir);
    expect(result['cli/commands/aspects']).toEqual(state1);
    expect(result['cli/core/loader']).toEqual(state2);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writeNodeDriftState pretty-prints JSON', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-per-node-pretty');
    await mkdir(tmpDir, { recursive: true });

    const nodeState = { hash: 'abc123', files: { 'src/test.ts': 'abc123' } };
    await writeNodeDriftState(tmpDir, 'test/node', nodeState);

    const content = await readFile(
      path.join(tmpDir, '.drift-state', 'test', 'node.json'),
      'utf-8',
    );
    // Pretty-printed JSON contains newlines
    expect(content).toContain('\n');
    // Ends with trailing newline
    expect(content.endsWith('\n')).toBe(true);
    // 2-space indentation
    expect(content).toContain('  "hash"');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('garbageCollectDriftState removes orphaned files, keeps valid ones', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-gc');
    const dir1 = path.join(tmpDir, '.drift-state', 'cli', 'commands');
    const dir2 = path.join(tmpDir, '.drift-state', 'cli', 'core');
    await mkdir(dir1, { recursive: true });
    await mkdir(dir2, { recursive: true });

    await writeFile(path.join(dir1, 'aspects.json'), '{"hash":"a","files":{}}', 'utf-8');
    await writeFile(path.join(dir1, 'orphan.json'), '{"hash":"b","files":{}}', 'utf-8');
    await writeFile(path.join(dir2, 'loader.json'), '{"hash":"c","files":{}}', 'utf-8');

    const validPaths = new Set(['cli/commands/aspects', 'cli/core/loader']);
    const removed = await garbageCollectDriftState(tmpDir, validPaths);

    expect(removed).toEqual(['cli/commands/orphan']);

    // Valid files still exist
    const kept1 = await readFile(path.join(dir1, 'aspects.json'), 'utf-8');
    expect(kept1).toBeTruthy();
    const kept2 = await readFile(path.join(dir2, 'loader.json'), 'utf-8');
    expect(kept2).toBeTruthy();

    // Orphaned file removed
    await expect(readFile(path.join(dir1, 'orphan.json'), 'utf-8')).rejects.toThrow();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('garbageCollectDriftState removes empty parent directories after GC', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-gc-dirs');
    const orphanDir = path.join(tmpDir, '.drift-state', 'orphan', 'deep');
    const validDir = path.join(tmpDir, '.drift-state', 'valid');
    await mkdir(orphanDir, { recursive: true });
    await mkdir(validDir, { recursive: true });

    await writeFile(path.join(orphanDir, 'node.json'), '{"hash":"x","files":{}}', 'utf-8');
    await writeFile(path.join(validDir, 'node.json'), '{"hash":"y","files":{}}', 'utf-8');

    const validPaths = new Set(['valid/node']);
    const removed = await garbageCollectDriftState(tmpDir, validPaths);

    expect(removed).toEqual(['orphan/deep/node']);

    // The orphan/deep directory and orphan directory should be removed
    const { stat: fsStat } = await import('node:fs/promises');
    await expect(fsStat(orphanDir)).rejects.toThrow();
    await expect(fsStat(path.join(tmpDir, '.drift-state', 'orphan'))).rejects.toThrow();

    // The valid directory should still exist
    const validStat = await fsStat(validDir);
    expect(validStat.isDirectory()).toBe(true);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('readDriftState ignores non-json files in drift-state directory', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-non-json');
    const driftDir = path.join(tmpDir, '.drift-state');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(driftDir, { recursive: true });

    // Write a .json file (should be read) and a non-.json file (should be skipped)
    await writeFile(path.join(driftDir, 'valid-node.json'), '{"hash":"aaa","files":{}}', 'utf-8');
    await writeFile(path.join(driftDir, 'readme.txt'), 'not a drift state file', 'utf-8');

    const result = await readDriftState(tmpDir);
    expect(Object.keys(result)).toEqual(['valid-node']);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('readDriftState skips corrupt json files gracefully', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-corrupt');
    const driftDir = path.join(tmpDir, '.drift-state');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(driftDir, { recursive: true });

    // Write a corrupt JSON file
    await writeFile(path.join(driftDir, 'corrupt-node.json'), 'not valid json{{{', 'utf-8');
    // Write a valid JSON file
    await writeFile(path.join(driftDir, 'good-node.json'), '{"hash":"bbb","files":{}}', 'utf-8');

    const result = await readDriftState(tmpDir);
    // Corrupt file should be skipped (readNodeDriftState returns undefined)
    expect(result['corrupt-node']).toBeUndefined();
    expect(result['good-node']).toEqual({ hash: 'bbb', files: {} });

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('garbageCollectDriftState handles non-existent drift-state directory', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-gc-nodir');
    await mkdir(tmpDir, { recursive: true });

    const removed = await garbageCollectDriftState(tmpDir, new Set());
    expect(removed).toEqual([]);

    await rm(tmpDir, { recursive: true, force: true });
  });

});
