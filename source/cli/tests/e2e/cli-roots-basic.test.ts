import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGoldenRepo } from '../support/roots-golden.js';
import { buildTypeScriptGoldenSpec } from '../fixtures/roots/golden/typescript/spec.js';

// =============================================================================
// tests/e2e/cli-roots-basic.test.ts — the spawned-CLI proof for `yg roots
// index`/`yg roots status`: a genuine `dist/bin.js` child process against a
// real on-disk project, never anything imported from src/**. The project is
// built from the committed TypeScript golden's OWN builder spec
// (tests/fixtures/roots/golden/typescript/spec.ts) — a real git repository,
// not a synthetic stand-in — with a MINIMAL `.yggdrasil/yg-config.yaml`
// written on top of it (the schema `version:` key, plus a `roots: {}` block
// only where a case needs one already present): a golden is a plain source
// repo, not a Yggdrasil project, and `index`'s config-only load (findYggRoot +
// parseConfig, never the graph) is exactly what makes that minimal a valid
// target at all.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

/** A real, freshly-built TypeScript golden repository — caller owns cleanup (`rmSync`). */
function buildProject(): string {
  return buildGoldenRepo(buildTypeScriptGoldenSpec());
}

/** Writes a minimal `.yggdrasil/yg-config.yaml` — the schema `version:` key only, plus an empty `roots: {}` block when `withRootsBlock` is true. Nothing else: no model/, no aspects, no architecture. */
function writeMinimalConfig(dir: string, withRootsBlock: boolean): void {
  mkdirSync(path.join(dir, '.yggdrasil'), { recursive: true });
  const content = withRootsBlock ? 'version: "5.2.0"\nroots: {}\n' : 'version: "5.2.0"\n';
  writeFileSync(path.join(dir, '.yggdrasil', 'yg-config.yaml'), content, 'utf-8');
}

describe.skipIf(!distExists)('CLI E2E — yg roots index / yg roots status', () => {
  it('index with a roots: block already present mines the repository and writes a committed model (exit 0)', () => {
    const dir = buildProject();
    try {
      writeMinimalConfig(dir, true);
      const { status, stdout } = run(['roots', 'index'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('Indexed');

      const modelPath = path.join(dir, '.yggdrasil', 'roots', 'model.json');
      expect(existsSync(modelPath)).toBe(true);
      const model = JSON.parse(readFileSync(modelPath, 'utf-8'));
      expect(model.header.rootsVersion).toBe(1);
      expect(typeof model.header.configHash).toBe('string');
      expect(model.header.configHash.length).toBeGreaterThan(0);
      expect(typeof model.header.bindingHash).toBe('string');
      expect(model.header.bindingHash.length).toBeGreaterThan(0);
      expect(typeof model.header.candidateCountLog2).toBe('number');
      expect(model.header.rolesStale).toBe(false);
      expect(model.header.lastIndexedSha).toBeNull();
      expect(Array.isArray(model.body.partitions)).toBe(true);

      // Independently-anchored proof the header's two engine-produced fields
      // are actually wired from the pipeline result, not hardcoded/mislabeled
      // at the call site (roots.ts:345-346) — a check against model.json alone
      // is self-referential and cannot catch either mistake.
      expect(model.header.bindingHash).not.toBe(model.header.configHash);
      // The committed TypeScript golden is a real 100-file repository — a
      // hardcoded `candidateCountLog2: 0` at the call site would pass every
      // shape assertion above but fail this one.
      expect(model.header.candidateCountLog2).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bindingHash depends on grammars, not config: editing ONLY the config changes configHash but leaves bindingHash unchanged', () => {
    const dir = buildProject();
    try {
      writeMinimalConfig(dir, true);
      const first = run(['roots', 'index'], dir);
      expect(first.status).toBe(0);
      const modelPath = path.join(dir, '.yggdrasil', 'roots', 'model.json');
      const firstModel = JSON.parse(readFileSync(modelPath, 'utf-8'));

      const configPath = path.join(dir, '.yggdrasil', 'yg-config.yaml');
      writeFileSync(configPath, 'version: "5.2.0"\nroots:\n  exclude:\n    - "vendor/**"\n', 'utf-8');

      const second = run(['roots', 'index'], dir);
      expect(second.status).toBe(0);
      const secondModel = JSON.parse(readFileSync(modelPath, 'utf-8'));

      expect(secondModel.header.configHash).not.toBe(firstModel.header.configHash);
      expect(secondModel.header.bindingHash).toBe(firstModel.header.bindingHash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('running index a SECOND time yields a byte-identical model.json — header included (cross-process determinism)', () => {
    const dir = buildProject();
    try {
      writeMinimalConfig(dir, true);
      const first = run(['roots', 'index'], dir);
      expect(first.status).toBe(0);
      const modelPath = path.join(dir, '.yggdrasil', 'roots', 'model.json');
      const firstBytes = readFileSync(modelPath);

      const second = run(['roots', 'index'], dir);
      expect(second.status).toBe(0);
      const secondBytes = readFileSync(modelPath);

      expect(secondBytes.equals(firstBytes)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a committed seeds.jsonl reaches the mined model and the status report — the command-layer join, pinned end-to-end (the whole-increment review proved a command that silently passed [] to the engine kept every other case green, because the header\'s seedsHash is hashed from the file independently of the mining input)', () => {
    const dir = buildProject();
    try {
      writeMinimalConfig(dir, true);
      const rootsDir = path.join(dir, '.yggdrasil', 'roots');
      mkdirSync(rootsDir, { recursive: true });
      const seed = {
        seedId: 's1',
        scopeRef: { path: 'src/mod0/file0.ts', qualifiedName: 'Handler0' },
        surfaces: ['auto.nameshape'],
        weight: 8,
        arch: true,
        author: 'maintainer',
        createdAt: '2026-01-01T00:00:00Z',
      };
      writeFileSync(path.join(rootsDir, 'seeds.jsonl'), `${JSON.stringify(seed)}\n`, 'utf-8');

      const { status } = run(['roots', 'index'], dir);
      expect(status).toBe(0);

      const model = JSON.parse(readFileSync(path.join(rootsDir, 'model.json'), 'utf-8'));
      const minedSeedIds = model.body.partitions.flatMap((p: { seeds: { seedId: string }[] }) =>
        p.seeds.map((s) => s.seedId),
      );
      expect(minedSeedIds).toContain('s1');

      const statusRun = run(['roots', 'status'], dir);
      expect(statusRun.status).toBe(0);
      expect(statusRun.stdout).toContain('Seeds: 1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('index WITHOUT a roots: block scaffolds it with defaults — printed FIRST — then mines (exit 0)', () => {
    const dir = buildProject();
    try {
      writeMinimalConfig(dir, false);
      const configPath = path.join(dir, '.yggdrasil', 'yg-config.yaml');
      expect(readFileSync(configPath, 'utf-8')).not.toMatch(/^roots:/m);

      const { status, stdout } = run(['roots', 'index'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('No `roots:` block found');
      expect(stdout).toContain('Indexed');
      // "printed first" — the scaffold notice precedes the mining summary.
      expect(stdout.indexOf('No `roots:` block found')).toBeLessThan(stdout.indexOf('Indexed'));

      expect(readFileSync(configPath, 'utf-8')).toMatch(/^roots:/m);
      expect(existsSync(path.join(dir, '.yggdrasil', 'roots', 'model.json'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('index with a NON-default roots: block already present never rewrites it — config byte-identical, no scaffold notice', () => {
    const dir = buildProject();
    try {
      const configPath = path.join(dir, '.yggdrasil', 'yg-config.yaml');
      mkdirSync(path.join(dir, '.yggdrasil'), { recursive: true });
      const original =
        'version: "5.2.0"\n' +
        '# a hand-authored roots block — must never be touched by index\n' +
        'roots:\n' +
        '  exclude:\n' +
        '    - "vendor/**"\n';
      writeFileSync(configPath, original, 'utf-8');

      const { status, stdout } = run(['roots', 'index'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('Indexed');
      expect(stdout).not.toContain('No `roots:` block found');

      expect(readFileSync(configPath, 'utf-8')).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a real config error (an unknown key under roots:) makes index refuse — exit 1, the only non-zero index exit', () => {
    const dir = buildProject();
    try {
      mkdirSync(path.join(dir, '.yggdrasil'), { recursive: true });
      writeFileSync(
        path.join(dir, '.yggdrasil', 'yg-config.yaml'),
        'version: "5.2.0"\nroots:\n  bogus_unknown_key: true\n',
        'utf-8',
      );
      const { status, stderr } = run(['roots', 'index'], dir);
      expect(status).toBe(1);
      expect(stderr).toContain('bogus_unknown_key');
      expect(existsSync(path.join(dir, '.yggdrasil', 'roots', 'model.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('index in a directory with no .yggdrasil/ at all refuses with the init hint (exit 1)', () => {
    const dir = buildProject();
    try {
      const { status, stderr } = run(['roots', 'index'], dir);
      expect(status).toBe(1);
      expect(stderr).toContain('No .yggdrasil/ directory found');
      expect(stderr).toContain('yg init');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('status reports exactly what index mined — counts and commit read back from the committed model', () => {
    const dir = buildProject();
    try {
      writeMinimalConfig(dir, true);
      const indexResult = run(['roots', 'index'], dir);
      expect(indexResult.status).toBe(0);

      const statusResult = run(['roots', 'status'], dir);
      expect(statusResult.status).toBe(0);
      expect(statusResult.stdout).toContain('indexed');

      const model = JSON.parse(readFileSync(path.join(dir, '.yggdrasil', 'roots', 'model.json'), 'utf-8'));
      expect(statusResult.stdout).toContain(`Partitions: ${model.body.partitions.length}`);
      const totalFacts = model.body.partitions.reduce((n: number, p: { facts: unknown[] }) => n + p.facts.length, 0);
      expect(statusResult.stdout).toContain(`Facts: ${totalFacts}`);
      // Internal header identifiers (rootsVersion, candidateCountLog2, rolesStale)
      // must never leak into the plain-terms status report.
      expect(statusResult.stdout).not.toMatch(/rootsVersion|candidateCountLog2|rolesStale/);
      if (model.header.headSha !== null) {
        expect(statusResult.stdout).toContain(`Last indexed at commit ${model.header.headSha.slice(0, 7)}, committed ${model.header.clock}.`);
      } else {
        expect(statusResult.stdout).toContain('Last indexed outside version control (no git history).');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('status ALWAYS exits 0 — no project, dormant, and configured-but-never-indexed all report as information, not failure', () => {
    const noProjectDir = buildProject();
    try {
      const result = run(['roots', 'status'], noProjectDir);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('this directory is not part of a Yggdrasil project');
    } finally {
      rmSync(noProjectDir, { recursive: true, force: true });
    }

    const dormantDir = buildProject();
    try {
      writeMinimalConfig(dormantDir, false);
      const result = run(['roots', 'status'], dormantDir);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('dormant');
    } finally {
      rmSync(dormantDir, { recursive: true, force: true });
    }

    const neverIndexedDir = buildProject();
    try {
      writeMinimalConfig(neverIndexedDir, true);
      const result = run(['roots', 'status'], neverIndexedDir);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('never indexed');
    } finally {
      rmSync(neverIndexedDir, { recursive: true, force: true });
    }
  });
});
