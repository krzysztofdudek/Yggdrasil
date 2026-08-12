import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadGraph } from '../../src/core/graph-loader.js';
import { runCheck } from '../../src/core/check.js';
import {
  readGitCommitRef,
  computePortalLockHash,
  computePortalFreshness,
  computePortalSourceFileCounts,
  runPortalCheck,
} from '../../src/portal/engine-api.js';
import { readRulesArtifacts } from '../../src/cli/rules-artifacts.js';
import type { LockFile } from '../../src/model/lock.js';

/**
 * Branch coverage for the Phase-5 facade provenance + freshness readers, against REAL on-disk
 * `.git` layouts and a REAL fixture graph (no mocking). The git-ref reader is a pure read over a
 * real `.git` directory we build on disk — every resolution path (detached HEAD / loose ref /
 * packed-refs / non-git / malformed / dangling ref) is exercised by a real directory shape. The
 * freshness reader is driven against the real portal-basic graph with a hand-built lock that
 * pins the baseline branches (no committed baseline, a stale baseline, a mapping-less baseline).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASIC_FIXTURE = path.resolve(__dirname, '../fixtures/portal-basic');
const RUNCHECK_PARITY_FIXTURE = path.resolve(__dirname, '../fixtures/runcheck-parity');

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
// SHA-256 object ids (64 hex chars) — `git init --object-format=sha256` repos.
const SHA256 = 'c'.repeat(64);
const SHA256_2 = 'd'.repeat(64);

describe('readGitCommitRef — every .git resolution path (real on-disk layouts)', () => {
  it('reads a detached HEAD (the sha held directly in HEAD)', () => {
    const root = tmp('yg-git-detached-');
    mkdirSync(path.join(root, '.git'), { recursive: true });
    writeFileSync(path.join(root, '.git', 'HEAD'), SHA + '\n');
    expect(readGitCommitRef(root)).toBe(SHA);
  });

  it('follows a symbolic HEAD to a loose ref file', () => {
    const root = tmp('yg-git-loose-');
    mkdirSync(path.join(root, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(path.join(root, '.git', 'refs', 'heads', 'main'), SHA2 + '\n');
    expect(readGitCommitRef(root)).toBe(SHA2);
  });

  it('falls back to packed-refs when the loose ref is absent', () => {
    const root = tmp('yg-git-packed-');
    mkdirSync(path.join(root, '.git'), { recursive: true });
    writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(
      path.join(root, '.git', 'packed-refs'),
      `# pack-refs with: peeled fully-peeled sorted\n${SHA} refs/heads/main\n${SHA2} refs/heads/other\n`,
    );
    expect(readGitCommitRef(root)).toBe(SHA);
  });

  it('returns null for a non-git directory (no fabrication)', () => {
    const root = tmp('yg-git-none-');
    expect(readGitCommitRef(root)).toBeNull();
  });

  it('returns null for a malformed HEAD (neither a sha nor a ref:)', () => {
    const root = tmp('yg-git-bad-');
    mkdirSync(path.join(root, '.git'), { recursive: true });
    writeFileSync(path.join(root, '.git', 'HEAD'), 'garbage not a ref\n');
    expect(readGitCommitRef(root)).toBeNull();
  });

  it('returns null for a symbolic HEAD whose ref resolves nowhere (no loose, no packed match)', () => {
    const root = tmp('yg-git-dangling-');
    mkdirSync(path.join(root, '.git'), { recursive: true });
    writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/missing\n');
    // A packed-refs that does NOT list the wanted ref — the reader exhausts it and returns null.
    writeFileSync(path.join(root, '.git', 'packed-refs'), `${SHA} refs/heads/elsewhere\n`);
    expect(readGitCommitRef(root)).toBeNull();
  });

  it('resolves a LINKED WORKTREE — `.git` is a `gitdir:` pointer FILE, HEAD is private, refs are shared via `commondir`', () => {
    // Real git worktree layout: <mainRepo>/.git is the real dir; the worktree's own <root>/.git
    // is a one-line pointer file to <mainRepo>/.git/worktrees/<name>/, which holds its OWN HEAD
    // (can differ from the main checkout's branch) plus a `commondir` pointing back to
    // <mainRepo>/.git for the refs/heads and packed-refs the worktree shares with the main repo.
    const mainRepo = tmp('yg-git-wt-main-');
    const worktreeRoot = tmp('yg-git-wt-linked-');
    const privateGitDir = path.join(mainRepo, '.git', 'worktrees', 'feature-x');
    mkdirSync(path.join(mainRepo, '.git', 'refs', 'heads'), { recursive: true });
    mkdirSync(privateGitDir, { recursive: true });
    writeFileSync(path.join(mainRepo, '.git', 'refs', 'heads', 'feature-x'), SHA + '\n');
    writeFileSync(path.join(privateGitDir, 'HEAD'), 'ref: refs/heads/feature-x\n');
    writeFileSync(path.join(privateGitDir, 'commondir'), '../..\n');
    writeFileSync(path.join(worktreeRoot, '.git'), `gitdir: ${privateGitDir}\n`);
    expect(readGitCommitRef(worktreeRoot)).toBe(SHA);
  });

  it('a linked worktree falls back to the main repo\'s packed-refs via `commondir`', () => {
    const mainRepo = tmp('yg-git-wt-main-packed-');
    const worktreeRoot = tmp('yg-git-wt-linked-packed-');
    const privateGitDir = path.join(mainRepo, '.git', 'worktrees', 'feature-y');
    mkdirSync(path.join(mainRepo, '.git'), { recursive: true });
    mkdirSync(privateGitDir, { recursive: true });
    writeFileSync(path.join(mainRepo, '.git', 'packed-refs'), `${SHA2} refs/heads/feature-y\n`);
    writeFileSync(path.join(privateGitDir, 'HEAD'), 'ref: refs/heads/feature-y\n');
    writeFileSync(path.join(privateGitDir, 'commondir'), '../..\n');
    writeFileSync(path.join(worktreeRoot, '.git'), `gitdir: ${privateGitDir}\n`);
    expect(readGitCommitRef(worktreeRoot)).toBe(SHA2);
  });

  it('returns null for a malformed `.git` pointer file (no `gitdir:` line)', () => {
    const root = tmp('yg-git-bad-pointer-');
    writeFileSync(path.join(root, '.git'), 'not a gitdir pointer\n');
    expect(readGitCommitRef(root)).toBeNull();
  });

  // `git init --object-format=sha256` stores 64-hex-char object ids. Every resolution path must
  // accept them, not only the SHA-1 (40-char) default — otherwise the reader silently returns
  // null on a SHA-256 repo and the attestation states "no commit ref" for a repo that has one.
  it('reads a detached HEAD holding a SHA-256 (64-hex) object id', () => {
    const root = tmp('yg-git-detached-256-');
    mkdirSync(path.join(root, '.git'), { recursive: true });
    writeFileSync(path.join(root, '.git', 'HEAD'), SHA256 + '\n');
    expect(readGitCommitRef(root)).toBe(SHA256);
  });

  it('follows a symbolic HEAD to a loose ref holding a SHA-256 object id', () => {
    const root = tmp('yg-git-loose-256-');
    mkdirSync(path.join(root, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(path.join(root, '.git', 'refs', 'heads', 'main'), SHA256 + '\n');
    expect(readGitCommitRef(root)).toBe(SHA256);
  });

  it('falls back to packed-refs holding a SHA-256 object id', () => {
    const root = tmp('yg-git-packed-256-');
    mkdirSync(path.join(root, '.git'), { recursive: true });
    writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(
      path.join(root, '.git', 'packed-refs'),
      `# pack-refs with: peeled fully-peeled sorted\n${SHA256} refs/heads/main\n${SHA256_2} refs/heads/other\n`,
    );
    expect(readGitCommitRef(root)).toBe(SHA256);
  });
});

describe('computePortalLockHash — committed-lock content fold', () => {
  it('hashes the committed lock on the real repo-basic-like fixture, stable across calls', async () => {
    // A temp copy with a committed lock written by hand (real bytes on disk).
    const root = tmp('yg-lockhash-');
    cpSync(BASIC_FIXTURE, root, { recursive: true });
    writeFileSync(
      path.join(root, '.yggdrasil', 'yg-lock.nondeterministic.json'),
      JSON.stringify({ version: 1, verdicts: {}, nodes: {} }),
    );
    const graph = await loadGraph(root);
    const h1 = computePortalLockHash(graph);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(computePortalLockHash(graph)).toBe(h1); // stable
  });

  it("returns '' when no committed lock exists (greenfield)", async () => {
    const root = tmp('yg-lockhash-empty-');
    cpSync(BASIC_FIXTURE, root, { recursive: true });
    const graph = await loadGraph(root);
    // portal-basic ships no committed lock files → empty hash, never fabricated.
    expect(computePortalLockHash(graph)).toBe('');
  });
});

describe('computePortalFreshness — the baseline branches (real graph)', () => {
  it('reports not-changed for nodes with NO committed baseline (the common case)', async () => {
    const graph = await loadGraph(BASIC_FIXTURE);
    const emptyLock: LockFile = { version: 1, verdicts: {}, nodes: {} };
    const fresh = await computePortalFreshness(graph, emptyLock);
    // Every node has no baseline → none reported changed (never over-fires).
    expect(fresh.every((f) => f.sourceChanged === false)).toBe(true);
    expect(fresh.some((f) => f.nodePath === 'api/orders')).toBe(true);
  });

  it('reports changed when a stored baseline differs from the live fingerprint', async () => {
    const graph = await loadGraph(BASIC_FIXTURE);
    // A baseline that cannot match the real current bytes (a deliberately wrong fingerprint).
    const lock: LockFile = {
      version: 1,
      verdicts: {},
      nodes: { 'api/orders': { source: 'deadbeef-not-the-real-fingerprint' } },
    };
    const fresh = await computePortalFreshness(graph, lock);
    const orders = fresh.find((f) => f.nodePath === 'api/orders')!;
    expect(orders.sourceChanged).toBe(true);
    // A sibling with no baseline stays not-changed.
    const users = fresh.find((f) => f.nodePath === 'api/users')!;
    expect(users.sourceChanged).toBe(false);
  });

  it('a mapping-less node with a stored baseline is never marked changed (undefined fingerprint)', async () => {
    const graph = await loadGraph(BASIC_FIXTURE);
    // The 'api' module node has no mapping → an undefined fingerprint. Even with a stale stored
    // baseline it can never be "fresh" (no source to be stale about).
    const lock: LockFile = {
      version: 1,
      verdicts: {},
      nodes: { api: { source: 'stale-baseline-on-a-mappingless-node' } },
    };
    const fresh = await computePortalFreshness(graph, lock);
    const apiNode = fresh.find((f) => f.nodePath === 'api')!;
    expect(apiNode.sourceChanged).toBe(false);
  });
});

describe('computePortalSourceFileCounts — the panel\'s real per-node file count (real graph)', () => {
  it('reports the real file count for a single-file mapping and 0 for a mapping-less node', async () => {
    const graph = await loadGraph(BASIC_FIXTURE);
    const counts = await computePortalSourceFileCounts(graph);
    const orders = counts.find((c) => c.nodePath === 'api/orders')!;
    // api/orders maps exactly one file (src/orders/orders.service.ts).
    expect(orders.sourceFileCount).toBe(1);
    const users = counts.find((c) => c.nodePath === 'api/users')!;
    expect(users.sourceFileCount).toBe(1);
    // The 'api' module node declares no mapping at all — never a fabricated count.
    const api = counts.find((c) => c.nodePath === 'api')!;
    expect(api.sourceFileCount).toBe(0);
  });

  it('agrees with computeNodeMappedFiles — the same expansion the source fingerprint uses', async () => {
    const graph = await loadGraph(BASIC_FIXTURE);
    const counts = await computePortalSourceFileCounts(graph);
    const { computeNodeMappedFiles } = await import('../../src/core/pairs.js');
    for (const nodePath of graph.nodes.keys()) {
      const files = await computeNodeMappedFiles(graph, nodePath);
      const marker = counts.find((c) => c.nodePath === nodePath)!;
      expect(marker.sourceFileCount).toBe(files.length);
    }
  });

  it('reports the real expanded file count, not the raw mapping-entry count, for a directory mapping', async () => {
    // BASIC_FIXTURE's own nodes each map exactly one file, so mapping.length already
    // equals the real file count for every node there — a facade that quietly
    // returned mapping.length instead of the real expansion would pass the two tests
    // above unnoticed. The committed `runcheck-parity` fixture's `cli/callers` node has
    // ONE mapping entry (a directory, `src/callers/`) that expands to EIGHT files on
    // disk, so the two numbers can only agree here if the facade is actually doing the
    // real expansion.
    const graph = await loadGraph(RUNCHECK_PARITY_FIXTURE);
    const counts = await computePortalSourceFileCounts(graph);
    const callers = counts.find((c) => c.nodePath === 'cli/callers')!;
    expect(callers.sourceFileCount).toBe(8); // real expansion, not the single mapping entry
  });
});

describe('runPortalCheck — parity with `yg check` on the review-cadence signal', () => {
  it('surfaces aspect-review-overdue warnings (portal injects the wall clock like the CLI)', async () => {
    // Real on-disk fixture with a past `review_by:` on its aspect. The portal MUST inject the
    // clock the same way the `yg check` CLI boundary does; without it, core skips the
    // review-cadence check and the portal silently undercounts warnings vs `yg check`.
    const root = tmp('yg-portal-overdue-');
    cpSync(BASIC_FIXTURE, root, { recursive: true });
    const aspectYaml = path.join(root, '.yggdrasil', 'aspects', 'no-todo-comments', 'yg-aspect.yaml');
    // A date long in the past — overdue relative to any real run clock.
    writeFileSync(aspectYaml, readFileSync(aspectYaml, 'utf-8') + '\nreview_by: "2020-01-01"\n');
    const graph = await loadGraph(root);

    const portalResult = await runPortalCheck(graph, [], () => new Date());
    const overduePortal = portalResult.issues.filter((i) => i.code === 'aspect-review-overdue');
    expect(overduePortal.length).toBeGreaterThan(0);

    // Oracle: the CLI path passes `nowUtc: () => new Date()`; the portal must match it exactly.
    const cliResult = await runCheck(graph, [], { nowUtc: () => new Date() });
    const overdueCli = cliResult.issues.filter((i) => i.code === 'aspect-review-overdue');
    expect(overduePortal.length).toBe(overdueCli.length);

    // Guard against a self-referential oracle: with NO clock, core skips the check entirely —
    // proving the portal's warnings come from the injected clock, not from runCheck by default.
    const noClock = await runCheck(graph, []);
    expect(noClock.issues.some((i) => i.code === 'aspect-review-overdue')).toBe(false);
  });

  it('surfaces rules-digest-stale warnings (portal injects the committed rules files like the CLI)', async () => {
    // Same class of defect as the clock above, one input over: core skips the committed-digest
    // staleness gate whenever the rules-artifacts snapshot is absent, so a facade that does not
    // read those files renders a project with a drifted or absent agent-rules install as CLEAN
    // while `yg check` warns about it — the browser surface reading greener than the command
    // line. portal-basic ships no AGENTS.md / CLAUDE.md / .clinerules at all, so the gate has a
    // real finding to make here.
    const graph = await loadGraph(BASIC_FIXTURE);

    const portalResult = await runPortalCheck(graph, [], () => new Date());
    const stalePortal = portalResult.issues.filter((i) => i.code === 'rules-digest-stale');
    expect(stalePortal.length).toBeGreaterThan(0);

    // Oracle: the CLI boundary reads the artifacts through the SAME shared reader and injects
    // them; the portal must match it exactly.
    const cliResult = await runCheck(graph, [], {
      rulesArtifacts: await readRulesArtifacts(BASIC_FIXTURE),
    });
    const staleCli = cliResult.issues.filter((i) => i.code === 'rules-digest-stale');
    expect(stalePortal.length).toBe(staleCli.length);

    // Guard against a self-referential oracle: with NO snapshot, core skips the gate entirely —
    // proving the portal's warning comes from the injected artifacts, not from runCheck's default.
    const noArtifacts = await runCheck(graph, []);
    expect(noArtifacts.issues.some((i) => i.code === 'rules-digest-stale')).toBe(false);

    // And the warning is non-blocking: it never turns into an error on either surface.
    expect(stalePortal.every((i) => i.severity === 'warning')).toBe(true);
  });
});
