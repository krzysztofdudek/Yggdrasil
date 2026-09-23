/**
 * Unit tests for three of this repo's own node-level deterministic rules whose
 * checks need graph context a single-file drill cannot supply (they are
 * drill-exempt for that reason). Each rule's REAL check.mjs is imported and
 * driven with a hand-built ctx, so an edit to the rule is exercised here.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// tests/unit/repo → repo root is five levels up: repo/unit/tests/cli/source.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
// A rule script that imports `@chrisdudek/yg/ast` resolves it only from inside the
// source/cli package (its own `exports` self-reference), so each real check.mjs is
// copied into a gitignored temp directory there before it is imported.
const TMP_ROOT = mkdtempSync(path.resolve(__dirname, '../../fixtures/.tmp-self-governance-'));
afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }));

type Violation = { file?: string; message: string; kind?: string };
type CheckFn = (ctx: unknown) => Violation[] | Promise<Violation[]>;

async function loadCheck(aspectId: string): Promise<CheckFn> {
  const dst = path.join(TMP_ROOT, aspectId, 'check.mjs');
  mkdirSync(path.dirname(dst), { recursive: true });
  copyFileSync(path.join(REPO_ROOT, '.yggdrasil', 'aspects', aspectId, 'check.mjs'), dst);
  const mod = (await import(pathToFileURL(dst).href)) as { check: CheckFn };
  return mod.check;
}

interface FakeNode {
  id: string;
  files: { path: string }[];
  children: FakeNode[];
}

function fakeGraph(nodes: FakeNode[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return {
    node(id: string) {
      const n = byId.get(id);
      if (!n) throw new Error(`no relation to '${id}'`);
      return n;
    },
    children(n: FakeNode) {
      return n.children;
    },
  };
}

describe('sibling-test-file judges every command file of a node', () => {
  const testsNode = (paths: string[]): FakeNode => ({
    id: 'cli/tests/unit/cli',
    files: paths.map((p) => ({ path: p })),
    children: [],
  });

  it('flags the second file of a two-file command node when only the first has a test', async () => {
    const check = await loadCheck('sibling-test-file');
    const ctx = {
      node: {
        id: 'cli/commands/drill',
        files: [{ path: 'source/cli/src/cli/drill-add.ts' }, { path: 'source/cli/src/cli/drill.ts' }],
      },
      graph: fakeGraph([testsNode(['source/cli/tests/unit/cli/drill-add.test.ts'])]),
    };
    const violations = await check(ctx);
    expect(violations.map((v) => v.file)).toEqual(['source/cli/src/cli/drill.ts']);
    expect(violations[0].kind).toBe('missing-test-sibling');
  });

  it('is satisfied when every command file of the node has its sibling test', async () => {
    const check = await loadCheck('sibling-test-file');
    const ctx = {
      node: {
        id: 'cli/commands/aspects',
        files: [{ path: 'source/cli/src/cli/aspects-log.ts' }, { path: 'source/cli/src/cli/aspects.ts' }],
      },
      graph: fakeGraph([
        testsNode(['source/cli/tests/unit/cli/aspects-log.test.ts', 'source/cli/tests/unit/cli/aspects.test.ts']),
      ]),
    };
    expect(await check(ctx)).toEqual([]);
  });
});

describe('portal/count-parity-via-reuse keys its positive arm on the node type and fails closed', () => {
  // Files without a parsed tree: the negative arms see nothing, so every result
  // below comes from the positive (reuse-manifest) arm alone.
  const files = [{ path: 'source/cli/src/portal/facade.ts', ast: null }];

  it('requires runCheck and computeExpectedPairs from an engine-facade node whatever its id', async () => {
    const check = await loadCheck('portal/count-parity-via-reuse');
    const violations = await check({ node: { id: 'cli/portal/renamed-facade', type: 'portal-engine-api' }, files });
    const messages = violations.map((v) => v.message).join('\n');
    expect(violations).toHaveLength(2);
    expect(messages).toContain("'runCheck'");
    expect(messages).toContain("'computeExpectedPairs'");
  });

  it('asks nothing extra of a pipeline node, which reaches the engine through the facade', async () => {
    const check = await loadCheck('portal/count-parity-via-reuse');
    expect(await check({ node: { id: 'cli/portal/pipeline', type: 'portal-pipeline' }, files })).toEqual([]);
  });

  it('refuses a node whose type the manifest does not know', async () => {
    const check = await loadCheck('portal/count-parity-via-reuse');
    const violations = await check({ node: { id: 'cli/portal/new-thing', type: 'portal-server' }, files });
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain("type 'portal-server'");
  });

  it('skips the positive arm for a file with no owning node', async () => {
    const check = await loadCheck('portal/count-parity-via-reuse');
    expect(await check({ files })).toEqual([]);
  });
});
