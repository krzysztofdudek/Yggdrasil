import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, renameSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Hermetic E2E suite — ARCHITECTURE TYPE CLASSIFICATION.
//
// Every classification mechanic the architecture file controls, proved against
// the real spawned binary (`yg check`, `yg type-suggest`, `yg check --approve`,
// `yg context`):
//   * forward classification    — type-when-mismatch (path / content / not atoms)
//   * strict backward scan       — type-strict-misplaced, strict positive pass,
//                                  strict-overlap-conflict
//   * architecture self-validity — enforce-strict-without-when,
//                                  type-without-when-with-mapping
//   * type-default cascade        — channel 3 (own type) + channel 4 (ancestor
//                                  type) reaching a `when`-classified node, with
//                                  context attribution AND fill enforcement
//   * yg type-suggest             — single / multiple / no-match(+closest ranking)
//                                  / partial-score / path-only path-vs-content
//                                  distinction / .yggdrasil auto-exempt /
//                                  gitignore warning
//
// HERMETICITY
//   - Reuses the cli-deterministic-lifecycle harness shape verbatim: the
//     `run(args, cwd)` spawnSync wrapper, BIN_PATH resolution, and the
//     `describe.skipIf(!distExists)` dist guard.
//   - ZERO committed fixtures. Each test authors a complete graph from scratch
//     inside a fresh mkdtempSync dir via `archGraph(...)` and rmSync(...,{
//     recursive, force }) in a finally, so no fixture bytes are copied.
//   - No network: the config's reviewer tier points at a loopback endpoint that
//     `yg check`/`yg type-suggest` never dial; the fill-enforcement tests use
//     only deterministic check.mjs aspects, so no LLM call and no endpoint is
//     ever reached.
//   - No wall-clock reads and no random sources inside any assertion.
//   - Every asserted exit code and message substring was verified against the
//     current spawned dist binary before being pinned (see report).
//
// NON-DUPLICATION (cases deliberately not re-tested here — covered elsewhere):
//   - type-strict-orphan (basic)            → cli-validation-codes.test.ts D2
//   - parent-type-forbidden (basic)         → cli-validation-codes.test.ts D1
//   - channel 3 `Source: architecture (type: service)` attribution + enforce,
//     channel 4 `Source: inherited from parent (type: module)` attribution +
//     enforce, on the committed e2e-lifecycle fixture
//                                            → cli-channels.test.ts scen. 2 & 3
//                                              (+ cli-conditional-when.test.ts)
//   - type-suggest single-match smoke, .yggdrasil auto-exempt (basic), path-only
//     (basic), missing --file exit 1, missing .yggdrasil exit 1
//                                            → cli-query.test.ts
//   The channel-3/4 case below is retained deliberately: it drives the type
//   from a FROM-SCRATCH `when`-classifying architecture (not the committed
//   fixture), tying classification to the default-aspect cascade in one graph —
//   a linkage the channels suite never exercises.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');

const distExists = existsSync(BIN_PATH);

// A loopback reviewer endpoint that classification/check never dials — present
// only so the scaffolded config carries a syntactically valid reviewer tier.
const LOOPBACK_ENDPOINT = 'http://127.0.0.1:11434';

function run(
  args: string[],
  cwd: string,
): {
  stdout: string;
  stderr: string;
  status: number | null;
  all: string;
} {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

interface BuildCtx {
  /** Absolute path to the .yggdrasil/ root. */
  ygRoot: string;
  /** Absolute path to the project root (parent of .yggdrasil/). */
  projectRoot: string;
}

/**
 * Scaffold a complete, structurally-valid graph from scratch in a fresh temp
 * dir: the supplied yg-architecture.yaml body, a config with one loopback
 * reviewer tier, and empty model/aspects/flows dirs.
 * The `build` callback writes the scenario-specific nodes/aspects/source files.
 * Returns the temp dir; the caller rmSync's it in a finally.
 */
function archGraph(
  label: string,
  architecture: string,
  build: (ctx: BuildCtx) => void,
): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-arch-${label}-`));
  const ygRoot = path.join(dir, '.yggdrasil');
  mkdirSync(path.join(ygRoot, 'model'), { recursive: true });
  mkdirSync(path.join(ygRoot, 'aspects'), { recursive: true });
  mkdirSync(path.join(ygRoot, 'flows'), { recursive: true });

  writeFileSync(path.join(ygRoot, 'yg-architecture.yaml'), architecture, 'utf-8');
  writeFileSync(
    path.join(ygRoot, 'yg-config.yaml'),
    [
      'quality:',
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

  build({ ygRoot, projectRoot: dir });
  return dir;
}

/** Write a yg-node.yaml under model/<nodePath>/. */
function writeNode(ygRoot: string, nodePath: string, yaml: string): void {
  const nodeDir = path.join(ygRoot, 'model', ...nodePath.split('/'));
  mkdirSync(nodeDir, { recursive: true });
  writeFileSync(path.join(nodeDir, 'yg-node.yaml'), yaml, 'utf-8');
}

/** Write a deterministic aspect (yg-aspect.yaml + check.mjs) under aspects/<id>/. */
function writeDeterministicAspect(
  ygRoot: string,
  id: string,
  description: string,
  checkSource: string,
): void {
  const aspectDir = path.join(ygRoot, 'aspects', ...id.split('/'));
  mkdirSync(aspectDir, { recursive: true });
  writeFileSync(
    path.join(aspectDir, 'yg-aspect.yaml'),
    [
      `name: ${id}`,
      `description: ${description}`,
      'reviewer:',
      '  type: deterministic',
      'status: enforced',
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(path.join(aspectDir, 'check.mjs'), checkSource, 'utf-8');
}

/** Write a repo source file (creating parent dirs) at a projectRoot-relative path. */
function writeSource(projectRoot: string, relPath: string, body: string): void {
  const abs = path.join(projectRoot, ...relPath.split('/'));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body, 'utf-8');
}

// A deterministic check.mjs that flags any file containing the given marker
// token. Reused by the channel-3/4 enforcement test (each type-default aspect
// keys off a distinct token so the two channels are independently provable).
const tokenCheck = (token: string, label: string): string =>
  `export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (file.content.includes('${token}')) {
      violations.push({ file: file.path, line: 1, column: 0, message: '${label}: ${token} found.' });
    }
  }
  return violations;
}
`;

describe.skipIf(!distExists)('CLI E2E — architecture type classification', () => {
  // =========================================================================
  // GROUP A — FORWARD classification: type-when-mismatch.
  // A node maps a file that does NOT satisfy its declared type's `when`.
  // core/checks/architecture.ts: checkTypeWhenMismatch.
  // =========================================================================

  it('A1: a file whose PATH fails the type `when` yields type-when-mismatch (exit 1)', () => {
    const architecture = [
      'node_types:',
      '  service:',
      "    description: 'A service that must live under src/services'",
      '    log_required: false',
      '    when:',
      '      path: "src/services/**"',
      '',
    ].join('\n');
    const dir = archGraph('when-path', architecture, ({ ygRoot, projectRoot }) => {
      writeNode(
        ygRoot,
        'widget',
        ['name: Widget', 'description: a widget mapping a file outside src/services', 'type: service', 'mapping:', '  - src/widget.ts', ''].join('\n'),
      );
      writeSource(projectRoot, 'src/widget.ts', 'export const w = 1;\n');
    });
    try {
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('type-when-mismatch');
      // Per-issue WHAT ("File '...' is in mapping of node '...'") is gone in the
      // grouped renderer; assert the group's shared `why` (which names the type),
      // the offending node line, and the Fix hints that convey the same intent.
      expect(all).toContain("When a node is declared as type 'service', every file in its mapping must satisfy the type's when predicate");
      expect(all).toContain("satisfies service.when");
      expect(all).toContain('- widget');
      // The remediation hints point the agent at type-suggest for the file.
      expect(all).toContain('yg type-suggest --file src/widget.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A2: a file whose CONTENT fails the type `when` yields type-when-mismatch (exit 1)', () => {
    const architecture = [
      'node_types:',
      '  command:',
      "    description: 'A CLI command that registers itself'",
      '    log_required: false',
      '    when:',
      '      content: "registerCommand"',
      '',
    ].join('\n');
    const dir = archGraph('when-content', architecture, ({ ygRoot, projectRoot }) => {
      writeNode(
        ygRoot,
        'cmd',
        ['name: Cmd', 'description: a command node mapping a file with no registerCommand', 'type: command', 'mapping:', '  - src/plain.ts', ''].join('\n'),
      );
      // No `registerCommand` token — fails the content atom.
      writeSource(projectRoot, 'src/plain.ts', 'export const p = 1;\n');
    });
    try {
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('type-when-mismatch');
      // Per-issue WHAT is gone in the grouped renderer; assert the group's shared
      // `why` (which names the type) and the offending node line instead.
      expect(all).toContain("When a node is declared as type 'command', every file in its mapping must satisfy the type's when predicate");
      expect(all).toContain('- cmd');
      // The grouped Fix block names the content-predicate type to refactor against.
      expect(all).toContain('satisfies command.when');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A3: a `not` atom in `when` excludes test files — a mapped *.test.ts yields type-when-mismatch (exit 1)', () => {
    const architecture = [
      'node_types:',
      '  command:',
      "    description: 'A command, but never a test file'",
      '    log_required: false',
      '    when:',
      '      all_of:',
      '        - path: "src/**/*.ts"',
      '        - not:',
      '            path: "**/*.test.ts"',
      '',
    ].join('\n');
    const dir = archGraph('when-not', architecture, ({ ygRoot, projectRoot }) => {
      writeNode(
        ygRoot,
        'cmd',
        ['name: Cmd', 'description: a command node wrongly mapping a test file', 'type: command', 'mapping:', '  - src/foo.test.ts', ''].join('\n'),
      );
      writeSource(projectRoot, 'src/foo.test.ts', 'export const t = 1;\n');
    });
    try {
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('type-when-mismatch');
      // Per-issue WHAT is gone in the grouped renderer; assert the group's shared
      // `why`, the offending node line, and the Fix hint naming the test file
      // (the `not` atom excluded it from command.when).
      expect(all).toContain("When a node is declared as type 'command', every file in its mapping must satisfy the type's when predicate");
      expect(all).toContain('- cmd');
      expect(all).toContain('yg type-suggest --file src/foo.test.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A4: a file that SATISFIES the type `when` produces no type-when-mismatch (check passes, exit 0)', () => {
    const architecture = [
      'node_types:',
      '  service:',
      "    description: 'A service under src/services'",
      '    log_required: false',
      '    when:',
      '      path: "src/services/**"',
      '',
    ].join('\n');
    const dir = archGraph('when-ok', architecture, ({ ygRoot, projectRoot }) => {
      writeNode(
        ygRoot,
        'orders',
        ['name: Orders', 'description: a conforming service node', 'type: service', 'mapping:', '  - src/services/orders.ts', ''].join('\n'),
      );
      writeSource(projectRoot, 'src/services/orders.ts', 'export const o = 1;\n');
    });
    try {
      // Seed the per-node relation verdict first (empty registry → approved); otherwise
      // a plain check is exit 1 because every mapped node now carries a relation verdict
      // that is unverified until --approve. Intent of this test is classification correctness.
      expect(run(['check', '--approve'], dir).status).toBe(0);
      const { status, all } = run(['check'], dir);
      expect(status).toBe(0);
      expect(all).not.toContain('type-when-mismatch');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GROUP B — STRICT backward scan (enforce: strict).
  // core/checks/mapping.ts: checkStrictBackwardCoverage. type-strict-orphan is
  // already pinned by cli-validation-codes D2; here we cover the REST.
  // =========================================================================

  it('B1: a file matching a strict type but owned by a WRONG-type node yields type-strict-misplaced (exit 1)', () => {
    const architecture = [
      'node_types:',
      '  secure:',
      "    description: 'Strictly enforced security-critical files'",
      '    log_required: false',
      '    enforce: strict',
      '    when:',
      '      path: "src/**/*.secure.ts"',
      '  service:',
      "    description: 'An ordinary service (broad when)'",
      '    log_required: false',
      '    when:',
      '      path: "**"',
      '',
    ].join('\n');
    const dir = archGraph('strict-misplaced', architecture, ({ ygRoot, projectRoot }) => {
      // A `service` node owns a *.secure.ts file — it matches secure.when (strict)
      // but the owner is the wrong type.
      writeNode(
        ygRoot,
        'widget',
        ['name: Widget', 'description: a service node owning a secure file', 'type: service', 'mapping:', '  - src/auth.secure.ts', ''].join('\n'),
      );
      writeSource(projectRoot, 'src/auth.secure.ts', 'export const a = 1;\n');
    });
    try {
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('type-strict-misplaced');
      // Per-issue WHAT (the file + strict type) is gone in the grouped renderer;
      // assert the group's shared `why` (which names the strict type), the owner
      // node line, and the Fix remediation that conveys the same intent.
      expect(all).toContain("Type 'secure' has enforce: strict");
      expect(all).toContain('- widget');
      expect(all).toContain("Change 'widget' type to 'secure' if conceptually correct.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B2: a file owned by the CORRECT strict-type node passes the backward scan (exit 0)', () => {
    const architecture = [
      'node_types:',
      '  secure:',
      "    description: 'Strictly enforced security-critical files'",
      '    log_required: false',
      '    enforce: strict',
      '    when:',
      '      path: "src/**/*.secure.ts"',
      '',
    ].join('\n');
    const dir = archGraph('strict-ok', architecture, ({ ygRoot, projectRoot }) => {
      // A `secure` node correctly owns the only *.secure.ts file → no orphan,
      // no misplaced. (No other repo file matches the narrow strict when.)
      writeNode(
        ygRoot,
        'auth',
        ['name: Auth', 'description: a correctly-typed secure node', 'type: secure', 'mapping:', '  - src/auth.secure.ts', ''].join('\n'),
      );
      writeSource(projectRoot, 'src/auth.secure.ts', 'export const a = 1;\n');
    });
    try {
      // Seed the per-node relation verdict (empty registry → approved); a plain check would
      // otherwise be exit 1 on the unverified relation verdict every mapped node now carries.
      expect(run(['check', '--approve'], dir).status).toBe(0);
      const { status, all } = run(['check'], dir);
      expect(status).toBe(0);
      expect(all).not.toContain('type-strict-orphan');
      expect(all).not.toContain('type-strict-misplaced');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B3: two enforce:strict types whose `when` both match a file yield strict-overlap-conflict (exit 1)', () => {
    const architecture = [
      'node_types:',
      '  secure:',
      "    description: 'Strict — every .ts under src'",
      '    log_required: false',
      '    enforce: strict',
      '    when:',
      '      path: "src/**/*.ts"',
      '  audited:',
      "    description: 'Strict — every .secure.ts under src (subset of secure.when)'",
      '    log_required: false',
      '    enforce: strict',
      '    when:',
      '      path: "src/**/*.secure.ts"',
      '',
    ].join('\n');
    const dir = archGraph('strict-overlap', architecture, ({ ygRoot, projectRoot }) => {
      writeNode(
        ygRoot,
        'widget',
        ['name: Widget', 'description: a node owning the doubly-claimed file', 'type: secure', 'mapping:', '  - src/auth.secure.ts', ''].join('\n'),
      );
      writeSource(projectRoot, 'src/auth.secure.ts', 'export const a = 1;\n');
    });
    try {
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('strict-overlap-conflict');
      // Per-issue WHAT is gone in the grouped renderer; assert the group's shared
      // `why` explaining the impossible-to-satisfy double-strict overlap.
      expect(all).toContain('Both types declare enforce: strict');
      // The grouped Fix block names both conflicting types (sorted: audited before secure).
      expect(all).toContain('yg impact --type audited');
      expect(all).toContain('yg impact --type secure');
      // The conflict supersedes orphan/misplaced for that file.
      expect(all).not.toContain('type-strict-misplaced');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GROUP C — ARCHITECTURE self-validity.
  // =========================================================================

  // (enforce-strict-without-when is covered by cli-architecture-when-validation T24 — not duplicated here.)

  it('C2: an ORGANIZATIONAL type (no `when`) whose node declares a non-empty mapping yields type-without-when-with-mapping (exit 1)', () => {
    // core/checks/architecture.ts: checkTypeWithoutWhenWithMapping. cli-check-
    // validation only NOTES this code in a comment — it is never actually
    // triggered there, so this is the first E2E proof of the error path.
    const architecture = [
      'node_types:',
      '  module:',
      "    description: 'Organizational parent-only type (no when)'",
      '    log_required: false',
      '  service:',
      "    description: 'A classifying service type'",
      '    log_required: false',
      '    when:',
      '      path: "**"',
      '',
    ].join('\n');
    const dir = archGraph('org-with-mapping', architecture, ({ ygRoot, projectRoot }) => {
      // The node is typed `module` (organizational) yet carries a mapping.
      writeNode(
        ygRoot,
        'widget',
        ['name: Widget', 'description: an organizational node that wrongly maps a file', 'type: module', 'mapping:', '  - src/widget.ts', ''].join('\n'),
      );
      writeSource(projectRoot, 'src/widget.ts', 'export const w = 1;\n');
    });
    try {
      const { status, all } = run(['check'], dir);
      expect(status).toBe(1);
      expect(all).toContain('type-without-when-with-mapping');
      // Per-issue WHAT (naming the node + organizational type) is gone in the
      // grouped renderer; assert the group's shared `why`, the offending node
      // line, and the Fix naming the organizational type to add a `when` to.
      expect(all).toContain('Types without `when` are organizational (parent-only). Nodes of such types cannot have mapped files.');
      expect(all).toContain('- widget');
      expect(all).toContain("Add a `when` predicate to type 'module'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C3: an organizational type used purely as a PARENT (empty mapping) is valid (exit 0)', () => {
    const architecture = [
      'node_types:',
      '  module:',
      "    description: 'Organizational parent-only type'",
      '    log_required: false',
      '  service:',
      "    description: 'A classifying service type'",
      '    log_required: false',
      '    when:',
      '      path: "src/services/**"',
      '    parents: [module]',
      '',
    ].join('\n');
    const dir = archGraph('org-parent-ok', architecture, ({ ygRoot, projectRoot }) => {
      // module parent with NO mapping — legal organizational usage.
      writeNode(ygRoot, 'svc', ['name: Svc', 'description: an organizational parent', 'type: module', ''].join('\n'));
      writeNode(
        ygRoot,
        'svc/orders',
        ['name: Orders', 'description: a service child under the module', 'type: service', 'mapping:', '  - src/services/orders.ts', ''].join('\n'),
      );
      writeSource(projectRoot, 'src/services/orders.ts', 'export const o = 1;\n');
    });
    try {
      // Seed the mapped child's relation verdict (empty registry → approved); otherwise a
      // plain check is exit 1 on the unverified relation verdict every mapped node now carries.
      expect(run(['check', '--approve'], dir).status).toBe(0);
      const { status, all } = run(['check'], dir);
      expect(status).toBe(0);
      expect(all).not.toContain('type-without-when-with-mapping');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GROUP D — TYPE-DEFAULT cascade driven by classification (channels 3 + 4).
  // A FROM-SCRATCH `when`-classifying architecture: the child's own type
  // (channel 3) and its ancestor type (channel 4) each contribute a default
  // deterministic aspect. Proves context attribution AND fill enforcement in
  // one graph — the classification→default-aspect linkage the channels suite
  // (which runs on the committed fixture) does not exercise.
  // =========================================================================

  it('D1: own-type (CH3) and ancestor-type (CH4) default aspects reach a `when`-classified node — context attributes both', () => {
    const architecture = [
      'node_types:',
      '  module:',
      "    description: 'Organizational parent carrying a default aspect'",
      '    log_required: false',
      '    aspects:',
      '      - parent-type-rule',
      '  service:',
      "    description: 'A service classified by path'",
      '    log_required: false',
      '    when:',
      '      path: "src/services/**"',
      '    parents: [module]',
      '    aspects:',
      '      - own-type-rule',
      '',
    ].join('\n');
    const dir = archGraph('type-default-attribution', architecture, ({ ygRoot, projectRoot }) => {
      writeDeterministicAspect(ygRoot, 'own-type-rule', 'Default aspect of the service type (channel 3).', tokenCheck('FORBIDDEN_OWN', 'own-type-rule'));
      writeDeterministicAspect(ygRoot, 'parent-type-rule', 'Default aspect of the ancestor module type (channel 4).', tokenCheck('FORBIDDEN_PARENT', 'parent-type-rule'));
      writeNode(ygRoot, 'svc', ['name: Svc', 'description: a module parent', 'type: module', ''].join('\n'));
      writeNode(
        ygRoot,
        'svc/handler',
        ['name: Handler', 'description: a service child classified by path', 'type: service', 'mapping:', '  - src/services/handler.ts', ''].join('\n'),
      );
      writeSource(projectRoot, 'src/services/handler.ts', 'export const h = 1;\n');
    });
    try {
      const ctx = run(['context', '--node', 'svc/handler'], dir);
      expect(ctx.status).toBe(0);
      // CH3: own type default aspect, attributed to the node's own type.
      expect(ctx.stdout).toContain('own-type-rule');
      expect(ctx.stdout).toContain('Source: architecture (type: service)');
      // CH4: ancestor type default aspect, attributed to the parent's type.
      expect(ctx.stdout).toContain('parent-type-rule');
      expect(ctx.stdout).toContain('Source: inherited from parent (type: module)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('D2: the own-type (CH3) default aspect ENFORCES at fill — its token refuses, naming the aspect (exit 1)', () => {
    const architecture = [
      'node_types:',
      '  service:',
      "    description: 'A service classified by path'",
      '    log_required: false',
      '    when:',
      '      path: "src/services/**"',
      '    aspects:',
      '      - own-type-rule',
      '',
    ].join('\n');
    const dir = archGraph('ch3-enforce', architecture, ({ ygRoot, projectRoot }) => {
      writeDeterministicAspect(ygRoot, 'own-type-rule', 'Default aspect of the service type (channel 3).', tokenCheck('FORBIDDEN_OWN', 'own-type-rule'));
      writeNode(
        ygRoot,
        'handler',
        ['name: Handler', 'description: a service node', 'type: service', 'mapping:', '  - src/services/handler.ts', ''].join('\n'),
      );
      // Token present → the type-default aspect's check.mjs flags it.
      writeSource(projectRoot, 'src/services/handler.ts', 'export const h = 1;\nconst x = "FORBIDDEN_OWN";\n');
    });
    try {
      // Fill is repo-wide (no per-node scoping); the type-default deterministic
      // aspect refuses on the planted token. The fill line names the [det] pair
      // and `refused`; the post-fill render names the aspect + the refusal.
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      expect(fill.all).toContain('[det] own-type-rule on node:handler — refused');
      expect(fill.all).toContain('own-type-rule');
      // The post-fill grouped render names the aspect in the group header
      // (enforced ... aspect 'own-type-rule') and lists the refusing node with its
      // deterministic Violations tail (FULL_WHAT detail is retained per-node). The
      // old per-issue WHAT line 0 ("Aspect '...' is refused on <unit> ...") is now
      // the group-level header and no longer rendered verbatim per issue.
      expect(fill.all).toContain("enforced");
      expect(fill.all).toContain("aspect 'own-type-rule'");
      expect(fill.all).toContain('- handler');
      expect(fill.all).toContain('own-type-rule: FORBIDDEN_OWN found.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('D3: the ancestor-type (CH4) default aspect ENFORCES at fill on a descendant — its token refuses (exit 1)', () => {
    const architecture = [
      'node_types:',
      '  module:',
      "    description: 'Organizational parent carrying a default aspect'",
      '    log_required: false',
      '    aspects:',
      '      - parent-type-rule',
      '  service:',
      "    description: 'A service classified by path'",
      '    log_required: false',
      '    when:',
      '      path: "src/services/**"',
      '    parents: [module]',
      '',
    ].join('\n');
    const dir = archGraph('ch4-enforce', architecture, ({ ygRoot, projectRoot }) => {
      writeDeterministicAspect(ygRoot, 'parent-type-rule', 'Default aspect of the ancestor module type (channel 4).', tokenCheck('FORBIDDEN_PARENT', 'parent-type-rule'));
      writeNode(ygRoot, 'svc', ['name: Svc', 'description: a module parent', 'type: module', ''].join('\n'));
      writeNode(
        ygRoot,
        'svc/handler',
        ['name: Handler', 'description: a service child', 'type: service', 'mapping:', '  - src/services/handler.ts', ''].join('\n'),
      );
      writeSource(projectRoot, 'src/services/handler.ts', 'export const h = 1;\nconst y = "FORBIDDEN_PARENT";\n');
    });
    try {
      // Fill is repo-wide; the ancestor-type default deterministic aspect refuses
      // on the planted token at the nested descendant node:svc/handler.
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      expect(fill.all).toContain('[det] parent-type-rule on node:svc/handler — refused');
      expect(fill.all).toContain('parent-type-rule');
      // The post-fill grouped render names the ancestor-type aspect in the group
      // header and lists the nested descendant node with its deterministic
      // Violations tail (FULL_WHAT detail is retained per-node). The old per-issue
      // WHAT line 0 ("Aspect '...' is refused on <unit> ...") is now the group
      // header and no longer rendered verbatim per issue.
      expect(fill.all).toContain("enforced");
      expect(fill.all).toContain("aspect 'parent-type-rule'");
      expect(fill.all).toContain('- svc/handler');
      expect(fill.all).toContain('parent-type-rule: FORBIDDEN_PARENT found.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // GROUP E — yg type-suggest classification surface.
  // cli/type-suggest.ts. cli-query covers the single-match smoke, basic path-
  // only, and basic auto-exempt; here we cover the deeper branches.
  // =========================================================================

  // A reusable two-type architecture: `command` is path+content (all_of),
  // `service` is path-only — used for the single/no-match/partial branches.
  const TWO_TYPE_ARCH = [
    'node_types:',
    '  command:',
    "    description: 'CLI command — under src/cli AND registers a command'",
    '    log_required: false',
    '    when:',
    '      all_of:',
    '        - path: "src/cli/**/*.ts"',
    '        - content: "registerCommand"',
    '  service:',
    "    description: 'Any TS under src/services'",
    '    log_required: false',
    '    when:',
    '      path: "src/services/**/*.ts"',
    '',
  ].join('\n');

  it('E1: a file satisfying a combined path+content `when` reports exactly that type with a ✓ trace (exit 0)', () => {
    const dir = archGraph('ts-single', TWO_TYPE_ARCH, ({ projectRoot }) => {
      writeSource(projectRoot, 'src/cli/orders.ts', 'export function reg() { registerCommand(); }\n');
    });
    try {
      const { status, stdout } = run(['type-suggest', '--file', 'src/cli/orders.ts'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('Matching types:');
      expect(stdout).toContain('command');
      // Both atoms of the all_of are shown satisfied.
      expect(stdout).toContain('path matches "src/cli/**/*.ts"');
      expect(stdout).toContain('content matches "registerCommand"');
      // It must NOT report the other (non-matching) type as a match.
      expect(stdout).not.toContain('service — full when satisfied');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E2: a file matching NO type reports "No type\'s `when` matches" plus a closest-types ranking (exit 0)', () => {
    const dir = archGraph('ts-nomatch', TWO_TYPE_ARCH, ({ projectRoot }) => {
      // Under neither src/cli nor src/services — matches nothing.
      writeSource(projectRoot, 'src/misc.ts', 'export const m = 1;\n');
    });
    try {
      const { status, stdout } = run(['type-suggest', '--file', 'src/misc.ts'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain("No type's `when` matches this file.");
      expect(stdout).toContain('Closest types (top 3, ranked by satisfied-fraction):');
      // Both fully-failing predicates score 0.00.
      expect(stdout).toContain('score: 0.00');
      expect(stdout).toContain('command');
      expect(stdout).toContain('service');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E3: a PARTIALLY-satisfied all_of (path ok, content fails) ranks the closest type with a fractional score (exit 0)', () => {
    const dir = archGraph('ts-partial', TWO_TYPE_ARCH, ({ projectRoot }) => {
      // Under src/cli (path atom ✓) but no registerCommand (content atom ✗) →
      // all_of average = 0.50.
      writeSource(projectRoot, 'src/cli/plain.ts', 'export const nope = 1;\n');
    });
    try {
      const { status, stdout } = run(['type-suggest', '--file', 'src/cli/plain.ts'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain("No type's `when` matches this file.");
      expect(stdout).toContain('command — predicate evaluates to false (score: 0.50)');
      // The trace pinpoints which atom passed and which failed.
      expect(stdout).toContain('path matches "src/cli/**/*.ts"');
      expect(stdout).toContain('content does not match "registerCommand"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E4: a file matching MULTIPLE types reports "Multiple types match" and the overlap NEXT hint (exit 0)', () => {
    const architecture = [
      'node_types:',
      '  alpha:',
      "    description: 'Any TS under src'",
      '    log_required: false',
      '    when:',
      '      path: "src/**/*.ts"',
      '  beta:',
      "    description: 'Any file named cmd.ts'",
      '    log_required: false',
      '    when:',
      '      path: "**/cmd.ts"',
      '',
    ].join('\n');
    const dir = archGraph('ts-multi', architecture, ({ projectRoot }) => {
      writeSource(projectRoot, 'src/cmd.ts', 'export const c = 1;\n');
    });
    try {
      const { status, stdout } = run(['type-suggest', '--file', 'src/cmd.ts'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('Multiple types match:');
      expect(stdout).toContain('alpha — full when satisfied');
      expect(stdout).toContain('beta — full when satisfied');
      expect(stdout).toContain('Architecture has overlapping when between types.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E5: on a NONEXISTENT file, path-only evaluation includes path-based types and EXCLUDES content-only types (exit 0)', () => {
    const architecture = [
      'node_types:',
      '  pathful:',
      "    description: 'path-only when'",
      '    log_required: false',
      '    when:',
      '      path: "src/**/*.ts"',
      '  contentful:',
      "    description: 'content-only when — not evaluable without file content'",
      '    log_required: false',
      '    when:',
      '      content: "registerCommand"',
      '',
    ].join('\n');
    const dir = archGraph('ts-pathonly', architecture, () => {
      // No source file created — the queried path does not exist on disk.
    });
    try {
      const { status, stdout } = run(['type-suggest', '--file', 'src/ghost.ts'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('(File does not exist — evaluating path predicates only)');
      expect(stdout).toContain('Matching types (path-only check):');
      // The path-based type appears with the tentative `?` marker.
      expect(stdout).toContain('pathful');
      expect(stdout).toContain('path matches "src/**/*.ts"');
      // The content-only type is NOT classifiable path-only → not listed.
      expect(stdout).not.toContain('contentful');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E6: on a nonexistent file matching no path predicate, type-suggest reports no path match (exit 0)', () => {
    const architecture = [
      'node_types:',
      '  service:',
      "    description: 'TS under src/services'",
      '    log_required: false',
      '    when:',
      '      path: "src/services/**/*.ts"',
      '',
    ].join('\n');
    const dir = archGraph('ts-pathonly-nomatch', architecture, () => {
      // No file — and the queried path is outside src/services.
    });
    try {
      const { status, stdout } = run(['type-suggest', '--file', 'docs/readme.md'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('(File does not exist — evaluating path predicates only)');
      expect(stdout).toContain("No type's path predicate matches this file path.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E7: a path INSIDE .yggdrasil/ is auto-exempt — classification does not apply (exit 0)', () => {
    // cli-query pins a model/ path; here the queried path is the config file
    // itself, exercising the same prefix exemption with a different sub-path.
    const architecture = [
      'node_types:',
      '  service:',
      "    description: 'any ts'",
      '    log_required: false',
      '    when:',
      '      path: "**/*.ts"',
      '',
    ].join('\n');
    const dir = archGraph('ts-exempt', architecture, () => {});
    try {
      const { status, stdout } = run(['type-suggest', '--file', '.yggdrasil/yg-config.yaml'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('This path is inside .yggdrasil/ — auto-exempt from classification.');
      expect(stdout).toContain('Type matching does not apply here.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E8: a .gitignore-matched file still classifies, but type-suggest warns it would fire file-mapping-gitignored (exit 0)', () => {
    const architecture = [
      'node_types:',
      '  service:',
      "    description: 'any ts'",
      '    log_required: false',
      '    when:',
      '      path: "**/*.ts"',
      '',
    ].join('\n');
    const dir = archGraph('ts-gitignore', architecture, ({ projectRoot }) => {
      writeSource(projectRoot, '.gitignore', 'ignored/\n');
      writeSource(projectRoot, 'ignored/thing.ts', 'export const i = 1;\n');
    });
    try {
      const { status, all, stdout } = run(['type-suggest', '--file', 'ignored/thing.ts'], dir);
      expect(status).toBe(0);
      // The gitignore warning is emitted on stderr (hence asserted via `all`).
      expect(all).toContain("'ignored/thing.ts' is matched by .gitignore.");
      expect(all).toContain('file-mapping-gitignored');
      // Classification still runs and reports the matching type on stdout.
      expect(stdout).toContain('Matching types:');
      expect(stdout).toContain('service');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E9: a pure type-declaration reorder never changes WHICH 3 candidate types --file names as closest, warm or cold', () => {
    // Four equally-scoring (0.00) path-only types, none of which matches the
    // queried file: a stable sort on score alone leaves ties in whatever
    // order the architecture happens to declare them in, so .slice(0, 3)
    // would pick MEMBERSHIP by declaration order, not by anything about the
    // types themselves — the same failure mode the cache's warm/cold split
    // exposes, since a fresh (cold) evaluation walks the reordered file while
    // a cache hit (warm) still serves the pre-reorder shard.
    const architecture = [
      'node_types:',
      '  alpha:',
      "    description: 'Alpha-layer marker type, path-only'",
      '    log_required: false',
      '    when:',
      '      path: "src/alpha/**"',
      '  bravo:',
      "    description: 'Bravo-layer marker type, path-only'",
      '    log_required: false',
      '    when:',
      '      path: "src/bravo/**"',
      '  charlie:',
      "    description: 'Charlie-layer marker type, path-only'",
      '    log_required: false',
      '    when:',
      '      path: "src/charlie/**"',
      '  delta:',
      "    description: 'Delta-layer marker type, path-only'",
      '    log_required: false',
      '    when:',
      '      path: "src/delta/**"',
      '',
    ].join('\n');
    const dir = archGraph('ts-closest-order', architecture, ({ projectRoot }) => {
      writeSource(projectRoot, 'src/misc/plain.ts', 'export const p = 1;\n'); // matches none of the four
    });
    // archGraph's own config carries no coverage: block, i.e. type_level
    // defaults off — but this test drives type-suggest --file specifically to
    // exercise the classification CACHE's warm/cold behavior, and the cache is
    // never constructed with the tier off. Turn it on for this one test.
    appendFileSync(path.join(dir, '.yggdrasil', 'yg-config.yaml'), 'coverage:\n  type_level: true\n');
    let parked: string | undefined;
    try {
      // Warm the cache with this declaration order (alpha, bravo, charlie, delta).
      const warm = run(['type-suggest', '--file', 'src/misc/plain.ts'], dir);
      expect(warm.status).toBe(0);
      expect(warm.stdout).toContain('alpha');
      expect(warm.stdout).toContain('bravo');
      expect(warm.stdout).toContain('charlie');
      expect(warm.stdout).not.toContain('delta'); // canonical top-3 by typeId excludes delta

      // A PURE reorder — move delta's whole block to the front, byte-identical
      // otherwise. architecturePredicateHash sorts by id before hashing, so
      // this must never invalidate the shard just written above.
      const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
      const original = readFileSync(archPath, 'utf-8');
      const deltaBlock =
        '  delta:\n    description: \'Delta-layer marker type, path-only\'\n    log_required: false\n    when:\n      path: "src/delta/**"\n';
      expect(original).toContain(deltaBlock);
      const withoutDelta = original.replace(deltaBlock, '');
      const reordered = withoutDelta.replace('node_types:\n', `node_types:\n${deltaBlock}`);
      expect(reordered).not.toBe(original);
      writeFileSync(archPath, reordered);

      // Still warm — the on-disk cache is untouched, so this must be a cache
      // HIT returning the exact same rendered text as the first run.
      const warmReordered = run(['type-suggest', '--file', 'src/misc/plain.ts'], dir);
      expect(warmReordered.stdout).toBe(warm.stdout);

      // Move (never delete) the on-disk cache aside so the next run is
      // genuinely cold — a rename, not a removal.
      parked = mkdtempSync(path.join(tmpdir(), 'yg-cache-parked-'));
      renameSync(path.join(dir, '.yggdrasil', '.type-class-cache'), path.join(parked, 'parked'));

      const cold = run(['type-suggest', '--file', 'src/misc/plain.ts'], dir);

      // Same exit code, same rendered TEXT, same candidate SET — a fresh
      // evaluation under the reordered file must select the identical 3
      // types the original warm run named, never delta in charlie's place.
      expect(cold.status).toBe(warm.status);
      expect(cold.stdout).toBe(warm.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (parked) rmSync(parked, { recursive: true, force: true });
    }
  });
});
