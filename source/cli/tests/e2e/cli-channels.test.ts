import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

// A dead loopback endpoint. Pointing the reviewer at this makes the LLM aspect
// path unreachable, so `yg check --approve` never produces an environment-dependent
// LLM verdict — port 1 never has a listener, on ANY machine, with no reliance on a
// real endpoint being present or absent. Used by killReviewer().
const DEAD_ENDPOINT = 'http://127.0.0.1:1';

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
  const dir = mkdtempSync(path.join(tmpdir(), `yg-chan-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Copy the fixture and strip the LLM aspect (`has-doc-comment`) so the node's
 * effective aspects are purely deterministic. This makes the fill/check
 * lifecycle hermetic: no network, no LLM verdict, fully reproducible — the
 * deterministic aspects (`no-todo-comments`, `requires-named-export`, plus the
 * `no-banned-word` aspect this suite authors) drive every refuse/pass outcome.
 * Because every aspect is deterministic, `yg check --approve` makes no LLM call,
 * so plain spawnSync is safe (no mock-reviewer deadlock).
 */
function deterministicFixture(label: string): string {
  const dir = copyFixture(label);
  // Drop the LLM aspect from the `service` node type's default aspects.
  const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  const arch = readFileSync(archPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '- has-doc-comment')
    .join('\n');
  writeFileSync(archPath, arch, 'utf-8');
  // Remove the now-orphaned aspect definition so `yg check` is clean.
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), {
    recursive: true,
    force: true,
  });
  return dir;
}

/**
 * Repoint the reviewer endpoint at the dead loopback address. Rewrites whatever
 * `endpoint:` the fixture config carries to the guaranteed-dead port-1 address,
 * so the LLM reviewer is ALWAYS unreachable regardless of the machine. The
 * deterministicFixture already removes the only LLM aspect, but killing the
 * endpoint as well guarantees no `yg check --approve` in this suite can reach
 * out over the network even if a future fixture edit reintroduces an LLM aspect.
 */
function killReviewer(dir: string): void {
  const cfgPath = path.join(dir, '.yggdrasil', 'yg-config.yaml');
  const cfg = readFileSync(cfgPath, 'utf-8').replace(
    /endpoint:\s*["']?[^"'\n]+["']?/,
    `endpoint: "${DEAD_ENDPOINT}"`,
  );
  writeFileSync(cfgPath, cfg, 'utf-8');
}

/** Build a hermetic, LLM-free copy of the fixture (strip LLM aspect + kill endpoint). */
function hermeticFixture(label: string): string {
  const dir = deterministicFixture(label);
  killReviewer(dir);
  return dir;
}

const ordersFile = (dir: string) => path.join(dir, 'src', 'services', 'orders.ts');
const servicesNodeYaml = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'yg-node.yaml');
const archYaml = (dir: string) => path.join(dir, '.yggdrasil', 'yg-architecture.yaml');

/**
 * Author a self-contained deterministic aspect `no-banned-word` that flags any
 * line containing the literal token `BANNED`. Raw-content check (mirrors the
 * fixture's `no-todo-comments`) — no AST imports, fully hermetic. The aspect's
 * default status is taken from `defaultStatus` so the suite can exercise
 * status-max() across channels by varying it.
 *
 * This aspect is NOT attached to any node type by default — each test attaches
 * it on exactly the channel under test, so the `Source:` attribution is
 * unambiguous (it never collides with the fixture's own type-default aspects).
 */
function authorBannedAspect(dir: string, defaultStatus: 'advisory' | 'enforced'): void {
  const aspectDir = path.join(dir, '.yggdrasil', 'aspects', 'no-banned-word');
  mkdirSync(aspectDir, { recursive: true });
  writeFileSync(
    path.join(aspectDir, 'yg-aspect.yaml'),
    [
      'name: NoBannedWord',
      'description: Source files must not contain the banned token BANNED.',
      'reviewer:',
      '  type: deterministic',
      `status: ${defaultStatus}`,
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(
    path.join(aspectDir, 'check.mjs'),
    [
      'export function check(ctx) {',
      '  const violations = [];',
      '  for (const file of ctx.files) {',
      '    const lines = file.content.split("\\n");',
      '    for (let i = 0; i < lines.length; i++) {',
      '      if (lines[i].includes("BANNED")) {',
      '        violations.push({ file: file.path, line: i + 1, column: 0, message: "Banned token found." });',
      '      }',
      '    }',
      '  }',
      '  return violations;',
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );
}

/** Append a `BANNED` token to the orders source so no-banned-word trips. */
function plantBannedToken(dir: string): void {
  appendFileSync(ordersFile(dir), '\n// BANNED token here\n');
}

/** The standard 2-type architecture (module parent + service child), with an
 *  optional default-aspect block injected onto the `module` (ancestor) type so
 *  channel-4 (ancestor arch type) can be exercised. `moduleAspectsBlock` is
 *  spliced verbatim under the module type. */
function writeArchitecture(dir: string, moduleAspectsBlock: string[]): void {
  const lines = [
    'node_types:',
    '  module:',
    "    description: 'Organizational grouping of related services. Parent-only — has no file mapping.'",
    '    log_required: false',
    ...moduleAspectsBlock.map((l) => `    ${l}`),
    '',
    '  service:',
    "    description: 'Discrete service unit implemented as a single source file under src/services/.'",
    '    log_required: false',
    '    when:',
    '      path: "src/services/**"',
    '    parents: [module]',
    '    aspects:',
    '      - no-todo-comments',
    '      - requires-named-export',
    '    relations:',
    '      uses: [service]',
    '      calls: [service]',
    '',
  ];
  writeFileSync(archYaml(dir), lines.join('\n'), 'utf-8');
}

/** Re-author the `services` (parent / module) node, optionally attaching aspects. */
function writeServicesNode(dir: string, aspectLines: string[]): void {
  const lines = [
    'name: Services',
    "description: Organizational parent grouping the application's service units.",
    'type: module',
    ...(aspectLines.length > 0 ? ['aspects:', ...aspectLines] : []),
    '',
  ];
  writeFileSync(servicesNodeYaml(dir), lines.join('\n'), 'utf-8');
}

// ---------------------------------------------------------------------------
// 7-channel aspect propagation — focus on the under-tested cascade channels:
//   CH2 ancestor NODE attach, CH4 ancestor ARCH TYPE default, and the
//   effective-status max() ACROSS channels. Asserts both yg context Source
//   attribution AND fill/check enforcement (`yg check --approve` fills verdicts
//   into .yggdrasil/yg-lock.json; a violation refuses the pair). Fully hermetic:
//   each test copies into a fresh mkdtemp, strips the LLM aspect, points the
//   reviewer at a dead loopback endpoint, and rmSync's in finally. No network,
//   no clock, no randomness in any assertion.
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)('CLI E2E — 7-channel aspect propagation (ancestor node, ancestor type, status max)', () => {
  // --- Scenario 1: CH2 ANCESTOR NODE ---

  it('1: an aspect on the parent NODE reaches the child — context shows "inherited from parent", enforced approve refuses', () => {
    const dir = hermeticFixture('ch2-ancestor-node');
    try {
      authorBannedAspect(dir, 'enforced');
      // Attach no-banned-word on the parent `services` node only (channel 2).
      writeServicesNode(dir, ['  - no-banned-word']);

      // Context on the CHILD attributes the aspect to the parent node.
      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain('no-banned-word');
      expect(ctx.stdout).toContain("Source: inherited from parent 'services'");

      // A clean fill succeeds (the inherited aspect is satisfied) — exit 0.
      expect(run(['check', '--approve'], dir).status).toBe(0);

      // Planting the banned token trips the inherited ENFORCED aspect → refuse.
      plantBannedToken(dir);
      const refused = run(['check', '--approve'], dir);
      expect(refused.status).toBe(1);
      expect(refused.all).toContain('no-banned-word');
      // Fill-time line names the refused deterministic pair on the child node.
      expect(refused.all).toContain('[det] no-banned-word on node:services/orders — refused');
      // The grouped error body lists the node under the enforced group.
      expect(refused.all).toContain('- services/orders');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Scenario 2: CH4 ANCESTOR ARCH TYPE ---

  it('2: a default aspect on the parent TYPE (module) reaches descendant services — context shows "inherited from parent (type: module)", enforced approve refuses', () => {
    const dir = hermeticFixture('ch4-ancestor-type');
    try {
      authorBannedAspect(dir, 'enforced');
      // Give the `module` (ancestor) TYPE a default aspect (channel 4). No
      // per-node attach anywhere — the only path to the child is the
      // ancestor-type channel.
      writeArchitecture(dir, ['aspects:', '  - no-banned-word']);
      writeServicesNode(dir, []);

      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain('no-banned-word');
      expect(ctx.stdout).toContain('Source: inherited from parent (type: module)');

      // Clean fill passes; planting a banned token trips the enforced
      // ancestor-type aspect.
      expect(run(['check', '--approve'], dir).status).toBe(0);
      plantBannedToken(dir);
      const refused = run(['check', '--approve'], dir);
      expect(refused.status).toBe(1);
      expect(refused.all).toContain('no-banned-word');
      // Fill-time line names the refused deterministic pair on the child node.
      expect(refused.all).toContain('[det] no-banned-word on node:services/orders — refused');
      // The grouped error body lists the node under the enforced group.
      expect(refused.all).toContain('- services/orders');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Scenario 3: CH1 own vs CH3 own-type vs CH2 ancestor — distinct Source labels ---

  it('3: own (CH1), own-type (CH3), and ancestor-node (CH2) attributions render as three DISTINCT Source labels', () => {
    const dir = hermeticFixture('source-labels');
    try {
      authorBannedAspect(dir, 'enforced');
      // CH2: attach no-banned-word on the parent node.
      writeServicesNode(dir, ['  - no-banned-word']);

      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);

      // CH1 own declaration: wip-rule is attached directly on services/orders.
      expect(ctx.stdout).toContain('wip-rule');
      // CH3 own type (service): no-todo-comments is a default of the `service` type.
      expect(ctx.stdout).toContain('no-todo-comments');
      // CH2 ancestor node: no-banned-word attached on the parent `services` node.
      expect(ctx.stdout).toContain('no-banned-word');

      // Map each aspect id to the Source line that immediately follows it.
      const lines = ctx.stdout.split('\n');
      const sourceFor = (aspectId: string): string => {
        const idx = lines.findIndex((l) => l.trimStart().startsWith(`${aspectId} [`));
        expect(idx, `aspect ${aspectId} not found in context`).toBeGreaterThanOrEqual(0);
        const sourceLine = lines[idx + 1];
        expect(sourceLine, `Source line missing after ${aspectId}`).toContain('Source:');
        return sourceLine.trim();
      };

      const wipSource = sourceFor('wip-rule'); // CH1
      const todoSource = sourceFor('no-todo-comments'); // CH3
      const bannedSource = sourceFor('no-banned-word'); // CH2

      expect(wipSource).toBe('Source: own declaration');
      expect(todoSource).toBe('Source: architecture (type: service)');
      expect(bannedSource).toBe("Source: inherited from parent 'services'");

      // The three labels are pairwise distinct — provenance is not collapsed.
      expect(new Set([wipSource, todoSource, bannedSource]).size).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Scenario 4: STATUS max() ACROSS CHANNELS ---

  it('4a: same aspect via two channels, BOTH advisory → effective advisory → a violation is a non-blocking warning (approve exits 0)', () => {
    const dir = hermeticFixture('max-both-advisory');
    try {
      // Aspect default advisory. CH2 parent-node bare attach (inherits the
      // advisory default) + CH4 module-type default explicitly advisory.
      authorBannedAspect(dir, 'advisory');
      writeArchitecture(dir, ['aspects:', '  - id: no-banned-word', '    status: advisory']);
      writeServicesNode(dir, ['  - no-banned-word']);

      // Effective status is advisory (max of advisory + advisory).
      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.stdout).toContain('no-banned-word [advisory]');

      plantBannedToken(dir);
      const fill = run(['check', '--approve'], dir);
      // Advisory violation: recorded, NOT blocking → fill exits 0 and renders the
      // refusal as a non-blocking warning ("Approved: services/orders" was the
      // removed per-node approve banner; the new equivalent is the post-fill
      // passing check with the advisory warning attached).
      expect(fill.status).toBe(0);
      expect(fill.all).toContain('advisory');
      expect(fill.all).toContain('no-banned-word');
      // The advisory violation renders under the Warnings section as an
      // `advisory` group (the old per-issue "(advisory — not blocking)" suffix
      // is not emitted by the grouped renderer); the node is listed there. A
      // second warning group (`rules-digest-stale`) is always present too —
      // this fixture never ran `yg init`, so it carries no AGENTS.md/CLAUDE.md/
      // .clinerules digest artifacts, and the committed-digest staleness gate
      // flags that on every `yg check`/`yg check --approve` here. It is
      // unrelated to the aspect under test, so we assert its presence
      // explicitly rather than let it silently inflate the count.
      expect(fill.all).toContain('Warnings (2) in 2 groups:');
      expect(fill.all).toContain("advisory  1 pairs  1 nodes  aspect 'no-banned-word'");
      expect(fill.all).toContain('- services/orders');
      expect(fill.all).toContain('rules-digest-stale');

      // `yg check` renders it as a non-blocking warning and PASSES.
      const check = run(['check'], dir);
      expect(check.status).toBe(0);
      expect(check.stdout).toContain('PASS (2 warnings)');
      expect(check.all).toContain('advisory');
      expect(check.all).toContain('no-banned-word');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4b: SAME aspect via two channels with DIFFERENT statuses (advisory + enforced) → max() = enforced → a violation BLOCKS (approve exits 1)', () => {
    const dir = hermeticFixture('max-mixed-enforced');
    try {
      // Aspect default advisory. CH2 parent-node bare attach inherits the
      // advisory default; CH4 module-type default is explicitly ENFORCED.
      // No EXPLICIT attach-site status is below the cascade, so this is a
      // legitimate max() (not an aspect-status-downgrade).
      authorBannedAspect(dir, 'advisory');
      writeArchitecture(dir, ['aspects:', '  - id: no-banned-word', '    status: enforced']);
      writeServicesNode(dir, ['  - no-banned-word']);

      // Effective status is the STRICTEST of the two channels → enforced.
      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain('no-banned-word [enforced]');
      // The cross-channel combination is legal — no downgrade error.
      expect(ctx.all).not.toContain('aspect-status-downgrade');

      // The same banned token that was only a warning when both channels were
      // advisory (4a) now BLOCKS, because one channel raised it to enforced.
      plantBannedToken(dir);
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      expect(fill.all).toContain('no-banned-word');
      // Fill-time line names the refused deterministic pair on the child node.
      expect(fill.all).toContain('[det] no-banned-word on node:services/orders — refused');
      // The grouped error body lists the node under the enforced group.
      expect(fill.all).toContain('- services/orders');

      // And `yg check` renders it as a blocking error, not a warning.
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('enforced');
      expect(check.all).toContain('no-banned-word');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Scenario 5: bump-up allowed, cross-channel downgrade is a validator error ---

  it('5a: an explicit attach-site status ABOVE the aspect default (bump-up) is allowed — no downgrade error, enforced blocks', () => {
    const dir = hermeticFixture('bump-up');
    try {
      // Aspect default advisory; the CH2 parent-node attach explicitly bumps it
      // UP to enforced. Raising is always allowed.
      authorBannedAspect(dir, 'advisory');
      writeArchitecture(dir, []);
      writeServicesNode(dir, ['  - id: no-banned-word', '    status: enforced']);

      const ctx = run(['context', '--node', 'services/orders'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).toContain('no-banned-word [enforced]');

      // The bump-up itself does not error `yg check`.
      const check = run(['check'], dir);
      expect(check.all).not.toContain('aspect-status-downgrade');

      // Enforced (via the bump-up) blocks on a violation.
      plantBannedToken(dir);
      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(1);
      expect(fill.all).toContain('no-banned-word');
      // Fill-time line names the refused deterministic pair on the child node.
      expect(fill.all).toContain('[det] no-banned-word on node:services/orders — refused');
      // The grouped error body lists the node under the enforced group.
      expect(fill.all).toContain('- services/orders');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('5b: a cross-channel DOWNGRADE — explicit advisory on the parent NODE below an enforced ancestor-TYPE cascade — is an aspect-status-downgrade error', () => {
    const dir = hermeticFixture('cross-channel-downgrade');
    try {
      // CH4 module-type default is enforced; the CH2 parent-node attach tries to
      // relax it back to advisory. An explicit attach-site status cannot weaken
      // a stricter cascade arriving from another channel.
      authorBannedAspect(dir, 'enforced');
      writeArchitecture(dir, ['aspects:', '  - id: no-banned-word', '    status: enforced']);
      writeServicesNode(dir, ['  - id: no-banned-word', '    status: advisory']);

      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('aspect-status-downgrade');
      // The child node is named in the downgrade group, and the cascading
      // ancestor source is listed as a group member; the shared why explains
      // that an explicit attach-site status cannot relax a stricter cascade.
      expect(check.all).toContain('services/orders');
      expect(check.all).toContain('- services');
      expect(check.all).toContain(
        'An explicit attach-site status cannot relax (downgrade) what already cascades',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
