/**
 * REGRESSION (C-0): a tree-sitter grammar that fails to LOAD during the relation
 * pass must FAIL CLOSED — it must NOT be silently swallowed into "this file has no
 * dependencies". tree-sitter is error-tolerant (it returns a tree with `hasError`
 * nodes for malformed source and never throws on bad syntax), so any exception
 * `parseFile` throws is by construction an INFRASTRUCTURE fault (missing/corrupt
 * WASM grammar, Parser.init()/Language.load() rejection, or parser.parse() returning
 * null). Before the fix, `parseSingle` caught it as `return null`, so an undeclared
 * cross-node dependency in an unparsable file went unreported and `yg check` exited
 * GREEN over code no reviewer ever analyzed — repo-wide for a whole language if that
 * language's grammar is missing.
 *
 * We simulate the ONE infrastructure fault that cannot be induced without corrupting
 * the global install (a missing/corrupt WASM grammar) by making `parseFile` throw a
 * resolveWasm-style error. Everything else is a REAL on-disk fixture graph + real
 * source files driven through the public `runCheck` entry point; `grammarWasmHash`
 * and every other parser export stay real. (The mock-free companion smoke test in
 * tests/unit/ast/grammar-registry-loads.test.ts proves the grammars actually load.)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Only `parseFile` is replaced — with a throw shaped exactly like resolveWasm's
// "missing WASM" error. tree-sitter never throws on malformed source, so this stands
// in for the real infrastructure fault the fix must catch. All other parser exports
// (grammarWasmHash, getParser, withParsedFile) remain the real implementations.
vi.mock('../../src/ast/parser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ast/parser.js')>();
  return {
    ...actual,
    parseFile: vi.fn(async (filePath: string) => {
      throw new Error(
        `Could not find WASM grammar tree-sitter-typescript.wasm in dist/grammars/ ` +
          `or in the tree-sitter-typescript package (probe: ${filePath}).`,
      );
    }),
  };
});

import { loadGraph } from '../../src/core/graph-loader.js';
import { runCheck } from '../../src/core/check.js';

function writeArch(root: string): void {
  mkdirSync(path.join(root, '.yggdrasil', 'model'), { recursive: true });
  writeFileSync(
    path.join(root, '.yggdrasil', 'yg-architecture.yaml'),
    `node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: "**"\n    relations:\n      uses: [service]\n`,
    'utf-8',
  );
  writeFileSync(
    path.join(root, '.yggdrasil', 'yg-config.yaml'),
    `quality:\n  max_direct_relations: 10\n`,
    'utf-8',
  );
}

function writeNode(root: string, nodeRel: string, yaml: string): void {
  const dir = path.join(root, '.yggdrasil', 'model', nodeRel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'yg-node.yaml'), yaml, 'utf-8');
}

function writeSrc(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

describe('relation conformance — grammar-load infra failure fails closed (C-0)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-infra-'));
    writeArch(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('surfaces a BLOCKING relation-parse-failed error instead of silently passing over the file', async () => {
    // node a imports node b across the boundary but declares NO relation → an
    // undeclared dependency a WORKING parser would refuse. Three .ts files fail
    // identically, exercising the per-language dedup (one issue, fileCount folded).
    writeNode(root, 'a', 'name: A\ntype: service\nmapping:\n  - src/a\n');
    writeNode(root, 'b', 'name: B\ntype: service\nmapping:\n  - src/b\n');
    writeSrc(root, 'src/a/foo.ts', "import { x } from '../b/bar.js';\nexport const foo = x;\n");
    writeSrc(root, 'src/a/baz.ts', 'export const baz = 2;\n');
    writeSrc(root, 'src/b/bar.ts', 'export const x = 1;\n');

    const graph = await loadGraph(root);
    const result = await runCheck(graph, null); // null git files → skip coverage

    // FAIL CLOSED: the grammar-load fault is a single blocking error (deduped per
    // language) that names the affected language and reflects every failed file.
    const parseFailed = result.issues.filter((i) => i.code === 'relation-parse-failed');
    expect(parseFailed).toHaveLength(1);
    expect(parseFailed[0].severity).toBe('error');
    expect(parseFailed[0].messageData.what).toContain('TypeScript');
    // All three .ts files (a/foo, a/baz, b/bar) fail identically → ONE deduped issue
    // whose scope reflects every affected file (the per-language fileCount increment).
    expect(parseFailed[0].messageData.what).toContain('3 TypeScript files');

    // The tell-tale of the OLD bug: because the file could not be parsed, no
    // cross-node dependency is detected, so a's undeclared import of b produces NO
    // relation-undeclared-dependency. Pre-fix this left the build GREEN over
    // unanalyzed code; the parse-failed error above is what now keeps it red.
    expect(
      result.issues.filter((i) => i.code === 'relation-undeclared-dependency'),
    ).toHaveLength(0);
  });

  it('names the single file directly when exactly one file of a language fails', async () => {
    writeNode(root, 'solo', 'name: Solo\ntype: service\nmapping:\n  - src/solo\n');
    writeSrc(root, 'src/solo/only.ts', 'export const only = 1;\n');

    const graph = await loadGraph(root);
    const result = await runCheck(graph, null);

    const parseFailed = result.issues.filter((i) => i.code === 'relation-parse-failed');
    expect(parseFailed).toHaveLength(1);
    expect(parseFailed[0].severity).toBe('error');
    // Single-file scope: the message names the file directly (no "N files" phrasing).
    expect(parseFailed[0].messageData.what).toContain('src/solo/only.ts');
    expect(parseFailed[0].messageData.what).not.toContain('files, e.g.');
  });
});
