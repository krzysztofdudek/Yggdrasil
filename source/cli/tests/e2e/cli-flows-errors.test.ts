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
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// FLOW definition + filesystem ERROR paths (the uncovered FL-DEF / FL-ERR
// cases). Everything is driven through the spawned dist binary (yg check / yg
// flows / yg check --approve). This suite pins the flow-parser and flow-loader
// error surfaces that the other flow suites do NOT reach:
//
//   N*  flow `name:` edges — EMPTY name ("") parse throw (cli-flows-extended P4
//       pins MISSING name, not empty); plus the same throw surfacing via
//       `yg flows`, not only `yg check`.
//   A*  flow `aspects:` shape edges — a NON-ARRAY scalar and an EMPTY (null)
//       key both raise "'aspects' must be an array of strings"; a MISSING
//       aspects key is VALID (exit 0). (cli-flows-extended P-series only pins
//       node/name/description errors, never the aspects-shape branch.)
//   B   non-string node entry — BOOLEAN variant exercising the `(boolean)`
//       type-label branch (P3 pins only the `(number)` branch).
//   D*  flow `description:` edge — an EMPTY ("") description trips
//       description-missing exactly like a MISSING key (P5 pins MISSING only).
//   F*  flow FILESYSTEM errors — a flow directory whose yg-flow.yaml is MISSING,
//       is a DIRECTORY (EISDIR), is UNPARSEABLE YAML (tab indent), or parses to
//       a NON-MAPPING (scalar / top-level array); and a STRAY non-directory file
//       directly under flows/ that the loader must ignore.
//   R   flow RENAME (directory + name field) with the participant/aspect set
//       UNCHANGED does NOT cascade — check stays green (a flow's identity is
//       cosmetic; only its effective aspect/participant set drives drift).
//   P   flow batch PARTIAL-failure isolation — one participant approves, the
//       other still refuses, exit 1 (cli-flow-channel5 test 3 pins a fill where
//       the cascaded aspect catches one drifted node; this pins isolation across
//       a 2-node fill: one PASS + one FAIL in the same invocation).
//
// Flow-load FILESYSTEM/parse failures are classified as a flow-specific
// what/why/next by the loader preamble (they name the offending yg-flow.yaml and
// say it is missing/malformed on an ALREADY-INITIALIZED graph):
//   * A flow directory with a MISSING yg-flow.yaml (ENOENT) is NOT mis-reported
//     as "No .yggdrasil/ directory found" — the graph IS initialized; the error
//     names the absent flow file instead.
//   * yg-flow.yaml being a DIRECTORY (EISDIR) / unparseable YAML surfaces as the
//     SAME structured flow finding, not an unclassified "Unexpected error ...
//     This is a bug" abort.
// A genuinely-missing `.yggdrasil/` still yields the "run yg init" message
// (G1) — the narrowing preserves that path.
//
// Verdict-lock model: `yg approve` is gone — verification happens via
// `yg check --approve` (repo-wide fill), state lives in
// `.yggdrasil/yg-lock.json`, and the states are verified/unverified/refused.
//
// HERMETIC: every test copies the committed e2e-lifecycle fixture into a fresh
// mkdtemp, mutates ONLY that copy, and rmSync's it in `finally`. The LLM aspect
// (`has-doc-comment`) is stripped so the reviewer endpoint is never contacted —
// only deterministic check.mjs aspects drive every outcome. No network, no
// clock, no randomness in any assertion.
// ---------------------------------------------------------------------------

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
  const dir = mkdtempSync(path.join(tmpdir(), `yg-flowerr-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Copy the fixture and strip the LLM aspect (`has-doc-comment`) so every node's
 * effective aspects are purely deterministic. No reviewer endpoint is ever
 * contacted, so the suite is hermetic and reproducible.
 */
function deterministicFixture(label: string): string {
  const dir = copyFixture(label);
  const arch = readFileSync(archPath(dir), 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '- has-doc-comment')
    .join('\n');
  writeFileSync(archPath(dir), arch, 'utf-8');
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), {
    recursive: true,
    force: true,
  });
  return dir;
}

// --- path helpers (operate on the temp COPY only) ---------------------------

const archPath = (dir: string) => path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
const flowsRoot = (dir: string) => path.join(dir, '.yggdrasil', 'flows');
const flowDir = (dir: string) => path.join(flowsRoot(dir), 'order-processing');
const flowYaml = (dir: string) => path.join(flowDir(dir), 'yg-flow.yaml');
const paymentsFile = (dir: string) => path.join(dir, 'src', 'services', 'payments.ts');
const noTodoCheckMjs = (dir: string) =>
  path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments', 'check.mjs');

/** Overwrite the order-processing flow file with raw YAML lines. */
function writeFlowYaml(dir: string, lines: string[]): void {
  writeFileSync(flowYaml(dir), lines.join('\n') + '\n', 'utf-8');
}

/** Fill every unverified pair (repo-wide) so a later check sees only the flow finding. */
function baselineParticipants(dir: string): void {
  expect(run(['check', '--approve'], dir).status).toBe(0);
}

describe.skipIf(!distExists)('CLI E2E — flow definition + filesystem error paths', () => {
  // =========================================================================
  // N. flow `name:` edges.
  // =========================================================================

  it('N1: an EMPTY name (name: "") is a parse throw, distinct from a MISSING name (exit 1)', () => {
    const dir = deterministicFixture('n1');
    try {
      writeFlowYaml(dir, [
        'name: ""',
        'description: A flow whose name is an empty string.',
        'nodes:',
        '  - services/orders',
        'aspects:',
        '  - no-todo-comments',
      ]);
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain("missing or empty 'name'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('N2: the same name parse throw surfaces via `yg flows` as a flow-specific finding (exit 1)', () => {
    const dir = deterministicFixture('n2');
    try {
      writeFlowYaml(dir, [
        'description: A flow file that omits the name field.',
        'nodes:',
        '  - services/orders',
      ]);
      const flows = run(['flows'], dir);
      expect(flows.status).toBe(1);
      expect(flows.all).toContain("missing or empty 'name'");
      // A malformed flow file is a USER graph error, not an internal bug — it is
      // classified as a flow-specific finding naming the file, NOT the generic
      // "Unexpected error ... file an issue" abort.
      expect(flows.all).toContain('could not be loaded');
      expect(flows.all).toContain('yg-flow.yaml');
      expect(flows.all).not.toContain('Unexpected error while listing flows');
      expect(flows.all).not.toContain('file an issue');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // A. flow `aspects:` shape edges.
  // =========================================================================

  it('A1: a NON-ARRAY (scalar) aspects value is rejected as "must be an array of strings" (exit 1)', () => {
    const dir = deterministicFixture('a1');
    try {
      writeFlowYaml(dir, [
        'name: OrderProcessing',
        'description: A flow whose aspects field is a bare scalar.',
        'nodes:',
        '  - services/orders',
        'aspects: no-todo-comments',
      ]);
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain("'aspects' must be an array of strings");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A2: an EMPTY aspects key (aspects: with a null value) is the SAME non-array error (exit 1)', () => {
    const dir = deterministicFixture('a2');
    try {
      // `aspects:` present but null — raw.aspects !== undefined yet not an Array.
      writeFlowYaml(dir, [
        'name: OrderProcessing',
        'description: A flow with an empty (null) aspects key.',
        'nodes:',
        '  - services/orders',
        'aspects:',
      ]);
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain("'aspects' must be an array of strings");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A3: a MISSING aspects key entirely is VALID — an aspect-less flow loads and check passes (exit 0)', () => {
    const dir = deterministicFixture('a3');
    try {
      baselineParticipants(dir);
      // No `aspects:` key at all → optional → flow loads with no flow aspects.
      writeFlowYaml(dir, [
        'name: OrderProcessing',
        'description: A flow that declares no aspects at all.',
        'nodes:',
        '  - services/orders',
        '  - services/payments',
      ]);
      const check = run(['check'], dir);
      expect(check.status).toBe(0);
      expect(check.stdout).toContain('PASS');
      // The flow still lists, just with no Aspects line.
      const flows = run(['flows'], dir);
      expect(flows.status).toBe(0);
      expect(flows.stdout).toContain('OrderProcessing');
      expect(flows.stdout).toContain('Participants: 2 nodes (services/orders, services/payments)');
      expect(flows.stdout).not.toContain('Aspects:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // B. non-string node entry — boolean type-label branch.
  // =========================================================================

  it('B1: a BOOLEAN node entry is rejected with its index and the (boolean) type label (exit 1)', () => {
    const dir = deterministicFixture('b1');
    try {
      writeFlowYaml(dir, [
        'name: OrderProcessing',
        'description: A flow with a boolean node entry.',
        'nodes:',
        '  - services/orders',
        '  - true',
        'aspects:',
        '  - no-todo-comments',
      ]);
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('contains non-string entry [index 1: true (boolean)]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // D. flow `description:` edge — empty string trips description-missing.
  // =========================================================================

  it('D1: an EMPTY description (description: "") trips description-missing, same as a MISSING key (exit 1)', () => {
    const dir = deterministicFixture('d1');
    try {
      baselineParticipants(dir);
      // The parser trims the description; "" trims to falsy → treated as absent.
      writeFlowYaml(dir, [
        'name: OrderProcessing',
        'description: ""',
        'nodes:',
        '  - services/orders',
        '  - services/payments',
        'aspects:',
        '  - no-todo-comments',
      ]);
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      // Grouped view: an empty description trips description-missing just like a
      // missing key. The per-issue `what` (the flow name) is no longer in the
      // default body; assert the group label + shared why/fix.
      expect(check.stdout).toContain('description-missing');
      expect(check.stdout).toContain('Description is used in context output');
      expect(check.stdout).toContain('Add a description field to yg-flow.yaml.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // F. flow FILESYSTEM errors.
  // =========================================================================

  it('F1: a flow directory whose yg-flow.yaml is MISSING blocks check with a flow-specific finding, NOT "run yg init" (exit 1)', () => {
    const dir = deterministicFixture('f1');
    try {
      rmSync(flowYaml(dir), { force: true });
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      // The graph IS initialized (the .yggdrasil/ tree and the flow directory
      // both exist); the absent yg-flow.yaml raises ENOENT but is classified as a
      // flow-load fault naming the file — NOT the misleading not-initialized
      // message that would send the user to `yg init`.
      expect(check.all).toContain('could not be loaded');
      expect(check.all).toContain('order-processing/yg-flow.yaml');
      expect(check.all).toContain('missing, unreadable, or malformed');
      expect(check.all).not.toContain('No .yggdrasil/ directory found');
      expect(check.all).not.toContain("Run 'yg init'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F2: a flow directory with a MISSING yg-flow.yaml breaks `yg check --approve` with the same flow-specific finding (exit 1)', () => {
    const dir = deterministicFixture('f2');
    try {
      rmSync(flowYaml(dir), { force: true });
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      // The graph cannot load, so the fill aborts up front — but with the
      // flow-specific message, never the not-initialized misclassification.
      expect(fill.all).toContain('could not be loaded');
      expect(fill.all).toContain('order-processing/yg-flow.yaml');
      expect(fill.all).not.toContain('No .yggdrasil/ directory found');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F3: a yg-flow.yaml that is a DIRECTORY (EISDIR) surfaces as a structured flow finding, NOT an unclassified abort (exit 1)', () => {
    const dir = deterministicFixture('f3');
    try {
      rmSync(flowYaml(dir), { force: true });
      mkdirSync(flowYaml(dir), { recursive: true });
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      // A flow YAML that is a directory raises EISDIR on read; it is classified
      // as a flow-load fault (naming the file + the EISDIR detail), NOT a generic
      // "Unexpected error ... file an issue" abort.
      expect(check.all).toContain('could not be loaded');
      expect(check.all).toContain('EISDIR');
      expect(check.all).not.toContain('Unexpected error while running check');
      expect(check.all).not.toContain('file an issue');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F4: an UNPARSEABLE yg-flow.yaml (tab indentation) surfaces as a structured flow finding, NOT an unclassified abort (exit 1)', () => {
    const dir = deterministicFixture('f4');
    try {
      // A tab as indentation is a hard YAML syntax error.
      writeFileSync(flowYaml(dir), 'name: X\n\tnodes: [a]\n', 'utf-8');
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      // A YAML syntax error in a flow file is classified as a flow-load fault
      // (naming the file + the parser detail), NOT a generic unclassified abort.
      expect(check.all).toContain('could not be loaded');
      expect(check.all).toContain('Tabs are not allowed as indentation');
      expect(check.all).not.toContain('Unexpected error while running check');
      expect(check.all).not.toContain('file an issue');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F5: a yg-flow.yaml that parses to a SCALAR (not a mapping) is rejected as "not a valid YAML mapping" (exit 1)', () => {
    const dir = deterministicFixture('f5');
    try {
      writeFileSync(flowYaml(dir), 'just a bare string\n', 'utf-8');
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('file is empty or not a valid YAML mapping');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F6: a yg-flow.yaml whose top level is an ARRAY is rejected as "not a valid YAML mapping" (exit 1)', () => {
    const dir = deterministicFixture('f6');
    try {
      writeFileSync(flowYaml(dir), '- services/orders\n- services/payments\n', 'utf-8');
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('file is empty or not a valid YAML mapping');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F7: a STRAY non-directory file directly under flows/ is ignored by the loader (exit 0, flow count unchanged)', () => {
    const dir = deterministicFixture('f7');
    try {
      baselineParticipants(dir);
      // A loose file in flows/ is not a flow directory → loader skips it.
      writeFileSync(path.join(flowsRoot(dir), 'README.md'), '# notes, not a flow\n', 'utf-8');
      const check = run(['check'], dir);
      expect(check.status).toBe(0);
      expect(check.stdout).toContain('PASS');
      // Still exactly one flow — the stray file was not counted.
      expect(check.stdout).toContain('1 flows');
      const flows = run(['flows'], dir);
      expect(flows.status).toBe(0);
      const participantLines = flows.stdout
        .split('\n')
        .filter((l) => l.includes('Participants:'));
      expect(participantLines.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // G. genuine no-graph — the narrowing preserves the "run yg init" message.
  // =========================================================================

  it('G1: a directory with NO .yggdrasil/ still yields the "run yg init" message, not a flow finding (exit 1)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-flowerr-g1-'));
    try {
      // A bare directory: no graph at all. The flow-error narrowing must not
      // swallow the genuine not-initialized case.
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('No .yggdrasil/ directory found');
      expect(check.all).toContain("Run 'yg init'");
      expect(check.all).not.toContain('could not be loaded');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // R. flow RENAME — identity change WITHOUT a set change does NOT cascade.
  // =========================================================================

  it('R1: renaming a flow (directory + name) with an UNCHANGED participant/aspect set does NOT cascade — check stays green (exit 0)', () => {
    const dir = deterministicFixture('r1');
    try {
      baselineParticipants(dir);
      expect(run(['check'], dir).status).toBe(0);

      // Rename the flow directory and its `name:` field; participants + aspects
      // are byte-for-byte the same effective set.
      const renamed = path.join(flowsRoot(dir), 'fulfillment');
      renameSync(flowDir(dir), renamed);
      const yamlPath = path.join(renamed, 'yg-flow.yaml');
      const updated = readFileSync(yamlPath, 'utf-8').replace(/^name:.*/m, 'name: Fulfillment');
      writeFileSync(yamlPath, updated, 'utf-8');

      // The participants' effective-aspect sets are unchanged → no drift, so no
      // pair goes unverified and check stays green.
      const check = run(['check'], dir);
      expect(check.status).toBe(0);
      expect(check.stdout).toContain('PASS');
      expect(check.stdout).not.toContain('unverified');

      // The flow lists under its new name.
      const flows = run(['flows'], dir);
      expect(flows.status).toBe(0);
      expect(flows.stdout).toContain('Fulfillment');
      expect(flows.stdout).not.toContain('OrderProcessing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // P. fill PARTIAL-failure isolation across flow participants.
  // =========================================================================

  it('P1: a fill isolates failures — one participant approves, the other refuses, exit 1', () => {
    const dir = deterministicFixture('p1');
    try {
      // Baseline both participants clean.
      baselineParticipants(dir);

      // Invalidate the flow aspect's verdict on BOTH participants by a no-op edit
      // to its check.mjs (an aspect-input change, not a source change) so the
      // next fill re-runs `no-todo-comments` on each participant.
      appendFileSync(noTodoCheckMjs(dir), '\n// cascade-trigger: trivial no-op comment\n');

      // Then violate ONLY payments at the source. The repo-wide fill re-runs each
      // node's deterministic checks independently: orders is clean and payments
      // refuses — one node's failure does not abort the clean node.
      appendFileSync(paymentsFile(dir), '\n// TODO: fix later\n');

      const batch = run(['check', '--approve'], dir);
      expect(batch.status).toBe(1);
      // One node passed, one failed — failures do not abort the clean node.
      expect(batch.stderr).toContain('[det] no-todo-comments on node:services/payments — refused');
      // The refusal renders as an enforced finding naming the violating node.
      expect(batch.stdout).toContain('enforced');
      expect(batch.stdout).toContain('services/payments');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P2: the fill records the refusal — a re-run finds nothing to do, and fixing the source clears it (exit 0)', () => {
    const dir = deterministicFixture('p2');
    try {
      baselineParticipants(dir);
      appendFileSync(noTodoCheckMjs(dir), '\n// cascade-trigger: trivial no-op comment\n');

      // First fill: orders approves, payments refuses (exit 1). The fill RECORDS
      // payments' refused enforced verdict in the lock.
      const original = readFileSync(paymentsFile(dir), 'utf-8');
      appendFileSync(paymentsFile(dir), '\n// TODO: fix later\n');
      expect(run(['check', '--approve'], dir).status).toBe(1);

      // The recorded enforced REFUSAL still blocks check (cached — same inputs).
      const afterBatch = run(['check'], dir);
      expect(afterBatch.status).toBe(1);
      expect(afterBatch.stdout).toContain('enforced');
      expect(afterBatch.stdout).toContain('services/payments');
      // A second fill finds nothing to do — every pair already holds a valid
      // verdict (the refused verdict is cached against unchanged inputs).
      const second = run(['check', '--approve'], dir);
      expect(second.status).toBe(1);
      // Fill progress (including "0 reviewer calls made" notice) goes to STDERR.
      expect(second.stderr).toContain('0 reviewer calls made — all expected pairs hold valid verdicts');

      // Fixing the source changes the inputs → the pair goes unverified again →
      // the next fill re-runs the now-clean check and approves it.
      writeFileSync(paymentsFile(dir), original, 'utf-8');
      expect(run(['check', '--approve'], dir).status).toBe(0);

      const cleared = run(['check'], dir);
      expect(cleared.status).toBe(0);
      expect(cleared.stdout).toContain('PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
