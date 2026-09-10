// =============================================================================
// CLI E2E — authoring a marketplace: start one, scaffold a package, check it.
//
// The publishing side of packages. Every scenario drives the real binary, and
// every repository here is built at test time — ZERO NETWORK, no clone, no
// registry, nothing to reach. The one thing worth stating up front is what
// scenarios 16 and 17 exist to prove: a marketplace repository need not have a
// `.yggdrasil/` at all, so `marketplace check` must never load a graph, must
// never ask for one, and must not behave differently when one happens to be
// sitting there.
//
//   Starting one
//    1. init in an empty git repository → a manifest with nothing published
//    2. init with .github/workflows/    → a CI file, and never a second one
//    3. init over an existing manifest  → refused, and the manifest untouched
//    4. init outside a git repository   → refused, naming the missing repository
//   Scaffolding a package
//    5. pack new                        → the skeleton, the entry, and check passes
//    6. pack new twice                  → refused, the directory untouched
//    7. pack new with a separator       → refused: a name is one segment
//    8. pack new with unicode           → accepted, and carried everywhere
//   One fixture, one fault, one code
//    9. an entry with no directory     → marketplace-entry-missing
//   10. a directory with no entry      → marketplace-dir-unlisted
//   11. implies reaching outside       → package-implies-escapes, naming both
//   12. a setting read, never declared → package-config-undeclared, naming key and file
//   13. a glob anchored to a directory → package-scope-literal-root, quoting it
//   14. a review date in a package     → package-review-by-present
//   15. a rule with no cases           → package-drills-missing, naming the rule
//   No graph, ever
//   16. no manifest                    → refused by name, and no word about .yggdrasil/
//   17. a marketplace that has a graph → identical outcome, graph ignored
//   Edges worth pinning
//   18. twenty rules                   → inside the stated bound
//   19. a rule file that cannot be read → refused, naming it, not a crash
//   20. a manifest that will not parse → refused, naming the file
//   The agent's side
//   21. yg knowledge read              → the topic prints
//   22. yg prime                       → one extra sentence in a marketplace
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir, platform } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGitFixture } from '../support/git-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURES = path.join(CLI_ROOT, 'tests', 'fixtures');
const BAD = path.join(FIXTURES, 'marketplace-bad');
const distExists = existsSync(BIN_PATH);

interface Run {
  stdout: string;
  stderr: string;
  status: number | null;
  all: string;
}

function run(args: string[], cwd: string): Run {
  const r = spawnSync('node', [BIN_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
    // No colour, so an assertion on a word is not defeated by an escape
    // sequence landing in the middle of it.
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return { stdout, stderr, status: r.status, all: stdout + stderr };
}

/** A throwaway directory. */
function dir(label: string): string {
  return mkdtempSync(path.join(tmpdir(), `yg-mkt-${label}-`));
}

/** A throwaway git repository. */
function repo(label: string): string {
  const d = dir(label);
  runGitFixture(d, ['init', '-q', '-b', 'main']);
  return d;
}

/** A copy of one committed negative fixture, so the original is never written to. */
function badFixture(label: string, name: string): string {
  const d = dir(label);
  cpSync(path.join(BAD, name), d, { recursive: true });
  return d;
}

const read = (d: string, rel: string): string => readFileSync(path.join(d, rel), 'utf-8');

describe.skipIf(!distExists)('CLI E2E — authoring a marketplace', () => {
  // -------------------------------------------------------------------------
  // Starting one
  // -------------------------------------------------------------------------

  it('1: init in an empty git repository writes a manifest with nothing published', () => {
    const d = repo('init');
    try {
      const r = run(['marketplace', 'init'], d);
      expect(r.status).toBe(0);
      expect(existsSync(path.join(d, 'packages'))).toBe(true);
      const manifest = read(d, 'yg-marketplace.yaml');
      expect(manifest).toContain('schema: yg-marketplace/1');
      expect(manifest).toContain('packages: []');
      // Nothing published yet is a valid marketplace, and the check says so.
      expect(run(['marketplace', 'check'], d).status).toBe(0);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('2: with .github/workflows/ present a CI file is written, and never a second one', () => {
    const d = repo('initci');
    try {
      mkdirSync(path.join(d, '.github', 'workflows'), { recursive: true });
      expect(run(['marketplace', 'init'], d).status).toBe(0);
      const workflow = path.join(d, '.github', 'workflows', 'yg-marketplace.yml');
      expect(existsSync(workflow)).toBe(true);
      expect(read(d, '.github/workflows/yg-marketplace.yml')).toContain('marketplace check');
      const before = read(d, '.github/workflows/yg-marketplace.yml');

      // Running init again is refused by the manifest before the workflow is
      // reached, so the file cannot be doubled that way either.
      expect(run(['marketplace', 'init'], d).status).toBe(1);
      expect(read(d, '.github/workflows/yg-marketplace.yml')).toBe(before);

      // And with the manifest gone — the only way back to the workflow branch —
      // the existing file is left alone rather than refused or rewritten.
      rmSync(path.join(d, 'yg-marketplace.yaml'));
      const again = run(['marketplace', 'init'], d);
      expect(again.status).toBe(0);
      expect(read(d, '.github/workflows/yg-marketplace.yml')).toBe(before);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('3: init over an existing manifest is refused, and the manifest is untouched', () => {
    const d = repo('initexisting');
    try {
      const original = 'schema: yg-marketplace/1\npackages:\n  - name: mine\n    path: packages/mine\n    version: 2.0.0\n';
      writeFileSync(path.join(d, 'yg-marketplace.yaml'), original, 'utf-8');
      const r = run(['marketplace', 'init'], d);
      expect(r.status).toBe(1);
      expect(r.all).toContain('yg-marketplace.yaml');
      expect(r.all).toContain('yg pack new');
      expect(read(d, 'yg-marketplace.yaml')).toBe(original);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('4: init outside a git repository is refused, naming what is missing', () => {
    const d = dir('initnogit');
    try {
      const r = run(['marketplace', 'init'], d);
      expect(r.status).toBe(1);
      expect(r.all).toContain('git repository');
      expect(r.all).toContain('git init');
      expect(existsSync(path.join(d, 'yg-marketplace.yaml'))).toBe(false);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Scaffolding a package
  // -------------------------------------------------------------------------

  /** A marketplace with one scaffolded package, ready for the scenarios below. */
  function scaffolded(label: string, name = 'demo'): string {
    const d = repo(label);
    run(['marketplace', 'init'], d);
    run(['pack', 'new', name], d);
    return d;
  }

  it('5: pack new scaffolds a package, publishes it, and the result passes the check', () => {
    const d = repo('packnew');
    try {
      run(['marketplace', 'init'], d);
      const r = run(['pack', 'new', 'demo'], d);
      expect(r.status).toBe(0);

      for (const rel of [
        'packages/demo/yg-package.yaml',
        'packages/demo/example/yg-aspect.yaml',
        'packages/demo/example/check.mjs',
      ]) {
        expect(existsSync(path.join(d, rel)), rel).toBe(true);
      }
      // The directory is `drills`, and the case prefix is exactly violates-/satisfies-.
      expect(existsSync(path.join(d, 'packages/demo/example/drills/violates-marker-left-behind'))).toBe(true);
      expect(existsSync(path.join(d, 'packages/demo/example/drills/satisfies-clean'))).toBe(true);
      expect(read(d, 'packages/demo/example/check.mjs')).toContain('ctx.config.example');

      const manifest = read(d, 'yg-marketplace.yaml');
      expect(manifest).toContain('name: demo');
      expect(manifest).toContain('path: packages/demo');
      // The comments init wrote are still there: the manifest was edited, not
      // regenerated from data.
      expect(manifest).toContain('# This repository publishes Yggdrasil rules.');

      const check = run(['marketplace', 'check'], d);
      expect(check.all).toContain('Ready to publish');
      expect(check.status).toBe(0);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('6: pack new for a name already there is refused, and the directory is untouched', () => {
    const d = scaffolded('packnewtwice');
    try {
      const before = read(d, 'packages/demo/yg-package.yaml');
      const r = run(['pack', 'new', 'demo'], d);
      expect(r.status).toBe(1);
      expect(r.all).toContain('packages/demo');
      expect(read(d, 'packages/demo/yg-package.yaml')).toBe(before);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('7: a package name with a separator in it is refused', () => {
    const d = repo('packnewslash');
    try {
      run(['marketplace', 'init'], d);
      const r = run(['pack', 'new', 'acme/house-style'], d);
      expect(r.status).toBe(1);
      expect(r.all).toContain('single path segment');
      expect(existsSync(path.join(d, 'packages', 'acme'))).toBe(false);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('8: a package name outside ASCII is accepted and carried everywhere', () => {
    const d = repo('packnewunicode');
    const name = 'reguły-domu';
    try {
      run(['marketplace', 'init'], d);
      const r = run(['pack', 'new', name], d);
      expect(r.status).toBe(0);
      expect(existsSync(path.join(d, 'packages', name, 'yg-package.yaml'))).toBe(true);
      expect(read(d, `packages/${name}/yg-package.yaml`)).toContain(`name: ${name}`);
      expect(read(d, 'yg-marketplace.yaml')).toContain(name);
      expect(run(['marketplace', 'check'], d).status).toBe(0);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // One fixture, one fault, one code
  // -------------------------------------------------------------------------

  /** Run the check over a copy of one committed negative fixture. */
  function checkBad(label: string, fixture: string): Run {
    const d = badFixture(label, fixture);
    try {
      return run(['marketplace', 'check'], d);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }

  it('9: an entry naming a directory that is not there is refused with its own code', () => {
    const r = checkBad('entrymissing', 'entry-without-dir');
    expect(r.status).toBe(1);
    expect(r.all).toContain('marketplace-entry-missing');
    expect(r.all).toContain('packages/ghost');
  });

  it('10: a package directory the manifest never names is refused with its own code', () => {
    const r = checkBad('dirunlisted', 'dir-without-entry');
    expect(r.status).toBe(1);
    expect(r.all).toContain('marketplace-dir-unlisted');
    expect(r.all).toContain('packages/stray');
  });

  it('11: implies reaching outside the package is refused, naming both', () => {
    const r = checkBad('impliesescapes', 'implies-escapes');
    expect(r.status).toBe(1);
    expect(r.all).toContain('package-implies-escapes');
    expect(r.all).toContain('bundle');
    expect(r.all).toContain('somebody-elses-rule');
  });

  it('12: a setting read and never declared is refused, naming the key and the file', () => {
    const r = checkBad('configundeclared', 'config-undeclared');
    expect(r.status).toBe(1);
    expect(r.all).toContain('package-config-undeclared');
    expect(r.all).toContain('threshold');
    expect(r.all).toContain('check.mjs');
  });

  it('13: a glob anchored to a directory name is refused, quoting the glob', () => {
    const r = checkBad('scopeliteral', 'scope-literal-root');
    expect(r.status).toBe(1);
    expect(r.all).toContain('package-scope-literal-root');
    expect(r.all).toContain('src/**/*.ts');
  });

  it('14: a review date inside a package is refused', () => {
    const r = checkBad('reviewby', 'review-by-present');
    expect(r.status).toBe(1);
    expect(r.all).toContain('package-review-by-present');
    expect(r.all).toContain('2027-01-31');
  });

  it('15: a deterministic rule with no cases is refused, naming the rule', () => {
    const r = checkBad('nodrills', 'no-drills');
    expect(r.status).toBe(1);
    expect(r.all).toContain('package-drills-missing');
    expect(r.all).toContain('file-length');
  });

  // -------------------------------------------------------------------------
  // No graph, ever
  // -------------------------------------------------------------------------

  it('16: with no manifest the refusal names that file, and never mentions a graph', () => {
    const d = dir('nomanifest');
    try {
      writeFileSync(path.join(d, 'README.md'), '# not a marketplace\n', 'utf-8');
      const r = run(['marketplace', 'check'], d);
      expect(r.status).toBe(1);
      expect(r.all).toContain('yg-marketplace.yaml');
      expect(r.all).toContain('marketplace-manifest-missing');
      // If this command loaded a graph, THIS is the message it would have
      // produced instead — a marketplace has no graph and must never be told
      // to make one.
      expect(r.all).not.toContain('.yggdrasil');
      expect(r.all).not.toContain('yg init');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('17: a graph that happens to be there changes nothing', () => {
    const clean = badFixture('withoutgraph', 'review-by-present');
    const withGraph = badFixture('withgraph', 'review-by-present');
    try {
      const before = run(['marketplace', 'check'], withGraph);
      // A graph, and a deliberately broken one at that: if anything here read
      // it, this would stop looking like the run above.
      mkdirSync(path.join(withGraph, '.yggdrasil', 'model'), { recursive: true });
      writeFileSync(path.join(withGraph, '.yggdrasil', 'yg-config.yaml'), 'version: nonsense\n', 'utf-8');
      const after = run(['marketplace', 'check'], withGraph);
      const control = run(['marketplace', 'check'], clean);

      expect(after.status).toBe(before.status);
      expect(after.status).toBe(control.status);
      expect(after.all).toContain('package-review-by-present');
      expect(after.all).not.toContain('yg init');
    } finally {
      rmSync(clean, { recursive: true, force: true });
      rmSync(withGraph, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Edges worth pinning
  // -------------------------------------------------------------------------

  it('18: a package of twenty rules is checked inside the stated bound', () => {
    const d = scaffolded('twenty');
    try {
      const names: string[] = [];
      for (let i = 0; i < 20; i++) {
        const rule = `rule-${String(i).padStart(2, '0')}`;
        names.push(rule);
        const ruleDir = path.join(d, 'packages', 'demo', rule);
        mkdirSync(path.join(ruleDir, 'drills', 'violates-a', 'src'), { recursive: true });
        mkdirSync(path.join(ruleDir, 'drills', 'satisfies-a', 'src'), { recursive: true });
        writeFileSync(
          path.join(ruleDir, 'yg-aspect.yaml'),
          `name: Rule${i}\ndescription: One of twenty rules, so the check is measured at scale.\nreviewer:\n  type: deterministic\n`,
          'utf-8',
        );
        writeFileSync(
          path.join(ruleDir, 'check.mjs'),
          'export function check(ctx) {\n  return ctx.subject.length === 0 ? [] : [];\n}\n',
          'utf-8',
        );
        writeFileSync(path.join(ruleDir, 'drills', 'violates-a', 'src', 'x.ts'), 'export const a = 1;\n', 'utf-8');
        writeFileSync(path.join(ruleDir, 'drills', 'satisfies-a', 'src', 'x.ts'), 'export const a = 1;\n', 'utf-8');
      }
      const manifest = path.join(d, 'packages', 'demo', 'yg-package.yaml');
      writeFileSync(
        manifest,
        readFileSync(manifest, 'utf-8').replace('  - example\n', `  - example\n${names.map((n) => `  - ${n}\n`).join('')}`),
        'utf-8',
      );

      // The bound is the test's own timeout, not a reading of the clock inside
      // the assertion: a wall-clock comparison would measure the machine's load
      // as much as the command, and fail on a busy runner for reasons that have
      // nothing to do with the code. Overrunning thirty seconds fails the test.
      const r = run(['marketplace', 'check'], d);
      expect(r.status).toBe(0);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(platform() === 'win32')('19: a rule file that cannot be read is refused by name, not thrown', () => {
    const d = scaffolded('unreadable');
    // The rule's own script: one of the files the check genuinely opens, so an
    // unreadable one is a fact about the package rather than about the walk.
    const locked = path.join(d, 'packages', 'demo', 'example', 'check.mjs');
    try {
      chmodSync(locked, 0o000);
      const r = run(['marketplace', 'check'], d);
      expect(r.status).toBe(1);
      expect(r.all).toContain('package-file-unreadable');
      expect(r.all).toContain('check.mjs');
      // A refusal, not a stack and not the generic "file an issue" abort.
      expect(r.all).not.toContain('Unexpected error');
    } finally {
      chmodSync(locked, 0o644);
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('20: a manifest that will not parse is refused, naming the file', () => {
    const d = scaffolded('brokenyaml');
    try {
      // A literal tab is the classic cause: YAML indentation is spaces only.
      writeFileSync(
        path.join(d, 'yg-marketplace.yaml'),
        'schema: yg-marketplace/1\npackages:\n\t- name: demo\n',
        'utf-8',
      );
      const r = run(['marketplace', 'check'], d);
      expect(r.status).toBe(1);
      expect(r.all).toContain('marketplace-manifest-invalid');
      expect(r.all).toContain('yg-marketplace.yaml');
      expect(r.all).not.toContain('Unexpected error');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // The agent's side
  // -------------------------------------------------------------------------

  it('21: the knowledge topic prints, and says the three things it must', () => {
    const d = dir('knowledge');
    try {
      const r = run(['knowledge', 'read', 'packages-and-marketplaces'], d);
      expect(r.status).toBe(0);
      expect(r.stdout.length).toBeGreaterThan(1000);
      expect(r.stdout).toContain('never edit one');
      expect(r.stdout).toContain('yg-aspect.adapt.yaml');
      expect(r.stdout).toContain('implies: [naming]');
      expect(run(['knowledge', 'list'], d).stdout).toContain('packages-and-marketplaces');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('22: yg prime adds exactly one sentence in a marketplace, and none elsewhere', () => {
    // The probe DID land: it lives in the command module (which may touch the
    // disk) and builds its sentence with a function exported from the knowledge
    // template, mirroring digestBlockBody. Nothing was added to the hand-tuned
    // rules content, so the "do not generate programmatically" note there is
    // untouched.
    const plain = dir('primeplain');
    const market = repo('primemarket');
    try {
      run(['marketplace', 'init'], market);
      const without = run(['prime'], plain);
      const with_ = run(['prime'], market);
      expect(without.status).toBe(0);
      expect(with_.status).toBe(0);

      const a = without.stdout.split('\n');
      const b = with_.stdout.split('\n');
      const extra = b.filter((line) => !a.includes(line));
      expect(extra.filter((line) => line.trim() !== '')).toHaveLength(1);
      expect(extra.join('')).toContain('packages-and-marketplaces');
    } finally {
      rmSync(plain, { recursive: true, force: true });
      rmSync(market, { recursive: true, force: true });
    }
  });
});
