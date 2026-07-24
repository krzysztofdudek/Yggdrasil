// =============================================================================
// E2E coverage for Phase-2 `yg check` view flags: --details, --aspect <id>,
// --top N (group-based), and mutual-exclusion errors.
//
// Phase 2 added:
//   --details        Ungrouped, one block per issue (reverses Phase-1 grouping).
//   --aspect <id>    Drill into one rule: only that aspect's issues, "K of N errors" header.
//   --top N (changed) N renders the N highest-priority GROUPS, not N individual issues.
//   Mutual exclusion: --details cannot combine with --approve, --top, or --summary.
//
// These tests spawn the REAL built binary (dist/bin.js) against a hermetic
// fixture built in code, then assert the specific grammar each flag produces.
//
// Implementation under test: src/cli/check.ts (renderOutput / renderDetailsSection)
// and src/cli/group-issues.ts (groupIssues).
// =============================================================================

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

// A loopback reviewer endpoint that is never dialed by read-only `yg check`.
const LOOPBACK_ENDPOINT = 'http://127.0.0.1:11434';

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

/** Strip chalk ANSI escapes so colour codes never break substring/regex matches. */
function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Count rendered issue BLOCKS in stripped stdout.
 *
 * Grouped default view: each group is ONE block (header line starting with "  <label>").
 * --details view: each ISSUE is ONE block.
 *
 * A block-start line: indented 2 spaces, non-whitespace first char, not a Why:/Fix: continuation.
 */
function countBlocks(stdout: string): number {
  return strip(stdout)
    .split('\n')
    .filter((l) => /^ {2}\S/.test(l) && !/^ {2}(Why:|Fix:)/.test(l))
    .length;
}

/**
 * Assert no Errors(N):/Warnings(N): subheader dangles empty — every rendered
 * subheader must be followed (skipping blank lines) by CONTENT: a group block,
 * a summary row, or the 4-space-indented "(no ... groups within --top N ...)"
 * annotation. A subheader followed directly by another subheader, the Next:
 * line, or end of output is the dangling-header defect this pins against.
 */
function expectNoDanglingSectionHeader(stdout: string): void {
  const lines = strip(stdout).split('\n');
  lines.forEach((line, i) => {
    if (/^(Errors|Warnings) \(\d+\):/.test(line)) {
      const following = lines.slice(i + 1).find((l) => l.trim() !== '') ?? '';
      expect(
        /^(Errors|Warnings) \(\d+\):|^Next:|^$/.test(following),
        `subheader "${line}" must not dangle empty (followed by "${following}")`,
      ).toBe(false);
    }
  });
}

/**
 * Build a hermetic project with TWO enforced LLM aspects and THREE nodes, so
 * `yg check` (cold lock) produces multiple unverified pairs across two different
 * aspects — a realistic multi-group scenario.
 *
 * Node plan:
 *   alpha — has aspect-one (via architecture default) and aspect-two (own attach)
 *   beta  — has aspect-one only (architecture default)
 *   gamma — has aspect-one only (architecture default)
 *
 * This gives:
 *   aspect-one:  3 unverified pairs (alpha, beta, gamma)
 *   aspect-two:  1 unverified pair  (alpha)
 *   Total: 4 unverified errors in 2 groups (one per code×aspectId after Phase-1.6
 *          unverified grouping by code only → both collapse into ONE "unverified" group).
 *
 * Wait — Phase 1.6 groups unverified by CODE ONLY, so both aspects land in the
 * SAME group. To get TWO distinct groups we need a non-unverified second error type.
 * We use an aspect that is NOT attached to any node (so it stays a pure cold-lock
 * unverified group) PLUS a mapping-path-missing structural error on a fourth node,
 * which always renders as a second group.
 *
 * Final fixture:
 *   Nodes: alpha, beta, gamma (all have aspect-one) + broken (mapping-path-missing).
 *   aspect-one on all three mapped nodes → 3 unverified pairs (1 group).
 *   broken node maps a non-existent file → 1 mapping-path-missing (second group).
 *   Total: 4 errors in 2 groups.
 *
 * For the --aspect test we also attach aspect-two to alpha (own attach), giving
 * aspect-two 1 unverified pair on top of the 3 from aspect-one.
 */
function buildViewsFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-check-views-'));
  const ygRoot = path.join(dir, '.yggdrasil');
  const srcDir = path.join(dir, 'src');

  mkdirSync(path.join(ygRoot, 'model'), { recursive: true });
  mkdirSync(path.join(ygRoot, 'aspects'), { recursive: true });
  mkdirSync(path.join(ygRoot, 'flows'), { recursive: true });
  mkdirSync(srcDir, { recursive: true });

  // Two enforced LLM aspects.
  for (const id of ['aspect-one', 'aspect-two']) {
    const aDir = path.join(ygRoot, 'aspects', id);
    mkdirSync(aDir, { recursive: true });
    writeFileSync(
      path.join(aDir, 'yg-aspect.yaml'),
      `name: ${id}\ndescription: Phase-2 views test aspect ${id}\nstatus: enforced\n`,
      'utf-8',
    );
    writeFileSync(path.join(aDir, 'content.md'), `# ${id}\n\nAll files must satisfy ${id}.\n`, 'utf-8');
  }

  // Architecture: one node type with aspect-one as default.
  writeFileSync(
    path.join(ygRoot, 'yg-architecture.yaml'),
    [
      'node_types:',
      '  svc:',
      "    description: 'Service node for Phase-2 views coverage'",
      '    log_required: false',
      '    when:',
      '      path: "src/**"',
      '    aspects:',
      '      - aspect-one',
      '',
    ].join('\n'),
    'utf-8',
  );

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

  // alpha: has aspect-one (default) + aspect-two (explicit attach).
  const alphaDir = path.join(ygRoot, 'model', 'alpha');
  mkdirSync(alphaDir, { recursive: true });
  writeFileSync(
    path.join(alphaDir, 'yg-node.yaml'),
    [
      'name: alpha',
      'type: svc',
      'description: alpha',
      'aspects:',
      '  - aspect-two',
      'relations: []',
      'mapping:',
      '  - src/alpha.ts',
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(path.join(srcDir, 'alpha.ts'), "export const alpha = 'alpha';\n", 'utf-8');

  // beta and gamma: aspect-one only (architecture default).
  for (const name of ['beta', 'gamma']) {
    const nodeDir = path.join(ygRoot, 'model', name);
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(
      path.join(nodeDir, 'yg-node.yaml'),
      [`name: ${name}`, 'type: svc', `description: ${name}`, 'aspects: []', 'relations: []', 'mapping:', `  - src/${name}.ts`, ''].join('\n'),
      'utf-8',
    );
    writeFileSync(path.join(srcDir, `${name}.ts`), `export const ${name} = '${name}';\n`, 'utf-8');
  }

  // broken: maps a non-existent file → mapping-path-missing (structural error, second group).
  const brokenDir = path.join(ygRoot, 'model', 'broken');
  mkdirSync(brokenDir, { recursive: true });
  writeFileSync(
    path.join(brokenDir, 'yg-node.yaml'),
    [
      'name: broken',
      'type: svc',
      'description: broken',
      'aspects: []',
      'relations: []',
      'mapping:',
      '  - src/does-not-exist.ts',
      '',
    ].join('\n'),
    'utf-8',
  );
  // NOTE: src/does-not-exist.ts is intentionally NOT created.

  return dir;
}

// Fixture error inventory (for documentation / cross-check in tests):
//   aspect-one unverified: alpha, beta, gamma → 3 pairs
//   aspect-two unverified: alpha              → 1 pair
//   mapping-path-missing:  broken             → 1 structural error
//   Total errors: 5 (4 unverified pairs in 1 group + 1 mapping-path-missing in 1 group = 2 groups).
//
// Phase-1.6: unverified groups by CODE ONLY → all 4 unverified pairs are ONE group.
// mapping-path-missing is a second group.
// Grand total: 5 errors in 2 groups.

describe.skipIf(!distExists)('CLI E2E — yg check Phase-2 view flags', () => {
  let dir: string;

  // Build the shared fixture once per describe block; tear down after all tests.
  // (vitest describe-level hooks run once; individual tests must not mutate dir.)

  it.sequential('setup: build fixture', () => {
    dir = buildViewsFixture();
    expect(existsSync(dir)).toBe(true);
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it.sequential('--details: ungrouped view, one block per issue (more blocks than default), exit 1', () => {
    const { stdout, status } = run(['check', '--details'], dir);
    const out = strip(stdout);

    expect(status).toBe(1);

    // True aggregate: 5 errors total (3 aspect-one + 1 aspect-two + 1 mapping-path-missing).
    expect(out).toMatch(/^Errors \(5\):$/m);

    // --details renders ONE block per issue, not per group.
    // Default grouped view collapses the 4 unverified pairs into 1 group → 2 total blocks.
    // --details emits 5 error blocks (one per error) PLUS 1 warning block: this
    // fixture never ran `yg init`, so it carries no AGENTS.md/CLAUDE.md/.clinerules
    // digest artifacts, and the committed-digest staleness gate (a warning, not
    // an error — the `Errors (5)` assertion above is unaffected) always fires
    // here. --details renders that warning as its own block too, for 6 total.
    const blockCount = countBlocks(out);
    expect(blockCount).toBe(6);
    // Pin WHICH warning contributes the 6th block — so a future change that
    // removes this gate and happens to add some other warning cannot satisfy
    // the count silently.
    expect(out).toContain('rules-digest-stale');

    // Each unverified issue line includes the per-issue "unverified  <node>" pattern
    // (not the grouped header with "N pairs  M nodes").
    expect(out).toMatch(/^ {2}unverified {2}alpha {2}/m);
    expect(out).toMatch(/^ {2}unverified {2}beta {2}/m);
    expect(out).toMatch(/^ {2}unverified {2}gamma {2}/m);

    // The mapping-path-missing issue renders individually.
    expect(out).toMatch(/^ {2}mapping-path-missing {2}broken {2}/m);

    // NO grouped header ("N pairs  M nodes") in --details output.
    expect(out).not.toMatch(/\d+ pairs {2}\d+ nodes/);
  });

  it.sequential('--aspect aspect-one: only that aspect\'s issues, K of N header, exit 1', () => {
    const { stdout, status } = run(['check', '--aspect', 'aspect-one'], dir);
    const out = strip(stdout);

    expect(status).toBe(1);

    // Header: "FAIL  (aspect 'aspect-one' — K of N errors)".
    // K = 3 (alpha, beta, gamma for aspect-one); N = 5 (true total).
    expect(out).toMatch(/\(aspect 'aspect-one' — 3 of 5 errors\)/);

    // Only aspect-one's issues are shown.
    expect(out).toContain('alpha');
    expect(out).toContain('beta');
    expect(out).toContain('gamma');

    // aspect-two issues (alpha only) must NOT appear as a separate group.
    // mapping-path-missing (broken) must NOT appear.
    expect(out).not.toContain('mapping-path-missing');
    expect(out).not.toContain('broken');

    // The drill-in "Next (this group):" line is used instead of global "Next:".
    expect(out).toMatch(/^Next \(this group\): yg check --approve$/m);
  });

  it.sequential('--aspect aspect-two: only that aspect\'s single issue, header shows K=1 of N=5, exit 1', () => {
    const { stdout, status } = run(['check', '--aspect', 'aspect-two'], dir);
    const out = strip(stdout);

    expect(status).toBe(1);

    // K = 1 (alpha only for aspect-two); N = 5 (true total).
    expect(out).toMatch(/\(aspect 'aspect-two' — 1 of 5 errors\)/);

    // Only alpha listed (it has aspect-two attached).
    expect(out).toContain('alpha');

    // beta and gamma are NOT affected by aspect-two.
    expect(out).not.toMatch(/^ {12}- beta/m);
    expect(out).not.toMatch(/^ {12}- gamma/m);

    // mapping-path-missing must NOT appear.
    expect(out).not.toContain('broken');
    expect(out).not.toContain('mapping-path-missing');
  });

  it.sequential('--top 1: exactly ONE group block rendered, true total still visible, exit 1', () => {
    const { stdout, status } = run(['check', '--top', '1'], dir);
    const out = strip(stdout);

    expect(status).toBe(1);

    // True aggregate header is always shown: 5 errors.
    expect(out).toMatch(/Errors \(5\)/);

    // --top 1 renders only 1 group block.
    const blockCount = countBlocks(out);
    expect(blockCount).toBe(1);

    // The Next: line is still present (--top is a narrowed view, not silent).
    expect(out).toMatch(/^Next:/m);

    // No section header is left dangling with nothing beneath it.
    expectNoDanglingSectionHeader(stdout);
  });

  it.sequential('bare --top: exactly ONE group block — the suggested-next group — true total visible, exit 1', () => {
    const { stdout, status } = run(['check', '--top'], dir);
    const out = strip(stdout);

    expect(status).toBe(1);

    // GUARDRAIL: the narrowed view never hides the true aggregate counts.
    expect(out).toMatch(/Errors \(5\)/);
    expect(out).toMatch(/yg check: FAIL/);

    // Bare --top = --top 1: exactly ONE group block renders.
    expect(countBlocks(out)).toBe(1);

    // The rendered group is the one the Next: line draws from — unverified
    // outranks the mapping-path-missing structural group in the priority cascade.
    expect(out).toContain('unverified');
    expect(out).not.toContain('mapping-path-missing');

    // The Next: line still prints — bare --top is a narrowed view, not silence.
    expect(out).toMatch(/^Next:/m);

    // Bare --top and --top 1 are the SAME view (n=1 semantics).
    const explicit = run(['check', '--top', '1'], dir);
    expect(strip(explicit.stdout)).toBe(out);

    // No section header is left dangling with nothing beneath it.
    expectNoDanglingSectionHeader(stdout);
  });

  it.sequential('--top 2: both groups rendered (all groups shown when N groups <= top), exit 1', () => {
    const { stdout, status } = run(['check', '--top', '2'], dir);
    const out = strip(stdout);

    expect(status).toBe(1);

    // True total still visible.
    expect(out).toMatch(/Errors \(5\)/);

    // Both groups (unverified + mapping-path-missing) should render.
    const blockCount = countBlocks(out);
    expect(blockCount).toBe(2);

    // No section header is left dangling with nothing beneath it.
    expectNoDanglingSectionHeader(stdout);
  });

  it.sequential('--details --approve: mutual-exclusion error to stderr, exit 1', () => {
    const { stderr, status } = run(['check', '--details', '--approve'], dir);
    const err = strip(stderr);

    expect(status).toBe(1);
    // The guided error message names both conflicting flags.
    expect(err).toContain('--details cannot be combined with --approve');
    // The next command is surfaced so the agent knows what to do.
    expect(err).toContain('yg check --details');
    expect(err).toContain('yg check --approve');
  });

  it.sequential('--details --summary: mutual-exclusion error to stderr, exit 1', () => {
    const { stderr, status } = run(['check', '--details', '--summary'], dir);
    const err = strip(stderr);

    expect(status).toBe(1);
    expect(err).toContain('--details cannot be combined with');
  });

  // ── Fix 7: read-only triage views cannot combine with the fill flag ──────────
  it.sequential('--summary --only-deterministic: rejected (read-only view + fill flag), exit 1', () => {
    const { stderr, status } = run(['check', '--summary', '--only-deterministic'], dir);
    const err = strip(stderr);
    expect(status).toBe(1);
    expect(err).toContain('--summary cannot be combined with --only-deterministic');
    // Guided next surfaces both intents.
    expect(err).toContain('yg check --summary');
    expect(err).toContain('yg check --approve --only-deterministic');
  });

  it.sequential('--top --only-deterministic: rejected (read-only view + fill flag), exit 1', () => {
    const { stderr, status } = run(['check', '--top', '--only-deterministic'], dir);
    const err = strip(stderr);
    expect(status).toBe(1);
    expect(err).toContain('--top cannot be combined with --only-deterministic');
  });

  // ── Fix 6(a): unknown aspect id is a clear error, not a silent 0-count FAIL ───
  it.sequential('--aspect <unknown-id>: clear "unknown aspect" error naming the id, exit 1', () => {
    const { stdout, stderr, status } = run(['check', '--aspect', 'totally-bogus-aspect'], dir);
    const err = strip(stderr);
    const out = strip(stdout);
    expect(status).toBe(1);
    // Error names the unknown id and says it is unknown.
    expect(err).toContain("Unknown aspect 'totally-bogus-aspect'");
    // It must NOT render the misleading drill-in "0 of N errors" FAIL.
    expect(out).not.toContain('0 of');
    expect(out).not.toContain("aspect 'totally-bogus-aspect'");
  });

});

/**
 * Build a hermetic project whose cold-lock `yg check` produces BOTH an error
 * and a warning: one node with an ENFORCED aspect (unverified pair → error)
 * and an ADVISORY aspect (unverified pair → warning). The --top slice orders
 * error groups before warning groups, so `--top 1` chooses only the error
 * group — leaving the Warnings section with a true count > 0 but no chosen
 * groups. This is the empty-subheader annotation scenario.
 */
function buildAnnotationFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-check-top-annotation-'));
  const ygRoot = path.join(dir, '.yggdrasil');
  const srcDir = path.join(dir, 'src');

  mkdirSync(path.join(ygRoot, 'model'), { recursive: true });
  mkdirSync(path.join(ygRoot, 'aspects'), { recursive: true });
  mkdirSync(path.join(ygRoot, 'flows'), { recursive: true });
  mkdirSync(srcDir, { recursive: true });

  // One enforced aspect (→ unverified ERROR) and one advisory aspect (→ unverified WARNING).
  for (const [id, status] of [['aspect-hard', 'enforced'], ['aspect-soft', 'advisory']] as const) {
    const aDir = path.join(ygRoot, 'aspects', id);
    mkdirSync(aDir, { recursive: true });
    writeFileSync(
      path.join(aDir, 'yg-aspect.yaml'),
      `name: ${id}\ndescription: top-annotation test aspect ${id}\nstatus: ${status}\n`,
      'utf-8',
    );
    writeFileSync(path.join(aDir, 'content.md'), `# ${id}\n\nAll files must satisfy ${id}.\n`, 'utf-8');
  }

  writeFileSync(
    path.join(ygRoot, 'yg-architecture.yaml'),
    [
      'node_types:',
      '  svc:',
      "    description: 'Service node for --top annotation coverage'",
      '    log_required: false',
      '    when:',
      '      path: "src/**"',
      '',
    ].join('\n'),
    'utf-8',
  );

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

  // solo: carries BOTH aspects → 1 unverified error + 1 unverified warning.
  const soloDir = path.join(ygRoot, 'model', 'solo');
  mkdirSync(soloDir, { recursive: true });
  writeFileSync(
    path.join(soloDir, 'yg-node.yaml'),
    [
      'name: solo',
      'type: svc',
      'description: solo',
      'aspects:',
      '  - aspect-hard',
      '  - aspect-soft',
      'relations: []',
      'mapping:',
      '  - src/solo.ts',
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(path.join(srcDir, 'solo.ts'), "export const solo = 'solo';\n", 'utf-8');

  return dir;
}

describe.skipIf(!distExists)('CLI E2E — yg check --top empty-section annotation', () => {
  let dir: string;

  it.sequential('setup: build annotation fixture', () => {
    dir = buildAnnotationFixture();
    expect(existsSync(dir)).toBe(true);
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it.sequential('--top 1 with errors AND warnings: warning subheader annotated, never dangling, exit 1', () => {
    const { stdout, status } = run(['check', '--top', '1'], dir);
    const out = strip(stdout);

    expect(status).toBe(1);

    // GUARDRAIL: true aggregate counts for BOTH severities stay visible even
    // though the slice renders no warning group. The true warning count is 2,
    // not 1: this fixture never ran `yg init`, so it carries no AGENTS.md/
    // CLAUDE.md/.clinerules digest artifacts, and the committed-digest
    // staleness gate (`rules-digest-stale`) always fires here alongside
    // `aspect-soft`'s unverified warning.
    expect(out).toMatch(/Errors \(1\)/);
    expect(out).toMatch(/Warnings \(2\)/);
    // Pin WHICH warning contributes the 2nd count. `--top 1` annotates the
    // whole warnings section away (no group body), so `rules-digest-stale`
    // cannot appear literally in `out` above — cross-check the untruncated
    // listing instead, so a future change that removes this gate and adds
    // some other 2nd warning cannot satisfy `Warnings (2)` silently.
    const untruncated = run(['check'], dir);
    expect(strip(untruncated.stdout)).toContain('rules-digest-stale');

    // Exactly ONE group block (the suggested-next error group).
    expect(countBlocks(out)).toBe(1);

    // The Warnings section carries the annotation instead of a dangling header.
    expect(out).toContain('    (no warning groups within --top 1 — run yg check for the full list)');
    // The Errors section has a body, so it is NOT annotated.
    expect(out).not.toContain('(no error groups within --top 1');

    expect(out).toMatch(/^Next:/m);
    expectNoDanglingSectionHeader(stdout);
  });

  it.sequential('bare --top behaves as --top 1: one group + annotated warning subheader, exit 1', () => {
    const { stdout, status } = run(['check', '--top'], dir);
    const out = strip(stdout);

    expect(status).toBe(1);
    // True warning count is 2 (aspect-soft + rules-digest-stale) — see the
    // comment on the --top 1 case above.
    expect(out).toMatch(/Errors \(1\)/);
    expect(out).toMatch(/Warnings \(2\)/);
    // Pin WHICH warning contributes the 2nd count — see the --top 1 case
    // above for why the cross-check is against the untruncated listing.
    const untruncated = run(['check'], dir);
    expect(strip(untruncated.stdout)).toContain('rules-digest-stale');
    expect(countBlocks(out)).toBe(1);
    expect(out).toContain('    (no warning groups within --top 1 — run yg check for the full list)');
    expectNoDanglingSectionHeader(stdout);

    // Bare --top and --top 1 are the SAME view (n=1 semantics).
    const explicit = run(['check', '--top', '1'], dir);
    expect(strip(explicit.stdout)).toBe(out);
  });
});

// =============================================================================
// F3 regression: bare `--top`'s single group must be exactly the group the
// `Next:` line names — on a repo whose top errors are UNRANKED structural codes.
//
// Fixture (no aspects → no unverified pairs; the top errors are structural):
//   - node `alpha` declares a relation to a non-existent target → relation-broken
//   - flow `broken-flow` references a non-existent node          → flow-node-broken
//   - `src/orphan.ts` is mapped to no node                       → unmapped-files
//
// Both structural codes are UNRANKED (not in ERROR_CODE_PRIORITY). The validators
// emit them relation-broken-FIRST, flow-node-broken-second, but groupIssues
// tie-breaks alphabetically (flow-node-broken < relation-broken). Under the OLD
// comparators the two surfaces DIVERGED: bare `--top` rendered the flow-node-broken
// group (alphabetical) while `Next:` named relation-broken (emission-order pick) —
// and coverage (`unmapped-files`) could jump ahead of structural in `--top`. Both
// surfaces now share ONE ordering (structural < coverage, alphabetical within), so
// the group `--top` renders is exactly the rule `Next:` names.
// =============================================================================

function buildStructuralCoverageFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-f3-invariant-'));
  const ygRoot = path.join(dir, '.yggdrasil');
  const srcDir = path.join(dir, 'src');
  mkdirSync(path.join(ygRoot, 'model', 'alpha'), { recursive: true });
  mkdirSync(path.join(ygRoot, 'aspects'), { recursive: true });
  mkdirSync(path.join(ygRoot, 'flows', 'broken-flow'), { recursive: true });
  mkdirSync(srcDir, { recursive: true });

  writeFileSync(
    path.join(ygRoot, 'yg-architecture.yaml'),
    [
      'node_types:',
      '  svc:',
      "    description: 'Service node for F3 invariant coverage'",
      '    log_required: false',
      '    when:',
      '      path: "src/**"',
      '    relations:',
      '      uses: [svc]',
      '',
    ].join('\n'),
    'utf-8',
  );
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
  // alpha declares a relation to a non-existent target → relation-broken.
  writeFileSync(
    path.join(ygRoot, 'model', 'alpha', 'yg-node.yaml'),
    [
      'name: alpha',
      'type: svc',
      'description: alpha',
      'aspects: []',
      'relations:',
      '  - type: uses',
      '    target: ghost',
      'mapping:',
      '  - src/alpha.ts',
      '',
    ].join('\n'),
    'utf-8',
  );
  // A flow referencing a non-existent node → flow-node-broken.
  writeFileSync(
    path.join(ygRoot, 'flows', 'broken-flow', 'yg-flow.yaml'),
    ['name: broken-flow', 'description: references a non-existent node', 'nodes:', '  - phantom', 'aspects: []', ''].join('\n'),
    'utf-8',
  );
  writeFileSync(path.join(srcDir, 'alpha.ts'), "export const alpha = 'a';\n", 'utf-8');
  // Mapped to no node → unmapped-files (coverage error).
  writeFileSync(path.join(srcDir, 'orphan.ts'), "export const orphan = 'o';\n", 'utf-8');
  return dir;
}

describe.skipIf(!distExists)('CLI E2E — F3: bare --top group === the rule Next names', () => {
  let dir: string;

  it.sequential('setup: build structural+coverage fixture', () => {
    dir = buildStructuralCoverageFixture();
    expect(existsSync(dir)).toBe(true);
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it.sequential('the group bare --top renders is exactly the rule the Next: line names (structural + coverage mix)', () => {
    const top = run(['check', '--top'], dir);
    const full = run(['check'], dir);
    // Red repo — both exit 1, TRUE aggregate preserved.
    expect(top.status).toBe(1);
    expect(full.status).toBe(1);

    const topOut = strip(top.stdout);
    const fullOut = strip(full.stdout);

    // Sanity: BOTH structural codes AND coverage are present in the full wall.
    // flow-node-broken names a FLOW, not a node — it carries no node path, so
    // its header is the bare label with no pair/node counts (those would be
    // fabricated). relation-broken does name a node and keeps its counts.
    expect(fullOut).toMatch(/^ {2}flow-node-broken$/m);
    expect(fullOut).toMatch(/^ {2}relation-broken {2}\d+ pairs/m);
    expect(fullOut).toMatch(/^ {2}unmapped \(/m);

    // The rule bare --top renders: the FIRST group header line's label token,
    // whether or not that group's header carries node-scoped counts.
    const topGroupMatch = topOut.match(/^ {2}(\S+)(?: {2}\d+ pairs {2}\d+ nodes.*)?$/m);
    expect(topGroupMatch).not.toBeNull();
    const topGroupRule = topGroupMatch![1];

    // The rule the Next: line names: `Next: Fix <code> in <node>`.
    const nextMatch = fullOut.match(/^Next: Fix (\S+) /m);
    expect(nextMatch).not.toBeNull();
    const nextRule = nextMatch![1];

    // THE INVARIANT: the two surfaces name the SAME rule.
    expect(topGroupRule).toBe(nextRule);
    // And concretely: the alphabetically-first structural code wins BOTH — NOT
    // relation-broken (the OLD emission-order pick) and NOT unmapped-files (the
    // OLD alphabetical-across-all coverage pick).
    expect(topGroupRule).toBe('flow-node-broken');
    expect(nextRule).not.toBe('relation-broken');
    expect(topGroupRule).not.toBe('unmapped-files');

    // Bare --top renders exactly ONE group.
    expect(countBlocks(topOut)).toBe(1);
  });
});
