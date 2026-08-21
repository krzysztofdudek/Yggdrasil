// Unit tests for `yg roots index` / `yg roots status` (source/cli/src/cli/roots.ts):
// the command's registration shape, the comment-preserving blockless-config
// scaffold, the dirty-hash fold (.yggdrasil/roots/** excluded), the header
// assembly mapping, and every branch of `status`'s always-exit-0 report.
// Real temp dirs and real temp git repos throughout — no mocks.

import { describe, it, expect, afterEach } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { registerRootsCommand, scaffoldRootsBlock, computeDirtyHash, assembleRootsModelHeader, renderRootsStatus } from '../../../src/cli/roots.js';
import { parseConfig } from '../../../src/io/config-parser.js';
import { writeModel, type RootsModelHeader } from '../../../src/roots/stores.js';
import { hashString } from '../../../src/io/hash.js';
import type { MinedModel } from '../../../src/roots/mine.js';
import { initDeterministicGitFixture, runDeterministicGitFixture } from '../../support/git-fixture.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Registration shape
// ---------------------------------------------------------------------------

describe('yg roots — command registration shape', () => {
  it('registers a single `roots` command with `index` and `status` subcommands', () => {
    const program = new Command();
    registerRootsCommand(program);
    const roots = program.commands.find((c) => c.name() === 'roots');
    expect(roots).toBeDefined();
    const subNames = roots!.commands.map((c) => c.name()).sort();
    expect(subNames).toEqual(['index', 'status']);
  });
});

// ---------------------------------------------------------------------------
// scaffoldRootsBlock — comment-preserving append, idempotent
// ---------------------------------------------------------------------------

describe('scaffoldRootsBlock', () => {
  it('adds an empty `roots:` mapping while preserving every existing key and comment (only flow-collection spacing may move)', async () => {
    const dir = tmpDir('yg-roots-scaffold-');
    const configPath = path.join(dir, 'yg-config.yaml');
    const original =
      'version: "5.2.0"\n' +
      'quality:\n' +
      '  max_direct_relations: 20\n' +
      '# a maintainer comment worth keeping\n' +
      'reviewer:\n' +
      '  tiers:\n' +
      '    standard:\n' +
      '      provider: claude-code\n';
    writeFileSync(configPath, original, 'utf-8');

    await scaffoldRootsBlock(configPath);

    const after = readFileSync(configPath, 'utf-8');
    expect(after).toContain('# a maintainer comment worth keeping');
    expect(after).toContain('version: "5.2.0"');
    expect(after).toContain('provider: claude-code');
    const parsed = parseYaml(after) as Record<string, unknown>;
    expect(parsed.roots).toEqual({});
  });

  it('is idempotent: re-parsing the scaffolded file through parseConfig fills every §4.5 default', async () => {
    const dir = tmpDir('yg-roots-scaffold-idem-');
    const configPath = path.join(dir, 'yg-config.yaml');
    writeFileSync(configPath, 'version: "5.2.0"\n', 'utf-8');

    await scaffoldRootsBlock(configPath);
    const config = await parseConfig(configPath);
    expect(config.roots).toBeDefined();
    expect(config.roots!.mdl.acceptMarginBits).toBe(4.0);
    expect(config.roots!.include).toEqual(['**/*']);

    // A second scaffold call (e.g. two runs sharing the same not-yet-committed
    // config) still leaves the config in the same fully-defaulted state — the
    // command itself never re-invokes this once `config.roots` is defined, but
    // the writer's own output is stable under a repeat call regardless.
    await scaffoldRootsBlock(configPath);
    const secondContent = readFileSync(configPath, 'utf-8');
    await scaffoldRootsBlock(configPath);
    const thirdContent = readFileSync(configPath, 'utf-8');
    expect(thirdContent).toBe(secondContent);
  });
});

// ---------------------------------------------------------------------------
// computeDirtyHash — .yggdrasil/roots/** excluded, deterministic, fail-soft
// ---------------------------------------------------------------------------

describe('computeDirtyHash', () => {
  function freshRepoWithYggRoot(): { repoRoot: string; yggRoot: string } {
    const repoRoot = tmpDir('yg-dirtyhash-');
    const init = initDeterministicGitFixture(repoRoot);
    if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}${init.stdout}`);
    mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');
    const add = runDeterministicGitFixture(repoRoot, ['add', '-A'], 0);
    if (add.status !== 0) throw new Error(`git add failed: ${add.stderr}${add.stdout}`);
    const commit = runDeterministicGitFixture(repoRoot, ['commit', '-q', '-m', 'init'], 0);
    if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr}${commit.stdout}`);
    const yggRoot = path.join(repoRoot, '.yggdrasil');
    mkdirSync(yggRoot, { recursive: true });
    return { repoRoot, yggRoot };
  }

  it('is unaffected by changes under .yggdrasil/roots/** (index\'s own writes)', async () => {
    const { repoRoot, yggRoot } = freshRepoWithYggRoot();
    mkdirSync(path.join(yggRoot, 'roots'), { recursive: true });
    writeFileSync(path.join(yggRoot, 'roots', 'model.json'), '{"first":true}', 'utf-8');

    const first = await computeDirtyHash(yggRoot, repoRoot);

    writeFileSync(path.join(yggRoot, 'roots', 'model.json'), '{"totally":"different","content":123}', 'utf-8');
    const second = await computeDirtyHash(yggRoot, repoRoot);

    expect(second).toBe(first);
  });

  it('changes when a file OUTSIDE .yggdrasil/roots/** is dirtied', async () => {
    const { repoRoot, yggRoot } = freshRepoWithYggRoot();
    const before = await computeDirtyHash(yggRoot, repoRoot);

    writeFileSync(path.join(repoRoot, 'src', 'a.ts'), 'export const a = 2;\n', 'utf-8');
    const after = await computeDirtyHash(yggRoot, repoRoot);

    expect(after).not.toBe(before);
  });

  it('is stable across two calls on an unchanged worktree', async () => {
    const { repoRoot, yggRoot } = freshRepoWithYggRoot();
    const first = await computeDirtyHash(yggRoot, repoRoot);
    const second = await computeDirtyHash(yggRoot, repoRoot);
    expect(second).toBe(first);
  });

  it('folds to the hash of the empty set in a non-git directory (fail-soft, never throws)', async () => {
    const dir = tmpDir('yg-dirtyhash-nongit-');
    const yggRoot = path.join(dir, '.yggdrasil');
    mkdirSync(yggRoot, { recursive: true });
    const result = await computeDirtyHash(yggRoot, dir);
    expect(result).toBe(hashString(JSON.stringify({}, [])));
  });
});

// ---------------------------------------------------------------------------
// assembleRootsModelHeader — the ownership-table mapping, in isolation
// ---------------------------------------------------------------------------

describe('assembleRootsModelHeader', () => {
  it('copies every computed input into its documented header field, verbatim', () => {
    const header = assembleRootsModelHeader({
      configHash: 'CONFIG_HASH',
      seedsHash: 'SEEDS_HASH',
      decisionsHash: 'DECISIONS_HASH',
      ledgerHash: 'LEDGER_HASH',
      headSha: 'abc123',
      clock: '2026-08-19T00:00:00+00:00',
      dirtyHash: 'DIRTY_HASH',
      bindingHash: 'BINDING_HASH',
      candidateCountLog2: 7,
    });
    const expected: RootsModelHeader = {
      rootsVersion: 1,
      headSha: 'abc123',
      lastIndexedSha: null,
      clock: '2026-08-19T00:00:00+00:00',
      bindingHash: 'BINDING_HASH',
      configHash: 'CONFIG_HASH',
      seedsHash: 'SEEDS_HASH',
      decisionsHash: 'DECISIONS_HASH',
      ledgerHash: 'LEDGER_HASH',
      dirtyHash: 'DIRTY_HASH',
      candidateCountLog2: 7,
      rolesStale: false,
    };
    expect(header).toEqual(expected);
  });

  it('always reports lastIndexedSha null and rolesStale false — R1-R3 has no resume state and always fully re-induces', () => {
    const header = assembleRootsModelHeader({
      configHash: 'a',
      seedsHash: 'b',
      decisionsHash: 'c',
      ledgerHash: 'd',
      headSha: null,
      clock: null,
      dirtyHash: 'e',
      bindingHash: 'f',
      candidateCountLog2: 0,
    });
    expect(header.lastIndexedSha).toBeNull();
    expect(header.rolesStale).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// renderRootsStatus — always resolves text, every state honest, never throws
// ---------------------------------------------------------------------------

const MINIMAL_MINED_MODEL: MinedModel = {
  partitions: [
    {
      id: 'p1',
      vocab: { nodeType: [], call: [], decorator: [], import: [], supertype: [], shape: [] },
      alphabets: {},
      roles: [],
      assignments: {},
      facts: [],
      moduleOfFile: {},
      seeds: [],
    },
  ],
  agentShare: null,
};

describe('renderRootsStatus', () => {
  it('reports no project when there is no .yggdrasil/ directory at all — plain terms, not the canonical missing-graph string', async () => {
    const dir = tmpDir('yg-status-noproj-');
    const text = await renderRootsStatus(dir);
    expect(text).toContain('this directory is not part of a Yggdrasil project');
    expect(text).toContain('yg init');
    // `status` must never reproduce the canonical missing-graph string shape
    // (`abortUnlessYggdrasilExists`/`loadGraphOrAbort` own that text) — it is
    // an honest read-only report, not the refusal `index` uses (R1c).
    expect(text).not.toContain('.yggdrasil/ directory found');
  });

  it('reports an unreadable config (missing yg-config.yaml) without throwing', async () => {
    const dir = tmpDir('yg-status-noconfig-');
    mkdirSync(path.join(dir, '.yggdrasil'), { recursive: true });
    const text = await renderRootsStatus(dir);
    expect(text).toContain('could not be read');
  });

  it('reports a structured config error (an unknown key inside roots:) via its own what/why/next message', async () => {
    const dir = tmpDir('yg-status-badconfig-');
    mkdirSync(path.join(dir, '.yggdrasil'), { recursive: true });
    writeFileSync(
      path.join(dir, '.yggdrasil', 'yg-config.yaml'),
      'version: "5.2.0"\nroots:\n  bogus_unknown_key: true\n',
      'utf-8',
    );
    const text = await renderRootsStatus(dir);
    expect(text).toContain('could not be read');
    expect(text).toContain('bogus_unknown_key');
  });

  it('reports dormant when yg-config.yaml has no roots: block', async () => {
    const dir = tmpDir('yg-status-dormant-');
    mkdirSync(path.join(dir, '.yggdrasil'), { recursive: true });
    writeFileSync(path.join(dir, '.yggdrasil', 'yg-config.yaml'), 'version: "5.2.0"\n', 'utf-8');
    const text = await renderRootsStatus(dir);
    expect(text).toContain('dormant');
    expect(text).toContain('yg roots index');
  });

  it('reports never-indexed when roots: is present but no model.json exists', async () => {
    const dir = tmpDir('yg-status-neverindexed-');
    mkdirSync(path.join(dir, '.yggdrasil'), { recursive: true });
    writeFileSync(path.join(dir, '.yggdrasil', 'yg-config.yaml'), 'version: "5.2.0"\nroots: {}\n', 'utf-8');
    const text = await renderRootsStatus(dir);
    expect(text).toContain('never indexed');
    expect(text).toContain('yg roots index');
  });

  it('reports an unparseable model.json without throwing', async () => {
    const dir = tmpDir('yg-status-corrupt-');
    const yggRoot = path.join(dir, '.yggdrasil');
    mkdirSync(yggRoot, { recursive: true });
    writeFileSync(path.join(yggRoot, 'yg-config.yaml'), 'version: "5.2.0"\nroots: {}\n', 'utf-8');
    mkdirSync(path.join(yggRoot, 'roots'), { recursive: true });
    writeFileSync(path.join(yggRoot, 'roots', 'model.json'), 'not valid json{{{', 'utf-8');
    const text = await renderRootsStatus(dir);
    expect(text).toContain('could not be read');
    expect(text).toContain('yg roots index');
  });

  it('reports the real field/fact counts for a genuinely indexed model', async () => {
    const dir = tmpDir('yg-status-indexed-');
    const yggRoot = path.join(dir, '.yggdrasil');
    mkdirSync(yggRoot, { recursive: true });
    writeFileSync(path.join(yggRoot, 'yg-config.yaml'), 'version: "5.2.0"\nroots: {}\n', 'utf-8');

    const header: RootsModelHeader = {
      rootsVersion: 1,
      headSha: 'deadbeef',
      lastIndexedSha: null,
      clock: '2026-08-19T00:00:00+00:00',
      bindingHash: 'bh',
      configHash: 'ch',
      seedsHash: 'sh',
      decisionsHash: 'dh',
      ledgerHash: 'lh',
      dirtyHash: 'dth',
      candidateCountLog2: 5,
      rolesStale: false,
    };
    await writeModel(yggRoot, header, MINIMAL_MINED_MODEL);

    const text = await renderRootsStatus(dir);
    expect(text).toContain('indexed');
    expect(text).toContain('Last indexed at commit deadbee, committed 2026-08-19T00:00:00+00:00.');
    expect(text).toContain('Partitions: 1');
    expect(text).toContain('Facts: 0');
    expect(text).toContain('Roles: 0');
    expect(text).toContain('Seeds: 0');
    // Internal bookkeeping identifiers never reach a user-facing surface.
    expect(text).not.toMatch(/rootsVersion|candidateCountLog2|rolesStale/);
  });

  it('reports "outside version control" instead of a null headSha/clock when the repo has no git history', async () => {
    const dir = tmpDir('yg-status-nogit-');
    const yggRoot = path.join(dir, '.yggdrasil');
    mkdirSync(yggRoot, { recursive: true });
    writeFileSync(path.join(yggRoot, 'yg-config.yaml'), 'version: "5.2.0"\nroots: {}\n', 'utf-8');

    const header: RootsModelHeader = {
      rootsVersion: 1,
      headSha: null,
      lastIndexedSha: null,
      clock: null,
      bindingHash: 'bh',
      configHash: 'ch',
      seedsHash: 'sh',
      decisionsHash: 'dh',
      ledgerHash: 'lh',
      dirtyHash: 'dth',
      candidateCountLog2: 3,
      rolesStale: false,
    };
    await writeModel(yggRoot, header, MINIMAL_MINED_MODEL);

    const text = await renderRootsStatus(dir);
    expect(text).toContain('Last indexed outside version control (no git history).');
    expect(text).not.toContain('null');
  });

  it('never throws — the entire report is safe to print even when something inside goes wrong', async () => {
    // A model.json whose header exists but whose body fails the MinedModel
    // structural guard (a future/foreign format, or a hand-edit) must still
    // render as text, not reject.
    const dir = tmpDir('yg-status-badshape-');
    const yggRoot = path.join(dir, '.yggdrasil');
    mkdirSync(yggRoot, { recursive: true });
    writeFileSync(path.join(yggRoot, 'yg-config.yaml'), 'version: "5.2.0"\nroots: {}\n', 'utf-8');
    const header: RootsModelHeader = {
      rootsVersion: 1,
      headSha: null,
      lastIndexedSha: null,
      clock: null,
      bindingHash: 'bh',
      configHash: 'ch',
      seedsHash: 'sh',
      decisionsHash: 'dh',
      ledgerHash: 'lh',
      dirtyHash: 'dth',
      candidateCountLog2: 0,
      rolesStale: false,
    };
    await writeModel(yggRoot, header, { notAMinedModel: true });
    const text = await renderRootsStatus(dir);
    expect(text).toContain('does not have the expected shape');
  });

  it('reports the specific malformed-model message — not the generic catch-all — when a partition has facts but is missing roles/seeds', async () => {
    // isMinedModel (mine.ts) must reject this, not just accept-then-let-the-
    // renderer-throw-into-the-catch-all: `p.roles.length`/`p.seeds.length`
    // (renderRootsStatusInner, below) would throw on a partition shaped like
    // this if the guard only checked `facts`.
    const dir = tmpDir('yg-status-partial-partition-');
    const yggRoot = path.join(dir, '.yggdrasil');
    mkdirSync(yggRoot, { recursive: true });
    writeFileSync(path.join(yggRoot, 'yg-config.yaml'), 'version: "5.2.0"\nroots: {}\n', 'utf-8');
    const header: RootsModelHeader = {
      rootsVersion: 1,
      headSha: null,
      lastIndexedSha: null,
      clock: null,
      bindingHash: 'bh',
      configHash: 'ch',
      seedsHash: 'sh',
      decisionsHash: 'dh',
      ledgerHash: 'lh',
      dirtyHash: 'dth',
      candidateCountLog2: 0,
      rolesStale: false,
    };
    await writeModel(yggRoot, header, { partitions: [{ id: 'p1', facts: [] }] });
    const text = await renderRootsStatus(dir);
    expect(text).toContain('does not have the expected shape');
    expect(text).not.toContain('status could not be determined');
  });
});

