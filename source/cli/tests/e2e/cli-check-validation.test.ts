import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  cpSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Hermetic E2E harness.
//
// Every test spawns the REAL built binary (dist/bin.js) against a COPY of a
// fixture (or a freshly-scaffolded minimal graph) inside a per-test mkdtemp
// directory, then asserts on the process exit code and stdout substrings.
//
// Determinism guarantees:
//   - No test reads the network, the wall clock, or any random source.
//   - `yg check` runs purely on the local graph + filesystem (no LLM call),
//     so no reviewer endpoint is contacted. The minimal graphs nonetheless
//     declare a reviewer tier pointed at a loopback address that is never
//     dialed, so even a future code path that resolved the tier would not
//     reach a real host.
//   - The committed fixtures under tests/fixtures/ are never mutated — each
//     test works on a cpSync copy in mkdtemp and removes it in a finally block.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const SAMPLE_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project');

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

/** Copy the committed sample-project fixture into a fresh temp dir for mutation. */
function copySampleProject(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-checkval-${label}-`));
  cpSync(SAMPLE_FIXTURE, dir, { recursive: true });
  return dir;
}

// A loopback reviewer endpoint that is never dialed by `yg check`. Used only so
// the scaffolded config carries a syntactically valid reviewer tier — no test
// depends on this host being reachable or absent.
const LOOPBACK_ENDPOINT = 'http://127.0.0.1:11434';

/**
 * Scaffold a minimal but structurally-complete graph in a fresh temp dir:
 *   - a single `service` node type whose `when` matches everything (so a node
 *     MAY carry a mapping without tripping `type-without-when-with-mapping`),
 *   - a config with one reviewer tier (so `config-reviewer-missing` never adds
 *     noise),
 *   - an empty model/ directory (required by the graph loader).
 *
 * The `build` callback then writes the scenario-specific nodes/aspects/flows.
 * Returns the temp dir; caller is responsible for rmSync cleanup.
 */
function minimalGraph(label: string, build: (ygRoot: string) => void): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-checkval-${label}-`));
  const ygRoot = path.join(dir, '.yggdrasil');
  mkdirSync(path.join(ygRoot, 'model'), { recursive: true });
  mkdirSync(path.join(ygRoot, 'aspects'), { recursive: true });
  mkdirSync(path.join(ygRoot, 'flows'), { recursive: true });

  writeFileSync(
    path.join(ygRoot, 'yg-architecture.yaml'),
    [
      'node_types:',
      '  service:',
      "    description: 'A service'",
      '    log_required: false',
      '    when:',
      '      path: "**"',
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(
    path.join(ygRoot, 'yg-config.yaml'),
    [
      'version: "6.0.0"', 'quality:',
      '  max_direct_relations: 10',
      'reviewer:',
      '  tiers:',
      '    standard:',
      '      provider: ollama',
      '      consensus: 1',
      '      config:',
      '        model: test',
      `        endpoint: ${LOOPBACK_ENDPOINT}`,
      '',
    ].join('\n'),
    'utf-8',
  );

  build(ygRoot);
  return dir;
}

/** Write a yg-node.yaml under model/<nodePath>/. */
function writeNode(ygRoot: string, nodePath: string, yaml: string): void {
  const nodeDir = path.join(ygRoot, 'model', ...nodePath.split('/'));
  mkdirSync(nodeDir, { recursive: true });
  writeFileSync(path.join(nodeDir, 'yg-node.yaml'), yaml, 'utf-8');
}

/** Write an aspect (yg-aspect.yaml + a rule-source file) under aspects/<id>/. */
function writeAspect(
  ygRoot: string,
  id: string,
  yaml: string,
  ruleSource: { file: 'content.md' | 'check.mjs'; body: string } | null,
): void {
  const aspectDir = path.join(ygRoot, 'aspects', ...id.split('/'));
  mkdirSync(aspectDir, { recursive: true });
  writeFileSync(path.join(aspectDir, 'yg-aspect.yaml'), yaml, 'utf-8');
  if (ruleSource) {
    writeFileSync(path.join(aspectDir, ruleSource.file), ruleSource.body, 'utf-8');
  }
}

/** Write a yg-flow.yaml under flows/<name>/. */
function writeFlow(ygRoot: string, dirName: string, yaml: string): void {
  const flowDir = path.join(ygRoot, 'flows', dirName);
  mkdirSync(flowDir, { recursive: true });
  writeFileSync(path.join(flowDir, 'yg-flow.yaml'), yaml, 'utf-8');
}

// ---------------------------------------------------------------------------
// Suite: `yg check` surfaces blocking VALIDATION codes through the spawned
// binary (exit 1 + the code substring). Every code string below was verified
// against the validator/checks/parser source before being asserted.
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)('CLI E2E — yg check surfaces blocking validation codes', () => {
  // --- 1. node-size budget ---------------------------------------------------
  // DELETED: the `oversized-node` error and the `quality.max_node_chars` budget
  // were removed in the verdict-lock redesign. The per-node character ceiling is
  // gone; prompt size is now bounded per LLM tier by `max_prompt_chars`
  // (surfaced as `prompt-too-large` at fill/check time on the assembled reviewer
  // prompt, not on a node's mapped-file byte count). No `max_node_chars` value
  // can fire any error anymore, so the original "oversized-node fires" assertion
  // tests a surface that no longer exists. The two negative cases below are
  // retained: they still prove the live property that a large deterministic-only
  // or aspect-less node does NOT block `yg check`.

  it('1b: a large node whose only aspect is deterministic does NOT block check', () => {
    // A deterministic check.mjs reads files programmatically (no context window),
    // so a node with a large mapped file but reviewed only deterministically must
    // not be flagged by any size constraint. `max_node_chars` is now an ignored
    // (removed) key; this asserts the live no-block behavior regardless.
    const dir = minimalGraph('oversized-det', (ygRoot) => {
      const root = path.dirname(ygRoot);
      writeAspect(
        ygRoot,
        'no-fs',
        'name: NoFs\ndescription: x\nreviewer:\n  type: deterministic\n',
        { file: 'check.mjs', body: 'export function check() { return []; }\n' },
      );
      writeNode(ygRoot, 'big', 'name: Big\ntype: service\ndescription: x\naspects:\n  - no-fs\nmapping:\n  - src/big.ts\n');
      mkdirSync(path.join(root, 'src'), { recursive: true });
      writeFileSync(path.join(root, 'src', 'big.ts'), '// large mapped source — no per-node byte ceiling exists anymore\n'.repeat(50), 'utf-8');
    });
    try {
      const { stdout } = run(['check'], dir);
      expect(stdout).not.toContain('oversized-node');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('1c: a large aspect-less node does NOT block check — it passes (exit 0)', () => {
    // An aspect-less node is never sent to a reviewer at all and has no ASPECT verdict to
    // fill, so a large mapped file produces no reviewer error of any kind. Strong form:
    // exit 0, no oversized-node (the removed code) anywhere in the output.
    // Since relation-conformance every MAPPED node also carries a relation verdict, so the
    // node is seeded with --approve first (empty registry → approved); a plain check then
    // re-validates it green. The aspect-less node still passes — it just now has a relation verdict.
    const dir = minimalGraph('oversized-bare', (ygRoot) => {
      const root = path.dirname(ygRoot);
      writeNode(ygRoot, 'big', 'name: Big\ntype: service\ndescription: x\nmapping:\n  - src/big.ts\n');
      mkdirSync(path.join(root, 'src'), { recursive: true });
      writeFileSync(path.join(root, 'src', 'big.ts'), '// large mapped source — no per-node byte ceiling exists anymore\n'.repeat(50), 'utf-8');
    });
    try {
      // Seed the relation verdict (empty registry → approved), then a plain check re-validates green.
      expect(run(['check', '--approve'], dir).status).toBe(0);
      const { status, stdout } = run(['check'], dir);
      expect(stdout).not.toContain('oversized-node');
      expect(status).toBe(0);
      // Relations are computed live, not cached: the lock carries no relation
      // section, and the aspect-less node passes the (live) relation check.
      // Under the 5.1.0 triad the lock spans three files; assert that NONE of
      // them serializes a relation section — read each raw committed/gitignored
      // file that exists on disk after the fill and check the merged contents.
      const ygDir = path.join(dir, '.yggdrasil');
      const lockFiles = [
        'yg-lock.nondeterministic.json',
        'yg-lock.logs.json',
        '.yg-lock.deterministic.json',
      ];
      const rawCombined = lockFiles
        .map((f) => path.join(ygDir, f))
        .filter((p) => existsSync(p))
        .map((p) => readFileSync(p, 'utf-8'))
        .join('\n');
      expect(rawCombined).not.toContain('relation_verdicts'); // relations are live, not cached
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 2. mapping-path-missing ----------------------------------------------
  // The committed sample-project already ships a node (users/missing-service)
  // whose mapping points at a file that does not exist on disk. The validator
  // detects this with code `mapping-path-missing` (verified against
  // core/checks/mapping.ts: checkMappingPathsExist).
  //
  // `yg check` must surface the true `mapping-path-missing` code AND the
  // offending node path. The check renderer (src/cli/check.ts) no longer groups
  // `mapping-path-missing` into COVERAGE_CODES (which rendered it through
  // renderUnmappedBlock() as a bare `unmapped (0)` line, dropping both the code
  // and the node path). It now falls through to the normal validation-error
  // renderer, which prints "<code>  <node-path>  <what>" with Why/Fix lines.
  //
  // This test is the tripwire: it pins the corrected mechanic on both the
  // validator-exposing command (`yg context --node`) and `yg check` itself.
  it('2: a missing mapping path is detected as mapping-path-missing (exit 1)', () => {
    const dir = copySampleProject('mapping-missing');
    try {
      // Guard: the fixture really maps a file that is absent on disk.
      const missingFile = path.join(dir, 'src', 'users', 'missing.service.ts');
      expect(existsSync(missingFile)).toBe(false);

      // The validator's true code + node path are exposed by `yg context`.
      const ctx = run(['context', '--node', 'users/missing-service'], dir);
      expect(ctx.status).toBe(1);
      expect(ctx.all).toContain('mapping-path-missing');
      expect(ctx.all).toContain('users/missing-service');

      // `yg check` blocks (exit 1) AND surfaces the real code plus the offending
      // node path — no longer mislabelled as a bare `unmapped (0)` line.
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.stdout).toContain('mapping-path-missing');
      expect(check.stdout).toContain('users/missing-service');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 3. yaml-invalid -------------------------------------------------------
  // Corrupt a node's yg-node.yaml into unparseable YAML. The parse failure is
  // recorded as a node parse error and surfaced by the validator with code
  // `yaml-invalid` (core/validator.ts maps graph.nodeParseErrors → yaml-invalid).
  it('3: a corrupt yg-node.yaml is reported as yaml-invalid (exit 1)', () => {
    const dir = copySampleProject('yaml-invalid');
    try {
      const nodeYaml = path.join(
        dir,
        '.yggdrasil',
        'model',
        'checkout',
        'controller',
        'yg-node.yaml',
      );
      // Unbalanced flow-collection + stray colons → YAML parse error.
      writeFileSync(
        nodeYaml,
        [
          'name: CheckoutController',
          'description: x',
          'type: service',
          'relations: [ this is : not valid : : :',
          '  - target: orders/order-service',
          '    type: uses',
          'mapping:',
          '- src/checkout/checkout.controller.ts',
          '',
        ].join('\n'),
        'utf-8',
      );

      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('yaml-invalid');
      expect(stdout).toContain('checkout/controller');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 4. aspect-undefined ---------------------------------------------------
  // A node declares an aspect that has no definition under aspects/. The
  // validator reports `aspect-undefined` and names the missing aspect id
  // (core/checks/aspects.ts: checkDanglingAspectRefs).
  it('4: a node referencing an undefined aspect yields aspect-undefined (exit 1)', () => {
    const dir = minimalGraph('aspect-undefined', (ygRoot) => {
      writeNode(
        ygRoot,
        'widget',
        [
          'name: Widget',
          'description: A widget node',
          'type: service',
          'aspects:',
          '  - nonexistent-aspect',
          '',
        ].join('\n'),
      );
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('aspect-undefined');
      expect(stdout).toContain('nonexistent-aspect');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 5. aspect-implies-cycle ----------------------------------------------
  // Two aspects imply each other (a → b → a). The implies graph must be acyclic;
  // the validator reports `aspect-implies-cycle` (core/checks/aspects.ts:
  // checkImpliesNoCycles).
  it('5: a mutual implies relationship yields aspect-implies-cycle (exit 1)', () => {
    const dir = minimalGraph('implies-cycle', (ygRoot) => {
      writeAspect(
        ygRoot,
        'a',
        ['name: AspectA', 'description: A', 'reviewer:', '  type: llm', 'implies:', '  - b', ''].join('\n'),
        { file: 'content.md', body: 'Rule A.\n' },
      );
      writeAspect(
        ygRoot,
        'b',
        ['name: AspectB', 'description: B', 'reviewer:', '  type: llm', 'implies:', '  - a', ''].join('\n'),
        { file: 'content.md', body: 'Rule B.\n' },
      );
      writeNode(
        ygRoot,
        'widget',
        ['name: Widget', 'description: A widget node', 'type: service', 'aspects:', '  - a', ''].join('\n'),
      );
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('aspect-implies-cycle');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 6a. aspect-reference-broken ------------------------------------------
  // An LLM aspect declares a `references:` entry pointing at a file that does
  // not exist. The validator reports `aspect-reference-broken`
  // (core/checks/aspect-contracts.ts: checkAspectReferences).
  it('6a: an LLM aspect referencing a missing file yields aspect-reference-broken (exit 1)', () => {
    const dir = minimalGraph('ref-broken', (ygRoot) => {
      writeAspect(
        ygRoot,
        'ref-aspect',
        [
          'name: RefAspect',
          'description: An LLM aspect with a broken reference',
          'reviewer:',
          '  type: llm',
          'references:',
          '  - docs/missing-table.md',
          '',
        ].join('\n'),
        { file: 'content.md', body: 'Rule referencing a lookup table.\n' },
      );
      writeNode(
        ygRoot,
        'widget',
        ['name: Widget', 'description: A widget node', 'type: service', 'aspects:', '  - ref-aspect', ''].join('\n'),
      );
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('aspect-reference-broken');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 6b. aspect-references-on-deterministic -------------------------------
  // A deterministic aspect (reviewer.type: deterministic — the binary's actual
  // non-LLM reviewer type) must not declare `references:`. The aspect parser
  // rejects this with `aspect-references-on-deterministic`
  // (io/aspect-parser.ts), surfaced by the validator via aspectParseErrors.
  it('6b: a deterministic aspect with references yields aspect-references-on-deterministic (exit 1)', () => {
    const dir = minimalGraph('ref-on-det', (ygRoot) => {
      writeAspect(
        ygRoot,
        'det-aspect',
        [
          'name: DetAspect',
          'description: A deterministic aspect that wrongly declares references',
          'reviewer:',
          '  type: deterministic',
          'references:',
          '  - docs/table.md',
          '',
        ].join('\n'),
        { file: 'check.mjs', body: 'export function check() {\n  return [];\n}\n' },
      );
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      expect(stdout).toContain('aspect-references-on-deterministic');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 7. flow-node-broken ---------------------------------------------------
  // A flow lists a participant node that does not exist in the graph. The
  // validator reports `flow-node-broken` and names the missing node
  // (core/checks/relations.ts: checkBrokenFlowRefs).
  it('7: a flow referencing a nonexistent participant yields flow-node-broken (exit 1)', () => {
    const dir = minimalGraph('flow-broken', (ygRoot) => {
      writeNode(
        ygRoot,
        'widget',
        ['name: Widget', 'description: A widget node', 'type: service', ''].join('\n'),
      );
      writeFlow(
        ygRoot,
        'broken-flow',
        [
          'name: Broken Flow',
          'description: A flow that references a missing node',
          'nodes:',
          '  - widget',
          '  - ghost/missing-node',
          '',
        ].join('\n'),
      );
    });
    try {
      const { status, stdout } = run(['check'], dir);
      expect(status).toBe(1);
      // Grouped view: the broken-participant issue surfaces as a flow-node-broken
      // group. The per-issue `what` (the missing node name) is no longer in the
      // default body, but the group label + shared why/fix convey the same intent.
      expect(stdout).toContain('flow-node-broken');
      expect(stdout).toContain('Flow participants must exist in the graph.');
      expect(stdout).toContain('Fix the nodes list in .yggdrasil/flows/broken-flow/yg-flow.yaml, or create the missing node .yggdrasil/model/ghost/missing-node/yg-node.yaml.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- file-duplicate-mapping: one source file owned by two nodes ---

  it('a source file mapped by two nodes is rejected (file-duplicate-mapping, exit 1)', () => {
    const dir = minimalGraph('dup-map', (ygRoot) => {
      const root = path.dirname(ygRoot);
      mkdirSync(path.join(root, 'src'), { recursive: true });
      // The file must exist, else mapping-path-missing would add noise.
      writeFileSync(path.join(root, 'src', 'shared.ts'), 'export const x = 1;\n', 'utf-8');
      writeNode(
        ygRoot,
        'alpha',
        ['name: Alpha', 'description: Alpha node', 'type: service', 'mapping:', '  - src/shared.ts', ''].join('\n'),
      );
      writeNode(
        ygRoot,
        'beta',
        ['name: Beta', 'description: Beta node', 'type: service', 'mapping:', '  - src/shared.ts', ''].join('\n'),
      );
    });
    try {
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      // The duplicate mapping surfaces as a file-duplicate-mapping block naming
      // the shared file; assert the label, the shared why, both owners in the
      // heading, and the node the finding is reported on as its member.
      expect(all).toContain('file-duplicate-mapping');
      expect(all).toContain('Each source file must have exactly one owner node.');
      expect(all).toContain("error[file-duplicate-mapping] File 'src/shared.ts' appears in the mappings of more than one node: alpha and beta");
      expect(all).toMatch(/^ {2}at: +beta$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- orphaned-drift-state: DELETED ---
  // The `.drift-state/` directory and the per-node baseline file are gone in the
  // verdict-lock redesign — state now lives in a single `.yggdrasil/yg-lock.json`.
  // A verdict whose node has left the graph is no longer surfaced as an
  // `orphaned-drift-state` warning; the next fill silently GC-prunes such stale
  // lock entries (core/fill.ts: "Prune verdict entries whose pair is no longer in
  // the expected universe"). There is no replacement warning to re-point to, so
  // this test of the removed surface is deleted.
});
