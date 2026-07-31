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
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Hermetic E2E — ASPECT AUTHORING & the DETERMINISTIC CHECK CONTRACT: rule-source
// XOR validation, the check.mjs runtime contract (non-array/throw/async/file-write/
// file-not-in-ctx) via the `yg check --approve` fill and `yg aspect-test`, directory
// aspect-reference-broken, implies-edge when, when on relation/descendants atoms, and
// aspect-test error paths. Harness reused verbatim from
// cli-deterministic-fill-lifecycle.test.ts; fully hermetic.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

function run(
  args: string[],
  cwd: string,
): {
  stdout: string;
  stderr: string;
  status: number | null;
  all: string;
} {
  const result = spawnSync('node', [BIN_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/** Copy the e2e-lifecycle fixture into a fresh temp dir for mutation. */
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-authoring-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Copy the fixture and strip the LLM aspect (`has-doc-comment`) so the node's
 * effective aspects are purely deterministic. This keeps the suite hermetic:
 * no reviewer endpoint is ever contacted, every approve/context/check outcome is
 * reproducible, and only deterministic check.mjs runs drive every verdict.
 */
function deterministicFixture(label: string): string {
  const dir = copyFixture(label);
  const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  const arch = readFileSync(archPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '- has-doc-comment')
    .join('\n');
  writeFileSync(archPath, arch, 'utf-8');
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), {
    recursive: true,
    force: true,
  });
  return dir;
}

// --- path helpers (operate on the temp COPY only) ---------------------------

const ordersFile = (dir: string) => path.join(dir, 'src', 'services', 'orders.ts');
const aspectDir = (dir: string, id: string) => path.join(dir, '.yggdrasil', 'aspects', id);
const aspectYaml = (dir: string, id: string) => path.join(aspectDir(dir, id), 'yg-aspect.yaml');
const docCommentDir = (dir: string) => path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment');
const nodeYaml = (dir: string, node: string) =>
  path.join(dir, '.yggdrasil', 'model', ...node.split('/'), 'yg-node.yaml');

/** Author a deterministic aspect (yg-aspect.yaml + check.mjs) into the temp copy. */
function writeDeterministicAspect(dir: string, id: string, status: string, checkSource: string): void {
  const adir = aspectDir(dir, id);
  mkdirSync(adir, { recursive: true });
  writeFileSync(
    aspectYaml(dir, id),
    [
      `name: ${id.replace(/-/g, '')}`,
      `description: Authored deterministic aspect ${id}.`,
      'reviewer:',
      '  type: deterministic',
      `status: ${status}`,
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(path.join(adir, 'check.mjs'), checkSource, 'utf-8');
}

/** Prepend an aspect id to the orders node's own aspects: list (creating it). */
function attachToOrders(dir: string, aspectId: string): void {
  const p = nodeYaml(dir, 'services/orders');
  let s = readFileSync(p, 'utf-8');
  if (/^aspects:\n/m.test(s)) {
    s = s.replace(/^aspects:\n/m, `aspects:\n  - ${aspectId}\n`);
  } else {
    s = s.replace(/^mapping:/m, `aspects:\n  - ${aspectId}\nmapping:`);
  }
  writeFileSync(p, s, 'utf-8');
}

/**
 * Silence the two channels that deliver `no-todo-comments` unconditionally in
 * the committed fixture (the `service` architecture-type default, channel 3, and
 * the order-processing flow, channel 5), leaving a node's own declaration as the
 * sole delivery path. Required so a per-attach `when` on the node is the ONLY
 * thing that can include/exclude the aspect.
 */
function isolateNoTodoToNodeChannel(dir: string): void {
  const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  const arch = readFileSync(archPath, 'utf-8').replace(
    '    aspects:\n      - no-todo-comments\n      - requires-named-export\n',
    '    aspects:\n      - requires-named-export\n',
  );
  writeFileSync(archPath, arch, 'utf-8');
  const flowPath = path.join(dir, '.yggdrasil', 'flows', 'order-processing', 'yg-flow.yaml');
  const flow = readFileSync(flowPath, 'utf-8').replace(
    'aspects:\n  - no-todo-comments\n',
    'aspects: []\n',
  );
  writeFileSync(flowPath, flow, 'utf-8');
}

// `no-todo-comments [enforced]` is the stable heading substring `yg context`
// prints when the aspect is effective; it is wholly absent when `when` filters
// it out — the deterministic ground truth for "applies" vs "does not apply".
const EFFECTIVE_MARKER = 'no-todo-comments [enforced]';

// A check.mjs body that flags any line containing the given literal token.
function bannedLiteralCheck(literal: string): string {
  return [
    'export function check(ctx) {',
    '  const violations = [];',
    '  for (const file of ctx.files) {',
    "    const lines = file.content.split('\\n');",
    '    for (let i = 0; i < lines.length; i++) {',
    `      if (lines[i].includes(${JSON.stringify(literal)})) {`,
    `        violations.push({ file: file.path, line: i + 1, column: 0, message: ${JSON.stringify(`${literal} token found.`)} });`,
    '      }',
    '    }',
    '  }',
    '  return violations;',
    '}',
    '',
  ].join('\n');
}

describe.skipIf(!distExists)('CLI E2E — aspect authoring & deterministic check contract', () => {
  // =========================================================================
  // GROUP A — rule-source XOR (content.md vs check.mjs) validation via yg check.
  // checkAspectRuleSources (core/checks/aspect-contracts.ts). NOT pinned by any
  // other E2E suite. Each case mutates the committed fixture's aspect files in
  // the temp COPY to trip exactly one reviewer/rule-source mismatch.
  // =========================================================================

  it('A1: an LLM aspect missing content.md yields aspect-missing-rule-source (exit 1)', () => {
    // Keep the LLM aspect (do NOT strip it) but delete its content.md.
    const dir = copyFixture('a1');
    try {
      rmSync(path.join(docCommentDir(dir), 'content.md'), { force: true });
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('aspect-missing-rule-source');
      // The grouped Fix names the aspect's missing content.md (LLM rule source).
      expect(all).toContain('Create .yggdrasil/aspects/has-doc-comment/content.md describing the rule.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A2: a deterministic aspect missing check.mjs yields aspect-missing-rule-source (exit 1)', () => {
    const dir = deterministicFixture('a2');
    try {
      rmSync(path.join(aspectDir(dir, 'no-todo-comments'), 'check.mjs'), { force: true });
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('aspect-missing-rule-source');
      // The grouped Fix names the aspect's missing check.mjs (deterministic rule source).
      expect(all).toContain('Create .yggdrasil/aspects/no-todo-comments/check.mjs exporting a check function.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A3: a deterministic aspect carrying BOTH content.md and check.mjs yields aspect-both-rule-sources + aspect-unexpected-rule-source (exit 1)', () => {
    const dir = deterministicFixture('a3');
    try {
      // no-todo-comments already ships check.mjs; add an illegal content.md.
      writeFileSync(path.join(aspectDir(dir, 'no-todo-comments'), 'content.md'), 'Bogus LLM rule.\n', 'utf-8');
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('aspect-both-rule-sources');
      // The shared WHY explains exactly one rule source is allowed.
      expect(all).toContain('Exactly one rule source is allowed per aspect; the validator cannot infer intent.');
      // The mismatched-file companion error names content.md as the wrong source.
      expect(all).toContain('aspect-unexpected-rule-source');
      expect(all).toContain("Remove .yggdrasil/aspects/no-todo-comments/content.md or change reviewer to 'llm'.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A4: an LLM aspect carrying BOTH content.md and check.mjs yields aspect-both-rule-sources + aspect-unexpected-rule-source (exit 1)', () => {
    const dir = copyFixture('a4');
    try {
      // has-doc-comment already ships content.md; add an illegal check.mjs.
      writeFileSync(path.join(docCommentDir(dir), 'check.mjs'), 'export function check() { return []; }\n', 'utf-8');
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('aspect-both-rule-sources');
      // The shared WHY explains exactly one rule source is allowed.
      expect(all).toContain('Exactly one rule source is allowed per aspect; the validator cannot infer intent.');
      // The mismatched-file companion error names check.mjs as the wrong source.
      expect(all).toContain('aspect-unexpected-rule-source');
      expect(all).toContain("Remove .yggdrasil/aspects/has-doc-comment/check.mjs or change reviewer to 'deterministic'.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A5: reviewer.type llm WITH only check.mjs (no content.md) yields aspect-missing-rule-source + aspect-unexpected-rule-source (exit 1)', () => {
    const dir = copyFixture('a5');
    try {
      // Drop content.md and ship check.mjs instead — an llm aspect with the
      // deterministic reviewer's input and none of its own.
      rmSync(path.join(docCommentDir(dir), 'content.md'), { force: true });
      writeFileSync(path.join(docCommentDir(dir), 'check.mjs'), 'export function check() { return []; }\n', 'utf-8');
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      // Missing its OWN source (content.md) AND carrying the WRONG one (check.mjs).
      expect(all).toContain('aspect-missing-rule-source');
      expect(all).toContain('Create .yggdrasil/aspects/has-doc-comment/content.md describing the rule.');
      expect(all).toContain('aspect-unexpected-rule-source');
      expect(all).toContain("Remove .yggdrasil/aspects/has-doc-comment/check.mjs or change reviewer to 'deterministic'.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A6: reviewer.type deterministic WITH only content.md (no check.mjs) yields aspect-missing-rule-source + aspect-unexpected-rule-source (exit 1)', () => {
    const dir = deterministicFixture('a6');
    try {
      // Replace check.mjs with content.md — a deterministic aspect with the LLM
      // reviewer's input and none of its own.
      rmSync(path.join(aspectDir(dir, 'no-todo-comments'), 'check.mjs'), { force: true });
      writeFileSync(path.join(aspectDir(dir, 'no-todo-comments'), 'content.md'), 'Bogus LLM rule.\n', 'utf-8');
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('aspect-missing-rule-source');
      expect(all).toContain('Create .yggdrasil/aspects/no-todo-comments/check.mjs exporting a check function.');
      expect(all).toContain('aspect-unexpected-rule-source');
      expect(all).toContain("Remove .yggdrasil/aspects/no-todo-comments/content.md or change reviewer to 'llm'.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GROUP B — the deterministic check.mjs RUNTIME contract.
  //
  // The runners (structure runner for --node, AST runner for --files) guard the
  // author-authored check against returning a non-array, throwing, and returning
  // a Promise, and against synthesizing a violation for a file not in ctx.
  //
  // Two surfaces are pinned:
  //  * The ENFORCEMENT surface — `yg check --approve` (fill). A check that crashes
  //    or returns an invalid result is NOT a code refusal: the fill classifies it
  //    as `aspect-check-runtime-error` and LEAVES THE PAIR UNVERIFIED (no verdict
  //    written), so the run ends red (exit 1) until the check.mjs is fixed.
  //  * The DIAGNOSTIC surface — `yg aspect-test`. A classified runner error
  //    (StructureRunnerError / AstRunnerError) is now rendered as its structured
  //    what/why/next (parity across --node and --files), with exit 1 — NOT routed
  //    through the generic abortOnUnexpectedError "does not classify / file an
  //    issue" wrapper and NOT leaking the internal STRUCTURE_CHECK_* / AST_* code
  //    prefix. The runner's own message text is what we pin; the wrapper and the
  //    code token must be ABSENT.
  // =========================================================================

  it('B1: a check returning a NON-ARRAY is an aspect-check-runtime-error at fill time — left unverified (exit 1)', () => {
    const dir = deterministicFixture('b1');
    try {
      writeDeterministicAspect(dir, 'ret-nonarray', 'enforced', 'export function check(ctx) { return { nope: true }; }\n');
      attachToOrders(dir, 'ret-nonarray');
      const { status, all } = run(['check', '--approve'], dir);
      expect(status).toBe(1);
      // The fill reports a runtime error and leaves the pair unverified (no verdict).
      expect(all).toContain('ret-nonarray');
      expect(all).toContain('aspect-check-runtime-error');
      expect(all).toContain('check.mjs returned object, expected Violation[].');
      // The pair is left unverified: it surfaces as a grouped unverified block
      // with the fill-it Fix. The aspect appears on the body line (not the header).
      expect(all).toMatch(/unverified \(not yet reviewed\)\s+1 pairs\s+1 nodes$/m);
      expect(all).toContain("- services/orders  aspect 'ret-nonarray'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B2: a check returning a NON-ARRAY fails aspect-test --node (exit 1, structured runner message)', () => {
    const dir = deterministicFixture('b2');
    try {
      writeDeterministicAspect(dir, 'ret-nonarray', 'enforced', 'export function check(ctx) { return { nope: true }; }\n');
      attachToOrders(dir, 'ret-nonarray');
      const { status, all } = run(['aspect-test', '--aspect', 'ret-nonarray', '--node', 'services/orders'], dir);
      expect(status).toBe(1);
      // The structure runner error (a CLASSIFIED aspect-author error) is rendered
      // as its structured what/why/next — mirroring the --files path (B5/B7) — not
      // routed through the generic "does not classify / file an issue" wrapper or
      // leaking the internal STRUCTURE_CHECK_* code prefix.
      expect(all).toContain('check.mjs returned object, expected Violation[].');
      expect(all).not.toContain('STRUCTURE_CHECK_RETURN_SHAPE');
      expect(all).not.toContain('This is a bug — please file an issue');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B3: a check that THROWS is an aspect-check-runtime-error at fill time — left unverified (exit 1, error message)', () => {
    const dir = deterministicFixture('b3');
    try {
      writeDeterministicAspect(dir, 'thrower', 'enforced', 'export function check(ctx) { throw new Error("boom in check"); }\n');
      attachToOrders(dir, 'thrower');
      const { status, all } = run(['check', '--approve'], dir);
      expect(status).toBe(1);
      expect(all).toContain('thrower');
      expect(all).toContain('aspect-check-runtime-error');
      expect(all).toContain('boom in check');
      // The pair is left unverified: it surfaces as a grouped unverified block
      // with the fill-it Fix. The aspect appears on the body line (not the header).
      expect(all).toMatch(/unverified \(not yet reviewed\)\s+1 pairs\s+1 nodes$/m);
      expect(all).toContain("- services/orders  aspect 'thrower'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B4: a check that THROWS fails aspect-test --node (exit 1, structured runner message)', () => {
    const dir = deterministicFixture('b4');
    try {
      writeDeterministicAspect(dir, 'thrower', 'enforced', 'export function check(ctx) { throw new Error("boom in check"); }\n');
      attachToOrders(dir, 'thrower');
      const { status, all } = run(['aspect-test', '--aspect', 'thrower', '--node', 'services/orders'], dir);
      expect(status).toBe(1);
      // Structured what/why/next (parity with the --files path in B5); no internal
      // code prefix, no generic "file an issue" wrapper.
      expect(all).toContain("check.mjs threw an exception while running (aspect 'thrower').");
      expect(all).toContain('boom in check');
      expect(all).not.toContain('STRUCTURE_CHECK_THROWN');
      expect(all).not.toContain('This is a bug — please file an issue');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B5: a check that THROWS fails aspect-test --files via the single-file runner (exit 1, AST_CHECK_THROWN message)', () => {
    const dir = deterministicFixture('b5');
    try {
      // No node attachment needed for --files; the aspect just has to exist.
      writeDeterministicAspect(dir, 'thrower', 'enforced', 'export function check(ctx) { throw new Error("boom in check"); }\n');
      const { status, all } = run(
        ['aspect-test', '--aspect', 'thrower', '--files', 'src/services/orders.ts'],
        dir,
      );
      expect(status).toBe(1);
      // The AST (single-file) runner's AstRunnerError omits the code prefix from
      // its .message, so we pin the what/why text, not the AST_CHECK_THROWN token.
      expect(all).toContain("check.mjs threw an exception while running (aspect 'thrower').");
      expect(all).toContain('boom in check');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B6: an ASYNC check fails aspect-test --node (exit 1, structured runner message)', () => {
    const dir = deterministicFixture('b6');
    try {
      writeDeterministicAspect(dir, 'asyncer', 'enforced', 'export async function check(ctx) { return []; }\n');
      attachToOrders(dir, 'asyncer');
      const { status, all } = run(['aspect-test', '--aspect', 'asyncer', '--node', 'services/orders'], dir);
      expect(status).toBe(1);
      // Structured what/why/next (parity with the --files path in B7); no internal
      // code prefix, no generic "file an issue" wrapper.
      expect(all).toContain('check.mjs returned a Promise; only synchronous returns are supported.');
      expect(all).not.toContain('STRUCTURE_CHECK_ASYNC');
      expect(all).not.toContain('This is a bug — please file an issue');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B7: an ASYNC check fails aspect-test --files via the single-file runner (exit 1, async message)', () => {
    const dir = deterministicFixture('b7');
    try {
      writeDeterministicAspect(dir, 'asyncer', 'enforced', 'export async function check(ctx) { return []; }\n');
      const { status, all } = run(
        ['aspect-test', '--aspect', 'asyncer', '--files', 'src/services/orders.ts'],
        dir,
      );
      expect(status).toBe(1);
      expect(all).toContain('check.mjs returned a Promise; only synchronous returns are supported');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // BUG / CONTRACT NOTE (pinned, not encoded as desirable) — the runners do NOT
  // sandbox the check. A check.mjs that performs a side effect (node:fs write,
  // network I/O) is NOT caught by the runner: it FAILS OPEN — the write actually
  // happens and the check returns its violations as if nothing occurred.
  // CONTRACT (knowledge read writing-deterministic-aspects, "Purity rule"):
  //   "Do not write files, make network calls, or call process.exit ...
  //    respecting that is your responsibility." — i.e. the runtime does NOT
  //    enforce purity; --check-determinism is the only mechanism that catches an
  //    impure check, and only when the impurity makes the output vary across runs
  //    (already pinned in cli-deterministic-ctx S4b). We pin the fail-open fact:
  //    the write lands and the check reports "No violations" (exit 0).
  // (Network side effects are NOT asserted here: a real network call is
  //  non-hermetic and forbidden by this suite's rules; the runner provably does
  //  not sandbox it either — same fail-open semantics as the file write, just
  //  non-deterministically timed via an unhandled async rejection.)
  it('B8: a file-WRITE side effect is NOT sandboxed — the runner fails open (exit 0, the write lands)', () => {
    const dir = deterministicFixture('b8');
    try {
      // Write the sentinel under a path inside the temp graph so the side effect
      // stays fully contained in the per-test mkdtemp (cleaned in finally).
      const sentinel = path.join(dir, 'SIDE_EFFECT_SENTINEL.txt');
      writeDeterministicAspect(
        dir,
        'writer',
        'enforced',
        [
          "import { writeFileSync } from 'node:fs';",
          'export function check(ctx) {',
          `  writeFileSync(${JSON.stringify(sentinel)}, 'written by check.mjs');`,
          '  return [];',
          '}',
          '',
        ].join('\n'),
      );
      expect(existsSync(sentinel)).toBe(false);
      const { status, all } = run(
        ['aspect-test', '--aspect', 'writer', '--files', 'src/services/orders.ts'],
        dir,
      );
      // Runner fails open: it reports no violations and the side effect happened.
      expect(status).toBe(0);
      expect(all).toContain('No violations.');
      expect(existsSync(sentinel)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B9: a check synthesizing a violation for a file NOT in ctx fails aspect-test --files (exit 1, AST_CHECK_FILE_NOT_IN_CONTEXT)', () => {
    const dir = deterministicFixture('b9');
    try {
      // Return a violation referencing a file the single-file runner was not
      // handed — the runner rejects it rather than failing open.
      writeDeterministicAspect(
        dir,
        'badfile',
        'enforced',
        [
          'export function check(ctx) {',
          "  return [{ file: 'src/services/NOT_GIVEN.ts', line: 1, column: 0, message: 'synthesized for an unseen file' }];",
          '}',
          '',
        ].join('\n'),
      );
      const { status, all } = run(
        ['aspect-test', '--aspect', 'badfile', '--files', 'src/services/orders.ts'],
        dir,
      );
      expect(status).toBe(1);
      expect(all).toContain("Violation referencing file 'src/services/NOT_GIVEN.ts' which is not in ctx.files");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B10: a check.mjs that FAILS TO IMPORT is aspect-check-runtime-error at the --only-deterministic fill boundary — left unverified, nothing written (exit 1)', () => {
    const dir = deterministicFixture('b10');
    try {
      // A top-level UNRESOLVABLE import makes the dynamic import() of check.mjs
      // REJECT before the check function ever runs — the load-time analogue of B3's
      // call-time throw. The runner's loadHookModule wraps it as
      // STRUCTURE_LOADER_RESOLVE_FAILED; the fill-det boundary must classify that
      // the SAME way as any other check crash — aspect-check-runtime-error — and
      // leave the pair UNVERIFIED with NO lock write. So the free, keyless CI gate
      // (`--approve --only-deterministic`) stays RED over a check it could never
      // load, never a false green. Group B's other fill cases (B1/B3) pin CALL-time
      // failures; this pins the IMPORT/LOAD-time failure at the same boundary.
      writeDeterministicAspect(
        dir,
        'import-broken',
        'enforced',
        [
          "import { nope } from 'this-module-does-not-exist';",
          'export function check(ctx) { void ctx; void nope; return []; }',
          '',
        ].join('\n'),
      );
      attachToOrders(dir, 'import-broken');

      // The free, keyless CI / pre-commit gate — deterministic-only fill. A
      // check.mjs that cannot even load is an infra disposition, not a code refusal.
      const { status, all } = run(['check', '--approve', '--only-deterministic'], dir);
      expect(status).toBe(1);
      expect(all).toContain('import-broken');
      expect(all).toContain('aspect-check-runtime-error');
      // The loader names the IMPORT-time cause (module could not be loaded), not a
      // call-time throw — distinguishing this from B3.
      expect(all).toContain('Failed to load check.mjs');
      // The pair is left unverified (no verdict written): grouped unverified block
      // naming the node + aspect, exactly like the call-time B1/B3 fill failures.
      expect(all).toMatch(/unverified \(not yet reviewed\)\s+1 pairs\s+1 nodes$/m);
      expect(all).toContain("- services/orders  aspect 'import-broken'");

      // NO false green: a later plain `yg check` never executes check.mjs — it
      // re-hashes the lock, finds NO entry for this pair (the failed fill wrote
      // nothing to the deterministic cache), and stays RED with the pair unverified.
      const after = run(['check'], dir);
      expect(after.status).toBe(1);
      expect(after.all).toMatch(/unverified \(not yet reviewed\)\s+1 pairs\s+1 nodes$/m);
      expect(after.all).toContain("- services/orders  aspect 'import-broken'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GROUP C — references validation gap (the directory variant of
  // aspect-reference-broken; cli-check-validation 6a pins only the missing-file
  // variant). Every other aspect-reference* code is already pinned by
  // cli-validation-codes / cli-check-validation (see SKIPPED in the report).
  // =========================================================================

  it('C1: an LLM aspect reference resolving to a DIRECTORY yields aspect-reference-broken (exit 1)', () => {
    const dir = copyFixture('c1');
    try {
      mkdirSync(path.join(dir, 'docs', 'atable'), { recursive: true });
      appendFileSync(aspectYaml(dir, 'has-doc-comment'), 'references:\n  - docs/atable\n');
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('aspect-reference-broken');
      // The shared WHY explains references must be regular files; the grouped Fix
      // names the offending aspect's yg-aspect.yaml.
      expect(all).toContain('reference files must be regular files; directories cannot be loaded into the reviewer prompt.');
      expect(all).toContain('.yggdrasil/aspects/has-doc-comment/yg-aspect.yaml');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GROUP D — implies edges: `when` on the implies edge, and a draft implier.
  // cli-implies covers bare implies, recursion, removal, status_inherit, cycles.
  // It does NOT cover a `when` on the implies edge object form, nor the
  // draft-implier-with-draft-implied divergence below.
  // =========================================================================

  // The implier `no-todo-comments` (service type default) implies `no-banned-word`
  // via the object form `{ id, when }`. The `when` is a relation atom: it passes
  // only when the node declares a `calls` relation to services/payments.
  it('D1: an implies edge object-form `when` (TRUE) pulls the implied aspect into the effective set', () => {
    const dir = deterministicFixture('d1-when-true');
    try {
      writeDeterministicAspect(dir, 'no-banned-word', 'enforced', bannedLiteralCheck('BANNED'));
      // Object-form implies edge with a relation-atom when on no-todo-comments.
      writeFileSync(
        aspectYaml(dir, 'no-todo-comments'),
        [
          'name: NoTodoComments',
          'description: Source files must not contain TODO comments.',
          'reviewer:',
          '  type: deterministic',
          'status: enforced',
          'implies:',
          '  - id: no-banned-word',
          '    when:',
          '      relations:',
          '        calls:',
          '          target: services/payments',
          '',
        ].join('\n'),
        'utf-8',
      );
      // orders declares the calls→payments relation → the edge `when` is TRUE.
      writeFileSync(
        nodeYaml(dir, 'services/orders'),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'relations:',
          '  - target: services/payments',
          '    type: calls',
          'mapping:',
          '  - src/services/orders.ts',
          '',
        ].join('\n'),
        'utf-8',
      );

      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain('no-banned-word [enforced]');
      expect(ctx.stdout).toContain("implied by 'no-todo-comments'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('D2: an implies edge object-form `when` (FALSE) excludes the implied aspect from the effective set', () => {
    const dir = deterministicFixture('d2-when-false');
    try {
      writeDeterministicAspect(dir, 'no-banned-word', 'enforced', bannedLiteralCheck('BANNED'));
      writeFileSync(
        aspectYaml(dir, 'no-todo-comments'),
        [
          'name: NoTodoComments',
          'description: Source files must not contain TODO comments.',
          'reviewer:',
          '  type: deterministic',
          'status: enforced',
          'implies:',
          '  - id: no-banned-word',
          '    when:',
          '      relations:',
          '        calls:',
          '          target: services/payments',
          '',
        ].join('\n'),
        'utf-8',
      );
      // orders declares NO relation → the edge `when` is FALSE → implied excluded.
      // (The committed orders node has no relations, so leave it untouched.)
      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      // The implied aspect is NOT in the effective set: it has no heading line
      // (`no-banned-word [<status>]`) and no "implied by" provenance line. (The
      // implier's static `Implies: no-banned-word` line still prints — that names
      // the declared edge, not an effective aspect — so we must not assert on the
      // bare token.)
      expect(ctx.stdout).not.toContain('no-banned-word [');
      expect(ctx.stdout).not.toContain("implied by 'no-todo-comments'");

      // Enforcement follows: a BANNED line is NOT flagged (the aspect never reached
      // the node), so a clean-but-for-BANNED fill records no refusal and passes.
      appendFileSync(ordersFile(dir), '\n// this constant is BANNED here\n');
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      expect(fill.stdout).toContain('yg check: PASS');
      // The edge `when` excludes no-banned-word from the effective set, so it
      // produces no pair and never refuses the BANNED line. Attached only through
      // that never-satisfied edge, it is effective on zero nodes — the dead-attach
      // linter reports that as a non-blocking warning, now its sole appearance.
      expect(fill.all).not.toContain('— refused');
      expect(fill.stdout).toContain('aspect-effective-nowhere');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A DRAFT implier is dormant for implies set-membership: it does NOT pull its
  // implied aspect into the effective set. computeEffectiveAspects and
  // computeEffectiveAspectStatuses agree (both skip draft impliers), so yg context
  // omits the implied aspect and a fill never evaluates it.
  // (Contract: agent-rules "Reviewer" / knowledge read aspect-status — a draft
  // aspect is dormant; an implied aspect arrives only via a NON-draft channel.)
  it('D3: a DRAFT implier does NOT propagate its implied aspect — context omits it and the fill does not evaluate it (exit 0)', () => {
    const dir = deterministicFixture('d3-draft-implier');
    try {
      // no-banned-word: own default DRAFT, attached NOWHERE except via the edge.
      writeDeterministicAspect(dir, 'no-banned-word', 'draft', bannedLiteralCheck('BANNED'));
      // draft-implier: DRAFT, implies the draft aspect, attached on orders only.
      writeDeterministicAspect(dir, 'draft-implier', 'draft', 'export function check(ctx) { return []; }\n');
      writeFileSync(
        aspectYaml(dir, 'draft-implier'),
        [
          'name: draftimplier',
          'description: A draft implier of a draft-default aspect.',
          'reviewer:',
          '  type: deterministic',
          'status: draft',
          'implies:',
          '  - no-banned-word',
          '',
        ].join('\n'),
        'utf-8',
      );
      attachToOrders(dir, 'draft-implier');

      // context: the implier itself is draft; the dormant implier does NOT pull
      // its implied aspect into the effective set, so no-banned-word is absent.
      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain('draft-implier [draft]');
      // no-banned-word is NOT an effective aspect entry (it only appears in the
      // implier's "Implies:" metadata line, never as a `no-banned-word [status]` entry).
      expect(ctx.stdout).not.toContain('no-banned-word [');
      expect(ctx.stdout).not.toContain("implied by 'draft-implier'");

      // fill: the implied aspect is dormant, so a BANNED line is NOT evaluated and
      // neither the draft implier nor its implied aspect produces a verifiable pair.
      appendFileSync(ordersFile(dir), '\n// this constant is BANNED here\n');
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      expect(fill.stdout).toContain('yg check: PASS');
      // Neither the dormant implier nor the never-reached implied aspect is filled.
      expect(fill.stdout).not.toContain('[det] draft-implier');
      expect(fill.stdout).not.toContain('no-banned-word');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GROUP E — `when` on a relation atom and on a descendants atom for an aspect
  // attach. cli-conditional-when covers only the node.* atoms (type / has_port /
  // has_mapping) and the boolean combinators; the relations / descendants atoms
  // of the aspect-when grammar are unexercised end-to-end.
  // =========================================================================

  it('E1: a per-attach `when` on a RELATION atom includes the aspect when the relation exists and excludes it otherwise', () => {
    const dir = deterministicFixture('e1-relation-atom');
    try {
      isolateNoTodoToNodeChannel(dir);
      // orders: a calls→payments relation present AND a node-attached
      // no-todo-comments gated on that same relation → predicate TRUE.
      writeFileSync(
        nodeYaml(dir, 'services/orders'),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'aspects:',
          '  - id: no-todo-comments',
          '    when:',
          '      relations:',
          '        calls:',
          '          target: services/payments',
          'relations:',
          '  - target: services/payments',
          '    type: calls',
          'mapping:',
          '  - src/services/orders.ts',
          '',
        ].join('\n'),
        'utf-8',
      );
      const present = run(['context', '--node', 'services/orders'], dir);
      expect(present.status).toBe(0);
      expect(present.stdout).toContain(EFFECTIVE_MARKER);

      // payments: SAME gated attach but NO relation → predicate FALSE → excluded.
      writeFileSync(
        nodeYaml(dir, 'services/payments'),
        [
          'name: PaymentsService',
          'description: Charges and refunds payments for orders.',
          'type: service',
          'aspects:',
          '  - id: no-todo-comments',
          '    when:',
          '      relations:',
          '        calls:',
          '          target: services/payments',
          'mapping:',
          '  - src/services/payments.ts',
          '',
        ].join('\n'),
        'utf-8',
      );
      const absent = run(['context', '--node', 'services/payments'], dir);
      expect(absent.status).toBe(0);
      expect(absent.stdout).not.toContain(EFFECTIVE_MARKER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E2: a per-attach `when` on a DESCENDANTS atom includes the aspect on a parent with matching descendants and excludes it otherwise', () => {
    const dir = deterministicFixture('e2-descendants-atom');
    try {
      isolateNoTodoToNodeChannel(dir);
      // Attach no-todo-comments on the `services` module, gated on having a
      // descendant of type `service` → TRUE (orders + payments are services).
      writeFileSync(
        nodeYaml(dir, 'services'),
        [
          'name: Services',
          'description: Organizational grouping of services.',
          'type: module',
          'aspects:',
          '  - id: no-todo-comments',
          '    when:',
          '      descendants:',
          '        type: service',
          '',
        ].join('\n'),
        'utf-8',
      );
      const matched = run(['context', '--node', 'services'], dir);
      expect(matched.status).toBe(0);
      expect(matched.stdout).toContain(EFFECTIVE_MARKER);

      // Re-gate on a descendant TYPE the subtree does not contain (`module`) →
      // FALSE → the aspect drops off the parent's effective list.
      writeFileSync(
        nodeYaml(dir, 'services'),
        [
          'name: Services',
          'description: Organizational grouping of services.',
          'type: module',
          'aspects:',
          '  - id: no-todo-comments',
          '    when:',
          '      descendants:',
          '        type: module',
          '',
        ].join('\n'),
        'utf-8',
      );
      const unmatched = run(['context', '--node', 'services'], dir);
      expect(unmatched.status).toBe(0);
      expect(unmatched.stdout).not.toContain(EFFECTIVE_MARKER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GROUP F — yg aspect-test error paths. (cli-deterministic-ctx covers the
  // both-modes / neither-mode guards; these are the remaining argument / target
  // errors, the LLM-aspect-in-files-mode guard, and the tier-irrelevance
  // confirmation for deterministic aspects.)
  // =========================================================================

  it('F1: aspect-test with an unknown --aspect id is rejected (exit 1)', () => {
    const dir = deterministicFixture('f1');
    try {
      const { status, all } = run(['aspect-test', '--aspect', 'does-not-exist', '--node', 'services/orders'], dir);
      expect(status).toBe(1);
      expect(all).toContain("Aspect 'does-not-exist' not found.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F2: aspect-test --node on a nonexistent node is rejected (exit 1)', () => {
    const dir = deterministicFixture('f2');
    try {
      const { status, all } = run(['aspect-test', '--aspect', 'no-todo-comments', '--node', 'no/such/node'], dir);
      expect(status).toBe(1);
      expect(all).toContain("Node 'no/such/node' not found.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // BUG (pinned, not encoded as correct) — a nonexistent --files path is an
  // EXPECTED user error (a typo'd path) but surfaces through the generic
  // abortOnUnexpectedError wrapper as an unclassified ENOENT crash ("This is a
  // bug — please file an issue"), rather than a clean what/why/next telling the
  // user the file does not exist. We pin the actual ENOENT + exit 1.
  it('F3: aspect-test --files on a nonexistent path fails (exit 1, ENOENT)', () => {
    const dir = deterministicFixture('f3');
    try {
      const { status, all } = run(
        ['aspect-test', '--aspect', 'no-todo-comments', '--files', 'src/services/MISSING.ts'],
        dir,
      );
      expect(status).toBe(1);
      expect(all).toContain('ENOENT');
      expect(all).toContain('src/services/MISSING.ts');
      // BUG: rendered as an unclassified crash (see note above).
      expect(all).toContain('This is a bug — please file an issue');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // aspect-test now ACCEPTS LLM aspects in --node mode (it runs the reviewer, or
  // prints the prompt under --dry-run) — the old deterministic-only rejection is
  // gone. The remaining kind guard is in --files (ad-hoc) mode: an LLM review
  // needs graph context an ad-hoc file list cannot supply, so --files on an LLM
  // aspect is rejected with a clear what/why/next.
  it('F4: aspect-test --files on an LLM --aspect is rejected — LLM reviews need graph context (exit 1)', () => {
    // Keep the LLM aspect this time (do NOT strip it) so we can target it.
    const dir = copyFixture('f4');
    try {
      const { status, all } = run(['aspect-test', '--aspect', 'has-doc-comment', '--files', 'src/services/orders.ts'], dir);
      expect(status).toBe(1);
      expect(all).toContain("--files cannot be used with LLM aspect 'has-doc-comment'.");
      expect(all).toContain('Use --node <node-path> or --file <path> instead, or switch to a deterministic aspect for --files mode.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Tier selection is irrelevant for a deterministic aspect: the fixture config
  // declares a `standard` reviewer tier (an LLM concept), yet aspect-test runs the
  // check.mjs locally with zero LLM involvement and never dials the reviewer
  // endpoint. (A tier declared ON a deterministic aspect is a separate validation
  // error — aspect-tier-on-deterministic — already pinned in cli-validation-codes
  // C4.) Here we confirm the run succeeds regardless of the configured tier and
  // contacts no endpoint.
  it('F5: tier is irrelevant for deterministic — aspect-test runs the check locally and passes (exit 0), no endpoint dialed', () => {
    const dir = deterministicFixture('f5');
    try {
      // Sanity: the config still carries a reviewer tier (the thing being ignored).
      const cfg = readFileSync(path.join(dir, '.yggdrasil', 'yg-config.yaml'), 'utf-8');
      expect(cfg).toContain('tiers:');
      const { status, all } = run(['aspect-test', '--aspect', 'no-todo-comments', '--node', 'services/orders'], dir);
      expect(status).toBe(0);
      expect(all).toContain('No violations.');
      // No reviewer/tier/endpoint chatter — the deterministic path bypasses it.
      expect(all).not.toContain('endpoint');
      expect(all).not.toContain('not reachable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
