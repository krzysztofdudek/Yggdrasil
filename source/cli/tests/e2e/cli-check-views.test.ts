// =============================================================================
// E2E coverage for Phase-2 `yg check` view flags: --details, --aspect <id>,
// --top N (group-based), and mutual-exclusion errors.
//
// Phase 2 added, in the one grammar (issue 191):
//   --details        Uncapped: every pair listed as `<aspect> @ <unit>` in its block
//                    (`view: details` on the verdict line).
//   --aspect <id>    Drill into one rule: only that aspect's blocks; the verdict line
//                    keeps the TRUE totals and ends `view: aspect <id>`.
//   --top N          The first N blocks, then `… +K more blocks  (yg check)`.
//   Mutual exclusion: --details cannot combine with --approve, --top, or --summary.
//
// These tests spawn the REAL built binary (dist/bin.js) against a hermetic
// fixture built in code, then assert the specific grammar each flag produces.
//
// Implementation under test: src/cli/check-render-views.ts and
// src/cli/check-render-groups.ts.
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
 * Count rendered finding BLOCKS in stripped stdout: each block opens with an
 * `error[<label>] ` or `warning[<label>] ` heading at column 0.
 */
function countBlocks(stdout: string): number {
  return strip(stdout)
    .split('\n')
    .filter((l) => /^(error|warning)\[[^\]]+\] /.test(l))
    .length;
}

/**
 * A narrowed view never leaves an empty section behind: the one grammar has no
 * `Errors (N):` / `Warnings (N):` sub-headers at all, and what the slice hides
 * is announced by the `… +K more block(s)  (yg check)` footer.
 */
function expectNoDanglingSectionHeader(stdout: string): void {
  const out = strip(stdout);
  expect(out).not.toMatch(/^(Errors|Warnings) \(\d+\)/m);
  expect(out).toMatch(/^… \+\d+ more blocks? {2}\(yg check\)$/m);
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
  //
  // ORDER-DEPENDENT: the `setup:` test below populates `dir`, and every test
  // after it reads that value. These were written as `it.sequential(...)`, an
  // option vitest 5 removed (it existed only to opt a test out of an enclosing
  // `concurrent` suite). Plain `it()` is exactly equivalent here: vitest runs
  // the tests of one file sequentially, in declaration order, unless the suite
  // or config opts into concurrency — and nothing in this repo does. Never mark
  // this block (or the config) `concurrent`; it would race `dir` against setup.

  it('setup: build fixture', () => {
    dir = buildViewsFixture();
    expect(existsSync(dir)).toBe(true);
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('--details: ungrouped view, one block per issue (more blocks than default), exit 1', () => {
    const { stdout, status } = run(['check', '--details'], dir);
    const out = strip(stdout);

    expect(status).toBe(1);

    // True aggregate: 5 errors total (3 aspect-one + 1 aspect-two + 1 mapping-path-missing).
    expect(out).toMatch(/^yg check: FAIL {2}5 errors · 1 warning .* {3}view: details$/m);

    // --details keeps one block per rule-and-cause but lists EVERY pair: the
    // default capped view summarises aspect-one as "3 pairs · 3 nodes".
    // 2 error blocks (mapping-path-missing + unverified) PLUS 1 warning block:
    // this fixture never ran `yg init`, so it carries no AGENTS.md/CLAUDE.md/
    // .clinerules digest artifacts, and the committed-digest staleness gate (a
    // warning, not an error — the `5 errors` count above is unaffected) always
    // fires here.
    const blockCount = countBlocks(out);
    expect(blockCount).toBe(3);
    // Pin WHICH warning contributes the 3rd block — so a future change that
    // removes this gate and happens to add some other warning cannot satisfy
    // the count silently.
    expect(out).toContain('warning[rules-digest-stale]');

    // Each unverified pair is listed on its own member line "<aspect> @ <node>"
    // (not the capped "<aspect>  N pairs · M nodes" summary line).
    expect(out).toMatch(/^ +(at: +)?aspect-one @ alpha$/m);
    expect(out).toMatch(/^ +(at: +)?aspect-one @ beta$/m);
    expect(out).toMatch(/^ +(at: +)?aspect-one @ gamma$/m);
    expect(out).toMatch(/^ +(at: +)?aspect-two @ alpha$/m);

    // The mapping-path-missing issue renders as its own block, naming its node.
    expect(out).toMatch(/^error\[mapping-path-missing\] Mapping path 'src\/does-not-exist\.ts' does not exist on disk\n {2}at: {3}broken$/m);

    // NO capped summary line ("N pairs · M nodes") in --details output.
    expect(out).not.toMatch(/\d+ pairs · \d+ nodes/);
    // …while the default view does summarise it.
    expect(strip(run(['check'], dir).stdout)).toMatch(/^ {2}at: {3}aspect-one {2}3 pairs · 3 nodes · reviewer$/m);
  });

  it('--aspect aspect-one: only that aspect\'s issues, K of N header, exit 1', () => {
    const { stdout, status } = run(['check', '--aspect', 'aspect-one'], dir);
    const out = strip(stdout);

    expect(status).toBe(1);

    // The verdict line keeps the TRUE total N = 5 and names the view; the one
    // block shown carries K = 3 (alpha, beta, gamma for aspect-one).
    expect(out).toMatch(/^yg check: FAIL {2}5 errors · .* {3}view: aspect aspect-one$/m);
    expect(countBlocks(out)).toBe(1);
    expect(out).toMatch(/^error\[unverified\] 3 pairs with no verdict yet$/m);

    // Only aspect-one's issues are shown.
    expect(out).toContain('aspect-one @ alpha');
    expect(out).toContain('aspect-one @ beta');
    expect(out).toContain('aspect-one @ gamma');

    // aspect-two issues (alpha only) must NOT appear.
    // mapping-path-missing (broken) must NOT appear as a block.
    expect(out).not.toContain('aspect-two');
    expect(out).not.toMatch(/^error\[mapping-path-missing\]/m);
    expect(out).not.toMatch(/^ {2}at: {3}broken$/m);

    // The drilled block's own step fills exactly this rule's pairs.
    expect(out).toMatch(/^ {2}fix: {2}yg check --approve {2}\(3 reviewer pairs · paid — ask the user first\)$/m);
  });

  it('--aspect aspect-two: only that aspect\'s single issue, header shows K=1 of N=5, exit 1', () => {
    const { stdout, status } = run(['check', '--aspect', 'aspect-two'], dir);
    const out = strip(stdout);

    expect(status).toBe(1);

    // K = 1 (alpha only for aspect-two); N = 5 (true total).
    expect(out).toMatch(/^yg check: FAIL {2}5 errors · .* {3}view: aspect aspect-two$/m);
    expect(out).toMatch(/^error\[unverified\] 1 pair with no verdict yet$/m);

    // Only alpha listed (it has aspect-two attached).
    expect(out).toMatch(/^ {2}at: {3}aspect-two @ alpha$/m);

    // beta and gamma are NOT affected by aspect-two.
    expect(out).not.toMatch(/@ beta$/m);
    expect(out).not.toMatch(/@ gamma$/m);

    // mapping-path-missing must NOT appear.
    expect(out).not.toMatch(/^ {2}at: {3}broken$/m);
    expect(out).not.toMatch(/^error\[mapping-path-missing\]/m);
  });

  it('--top 1: exactly ONE group block rendered, true total still visible, exit 1', () => {
    const { stdout, status } = run(['check', '--top', '1'], dir);
    const out = strip(stdout);

    expect(status).toBe(1);

    // True aggregate header is always shown: 5 errors.
    expect(out).toMatch(/^yg check: FAIL {2}5 errors · .* {3}view: top 1$/m);

    // --top 1 renders only 1 block, and says how many it hid.
    const blockCount = countBlocks(out);
    expect(blockCount).toBe(1);
    expect(out).toMatch(/^… \+2 more blocks {2}\(yg check\)$/m);

    // The next: line is still present (--top is a narrowed view, not silent).
    expect(out).toMatch(/^next: /m);

    // No section header is left dangling with nothing beneath it.
    expectNoDanglingSectionHeader(stdout);
  });

  it('bare --top: exactly ONE group block — the suggested-next group — true total visible, exit 1', () => {
    const { stdout, status } = run(['check', '--top'], dir);
    const out = strip(stdout);

    expect(status).toBe(1);

    // GUARDRAIL: the narrowed view never hides the true aggregate counts.
    expect(out).toMatch(/^yg check: FAIL {2}5 errors · /m);

    // Bare --top = --top 1: exactly ONE block renders.
    expect(countBlocks(out)).toBe(1);

    // The rendered block is the one the next: line draws from — blocks are
    // ordered by tier, so the mapping-path-missing graph error (a code/graph
    // fix) outranks the unverified pairs (pending a fill).
    expect(out).toMatch(/^error\[mapping-path-missing\] /m);
    expect(out).not.toMatch(/^error\[unverified\]/m);
    expect(out).toMatch(/^next: .* {2}\(mapping-path-missing\)$/m);

    // The then: line still names the fill the hidden block needs.
    expect(out).toMatch(/^then: yg check --approve {2}\(4 reviewer pairs · paid — ask the user first\)$/m);

    // Bare --top and --top 1 are the SAME view (n=1 semantics).
    const explicit = run(['check', '--top', '1'], dir);
    expect(strip(explicit.stdout)).toBe(out);

    // No section header is left dangling with nothing beneath it.
    expectNoDanglingSectionHeader(stdout);
  });

  it('--top 2: both groups rendered (all groups shown when N groups <= top), exit 1', () => {
    const { stdout, status } = run(['check', '--top', '2'], dir);
    const out = strip(stdout);

    expect(status).toBe(1);

    // True total still visible.
    expect(out).toMatch(/^yg check: FAIL {2}5 errors · .* {3}view: top 2$/m);

    // Both error blocks (mapping-path-missing + unverified) render; only the
    // rules-digest-stale warning is left behind the footer.
    const blockCount = countBlocks(out);
    expect(blockCount).toBe(2);
    expect(out).toMatch(/^error\[mapping-path-missing\] /m);
    expect(out).toMatch(/^error\[unverified\] /m);
    expect(out).toMatch(/^… \+1 more block {2}\(yg check\)$/m);

    // No section header is left dangling with nothing beneath it.
    expectNoDanglingSectionHeader(stdout);
  });

  it('--details --approve: mutual-exclusion error to stderr, exit 1', () => {
    const { stderr, status } = run(['check', '--details', '--approve'], dir);
    const err = strip(stderr);

    expect(status).toBe(1);
    // The guided error message names both conflicting flags.
    expect(err).toContain('--details cannot be combined with --approve');
    // The next command is surfaced so the agent knows what to do.
    expect(err).toContain('yg check --details');
    expect(err).toContain('yg check --approve');
  });

  it('--details --summary: mutual-exclusion error to stderr, exit 1', () => {
    const { stderr, status } = run(['check', '--details', '--summary'], dir);
    const err = strip(stderr);

    expect(status).toBe(1);
    expect(err).toContain('--details cannot be combined with');
  });

  // ── Fix 7: read-only triage views cannot combine with the fill flag ──────────
  it('--summary --only-deterministic: rejected (read-only view + fill flag), exit 1', () => {
    const { stderr, status } = run(['check', '--summary', '--only-deterministic'], dir);
    const err = strip(stderr);
    expect(status).toBe(1);
    expect(err).toContain('--summary cannot be combined with --only-deterministic');
    // Guided next surfaces both intents.
    expect(err).toContain('yg check --summary');
    expect(err).toContain('yg check --approve --only-deterministic');
  });

  it('--top --only-deterministic: rejected (read-only view + fill flag), exit 1', () => {
    const { stderr, status } = run(['check', '--top', '--only-deterministic'], dir);
    const err = strip(stderr);
    expect(status).toBe(1);
    expect(err).toContain('--top cannot be combined with --only-deterministic');
  });

  // ── Fix 6(a): unknown aspect id is a clear error, not a silent 0-count FAIL ───
  it('--aspect <unknown-id>: clear "unknown aspect" error naming the id, exit 1', () => {
    const { stdout, stderr, status } = run(['check', '--aspect', 'totally-bogus-aspect'], dir);
    const err = strip(stderr);
    const out = strip(stdout);
    expect(status).toBe(1);
    // Error names the unknown id and says it is unknown.
    expect(err).toContain("error[aspect-not-found]: Unknown aspect 'totally-bogus-aspect'");
    // It must NOT render the misleading drill-in "0 of N errors" FAIL.
    expect(out).not.toContain('0 of');
    expect(out).not.toContain("aspect 'totally-bogus-aspect'");
  });

});

/**
 * Build a hermetic project whose cold-lock `yg check` produces BOTH an error
 * and a warning: one node with an ENFORCED aspect (unverified pair → error)
 * and an ADVISORY aspect (unverified pair → warning). The --top slice orders
 * error blocks before warning blocks, so `--top 1` chooses only the error
 * block — leaving warnings with a true count > 0 but no block shown. The
 * verdict line keeps the true counts and the `… +K more blocks` footer names
 * what the slice hid (formerly the empty-subheader annotation scenario).
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

  // ORDER-DEPENDENT, same contract as the block above: `setup:` populates `dir`
  // for the tests that follow. Plain `it()` (not the vitest-5-removed
  // `it.sequential`) is sufficient only while this suite stays non-concurrent.
  it('setup: build annotation fixture', () => {
    dir = buildAnnotationFixture();
    expect(existsSync(dir)).toBe(true);
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('--top 1 with errors AND warnings: hidden warnings counted and announced, never dangling, exit 1', () => {
    const { stdout, status } = run(['check', '--top', '1'], dir);
    const out = strip(stdout);

    expect(status).toBe(1);

    // GUARDRAIL: true aggregate counts for BOTH severities stay visible even
    // though the slice renders no warning block. The true warning count is 2,
    // not 1: this fixture never ran `yg init`, so it carries no AGENTS.md/
    // CLAUDE.md/.clinerules digest artifacts, and the committed-digest
    // staleness gate (`rules-digest-stale`) always fires here alongside
    // `aspect-soft`'s unverified warning.
    expect(out).toMatch(/^yg check: FAIL {2}1 error · 2 warnings {3}.*view: top 1$/m);
    // Pin WHICH warning contributes the 2nd count. `--top 1` hides every
    // warning block, so `rules-digest-stale` cannot appear in `out` above —
    // cross-check the untruncated listing instead, so a future change that
    // removes this gate and adds some other 2nd warning cannot satisfy the
    // `2 warnings` count silently.
    const untruncated = strip(run(['check'], dir).stdout);
    expect(untruncated).toContain('warning[rules-digest-stale]');
    expect(untruncated).toMatch(/^warning\[unverified\] 1 pair with no verdict yet\n {2}at: {3}aspect-soft @ solo$/m);

    // Exactly ONE block (the error block).
    expect(countBlocks(out)).toBe(1);
    expect(out).toMatch(/^error\[unverified\] 1 pair with no verdict yet\n {2}at: {3}aspect-hard @ solo$/m);
    expect(out).not.toMatch(/^warning\[/m);

    // The two hidden warning blocks are announced by the footer, not dropped.
    expect(out).toMatch(/^… \+2 more blocks {2}\(yg check\)$/m);

    // The one error block's fix IS the step, so it prints no separate next:.
    expect(out).toMatch(/^ {2}fix: {2}yg check --approve {2}\(1 reviewer pair · paid — ask the user first\)$/m);
    expectNoDanglingSectionHeader(stdout);
  });

  it('bare --top behaves as --top 1: one block + the hidden-warnings footer, exit 1', () => {
    const { stdout, status } = run(['check', '--top'], dir);
    const out = strip(stdout);

    expect(status).toBe(1);
    // True warning count is 2 (aspect-soft + rules-digest-stale) — see the
    // comment on the --top 1 case above.
    expect(out).toMatch(/^yg check: FAIL {2}1 error · 2 warnings {3}/m);
    // Pin WHICH warning contributes the 2nd count — see the --top 1 case
    // above for why the cross-check is against the untruncated listing.
    const untruncated = run(['check'], dir);
    expect(strip(untruncated.stdout)).toContain('warning[rules-digest-stale]');
    expect(countBlocks(out)).toBe(1);
    expect(out).toMatch(/^… \+2 more blocks {2}\(yg check\)$/m);
    expectNoDanglingSectionHeader(stdout);

    // Bare --top and --top 1 are the SAME view (n=1 semantics).
    const explicit = run(['check', '--top', '1'], dir);
    expect(strip(explicit.stdout)).toBe(out);
  });
});

// =============================================================================
// F3 regression: bare `--top`'s single block must be exactly the rule the
// `next:` line names — on a repo whose top errors are UNRANKED structural codes.
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
// and coverage (`unmapped`) could jump ahead of structural in `--top`. Both
// surfaces now share ONE ordering (structural < coverage, alphabetical within), so
// the block `--top` renders is exactly the rule `next:` names (its label, in the
// parenthesis after the step).
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

describe.skipIf(!distExists)('CLI E2E — F3: bare --top block === the rule next: names', () => {
  let dir: string;

  // ORDER-DEPENDENT, same contract as the blocks above: `setup:` populates `dir`
  // for the tests that follow. Plain `it()` (not the vitest-5-removed
  // `it.sequential`) is sufficient only while this suite stays non-concurrent.
  it('setup: build structural+coverage fixture', () => {
    dir = buildStructuralCoverageFixture();
    expect(existsSync(dir)).toBe(true);
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('the block bare --top renders is exactly the rule the next: line names (structural + coverage mix)', () => {
    const top = run(['check', '--top'], dir);
    const full = run(['check'], dir);
    // Red repo — both exit 1, TRUE aggregate preserved.
    expect(top.status).toBe(1);
    expect(full.status).toBe(1);

    const topOut = strip(top.stdout);
    const fullOut = strip(full.stdout);
    expect(topOut).toMatch(/^yg check: FAIL {2}3 errors · /m);

    // Sanity: BOTH structural codes AND coverage are present in the full wall.
    // flow-node-broken names a FLOW, not a node — it carries no node path, so
    // its block has no `at:` node line (one would be fabricated).
    // relation-broken does name a node. Neither carries a pair count: they
    // are issues, not a pair's verdict.
    expect(fullOut).toMatch(/^error\[flow-node-broken\] Flow 'broken-flow' references non-existent node 'phantom'\n {2}why: {2}/m);
    expect(fullOut).toMatch(/^error\[relation-broken\] Relation target 'ghost' does not exist\n {2}at: {3}alpha$/m);
    expect(fullOut).toMatch(/^error\[unmapped\] 1 file belongs to no node$/m);
    expect(fullOut).not.toMatch(/^error\[(flow-node-broken|relation-broken)\].*\bpairs?\b/m);

    // The rule bare --top renders: the first block heading's label.
    const topGroupMatch = topOut.match(/^error\[([^\]]+)\] /m);
    expect(topGroupMatch).not.toBeNull();
    const topGroupRule = topGroupMatch![1];

    // The rule the next: line names: `next: <step>  (<label>[ — …])`.
    const nextMatch = fullOut.match(/^next: .* {2}\(([a-z-]+)(?: — [^)]*)?\)$/m);
    expect(nextMatch).not.toBeNull();
    const nextRule = nextMatch![1];

    // THE INVARIANT: the two surfaces name the SAME rule.
    expect(topGroupRule).toBe(nextRule);
    // And concretely: the alphabetically-first structural code wins BOTH — NOT
    // relation-broken (the OLD emission-order pick) and NOT unmapped-files (the
    // OLD alphabetical-across-all coverage pick).
    expect(topGroupRule).toBe('flow-node-broken');
    expect(nextRule).not.toBe('relation-broken');
    expect(topGroupRule).not.toBe('unmapped');

    // Bare --top renders exactly ONE group.
    expect(countBlocks(topOut)).toBe(1);
  });
});
