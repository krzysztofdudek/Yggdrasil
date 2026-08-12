/**
 * Live type-to-type relation gate (coverage.type_level's import-edge check) — fixture-
 * driven integration tests via runCheck on the dedicated tests/fixtures/type-relation-gate/
 * fixture (a NEW, self-contained fixture; tests/fixtures/type-coverage-basic/ is never
 * touched by this suite — its own golden-pinned facts belong to type-coverage.test.ts).
 *
 * Case matrix (see the fixture's own yg-architecture.yaml comment for the full layout):
 *   - svc -> owner-type (handler.ts -> target.ts): FORBIDDEN. svc has a deny-default
 *     relations table (calls: [util]) that does not list owner-type.
 *   - svc -> util (handler.ts -> plain-util.ts): ALLOWED. Explicitly listed in svc's
 *     calls: [util].
 *   - util -> owner-type (plain-util.ts -> target.ts): ALLOWED. util has NO relations
 *     table at all, so its outgoing edges are a vacuous allow.
 *   - an edge into the deliberately ambiguous src/svc/ambiguous.ts: NOT gated at all —
 *     ambiguous/unmatched files are excluded from the typed-edge index at the source.
 *   - flag-off (coverage.typeLevel: false): the gate produces zero findings and never
 *     even parses a type-covered-only file.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, cpSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { runCheck, scanUncoveredFiles } from '../../../src/core/check.js';
import { walkRepoFiles } from '../../../src/io/repo-scanner.js';
import { computeTypeCoverage } from '../../../src/core/type-coverage.js';
import { FileContentCache } from '../../../src/io/file-content-cache.js';
import { runRelationPass } from '../../../src/relations/pass.js';
import { extractorForLanguage } from '../../../src/relations/extractors/registry.js';
import { makeResolvePathToFile } from '../../../src/relations/resolve-path.js';
import { astCacheDir } from '../../../src/relations/facts-cache.js';
import { buildOwnerIndex } from '../../../src/relations/owner-index.js';

// node:fs/promises' named exports are non-configurable in real Node ESM (vi.spyOn cannot
// redefine them directly), so the read-cost tests below track calls through a partial
// mock instead: wrap ONLY readFile in a vi.fn that still delegates to the real
// implementation (every other export, and readFile's own behavior, is untouched — this is
// a call-tracking wrapper, not a behavior fake).
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
import { readFile } from 'node:fs/promises';
const mockReadFile = vi.mocked(readFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-relation-gate');

let tmpDirs: string[] = [];
function copyFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-type-relation-gate-'));
  cpSync(FIXTURE, dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

describe('live type-relation gate — fixture rows', () => {
  it('deny-default table blocks svc -> owner-type (handler.ts -> target.ts, not in calls: [util])', async () => {
    const dir = copyFixture();
    const graph = await loadGraph(dir);
    const files = await walkRepoFiles(dir);
    const result = await runCheck(graph, files);
    const finding = result.issues.find(
      (i) => i.code === 'type-relation-forbidden' && i.messageData.what.includes('svc') && i.messageData.what.includes('owner-type'),
    );
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('error');
    expect(finding!.messageData.what).toContain('handler.ts');
    expect(finding!.messageData.what).toContain('target.ts');
    // Structured identity: the concrete forbidden edge, not just prose — an
    // aggregate finding (per type-pair) needs the full edge list attached.
    expect(finding!.relationEdges).toEqual([
      { fromFile: 'src/svc/handler.ts', toFile: 'src/owner/target.ts' },
    ]);
  });

  it('an EXPLICIT allow entry permits svc -> util (handler.ts -> plain-util.ts, listed in calls: [util])', async () => {
    const dir = copyFixture();
    const graph = await loadGraph(dir);
    const files = await walkRepoFiles(dir);
    const result = await runCheck(graph, files);
    const findings = result.issues.filter((i) => i.code === 'type-relation-forbidden');
    expect(findings.some((f) => f.messageData.what.includes('handler.ts') && f.messageData.what.includes('plain-util.ts'))).toBe(false);
  });

  it('an ABSENT relations table on the source type is a VACUOUS allow (plain-util.ts -> target.ts, util has no relations table at all)', async () => {
    const dir = copyFixture();
    const graph = await loadGraph(dir);
    const files = await walkRepoFiles(dir);
    const result = await runCheck(graph, files);
    const findings = result.issues.filter((i) => i.code === 'type-relation-forbidden');
    expect(findings.some((f) => f.messageData.what.includes('plain-util.ts') && f.messageData.what.includes('target.ts'))).toBe(false);
  });

  it('an edge into the AMBIGUOUS file (handler.ts -> ambiguous.ts) is NOT gated at all', async () => {
    const dir = copyFixture();
    const graph = await loadGraph(dir);
    const files = await walkRepoFiles(dir);
    const result = await runCheck(graph, files);
    const findings = result.issues.filter((i) => i.code === 'type-relation-forbidden');
    expect(findings.every((f) => !f.messageData.what.includes('ambiguous.ts'))).toBe(true);
    // ambiguous-node-type still fires independently for ambiguous.ts itself — this row
    // proves the two mechanisms don't double-report the same file.
    expect(result.issues.some((i) => i.code === 'ambiguous-node-type')).toBe(true);
  });

  it('flag-off: coverage.typeLevel false -> the gate does not exist (zero type-relation-forbidden issues)', async () => {
    const dir = copyFixture();
    const graphOn = await loadGraph(dir);
    const graphOff = { ...graphOn, config: { ...graphOn.config, coverage: { ...graphOn.config.coverage!, typeLevel: false } } };
    const files = await walkRepoFiles(dir);
    const result = await runCheck(graphOff, files);
    expect(result.issues.some((i) => i.code === 'type-relation-forbidden')).toBe(false);
  });

  it('derived edges never trip port machinery — a ported target reached only via a DERIVED edge triggers no port-missing-consumes and no port-aspect delivery', async () => {
    const dir = copyFixture();
    const graph = await loadGraph(dir);
    const files = await walkRepoFiles(dir);
    const result = await runCheck(graph, files);
    // The gate's OWN verdict on this edge still fires — svc -> owner-type is forbidden
    // (same row as the deny-default test above), proving the gate is unaffected by the
    // port living on the very same target node.
    const forbidden = result.issues.find(
      (i) => i.code === 'type-relation-forbidden' && i.messageData.what.includes('svc') && i.messageData.what.includes('owner-type'),
    );
    expect(forbidden).toBeDefined();
    // Port-contract machinery reads ONLY a node's own declared relations
    // (graph.nodes[*].meta.relations); this fixture declares none against the owner
    // node's port, so a derived (never-declared) edge is invisible to it by
    // construction — not a special case the gate's own code had to add.
    expect(result.issues.some((i) => i.code === 'port-missing-consumes')).toBe(false);
    expect(result.issues.some((i) => i.code === 'port-undefined')).toBe(false);
    expect(result.issues.some((i) => i.code === 'port-missing-aspect')).toBe(false);
  });

  it('at flag-off, runRelationPass never receives/parses the extra type-covered files (enumeration itself is gated, not just the gate decision)', async () => {
    const dir = copyFixture();
    const graphOn = await loadGraph(dir);
    const graphOff = { ...graphOn, config: { ...graphOn.config, coverage: { ...graphOn.config.coverage!, typeLevel: false } } };
    // plain-util.ts ONLY exists in the type-covered universe (never node-mapped) — at
    // flag-off it must never be read/parsed at all.
    mockReadFile.mockClear();
    const files = await walkRepoFiles(dir);
    await runCheck(graphOff, files);
    const readPlainUtil = mockReadFile.mock.calls.some(([p]) => String(p).includes('plain-util.ts'));
    expect(readPlainUtil).toBe(false);
  });

  it('nested-graph subtrees are excluded from the gate enumeration even at flag-on', async () => {
    // Reuses the SAME walk exclusions walkRepoFiles already applies (excludeNestedGraphSubtrees,
    // the top-level .yggdrasil/ skip) — the type-covered file list fed into
    // runRelationPass is DERIVED from walkRepoFiles output (via computeTypeCoverage's
    // `covered` map), never a second, independent enumeration, so this exclusion is inherited
    // by construction. This test is a REGRESSION PIN against a future refactor accidentally
    // reintroducing a parallel file walk, not a fresh mechanism.
    const dir = copyFixture();
    // Nest the subtree UNDER src/svc/ (not anywhere else) so its relative path WOULD match
    // svc's when: "src/svc/**" if the nested-graph exclusion did not apply — a nested
    // subtree placed somewhere the fixture's types don't reach would prove nothing.
    const nestedYggDir = path.join(dir, 'src', 'svc', 'vendored', '.yggdrasil');
    mkdirSync(nestedYggDir, { recursive: true });
    writeFileSync(path.join(nestedYggDir, 'yg-config.yaml'), 'version: "5.2.0"\n');
    const nestedFile = path.join(dir, 'src', 'svc', 'vendored', 'nested-handler.ts');
    writeFileSync(nestedFile, "import { ownerThing } from '../../owner/target.ts';\n");

    const graph = await loadGraph(dir);
    mockReadFile.mockClear();
    const files = await walkRepoFiles(dir); // already excludes nested-graph subtrees, by construction
    const result = await runCheck(graph, files);

    const readNested = mockReadFile.mock.calls.some(([p]) => String(p).includes('nested-handler.ts'));
    expect(readNested).toBe(false); // never parsed — excluded upstream by walkRepoFiles,
                                     // before computeTypeCoverage or the relation pass ever see it
    const mentionsNested = result.issues.some((i) => i.messageData.what.includes('nested-handler.ts'));
    expect(mentionsNested).toBe(false); // never appears in any finding's edge list either
  });
});

// ── Direct tests of the public TypedEdgeIndex surface ────────────────────────
//
// The gate-finding tests above only ever observe TypedEdgeIndex through
// computeTypeGateFindings' own aggregation. This test instead reads
// runRelationPass's `typedEdges` field directly — pinning the exact edge set
// the live pass produces for a real, parsed file, independent of how the gate
// happens to consume it.
describe('runRelationPass.typedEdges — direct surface', () => {
  /** The SAME covered map core/check.ts's earlyTypeCoverage assembles: every
   *  uncovered file's matched classifying type. */
  async function computeCovered(dir: string) {
    const graph = await loadGraph(dir);
    const files = await walkRepoFiles(dir);
    const uncovered = scanUncoveredFiles(graph, files);
    const typeCoverage = await computeTypeCoverage(graph, uncovered, new FileContentCache());
    return { graph, covered: typeCoverage.covered };
  }

  it("runRelationPass(...).typedEdges.edgesFrom('src/svc/handler.ts') carries exactly the forbidden and allowed edges, and NOTHING for the ambiguous file (exclusion pinned at the SOURCE)", async () => {
    const dir = copyFixture();
    const { graph, covered } = await computeCovered(dir);
    const projectRoot = path.dirname(graph.rootPath);
    const result = await runRelationPass(graph, projectRoot, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: makeResolvePathToFile(projectRoot, buildOwnerIndex(graph.nodes).ownerOf),
      symbolIndexDir: astCacheDir(graph.rootPath),
      typeCoveredFiles: covered,
    });

    const edges = result.typedEdges.edgesFrom('src/svc/handler.ts');
    expect(edges).toEqual(
      expect.arrayContaining([
        { toFile: 'src/owner/target.ts', toOwner: { kind: 'node', path: 'owner', type: 'owner-type' } },
        { toFile: 'src/util/plain-util.ts', toOwner: { kind: 'type-covered', type: 'util' } },
      ]),
    );
    // Exactly those two — no ambiguous.ts entry, no phantom third edge.
    expect(edges).toHaveLength(2);
    expect(edges.some((e) => e.toFile.includes('ambiguous'))).toBe(false);
  });
});
