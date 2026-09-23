/**
 * `yg aspect-test --file <path>` target classification —
 * core/aspect-test-file-target.ts.
 *
 * Driven against the real committed fixture tests/fixtures/type-coverage-basic/
 * (copied per test, never mutated in place), whose five uncovered files land in
 * one lattice row each: handler.ts covered by `svc`, overlap.ts ambiguous
 * between `svc` and `util`, special.ts claimed by the strict `special`, plain.ts
 * matching nothing, and vendor/tool.ts under a coverage.excluded root. Each row
 * must come back as the refusal (or the success) that names what to do next —
 * the reason a reader gets when `--file` cannot address a path is the whole
 * value of this module. No mocking: the graph is loaded for real and every file
 * is read from disk.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadGraph } from '../../../src/core/graph-loader.js';
import {
  classifyAspectTestFileTarget,
  computeTypeCoverageForAspectTest,
} from '../../../src/core/aspect-test-file-target.js';
import type { Graph } from '../../../src/model/graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '../../fixtures/type-coverage-basic');

let tmpDirs: string[] = [];

function copyFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-aspect-test-file-'));
  cpSync(FIXTURE, dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

/** The same loaded graph with coverage.type_level flipped in memory — the flag-off twin. */
function withTypeLevel(graph: Graph, typeLevel: boolean): Graph {
  return { ...graph, config: { ...graph.config, coverage: { ...graph.config.coverage!, typeLevel } } };
}

async function refusal(dir: string, file: string, graph?: Graph): Promise<{ what: string; why: string; next: string }> {
  const target = await classifyAspectTestFileTarget(graph ?? (await loadGraph(dir)), dir, file);
  if (target.kind !== 'refused') throw new Error(`expected a refusal for ${file}, got ${target.kind}`);
  return target.messageData;
}

describe('computeTypeCoverageForAspectTest', () => {
  it('is undefined with coverage.type_level off, so callers enumerate the component-only universe', async () => {
    const dir = copyFixture();
    const graph = withTypeLevel(await loadGraph(dir), false);
    expect(await computeTypeCoverageForAspectTest(graph, dir)).toBeUndefined();
  });

  it('classifies the uncovered files once: covered by type, ambiguous paths listed apart', async () => {
    const dir = copyFixture();
    const result = await computeTypeCoverageForAspectTest(await loadGraph(dir), dir);
    expect(result).toBeDefined();
    expect(result!.covered.get('src/svc/handler.ts')).toBe('svc');
    expect(result!.covered.has('src/svc/overlap.ts')).toBe(false);
    expect(result!.ambiguousPaths).toEqual(['src/svc/overlap.ts']);
  });
});

describe('classifyAspectTestFileTarget', () => {
  it('addresses a file covered by exactly one non-strict type, with that type and its classification', async () => {
    const dir = copyFixture();
    const target = await classifyAspectTestFileTarget(await loadGraph(dir), dir, 'src/svc/handler.ts');
    expect(target.kind).toBe('ok');
    if (target.kind !== 'ok') return;
    expect(target.file).toBe('src/svc/handler.ts');
    expect(target.typeId).toBe('svc');
    expect(target.typeCoverage.covered.get('src/svc/handler.ts')).toBe('svc');
    expect(target.typeCoverage.ambiguousPaths).toEqual(['src/svc/overlap.ts']);
    // svc declares no relations, so a file of that type may reach nothing beyond itself.
    expect(target.allowedReads.filter((p) => p !== 'src/svc/handler.ts')).toEqual([]);
  });

  it('refuses every path while type-level coverage is off, naming the flag', async () => {
    const dir = copyFixture();
    const graph = withTypeLevel(await loadGraph(dir), false);
    const msg = await refusal(dir, 'src/svc/handler.ts', graph);
    expect(msg.what).toBe("'src/svc/handler.ts' cannot be addressed by --file — type-level coverage is off.");
    expect(msg.next).toContain('Enable coverage.type_level');
  });

  it('refuses a path under a coverage.excluded root even though a type matches it', async () => {
    const dir = copyFixture();
    const msg = await refusal(dir, 'vendor/tool.ts');
    expect(msg.what).toBe("'vendor/tool.ts' is excluded from coverage.");
    expect(msg.next).toContain('coverage.excluded');
  });

  it('refuses an ambiguous file, naming every type it matches', async () => {
    const dir = copyFixture();
    const msg = await refusal(dir, 'src/svc/overlap.ts');
    expect(msg.what).toBe("'src/svc/overlap.ts' is ambiguous: it matches 2 architecture types (svc, util).");
    expect(msg.why).toContain('EXACTLY one non-strict architecture type');
    expect(msg.next).toContain('Narrow the architecture');
  });

  it('refuses a file a strict type claims, pointing at a node mapping instead', async () => {
    const dir = copyFixture();
    const msg = await refusal(dir, 'src/util/special.ts');
    expect(msg.what).toBe("'src/util/special.ts' matches strict type 'special', which requires an explicit node mapping, not --file addressing.");
    expect(msg.next).toBe("Map this file to a node of type 'special' and use --node.");
  });

  it('refuses a file no type matches', async () => {
    const dir = copyFixture();
    const msg = await refusal(dir, 'src/misc/plain.ts');
    expect(msg.what).toBe("'src/misc/plain.ts' matches no architecture type.");
    expect(msg.next).toContain('add a matching type to yg-architecture.yaml');
  });

  it('refuses a file too large to classify, saying why rather than calling it unmatched', async () => {
    const dir = copyFixture();
    // Over the 5MB content-scan limit, so the content-only `big` type cannot be evaluated.
    writeFileSync(path.join(dir, 'src', 'huge.ts'), Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));
    const msg = await refusal(dir, 'src/huge.ts');
    expect(msg.what).toMatch(/^'src\/huge\.ts' could not be classified: .*5MB/);
    expect(msg.next).toContain('--files');
  });
});
