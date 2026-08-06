/**
 * REGRESSION: a `per: file` companion.mjs rule with N subjects on one node,
 * whose relation target maps M files, used to re-parse that node's own mapping
 * AND the relation target's mapped files on EVERY one of those N subject
 * resolutions — buildUnitCtx (structure/hook-loader.ts) prewarms both sets
 * before the hook body ever runs, so the waste reproduces even with a no-op
 * companion — and discarded every re-parse the moment each call returned
 * (resolveCompanionsForPair, core/companion-resolve.ts, built its own
 * throwaway parse cache per call). Sharing ONE parse cache across every
 * subject of the same (aspect, node) collapses that to one parse per distinct
 * file, with byte-identical resolved companions and observations either way.
 *
 * This repository ships zero companion hooks, so none of this reproduces
 * against its own graph — the fixture below is purpose-built. Only `parseFile`
 * is replaced (a call counter around a pure function, delegating to the real
 * implementation); the whole graph, fixture, and public entry point
 * (`resolveCompanionsForPair`, the exact function a shared cache was added to)
 * stay real. Mirrors the mocking shape of
 * tests/integration/relation-parse-infra-failclosed.test.ts.
 */
import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import path from 'node:path';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';

// Every parse this run performs is recorded here, by the path handed to the
// parser. The counter lives inside the module replacement rather than being
// read off a spy handle, so nothing outside the replacement ever holds a
// reference to the parse entry point — a tree it returns is owned by whoever
// asked for it, and that ownership must not be diluted by a test reaching for
// the same function to observe it.
const parsedPaths: string[] = [];

vi.mock('../../src/ast/parser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ast/parser.js')>();
  return {
    ...actual,
    parseFile: async (...args: Parameters<typeof actual.parseFile>) => {
      parsedPaths.push(args[0]);
      return actual.parseFile(...args);
    },
  };
});


// A second, independent call counter, at the actual disk-I/O boundary rather
// than an intermediate function: `readdir` (node:fs/promises) is what
// io/hash.ts's directory walk calls once per directory it visits, and — being
// a real module boundary crossed by an import, not an in-module function
// reference — a mock on it observes every caller regardless of which internal
// function does the calling, including a memoising wrapper co-located in the
// SAME file as the walk it wraps (io/hash.ts's enumerateNodeMappedFilesCached
// and expandMappingPathsWithinOwnGraph are one such same-file pair; a mock on
// either one's own export could never observe the other calling it locally).
// Counting calls to it (not parseFile) is what proves the node-path-keyed
// mapping-expansion cache: it collapses regardless of whether a shared PARSE
// cache is ever used, since it guards a DIFFERENT resource (the disk walk, not
// the AST parse).
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: vi.fn(actual.readdir),
  };
});

import { readdir } from 'node:fs/promises';
const mockReaddir = vi.mocked(readdir);

import { loadGraph } from '../../src/core/graph-loader.js';
import { computeExpectedPairs } from '../../src/core/pairs.js';
import { resolveCompanionsForPair } from '../../src/core/companion-resolve.js';
import { resetMappedFilesCache } from '../../src/io/hash.js';
import type { ExpectedPair } from '../../src/core/pairs.js';
import type { Graph, AspectDef } from '../../src/model/graph.js';

const REVIEWER_CONFIG =
  'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n        temperature: 0\n';

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/**
 * Node A maps `subjectCount` files under a `per: file` companion aspect and
 * declares a `uses` relation to node B, whose mapping (a directory) expands to
 * `targetFileCount` files. The companion touches every one of B's files'
 * `.content` (via ctx.graph) and returns `[]` — the resolved output is still
 * rich enough (observations fold a read: per touched file) to prove
 * byte-identical resolution with vs. without a shared parse cache, and the
 * prewarm that does the wasted parsing runs BEFORE the hook body regardless of
 * what the hook itself does.
 */
function buildParseCountFixture(root: string, subjectCount: number, targetFileCount: number): void {
  write(root, '.yggdrasil/yg-config.yaml', REVIEWER_CONFIG);
  write(
    root,
    '.yggdrasil/yg-architecture.yaml',
    'node_types:\n  module:\n    description: m\n    log_required: false\n    relations:\n      uses: [module]\n',
  );
  const aMapping = Array.from({ length: subjectCount }, (_, i) => `src/a/f${i + 1}.ts`);
  for (const [i, rel] of aMapping.entries()) write(root, rel, `export const a${i + 1} = ${i + 1};\n`);
  write(
    root,
    '.yggdrasil/model/A/yg-node.yaml',
    `name: A\ntype: module\ndescription: a\nmapping:\n${aMapping.map((m) => `  - ${m}`).join('\n')}\n` +
      `relations:\n  - type: uses\n    target: B\naspects:\n  - companion-noop\n`,
  );
  for (let i = 1; i <= targetFileCount; i++) write(root, `src/b/g${i}.ts`, `export const g${i} = ${i};\n`);
  write(root, '.yggdrasil/model/B/yg-node.yaml', 'name: B\ntype: module\ndescription: b\nmapping:\n  - src/b\n');
  write(
    root,
    '.yggdrasil/aspects/companion-noop/yg-aspect.yaml',
    'name: companion-noop\ndescription: rule\nreviewer:\n  type: llm\nstatus: enforced\nscope:\n  per: file\n',
  );
  write(root, '.yggdrasil/aspects/companion-noop/content.md', '# rule\nno-op\n');
  write(
    root,
    '.yggdrasil/aspects/companion-noop/companion.mjs',
    "export function companion(ctx) {\n" +
      "  const b = ctx.graph.node('B');\n" +
      "  for (const f of b.files) void f.content.length; // touch every target file's content\n" +
      "  return [];\n" +
      "}\n",
  );
}

/**
 * Node A maps `subjectCount` files under a `per: file` companion aspect and
 * declares a `uses` relation to node B, whose mapping is exactly ONE file. The
 * companion parses that one file with `ctx.parseAst` and returns its parsed
 * text as a descriptor label, so a test can tell whether a given resolution
 * saw the file's ORIGINAL or an EDITED content.
 */
function buildFreshnessFixture(root: string, subjectCount: number): void {
  write(root, '.yggdrasil/yg-config.yaml', REVIEWER_CONFIG);
  write(
    root,
    '.yggdrasil/yg-architecture.yaml',
    'node_types:\n  module:\n    description: m\n    log_required: false\n    relations:\n      uses: [module]\n',
  );
  const aMapping = Array.from({ length: subjectCount }, (_, i) => `src/a/f${i + 1}.ts`);
  for (const [i, rel] of aMapping.entries()) write(root, rel, `export const a${i + 1} = ${i + 1};\n`);
  write(
    root,
    '.yggdrasil/model/A/yg-node.yaml',
    `name: A\ntype: module\ndescription: a\nmapping:\n${aMapping.map((m) => `  - ${m}`).join('\n')}\n` +
      `relations:\n  - type: uses\n    target: B\naspects:\n  - companion-inspect\n`,
  );
  write(root, 'src/b/g1.ts', 'export const g1 = "ORIGINAL";\n');
  write(root, '.yggdrasil/model/B/yg-node.yaml', 'name: B\ntype: module\ndescription: b\nmapping:\n  - src/b/g1.ts\n');
  write(
    root,
    '.yggdrasil/aspects/companion-inspect/yg-aspect.yaml',
    'name: companion-inspect\ndescription: rule\nreviewer:\n  type: llm\nstatus: enforced\nscope:\n  per: file\n',
  );
  write(root, '.yggdrasil/aspects/companion-inspect/content.md', '# rule\ninspect\n');
  write(
    root,
    '.yggdrasil/aspects/companion-inspect/companion.mjs',
    "export function companion(ctx) {\n" +
      "  const b = ctx.graph.node('B');\n" +
      "  const g1 = b.files.find((f) => f.path === 'src/b/g1.ts');\n" +
      "  const tree = ctx.parseAst(g1, 'typescript');\n" +
      "  return [{ path: 'src/b/g1.ts', label: tree.rootNode.text }];\n" +
      "}\n",
  );
}

/**
 * Node A maps `subjectCount` files under a `per: file` companion aspect and
 * declares a `uses` relation to node B, whose mapping is a DIRECTORY (not a
 * single file) starting with exactly one file in it. The companion returns the
 * sorted, comma-joined list of B's mapped file paths as a descriptor label, so
 * a test can tell exactly which files a given resolution's directory walk saw.
 */
function buildDirectoryListingFixture(root: string, subjectCount: number): void {
  write(root, '.yggdrasil/yg-config.yaml', REVIEWER_CONFIG);
  write(
    root,
    '.yggdrasil/yg-architecture.yaml',
    'node_types:\n  module:\n    description: m\n    log_required: false\n    relations:\n      uses: [module]\n',
  );
  const aMapping = Array.from({ length: subjectCount }, (_, i) => `src/a/f${i + 1}.ts`);
  for (const [i, rel] of aMapping.entries()) write(root, rel, `export const a${i + 1} = ${i + 1};\n`);
  write(
    root,
    '.yggdrasil/model/A/yg-node.yaml',
    `name: A\ntype: module\ndescription: a\nmapping:\n${aMapping.map((m) => `  - ${m}`).join('\n')}\n` +
      `relations:\n  - type: uses\n    target: B\naspects:\n  - companion-list\n`,
  );
  write(root, 'src/b/g1.ts', 'export const g1 = 1;\n');
  write(root, '.yggdrasil/model/B/yg-node.yaml', 'name: B\ntype: module\ndescription: b\nmapping:\n  - src/b\n');
  write(
    root,
    '.yggdrasil/aspects/companion-list/yg-aspect.yaml',
    'name: companion-list\ndescription: rule\nreviewer:\n  type: llm\nstatus: enforced\nscope:\n  per: file\n',
  );
  write(root, '.yggdrasil/aspects/companion-list/content.md', '# rule\nlist\n');
  write(
    root,
    '.yggdrasil/aspects/companion-list/companion.mjs',
    "export function companion(ctx) {\n" +
      "  const b = ctx.graph.node('B');\n" +
      "  const listing = b.files.map((f) => f.path).sort().join(',');\n" +
      "  return [{ path: 'src/b/g1.ts', label: listing }];\n" +
      "}\n",
  );
}

async function companionPairsFor(graph: Graph, aspectId: string): Promise<ExpectedPair[]> {
  const { pairs } = await computeExpectedPairs(graph);
  return pairs
    .filter((p) => p.aspectId === aspectId)
    .sort((a, b) => (a.unitKey < b.unitKey ? -1 : a.unitKey > b.unitKey ? 1 : 0));
}

function aspectFor(graph: Graph, aspectId: string): AspectDef {
  const aspect = graph.aspects.find((a) => a.id === aspectId);
  if (!aspect) throw new Error(`fixture is missing aspect '${aspectId}'`);
  return aspect;
}

describe("companion parse-cache sharing across a per:file rule's subjects", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'yg-companion-parse-cache-'));
    parsedPaths.length = 0;
    mockReaddir.mockClear();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("resolving every subject collapses the relation target's mapping expansion to one disk walk total, independent of any parse cache", async () => {
    // This is the mapping-EXPANSION cache (change 1) — a distinct resource from
    // the parse cache (change 2) above. It collapses even with NO shared parse
    // cache passed, because it guards the directory-walk + .gitignore
    // evaluation a node's mapping goes through, not the AST parse.
    //
    // Isolated to B's (the relation target's) mapping specifically: A's own
    // mapping is ALSO re-expanded once per pair by a separate, pre-existing,
    // out-of-scope call site (core/pairs.ts's computeNodeMappedFiles, used by
    // resolveCompanionsForPair to decide whether the subject is narrower than
    // the full node mapping — unrelated to buildUnitCtx's own prewarm/ctx.graph
    // expansion and not part of this cache), so counting A's calls would
    // conflate the two. B's mapping is expanded ONLY from inside buildUnitCtx —
    // nothing outside it ever expands a relation target's mapping — so its
    // count is an uncontaminated measurement of this cache alone.
    const subjectCount = 5;
    const targetFileCount = 12;
    buildParseCountFixture(root, subjectCount, targetFileCount);
    const graph = await loadGraph(root);
    const projectRoot = path.dirname(graph.rootPath);
    const pairs = await companionPairsFor(graph, 'companion-noop');
    const aspect = aspectFor(graph, 'companion-noop');
    mockReaddir.mockClear();

    for (const pair of pairs) {
      const resolved = await resolveCompanionsForPair(graph, projectRoot, pair, aspect);
      expect(resolved.kind).toBe('ok');
    }

    const targetDir = path.join(projectRoot, 'src', 'b');
    const targetWalks = mockReaddir.mock.calls.filter(([dir]) => dir === targetDir);
    // B's directory is walked exactly ONCE across all five subjects — not once
    // per subject, and not twice per subject (it used to be expanded once to
    // pre-populate ctx.graph's node view and AGAIN, redundantly, in the AST
    // prewarm loop, within a SINGLE buildUnitCtx call).
    expect(targetWalks).toHaveLength(1);
  });

  it('without a shared cache, every subject independently re-parses the node\'s own files and every relation-target file', async () => {
    const subjectCount = 5;
    const targetFileCount = 12;
    buildParseCountFixture(root, subjectCount, targetFileCount);
    const graph = await loadGraph(root);
    const projectRoot = path.dirname(graph.rootPath);
    const pairs = await companionPairsFor(graph, 'companion-noop');
    expect(pairs).toHaveLength(subjectCount);
    const aspect = aspectFor(graph, 'companion-noop');

    for (const pair of pairs) {
      const resolved = await resolveCompanionsForPair(graph, projectRoot, pair, aspect);
      expect(resolved.kind).toBe('ok');
    }

    // Every one of the N subjects independently re-parsed all N of A's own
    // mapped files AND all M of B's relation-target files: N × (N + M) total
    // parses, not (N + M) — the N×M-shaped waste described in the defect (here
    // widened to also cover the node's own re-parsed mapping).
    expect(parsedPaths.length).toBe(subjectCount * (subjectCount + targetFileCount));
    for (let i = 1; i <= targetFileCount; i++) {
      const calls = parsedPaths.filter((p) => p === `src/b/g${i}.ts`);
      expect(calls).toHaveLength(subjectCount);
    }
  });

  it('sharing one parse cache across every subject collapses parsing to one pass per distinct file, with byte-identical resolved output', async () => {
    const subjectCount = 5;
    const targetFileCount = 12;
    buildParseCountFixture(root, subjectCount, targetFileCount);
    const graph = await loadGraph(root);
    const projectRoot = path.dirname(graph.rootPath);
    const pairs = await companionPairsFor(graph, 'companion-noop');
    const aspect = aspectFor(graph, 'companion-noop');

    // Baseline: resolve every subject independently (today's behavior — no
    // shared cache passed) and keep each resolved result for the equivalence
    // check below.
    const baseline = [];
    for (const pair of pairs) {
      baseline.push(await resolveCompanionsForPair(graph, projectRoot, pair, aspect));
    }
    parsedPaths.length = 0;

    // Now resolve the SAME subjects sharing ONE parse cache — exactly what
    // fill.ts's (aspectId, node) bucket now constructs and threads through.
    const sharedCache = new Map();
    const shared = [];
    for (const pair of pairs) {
      shared.push(await resolveCompanionsForPair(graph, projectRoot, pair, aspect, undefined, undefined, sharedCache));
    }

    // Every distinct file — N own-mapping files + M relation-target files — is
    // parsed exactly ONCE across the whole bucket, regardless of subject count.
    expect(parsedPaths.length).toBe(subjectCount + targetFileCount);
    for (let i = 1; i <= targetFileCount; i++) {
      expect(parsedPaths.filter((p) => p === `src/b/g${i}.ts`)).toHaveLength(1);
    }

    // The verdict-relevant output — resolved companions AND observations (the
    // read: entries the companion's content touches folded, per subject) — is
    // byte-identical whether or not the parse cache is shared. Skipping the
    // re-parse never changes what a check/companion observes.
    expect(shared).toEqual(baseline);
  });

  it("a relation-target file edited between two subjects sharing a bucket's cache is re-parsed with its current bytes, never served a stale tree", async () => {
    const subjectCount = 3;
    buildFreshnessFixture(root, subjectCount);
    const graph = await loadGraph(root);
    const projectRoot = path.dirname(graph.rootPath);
    const pairs = await companionPairsFor(graph, 'companion-inspect');
    expect(pairs).toHaveLength(subjectCount);
    const aspect = aspectFor(graph, 'companion-inspect');
    const sharedCache = new Map();

    const first = await resolveCompanionsForPair(graph, projectRoot, pairs[0], aspect, undefined, undefined, sharedCache);
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    expect(first.companions.promptCompanions[0]?.label).toContain('ORIGINAL');

    // Edit the relation-target file BETWEEN two subjects that share the SAME
    // parse cache — the constraint this change must never violate.
    writeFileSync(path.join(root, 'src/b/g1.ts'), 'export const g1 = "CHANGED";\n');

    const third = await resolveCompanionsForPair(graph, projectRoot, pairs[2], aspect, undefined, undefined, sharedCache);
    expect(third.kind).toBe('ok');
    if (third.kind !== 'ok') return;
    expect(third.companions.promptCompanions[0]?.label).toContain('CHANGED');
    expect(third.companions.promptCompanions[0]?.label).not.toContain('ORIGINAL');
  });

  it("a file added to a relation target's mapped directory stays invisible across subjects until the mapping-expansion cache is reset, then is picked up", async () => {
    const subjectCount = 3;
    buildDirectoryListingFixture(root, subjectCount);
    const graph = await loadGraph(root);
    const projectRoot = path.dirname(graph.rootPath);
    const pairs = await companionPairsFor(graph, 'companion-list');
    expect(pairs).toHaveLength(subjectCount);
    const aspect = aspectFor(graph, 'companion-list');

    const first = await resolveCompanionsForPair(graph, projectRoot, pairs[0], aspect);
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    expect(first.companions.promptCompanions[0]?.label).toBe('src/b/g1.ts');

    // A second file appears in B's mapped directory BETWEEN two subjects of the
    // SAME run — the directory walk that produced the first resolution's file
    // list is cached (keyed by node path), so this alone must NOT surface it.
    writeFileSync(path.join(root, 'src/b/g2.ts'), 'export const g2 = 2;\n');

    const second = await resolveCompanionsForPair(graph, projectRoot, pairs[1], aspect);
    expect(second.kind).toBe('ok');
    if (second.kind !== 'ok') return;
    expect(second.companions.promptCompanions[0]?.label).toBe('src/b/g1.ts');

    // Resetting the cache — exactly what the one long-lived caller (the portal,
    // on every refresh) does before re-deriving anything — makes the NEXT
    // expansion re-walk the directory and see the addition.
    resetMappedFilesCache();

    const third = await resolveCompanionsForPair(graph, projectRoot, pairs[2], aspect);
    expect(third.kind).toBe('ok');
    if (third.kind !== 'ok') return;
    expect(third.companions.promptCompanions[0]?.label).toBe('src/b/g1.ts,src/b/g2.ts');
  });
});
