import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGraph } from '../../src/core/graph-loader.js';

// NOTE: the original "4.2.0 → 4.3.0 migration end-to-end" test exercised a
// REGISTERED 4.3.0 migration (and the rest of the chain to 5.0.0). The
// verdict-lock redesign removed every legacy migration module — the registry is
// now empty (design §13) — so there is no 4.3.0 migration to drive end-to-end.
// The empty-registry version-lift contract is covered by
// migration-framework.test.ts. What remains here is the loader's schema-version
// gate, which is independent of any migration and still load-bearing.

describe('schema-version load gate', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'mig-load-gate-'));
    mkdirSync(join(repo, '.yggdrasil', 'model', 'foo'), { recursive: true });
    writeFileSync(
      join(repo, '.yggdrasil', 'yg-architecture.yaml'),
      'node_types:\n  module:\n    description: "Grouping"\n',
    );
    writeFileSync(
      join(repo, '.yggdrasil', 'model', 'foo', 'yg-node.yaml'),
      'name: foo\ndescription: "test"\ntype: module\nmapping:\n  - src/foo.ts\n',
    );
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'foo.ts'), '');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('refuse-load triggers when config schema version is above what this CLI supports', async () => {
    writeFileSync(join(repo, '.yggdrasil', 'yg-config.yaml'), 'version: "7.0.0"\n');
    // A too-new schema version is an expected user error (upgrade the CLI), thrown as
    // UnsupportedSchemaVersionError; the "upgrade CLI" guidance now lives in the
    // command-layer presentation, not the loader's message.
    await expect(loadGraph(repo)).rejects.toThrow(/newer than this CLI supports/i);
  });
});
