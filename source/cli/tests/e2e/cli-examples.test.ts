// =============================================================================
// The shipped examples/ projects must be valid and self-contained: the README
// walks adopters through `cd examples/passing && yg check` (PASS) and
// `cd examples/failing && yg check` (the requires-audit refusal). Each example
// ships a COMMITTED .yggdrasil/yg-lock.json, so `yg check` is a PURE READ that
// reproduces the verdict from the lock with NO API key / NO reviewer — exactly
// what an adopter (and CI) sees. This test spawns the built binary against both
// examples and asserts the documented outcome, so the examples cannot silently
// rot (they predate the verdict-lock model once already).
//
// The LLM examples (passing/failing) are READ-ONLY here — plain `yg check` only,
// reproducing the committed verdict with no reviewer. The keyless examples use a
// deterministic `check.mjs` or the built-in relation check, so they need no key
// either: the relation example is green on plain `yg check`, and the
// deterministic examples reach green via the FREE, keyless
// `yg check --approve --only-deterministic` fill (no reviewer, no network).
//
// NO module under source/cli/src/** is imported anywhere in this file. The
// expected canonical digest hash (E11 below) is obtained by spawning
// `yg prime --digest` — the same public command an adopter would run — never
// by importing the template that generates it.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');       // source/cli
const REPO_ROOT = path.join(CLI_ROOT, '..', '..');       // repo root
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

/** Digest anchor line format — `<!-- yggdrasil:digest cli=<version>
 *  sha256=<hex> -->` — a stable, documented part of the committed-artifact
 *  contract: it is visible verbatim in AGENTS.md, .clinerules/yggdrasil.md,
 *  and `yg prime --digest` output. Hand-duplicated here rather than imported
 *  from templates/digest.js (mirrors cli-universal-install.test.ts). */
const ANCHOR_RE = /<!-- yggdrasil:digest cli=(?<cli>[^ ]+) sha256=(?<sha256>[0-9a-f]{64}) -->/;

// Every shipped example project, for the E11 universal-install check below.
// Derived by listing examples/ and keeping only entries that carry a
// .yggdrasil/ directory (i.e. are actual Yggdrasil-managed projects, not
// stray files like README.md) — so a newly-added example is picked up
// automatically instead of silently going uncovered by a hardcoded list.
function listExampleDirs(): string[] {
  const examplesRoot = path.join(REPO_ROOT, 'examples');
  return readdirSync(examplesRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(path.join(examplesRoot, name, '.yggdrasil')))
    .sort();
}
const ALL_EXAMPLES = listExampleDirs();

function ygCheck(exampleDir: string): { all: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, 'check'], {
    cwd: path.join(REPO_ROOT, 'examples', exampleDir),
    encoding: 'utf-8',
  });
  return { all: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status };
}

/**
 * The canonical digest hash, obtained by spawning `yg prime --digest` (the
 * public command) rather than importing the template that generates it.
 * `prime --digest` does no project I/O, so CLI_ROOT works fine as `cwd`.
 * Memoized — every case in this file targets the same build.
 */
let cachedCanonicalSha256: string | undefined;
function canonicalDigestSha256(): string {
  if (!cachedCanonicalSha256) {
    const r = spawnSync('node', [BIN_PATH, 'prime', '--digest'], { cwd: CLI_ROOT, encoding: 'utf-8' });
    if (r.status !== 0) {
      throw new Error(`yg prime --digest failed unexpectedly (exit ${r.status}): ${(r.stdout ?? '') + (r.stderr ?? '')}`);
    }
    const anchorLine = (r.stdout ?? '').split('\n', 1)[0];
    const m = anchorLine.match(ANCHOR_RE);
    if (!m?.groups?.sha256) {
      throw new Error(`yg prime --digest produced an unrecognized anchor line: ${anchorLine}`);
    }
    cachedCanonicalSha256 = m.groups.sha256;
  }
  return cachedCanonicalSha256;
}

// Free, keyless deterministic fill: runs the example's check.mjs locally and
// writes ONLY the gitignored deterministic cache — no reviewer, no API key, no
// network. This is how the keyless deterministic examples reach green from a
// clean clone (their verdict is not committed; it is rebuilt for free).
function ygFillDeterministic(exampleDir: string): { all: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, 'check', '--approve', '--only-deterministic'], {
    cwd: path.join(REPO_ROOT, 'examples', exampleDir),
    encoding: 'utf-8',
  });
  return { all: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status };
}

describe.skipIf(!distExists)('CLI E2E — shipped examples are valid + reproducible (read-only, no reviewer)', () => {
  it('examples/passing — yg check PASS from the committed lock, no API key', () => {
    const r = ygCheck('passing');
    expect(r.status).toBe(0);
    expect(r.all).toContain('yg check: PASS');
  });

  it('examples/failing — yg check FAIL showing the requires-audit refusal on payments', () => {
    const r = ygCheck('failing');
    expect(r.status).toBe(1);
    expect(r.all).toContain('refused');
    expect(r.all).toContain("requires-audit");
    expect(r.all).toContain('payments');
  });

  // --- Keyless examples (deterministic check.mjs + built-in relation check) ---
  // No reviewer, no API key. The relation example is green on plain `yg check`;
  // the deterministic examples reach green via the free `--only-deterministic`
  // fill (which writes only the gitignored cache).

  it('examples/layered-architecture — plain yg check PASS (live relation check, no key)', () => {
    const r = ygCheck('layered-architecture');
    expect(r.status).toBe(0);
    expect(r.all).toContain('yg check: PASS');
  });

  for (const name of ['no-secrets-in-logs', 'pure-transforms', 'checkout-flow']) {
    it(`examples/${name} — free deterministic fill reaches PASS, no key`, () => {
      const fill = ygFillDeterministic(name);
      expect(fill.status).toBe(0);
      expect(fill.all).toContain('yg check: PASS');
      // Plain check then re-hashes the cached verdict — still green, still keyless.
      const r = ygCheck(name);
      expect(r.status).toBe(0);
      expect(r.all).toContain('yg check: PASS');
    });
  }

  // --- E11: every shipped example carries the CURRENT universal install ---
  //
  // The thirteen per-platform installers are retired; every example project
  // now carries the SAME three artifacts (AGENTS.md digest block matching
  // the installed CLI's canonical hash, a CLAUDE.md @AGENTS.md import, and
  // .clinerules/yggdrasil.md), and `yg check` never flags them stale or
  // uncovered — kept in its own per-example `it` so a red E11 case never
  // masks this file's other assertions.
  for (const name of ALL_EXAMPLES) {
    it(`examples/${name} — carries the universal install artifacts, and yg check never flags them stale or uncovered (E11)`, () => {
      const dir = path.join(REPO_ROOT, 'examples', name);
      expect(existsSync(path.join(dir, 'AGENTS.md'))).toBe(true);
      expect(existsSync(path.join(dir, 'CLAUDE.md'))).toBe(true);
      expect(existsSync(path.join(dir, '.clinerules', 'yggdrasil.md'))).toBe(true);

      const agents = readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8');
      expect(agents).toMatch(ANCHOR_RE);
      expect(agents.match(ANCHOR_RE)?.groups?.sha256).toBe(canonicalDigestSha256());

      const r = ygCheck(name);
      expect(r.all).not.toContain('rules-digest-stale');
      expect(r.all).not.toContain('unmapped-files');
      expect(r.all).not.toContain('uncovered-advisory');
    });
  }
});
