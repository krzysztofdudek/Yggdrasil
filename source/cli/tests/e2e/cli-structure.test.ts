import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Subprocess E2E for `yg structure` — the read-only structural dashboard.
// Harness mirrors cli-commands-surface.test.ts: run() wraps spawnSync on the
// compiled dist/bin.js, each case builds its own hermetic temp dir and removes
// it in a finally. Public CLI surface only (spawn the binary; assert on
// stdout/stderr/exit). No internal imports, no network, no clock.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
// sample-project has clean cross-tree structural relations
// (checkout/controller -> orders/order-service; orders/order-service ->
// auth/auth-api and users/user-repo) AND a red check state (unverified LLM
// pairs) — so it exercises both the section rendering and lock-blindness.
const SAMPLE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project');

const distExists = existsSync(BIN_PATH);

const LEGEND =
  'edges = declared structural relations ∪ statically detected dependencies; event relations excluded; weights not computed';

function run(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/** Copy the sample-project fixture into a fresh temp dir. */
function copySample(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-structure-${label}-`));
  cpSync(SAMPLE, dir, { recursive: true });
  return dir;
}

/** An empty temp dir with NO .yggdrasil/ — for the no-graph loader-error path. */
function emptyDir(label: string): string {
  return mkdtempSync(path.join(tmpdir(), `yg-structure-empty-${label}-`));
}

describe.skipIf(!distExists)('CLI E2E — yg structure (read-only structural dashboard)', () => {
  it('renders the edge-universe legend, tunnels, modules, and change reach; exit 0', () => {
    const dir = copySample('render');
    try {
      const { stdout, status } = run(['structure'], dir);
      expect(status).toBe(0);

      // Legend printed ALWAYS, verbatim.
      expect(stdout).toContain(LEGEND);

      // Tunnels section names the known cross-tree edge with its span in WORDS.
      expect(stdout).toContain('Tunnels');
      expect(stdout).toContain('checkout/controller → orders/order-service');
      expect(stdout).toMatch(/jumps \d+ level/);

      // Modules per-depth view: sample-project has 4 top-level groups, so a
      // depth-1 section renders and names the groups.
      expect(stdout).toContain('Modules');
      expect(stdout).toMatch(/depth 1\b/);
      expect(stdout).toMatch(/\bgroups\b/);

      // Change reach line, phrased in plain language with a percentage.
      expect(stdout).toMatch(
        /From an average component, \d+% of the system is reachable through dependencies\./,
      );

      // Plain-language guard: no method jargon leaks into the output.
      for (const banned of ['LCA', 'conductance', 'SCC', 'Laplacian', 'Fiedler', 'eigenvalue']) {
        expect(stdout).not.toContain(banned);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stays exit 0 even when `yg check` is red (lock-blind instrument)', () => {
    const dir = copySample('lockblind');
    try {
      // sample-project has unverified pairs — check is RED (non-zero).
      const check = run(['check'], dir);
      expect(check.status).not.toBe(0);

      // structure never reads the lock and never gates — it still exits 0.
      const structure = run(['structure'], dir);
      expect(structure.status).toBe(0);
      expect(structure.stdout).toContain(LEGEND);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('errors with the standard loader message and non-zero exit when no .yggdrasil/', () => {
    const dir = emptyDir('nograph');
    try {
      const { status, stderr } = run(['structure'], dir);
      expect(status).not.toBe(0);
      expect(stderr).toContain('No .yggdrasil/ directory found');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// type-relation-gate: one explicit node ("owner") and two cleanly type-covered
// files (src/svc/handler.ts, src/util/plain-util.ts) with REAL static imports
// between all three — src/svc/handler.ts imports both owner/target.ts and
// util/plain-util.ts; util/plain-util.ts imports owner/target.ts. Purpose-built
// for exercising the live type-relation gate's edge set, which is exactly what
// `yg structure`'s type-level widening consumes.
const RELATION_GATE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-relation-gate');

describe.skipIf(!distExists)('yg structure — the type-level widening', () => {
  function copyRelationGate(label: string, typeLevel: boolean): string {
    const dir = mkdtempSync(path.join(tmpdir(), `yg-structure-typecov-${label}-`));
    cpSync(RELATION_GATE, dir, { recursive: true });
    if (!typeLevel) {
      const configPath = path.join(dir, '.yggdrasil', 'yg-config.yaml');
      writeFileSync(configPath, readFileSync(configPath, 'utf-8').replace('type_level: true', 'type_level: false'));
    }
    return dir;
  }

  it('flag off: the universe is node-only, byte-identical to today (no type-covered edges, "component" wording)', () => {
    const dir = copyRelationGate('off', false);
    try {
      const out = run(['structure'], dir).all;
      expect(out).toContain('No structural dependencies between components yet.');
      expect(out).toContain('From an average component, 0% of the system is reachable');
      expect(out).not.toContain('handler.ts');
      expect(out).not.toContain('plain-util.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flag on: every real import touching a type-covered file joins the universe, named by file path (never a fabricated node)', () => {
    const dir = copyRelationGate('on', true);
    try {
      const { status, all } = run(['structure'], dir);
      expect(status).toBe(0);
      // svc/handler.ts -> owner (node-owned target, named by its node id) and
      // -> util/plain-util.ts (type-covered target, named by its own file path).
      expect(all).toContain('src/svc/handler.ts → owner');
      expect(all).toContain('src/svc/handler.ts → src/util/plain-util.ts');
      expect(all).toContain('src/util/plain-util.ts → owner');
      // The ambiguous file is never gated and never appears as an edge endpoint.
      expect(all).not.toContain('ambiguous.ts');
      // The reach caption honestly names the widened population.
      expect(all).toContain('From an average component or type-covered file,');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// type-coverage-basic-pass has exactly ONE classifying type (svc, matched by
// path: "src/svc/**") and no explicit node — the narrowest fixture that lets a
// broken predicate take out type-level classification ENTIRELY (covered.size
// reaches exactly 0), rather than merely shrinking it, so the command surviving
// intact is proven on the actual code path it takes today.
const PASS_TWIN = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-coverage-basic-pass');

describe.skipIf(!distExists)('yg structure — survives a malformed when: predicate', () => {
  it('a broken content regex on the one classifying type degrades the widening to the node-only view instead of crashing the read-only dashboard', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-structure-malformed-'));
    try {
      cpSync(PASS_TWIN, dir, { recursive: true });
      const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
      writeFileSync(
        archPath,
        readFileSync(archPath, 'utf-8').replace('path: "src/svc/**"', 'content: "([unclosed"'),
      );

      const { status, all } = run(['structure'], dir);
      // A read-only, never-gating dashboard survives a malformed architecture —
      // exit 0, same as any other run over this fixture.
      expect(status).toBe(0);
      // No type-covered file could be classified (the sole type's predicate is
      // broken), so the widening degrades to the plain node-only view: no file
      // path joins the universe, and the reach caption keeps its unwidened wording.
      expect(all).toContain('From an average component, ');
      expect(all).not.toContain('component or type-covered file');
      expect(all).not.toContain('handler.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
