// =============================================================================
// E2E — the universal agent-rules install (E1-E9, E12) and the committed-digest
// staleness gate (Amendment 1's four states), all driven through the public
// CLI surface (spawn dist/bin.js), never by importing installer internals.
//
// Context: the thirteen per-platform installers and their generated files
// (.cursor/rules/yggdrasil.mdc, .yggdrasil/agent-rules.md, GEMINI.md @import,
// ...) are RETIRED. `yg init` now installs ONE identical set of artifacts for
// every agent — an AGENTS.md digest block, a CLAUDE.md @AGENTS.md import, and
// .clinerules/yggdrasil.md — and sweeps every legacy artifact any of the old
// installers ever wrote. `yg check` carries a new, non-blocking warning gate
// (`rules-digest-stale`) that fires when the committed digest drifts from the
// hash the installed CLI would write.
//
// Every scenario spawns the real binary, asserts on stdout/stderr/exit codes
// and real files on disk, and cleans up its own mkdtemp dir in `finally`. NO
// module under source/cli/src/** is imported anywhere in this file. The
// expected canonical digest block/anchor/hash are obtained by spawning
// `yg prime --digest` — the same public command an adopter would run — never
// by importing the template that generates it (see `canonicalDigest()`
// below). `yg prime --digest` performs no project I/O (E8 proves it prints
// even from a directory with no `.yggdrasil/` at all), so any existing
// directory works as its `cwd`; the result is memoized because every
// scenario in this file targets the same build.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.join(__dirname, '../..', 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

// Literal marker strings — deliberately hardcoded rather than imported. They
// are a stable, documented write-format contract (see src/utils/marker-block.ts)
// used here only to author FIXTURE bytes (as a real hand-edited repo would
// contain), the same way this suite hand-authors YAML without importing the
// graph schema types.
const YGGDRASIL_START = '<!-- yggdrasil:start -->';
const YGGDRASIL_END = '<!-- yggdrasil:end -->';

/** Digest anchor line format — `<!-- yggdrasil:digest cli=<version>
 *  sha256=<hex> -->` — a stable, documented part of the committed-artifact
 *  contract: it is visible verbatim in AGENTS.md, .clinerules/yggdrasil.md,
 *  and `yg prime --digest` output. Hand-duplicated here rather than imported
 *  from templates/digest.js, the same convention as YGGDRASIL_START/END above. */
const ANCHOR_RE = /<!-- yggdrasil:digest cli=(?<cli>[^ ]+) sha256=(?<sha256>[0-9a-f]{64}) -->/;

function run(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; status: number | null; all: string } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return { stdout, stderr, status: r.status, all: stdout + stderr };
}

/**
 * The canonical digest block/anchor/hash, obtained by spawning
 * `yg prime --digest` (the public command) rather than importing the
 * template that generates it. `run()` above requires a `cwd`; since
 * `prime --digest` does no project I/O, `__dirname` (this test file's own,
 * always-existing directory) works fine. Memoized — every scenario in this
 * file targets the same build, so the value is stable file-wide.
 */
let cachedCanonicalDigest: { block: string; anchorLine: string; sha256: string } | undefined;
function canonicalDigest(): { block: string; anchorLine: string; sha256: string } {
  if (!cachedCanonicalDigest) {
    const res = run(['prime', '--digest'], __dirname);
    if (res.status !== 0) {
      throw new Error(`yg prime --digest failed unexpectedly (exit ${res.status}): ${res.all}`);
    }
    const anchorLine = res.stdout.split('\n', 1)[0];
    const m = anchorLine.match(ANCHOR_RE);
    if (!m?.groups?.sha256) {
      throw new Error(`yg prime --digest produced an unrecognized anchor line: ${anchorLine}`);
    }
    cachedCanonicalDigest = { block: res.stdout, anchorLine, sha256: m.groups.sha256 };
  }
  return cachedCanonicalDigest;
}

/**
 * sha256 over the LF-normalized body — mirrors the hashing convention the
 * anchor's `sha256=` field publicly encodes (a CRLF checkout must hash
 * identically to an LF one). Used only to author a self-consistent
 * "internally valid but non-canonical" fixture anchor for the OUTDATED gate
 * state below (E7) — a plain, generic sha256 computation, not an import of
 * the CLI's own digest module. The E7 assertion that `yg check` actually
 * reports "outdated" (never "modified") is what proves this matches the
 * CLI's own algorithm — if it didn't, the gate would call the fixture
 * "modified" and the test would fail.
 */
function sha256Hex(body: string): string {
  return createHash('sha256').update(body.replace(/\r\n/g, '\n'), 'utf-8').digest('hex');
}

/**
 * Minimal v5 config. The reviewer endpoint points at the dead loopback port 1
 * (no listener on any machine) — but the graphs below carry only deterministic
 * aspects, so the reviewer is never invoked. Included so the schema stays
 * valid without introducing any external dependency.
 *
 * UNLIKE the byte-identical constant in cli-greenfield-init.test.ts, this
 * copy adds an explicit `coverage: required: []` block (require-nothing —
 * the same mode a real `yg init` fresh-bootstraps into via DEFAULT_CONFIG).
 * Without it, an absent coverage block defaults to "require the WHOLE repo",
 * and E7 below installs real universal-install artifacts (AGENTS.md,
 * CLAUDE.md, .clinerules/yggdrasil.md, .gitattributes) at the repo root via
 * the real `yg init --upgrade` — files no node maps — which would then be a
 * BLOCKING unmapped-files error under require-whole-repo, unrelated to the
 * digest gate this suite exists to test. cli-greenfield-init.test.ts never
 * combines its copy of this fixture with an `init`/`init --upgrade` call, so
 * it never surfaces this interaction.
 */
const MINIMAL_CONFIG = `version: "5.2.0"
quality:
  max_direct_relations: 10
coverage:
  required: []
  excluded: []
reviewer:
  default: standard
  tiers:
    standard:
      provider: ollama
      consensus: 1
      config:
        model: "qwen2.5-coder:0.5b"
        endpoint: "http://127.0.0.1:1"
`;

/**
 * Hand-author a minimal, fully deterministic greenfield graph in a fresh
 * mkdtemp dir: config, architecture with one mapping node type + an
 * organizational parent, two nodes (parent module + child widget), one
 * deterministic aspect (no-todo-comments check.mjs), and one source file.
 * Copied verbatim (structure and content) from cli-greenfield-init.test.ts's
 * greenfieldGraph() — both files own their fixtures per suite convention, so
 * this suite stays hermetic and self-contained. Returns the project root.
 * Caller owns cleanup.
 */
function greenfieldGraph(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-greenfield-${label}-`));
  const yggRoot = path.join(dir, '.yggdrasil');
  mkdirSync(path.join(yggRoot, 'model', 'widgets', 'widget'), { recursive: true });
  mkdirSync(path.join(yggRoot, 'aspects', 'no-todo-comments'), { recursive: true });
  mkdirSync(path.join(yggRoot, 'flows'), { recursive: true });
  mkdirSync(path.join(dir, 'src', 'widgets'), { recursive: true });

  writeFileSync(path.join(yggRoot, 'yg-config.yaml'), MINIMAL_CONFIG, 'utf-8');

  writeFileSync(
    path.join(yggRoot, 'yg-architecture.yaml'),
    `node_types:
  module:
    description: 'Organizational grouping. Parent-only — no file mapping.'
    log_required: false
  widget:
    description: 'A widget implemented as a single source file under src/widgets/.'
    log_required: false
    when:
      path: "src/widgets/**"
    parents: [module]
    aspects:
      - no-todo-comments
`,
    'utf-8',
  );

  writeFileSync(
    path.join(yggRoot, 'aspects', 'no-todo-comments', 'yg-aspect.yaml'),
    `name: NoTodoComments
description: Source files must not contain TODO comments.
reviewer:
  type: deterministic
status: enforced
`,
    'utf-8',
  );
  writeFileSync(
    path.join(yggRoot, 'aspects', 'no-todo-comments', 'check.mjs'),
    `export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    const lines = file.content.split('\\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('TODO')) {
        violations.push({ file: file.path, line: i + 1, column: 0, message: 'TODO found.' });
      }
    }
  }
  return violations;
}
`,
    'utf-8',
  );

  writeFileSync(
    path.join(yggRoot, 'model', 'widgets', 'yg-node.yaml'),
    `name: Widgets
description: Organizational parent grouping the application's widgets.
type: module
`,
    'utf-8',
  );
  writeFileSync(
    path.join(yggRoot, 'model', 'widgets', 'widget', 'yg-node.yaml'),
    `name: Widget
description: A single widget unit.
type: widget
mapping:
  - src/widgets/widget.ts
`,
    'utf-8',
  );

  writeFileSync(
    path.join(dir, 'src', 'widgets', 'widget.ts'),
    `export function widget() {
  return 'ok';
}
`,
    'utf-8',
  );

  return dir;
}

/** A bare repo for the --upgrade path: just .yggdrasil/yg-config.yaml carrying
 *  the current schema version — the minimum --upgrade needs to detect a
 *  version and refresh rules. No nodes, no architecture. Mirrors
 *  bareUpgradeRepo from cli-greenfield-init.test.ts / cli-migrations-config-
 *  extended.test.ts. */
function bareUpgradeRepo(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-univ-${label}-`));
  const yggRoot = path.join(dir, '.yggdrasil');
  mkdirSync(yggRoot, { recursive: true });
  writeFileSync(path.join(yggRoot, 'yg-config.yaml'), 'version: "5.2.0"\n', 'utf-8');
  return dir;
}

const agentsMdOf = (dir: string) => path.join(dir, 'AGENTS.md');
const claudeMdOf = (dir: string) => path.join(dir, 'CLAUDE.md');
const clinerulesOf = (dir: string) => path.join(dir, '.clinerules', 'yggdrasil.md');
const gitattributesOf = (dir: string) => path.join(dir, '.gitattributes');

/** Count of qualifying `YGGDRASIL_START` marker lines in `content` — good
 *  enough for this suite's fixtures (no fenced-code-block decoys). */
function countBlocks(content: string): number {
  return content.split('\n').filter((l) => l.trim() === YGGDRASIL_START).length;
}

describe.skipIf(!distExists)('universal install (E1-E9, E12) + committed-digest staleness gate', () => {
  // E1 fresh: bare non-TTY init (also covers E12 keyless bootstrap)
  it('E1/E12: bare init in an empty dir bootstraps keyless universal artifacts', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-e1-'));
    try {
      const res = run(['init'], dir);
      expect(res.status).toBe(0);
      const agents = readFileSync(agentsMdOf(dir), 'utf-8');
      expect(agents).toMatch(ANCHOR_RE);
      expect(agents.match(ANCHOR_RE)?.groups?.sha256).toBe(canonicalDigest().sha256);
      expect(readFileSync(claudeMdOf(dir), 'utf-8')).toContain('@AGENTS.md');
      expect(existsSync(clinerulesOf(dir))).toBe(true);
      const clineContent = readFileSync(clinerulesOf(dir), 'utf-8');
      expect(clineContent.match(ANCHOR_RE)?.groups?.sha256).toBe(canonicalDigest().sha256);
      // Keyless: the run SAYS it configured no reviewer, and the written
      // config carries no reviewer section to back that up.
      expect(res.all).toContain('no reviewer configured');
      expect(res.all).not.toContain('provider:');
      const cfg = readFileSync(path.join(dir, '.yggdrasil', 'yg-config.yaml'), 'utf-8');
      expect(cfg).not.toContain('reviewer:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Amendment 3: `yg init` is also reachable with --provider, and that path no
  // longer requires --platform. Covers the OTHER fresh-bootstrap leg E1/E12
  // above does not: a reviewer IS configured, and no --platform flag is given
  // anywhere in the invocation.
  it('E12b: non-interactive init with --provider (no --platform) bootstraps the universal artifacts with a reviewer configured', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-e12b-'));
    try {
      const res = run(['init', '--provider', 'claude-code', '--model', 'haiku'], dir);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('Yggdrasil initialized');
      const cfg = readFileSync(path.join(dir, '.yggdrasil', 'yg-config.yaml'), 'utf-8');
      expect(cfg).toContain('provider: claude-code');
      expect(cfg).toContain('model: haiku');
      // The universal artifacts install exactly as in the keyless path — no
      // --platform was passed anywhere in this invocation.
      const agents = readFileSync(agentsMdOf(dir), 'utf-8');
      expect(agents.match(ANCHOR_RE)?.groups?.sha256).toBe(canonicalDigest().sha256);
      expect(readFileSync(claudeMdOf(dir), 'utf-8')).toContain('@AGENTS.md');
      expect(existsSync(clinerulesOf(dir))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // E2: CRLF preservation — a prior-installation fixture whose AGENTS.md is a
  // CRLF-line-ending file (a Windows checkout). `yg init --upgrade` must
  // preserve the file's own EOL style: the rewritten digest block comes back
  // CRLF-terminated throughout, not silently normalized to LF.
  it('E2: init --upgrade preserves a CRLF-line-ending AGENTS.md (prior installation)', () => {
    const dir = bareUpgradeRepo('crlf');
    try {
      const priorCrlf = '# Project Notes\r\n\r\nSome pre-existing content.\r\n';
      writeFileSync(agentsMdOf(dir), priorCrlf, 'utf-8');

      const res = run(['init', '--upgrade'], dir);
      expect(res.status).toBe(0);

      const after = readFileSync(agentsMdOf(dir), 'utf-8');
      // The pre-existing prose survives, still CRLF-terminated.
      expect(after).toContain('# Project Notes\r\n');
      expect(after).toContain('Some pre-existing content.\r\n');
      // The freshly-appended digest block is ALSO CRLF-terminated throughout
      // (no bare `\n` line anywhere in the file).
      expect(after.includes('\r\n')).toBe(true);
      const bareLfLines = after.split('\r\n').join('').includes('\n');
      expect(bareLfLines).toBe(false);
      // And it is still a valid, canonical digest block once CRLF-normalized.
      const lfNormalized = after.replace(/\r\n/g, '\n');
      expect(lfNormalized.match(ANCHOR_RE)?.groups?.sha256).toBe(canonicalDigest().sha256);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // E3: a prior AGENTS.md with the block MOVED away from the top of the file
  // (surrounded by the user's own prose) and DUPLICATED (two yggdrasil blocks,
  // e.g. left over from a merge or a manual copy-paste). `yg init --upgrade`
  // replaces the FIRST block in place with the current canonical one, drops
  // every duplicate, and leaves the user's surrounding prose untouched.
  it('E3: init --upgrade collapses a moved + duplicated AGENTS.md block to one canonical block, preserving surrounding prose', () => {
    const dir = bareUpgradeRepo('moved-duplicated');
    try {
      const staleBlock = (marker: string) =>
        `${YGGDRASIL_START}\n<!-- yggdrasil:digest cli=0.0.1 sha256=${'0'.repeat(64)} -->\n## Yggdrasil\n\nStale block ${marker}.\n${YGGDRASIL_END}`;
      const prior = [
        '# My Project',
        '',
        'Some intro.',
        '',
        staleBlock('first'),
        '',
        'More custom prose after.',
        '',
        staleBlock('second'),
        '',
        'Final notes.',
        '',
      ].join('\n');
      writeFileSync(agentsMdOf(dir), prior, 'utf-8');

      const res = run(['init', '--upgrade'], dir);
      expect(res.status).toBe(0);

      const after = readFileSync(agentsMdOf(dir), 'utf-8');
      expect(countBlocks(after)).toBe(1);
      expect(after.match(ANCHOR_RE)?.groups?.sha256).toBe(canonicalDigest().sha256);
      // Every piece of surrounding user prose survives, in place.
      expect(after).toContain('# My Project');
      expect(after).toContain('Some intro.');
      expect(after).toContain('More custom prose after.');
      expect(after).toContain('Final notes.');
      // Neither stale block's own text survives.
      expect(after).not.toContain('Stale block first.');
      expect(after).not.toContain('Stale block second.');
      // POSITIONAL: the block was replaced IN PLACE (at the first stale
      // block's original position), not deleted-and-appended at the end. The
      // assertions above alone would ALSO pass for a broken installer that
      // dropped both stale blocks and appended a fresh one after "Final
      // notes." — that alternative would put the canonical block's start
      // marker AFTER "More custom prose after.", which these two checks rule
      // out directly.
      const introIdx = after.indexOf('Some intro.');
      const markerIdx = after.indexOf(YGGDRASIL_START);
      const trailingIdx = after.indexOf('More custom prose after.');
      expect(introIdx).toBeGreaterThan(-1);
      expect(markerIdx).toBeGreaterThan(-1);
      expect(trailingIdx).toBeGreaterThan(-1);
      expect(introIdx).toBeLessThan(markerIdx); // intro prose precedes the block
      expect(markerIdx).toBeLessThan(trailingIdx); // block precedes the trailing prose
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // E4: CLAUDE.md carrying the LEGACY `@.yggdrasil/agent-rules.md` import line
  // (the pre-universal-install convention) alongside the user's own content.
  // `yg init --upgrade` strips the legacy line and appends the new
  // `@AGENTS.md` import, leaving the user's own content untouched.
  it('E4: init --upgrade swaps a legacy @.yggdrasil/agent-rules.md import line in CLAUDE.md for @AGENTS.md', () => {
    const dir = bareUpgradeRepo('claude-line-swap');
    try {
      writeFileSync(
        claudeMdOf(dir),
        '# Project instructions\n\n@.yggdrasil/agent-rules.md\n\nOther custom instructions.\n',
        'utf-8',
      );

      const res = run(['init', '--upgrade'], dir);
      expect(res.status).toBe(0);

      const after = readFileSync(claudeMdOf(dir), 'utf-8');
      expect(after).not.toContain('@.yggdrasil/agent-rules.md');
      expect(after).toContain('@AGENTS.md');
      expect(after).toContain('# Project instructions');
      expect(after).toContain('Other custom instructions.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // E4b: the SAME legacy import line, but in AGENTS.md rather than CLAUDE.md —
  // the shape the retired `amp` platform installer used to write (AGENTS.md
  // with an @import line pointing at the shared .yggdrasil/agent-rules.md,
  // co-written alongside it). The sweep strips the legacy line from AGENTS.md
  // too (installRules runs stripLegacyImportLines on both files) and the
  // shared legacy rules file itself is removed.
  it('E4b: init --upgrade strips a legacy amp-style @.yggdrasil/agent-rules.md import line from AGENTS.md and removes the shared file', () => {
    const dir = bareUpgradeRepo('amp-import-line');
    try {
      writeFileSync(
        agentsMdOf(dir),
        '# Notes\n\n@.yggdrasil/agent-rules.md\n\nMore text.\n',
        'utf-8',
      );
      mkdirSync(path.join(dir, '.yggdrasil'), { recursive: true });
      writeFileSync(path.join(dir, '.yggdrasil', 'agent-rules.md'), '# legacy shared rules\n', 'utf-8');

      const res = run(['init', '--upgrade'], dir);
      expect(res.status).toBe(0);

      const after = readFileSync(agentsMdOf(dir), 'utf-8');
      expect(after).not.toContain('@.yggdrasil/agent-rules.md');
      expect(after).toContain('# Notes');
      expect(after).toContain('More text.');
      expect(after.match(ANCHOR_RE)?.groups?.sha256).toBe(canonicalDigest().sha256);
      expect(existsSync(path.join(dir, '.yggdrasil', 'agent-rules.md'))).toBe(false);
      expect(res.stdout).toContain('.yggdrasil/agent-rules.md');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // E5: every legacy per-platform artifact present AT ONCE — the "kitchen
  // sink" a repo that adopted several agents under the old system might carry.
  // `yg init --upgrade` sweeps the FULL path list in one pass: some files are
  // wholly ours and get deleted outright; others (GEMINI.md / copilot-
  // instructions.md / .aider.conf.yml) carry user content around a generated
  // piece and get that piece surgically removed instead.
  it('E5: init --upgrade sweeps every legacy per-platform artifact in one pass', () => {
    const dir = bareUpgradeRepo('kitchen-sink');
    try {
      const write = (rel: string, content: string) => {
        const abs = path.join(dir, ...rel.split('/'));
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, content, 'utf-8');
      };

      // Wholly-generated legacy artifacts — always unconditionally overwritten
      // by the old installers, so safe to delete outright.
      write('.yggdrasil/agent-rules.md', '# legacy shared rules\n');
      write('.cursor/rules/yggdrasil.mdc', '# cursor mirror\n');
      write('.windsurf/rules/yggdrasil.md', '# windsurf mirror\n');
      write('.roo/rules/yggdrasil.md', '# roo mirror\n');
      write('.codebuddy/rules/yggdrasil/RULE.mdc', '---\nalwaysApply: true\n---\n# codebuddy mirror\n');

      // GEMINI.md: "only ours" — purely the legacy import line, so the whole
      // file is deleted once the line is stripped and nothing remains.
      write('GEMINI.md', '@.yggdrasil/agent-rules.md\n');

      // copilot-instructions.md: a marker block alongside the user's own text
      // — the block is cut, the file (and the user's text) survives.
      write(
        '.github/copilot-instructions.md',
        `# Copilot notes\n\n${YGGDRASIL_START}\n## Yggdrasil\n\nInlined legacy rules.\n${YGGDRASIL_END}\n\nUser's own copilot notes.\n`,
      );

      // .aider.conf.yml: a genuine read-entry list item under `read:`.
      write(
        '.aider.conf.yml',
        'some-setting: true\nread:\n  - .yggdrasil/agent-rules.md # added by yg init\n',
      );

      const res = run(['init', '--upgrade'], dir);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('Legacy per-platform artifacts cleaned up');

      // Full §5 legacy path list: gone.
      expect(existsSync(path.join(dir, '.yggdrasil', 'agent-rules.md'))).toBe(false);
      expect(existsSync(path.join(dir, '.cursor', 'rules', 'yggdrasil.mdc'))).toBe(false);
      expect(existsSync(path.join(dir, '.windsurf', 'rules', 'yggdrasil.md'))).toBe(false);
      expect(existsSync(path.join(dir, '.roo', 'rules', 'yggdrasil.md'))).toBe(false);
      expect(existsSync(path.join(dir, '.codebuddy', 'rules', 'yggdrasil', 'RULE.mdc'))).toBe(false);
      expect(existsSync(path.join(dir, 'GEMINI.md'))).toBe(false);

      const copilot = readFileSync(path.join(dir, '.github', 'copilot-instructions.md'), 'utf-8');
      expect(copilot).not.toContain(YGGDRASIL_START);
      expect(copilot).not.toContain('Inlined legacy rules.');
      expect(copilot).toContain('# Copilot notes');
      expect(copilot).toContain("User's own copilot notes.");

      const aiderConf = readFileSync(path.join(dir, '.aider.conf.yml'), 'utf-8');
      expect(aiderConf).not.toContain('.yggdrasil/agent-rules.md');
      expect(aiderConf).not.toContain('added by yg init');
      expect(aiderConf).toContain('some-setting: true');

      // And the three universal artifacts are freshly installed.
      expect(existsSync(agentsMdOf(dir))).toBe(true);
      expect(existsSync(claudeMdOf(dir))).toBe(true);
      expect(existsSync(clinerulesOf(dir))).toBe(true);
      expect(readFileSync(agentsMdOf(dir), 'utf-8').match(ANCHOR_RE)?.groups?.sha256).toBe(canonicalDigest().sha256);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // E6: idempotence — running `init --upgrade` a second time over an
  // already-current install changes NOTHING: identical bytes, and the summary
  // reports "already up to date" rather than re-writing anything. Covers all
  // FOUR files `init --upgrade` writes — the three universal-install
  // artifacts plus the repo-root `.gitattributes` it also maintains (the lock
  // "generated" marker line) — so a regression that made the .gitattributes
  // write non-idempotent would not slip past this on the other three files
  // alone.
  it('E6: running init --upgrade twice is a byte-for-byte no-op the second time', () => {
    const dir = bareUpgradeRepo('idempotent');
    try {
      const first = run(['init', '--upgrade'], dir);
      expect(first.status).toBe(0);

      const beforeAgents = readFileSync(agentsMdOf(dir), 'utf-8');
      const beforeClaude = readFileSync(claudeMdOf(dir), 'utf-8');
      const beforeCline = readFileSync(clinerulesOf(dir), 'utf-8');
      const beforeGitattributes = readFileSync(gitattributesOf(dir), 'utf-8');

      const second = run(['init', '--upgrade'], dir);
      expect(second.status).toBe(0);
      expect(second.stdout).toContain('Agent rules already up to date — nothing changed.');

      expect(readFileSync(agentsMdOf(dir), 'utf-8')).toBe(beforeAgents);
      expect(readFileSync(claudeMdOf(dir), 'utf-8')).toBe(beforeClaude);
      expect(readFileSync(clinerulesOf(dir), 'utf-8')).toBe(beforeCline);
      expect(readFileSync(gitattributesOf(dir), 'utf-8')).toBe(beforeGitattributes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // E7: staleness gate through the public CLI — Amendment 1. All FOUR states
  // (missing, modified, outdated, duplicated), the exact warning text for
  // each, that the gate NEVER blocks (exit 0 throughout, on an otherwise-clean
  // repo), and that `yg init --upgrade` clears it every time.
  it('E7: the committed-digest staleness gate warns on missing/modified/outdated/duplicated, never blocks, and init --upgrade always clears it', () => {
    const dir = greenfieldGraph('gate');
    try {
      // Install clean, then fill the deterministic pair so the ONLY thing left
      // to observe in every state below is the digest gate itself.
      expect(run(['init', '--upgrade'], dir).status).toBe(0);
      expect(run(['check', '--approve'], dir).status).toBe(0);

      // Baseline: aligned, no warning at all.
      const aligned = run(['check'], dir);
      expect(aligned.status).toBe(0);
      expect(aligned.all).not.toContain('rules-digest-stale');

      // --- MISSING: delete .clinerules/yggdrasil.md ---
      rmSync(clinerulesOf(dir), { force: true });
      const missing = run(['check'], dir);
      expect(missing.status).toBe(0); // never blocks
      expect(missing.all).toContain('rules-digest-stale');
      expect(missing.all).toContain('.clinerules/yggdrasil.md is missing');
      expect(missing.all).toContain('yg init --upgrade');
      // Restore.
      expect(run(['init', '--upgrade'], dir).status).toBe(0);
      expect(run(['check'], dir).all).not.toContain('rules-digest-stale');

      // --- MODIFIED: hand-edit the AGENTS.md body, keeping the anchor line ---
      const clean = readFileSync(agentsMdOf(dir), 'utf-8');
      const modified = clean.replace('Non-negotiable invariants', 'HAND-EDITED invariants');
      expect(modified).not.toBe(clean); // guard: the replace actually matched
      writeFileSync(agentsMdOf(dir), modified, 'utf-8');
      const modifiedResult = run(['check'], dir);
      expect(modifiedResult.status).toBe(0); // never blocks
      expect(modifiedResult.all).toContain('rules-digest-stale');
      // Symmetric with the MISSING case above: name the affected artifact,
      // not just the finding kind — otherwise this would also pass on a
      // report wrongly attributed to .clinerules/yggdrasil.md or the
      // CLAUDE.md import.
      expect(modifiedResult.all).toContain('AGENTS.md digest block was modified by hand');
      expect(modifiedResult.all).toContain('yg init --upgrade');
      // Restore.
      expect(run(['init', '--upgrade'], dir).status).toBe(0);
      expect(run(['check'], dir).all).not.toContain('rules-digest-stale');

      // --- OUTDATED: an internally-consistent block from an "older CLI" —
      // its own body hashes to its own anchor, but that hash disagrees with
      // the installed CLI's canonical digest. ---
      const oldBody = '## Yggdrasil\n\nAn older operating manual body, pre-dating this CLI version.\n';
      const oldHash = sha256Hex(oldBody);
      expect(oldHash).not.toBe(canonicalDigest().sha256); // guard: genuinely a different hash
      const outdatedBlock = `${YGGDRASIL_START}\n<!-- yggdrasil:digest cli=0.0.1 sha256=${oldHash} -->\n${oldBody}${YGGDRASIL_END}\n`;
      writeFileSync(agentsMdOf(dir), outdatedBlock, 'utf-8');
      const outdatedResult = run(['check'], dir);
      expect(outdatedResult.status).toBe(0); // never blocks
      expect(outdatedResult.all).toContain('rules-digest-stale');
      // Same symmetry fix as MODIFIED above: name the artifact.
      expect(outdatedResult.all).toContain('AGENTS.md digest block is from an older CLI');
      expect(outdatedResult.all).toContain('yg init --upgrade');
      // Restore.
      expect(run(['init', '--upgrade'], dir).status).toBe(0);
      expect(run(['check'], dir).all).not.toContain('rules-digest-stale');

      // --- DUPLICATED: the canonical block appears twice in AGENTS.md ---
      const cleanAgain = readFileSync(agentsMdOf(dir), 'utf-8');
      writeFileSync(agentsMdOf(dir), `${cleanAgain.trimEnd()}\n\n${cleanAgain}`, 'utf-8');
      expect(countBlocks(readFileSync(agentsMdOf(dir), 'utf-8'))).toBe(2);
      const duplicatedResult = run(['check'], dir);
      expect(duplicatedResult.status).toBe(0); // never blocks
      expect(duplicatedResult.all).toContain('rules-digest-stale');
      expect(duplicatedResult.all).toContain('more than one yggdrasil block');
      expect(duplicatedResult.all).toContain('yg init --upgrade');
      // Restore — final assertion that the gate is clear again.
      expect(run(['init', '--upgrade'], dir).status).toBe(0);
      const restored = run(['check'], dir);
      expect(restored.status).toBe(0);
      expect(restored.all).not.toContain('rules-digest-stale');
      expect(countBlocks(readFileSync(agentsMdOf(dir), 'utf-8'))).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // E8: prime
  it('E8: prime prints the full manual anywhere; --digest matches installed anchor', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-e8-'));
    try {
      const manual = run(['prime'], dir); // NO graph here — must still print
      expect(manual.status).toBe(0);
      expect(manual.stdout).toContain('## SYSTEM');
      expect(manual.stdout).toContain('Start with: yg check');

      run(['init'], dir);
      const digest = run(['prime', '--digest'], dir);
      expect(digest.status).toBe(0);
      const agents = readFileSync(agentsMdOf(dir), 'utf-8');
      // Same anchor line — the digest's own first line matches AGENTS.md's.
      expect(agents).toContain(digest.stdout.trimEnd().split('\n')[0]);
      expect(digest.stdout.match(ANCHOR_RE)?.groups?.sha256).toBe(canonicalDigest().sha256);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // E9: aider / GEMINI.md sweep edges — proving the sweep's false-positive
  // avoidance. A marker-COMMENT substring that is not the exact list-item form
  // (aider) and an import PATH mentioned in prose rather than as its own line
  // (GEMINI.md) must be left byte-for-byte untouched; a genuine GEMINI.md
  // import line WITH other content strips only the line, keeping the file.
  it('E9: init --upgrade never touches an aider/GEMINI.md decoy, but strips a genuine GEMINI.md import line and keeps the rest of the file', () => {
    const dir = bareUpgradeRepo('aider-gemini-edges');
    try {
      // Decoy: mentions the marker comment as prose, not as the real list item
      // the old installer wrote — must be left untouched.
      const aiderDecoy = 'notes: "history mentions .yggdrasil/agent-rules.md # added by yg init once"\n';
      writeFileSync(path.join(dir, '.aider.conf.yml'), aiderDecoy, 'utf-8');

      // Decoy: mentions the legacy import path mid-sentence, never as its own
      // line — must be left untouched (not counted as removed, not rewritten).
      const geminiDecoy = 'Some tools used `@.yggdrasil/agent-rules.md` as an import historically.\n';
      writeFileSync(path.join(dir, 'GEMINI.md'), geminiDecoy, 'utf-8');

      const res = run(['init', '--upgrade'], dir);
      expect(res.status).toBe(0);

      expect(readFileSync(path.join(dir, '.aider.conf.yml'), 'utf-8')).toBe(aiderDecoy);
      expect(readFileSync(path.join(dir, 'GEMINI.md'), 'utf-8')).toBe(geminiDecoy);
      expect(res.stdout).not.toContain('.aider.conf.yml');
      expect(res.stdout).not.toContain('GEMINI.md');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E9b: a genuine GEMINI.md import line alongside other content strips only the line, keeping the file and the rest of its content', () => {
    const dir = bareUpgradeRepo('gemini-strip-only');
    try {
      writeFileSync(
        path.join(dir, 'GEMINI.md'),
        '# Gemini notes\n\n@.yggdrasil/agent-rules.md\n\nExtra content stays.\n',
        'utf-8',
      );

      const res = run(['init', '--upgrade'], dir);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('GEMINI.md (import line)');

      const after = readFileSync(path.join(dir, 'GEMINI.md'), 'utf-8');
      expect(after).not.toContain('@.yggdrasil/agent-rules.md');
      expect(after).toContain('# Gemini notes');
      expect(after).toContain('Extra content stays.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A repository that documents its own agent setup shows the import line
  // inside a fenced example. Counting that example as an installed import made
  // the installer skip the file while reporting success AND made the gate
  // report the import present — the two agreed, and the repo silently gave
  // Claude Code no rules with nothing anywhere to surface it.
  it('a CLAUDE.md whose only @AGENTS.md is a fenced example gets a real import, and the gate says so beforehand', () => {
    const dir = greenfieldGraph('fenced-import');
    try {
      const fenced = '# Setup docs\n\nAdd this line:\n\n```md\n@AGENTS.md\n```\n';
      writeFileSync(claudeMdOf(dir), fenced, 'utf-8');
      // Install everything else first so the ONLY finding is the import line.
      run(['init', '--upgrade'], dir);
      writeFileSync(claudeMdOf(dir), fenced, 'utf-8');

      const before = run(['check'], dir);
      expect(before.stdout).toContain('rules-digest-stale');
      expect(before.stdout).toContain('CLAUDE.md @AGENTS.md import is missing');

      const res = run(['init', '--upgrade'], dir);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('CLAUDE.md');

      const after = readFileSync(claudeMdOf(dir), 'utf-8');
      expect(after).toContain('```md\n@AGENTS.md\n```');
      expect(after.trimEnd().endsWith('@AGENTS.md')).toBe(true);
      expect(run(['check'], dir).stdout).not.toContain('rules-digest-stale');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The upgrade adds four files to an existing project's root. On a project
  // that requires its whole tree they are new BLOCKING errors on the very next
  // check, and the check's own fix line points at node ownership rather than
  // at excluding repository plumbing. The upgrade says so where the files are
  // created, and prints the stanza — without touching the config itself.
  it('init --upgrade warns, with the exact exclude stanza, when the project requires its whole tree', () => {
    const dir = greenfieldGraph('coverage-warn');
    const configPath = path.join(dir, '.yggdrasil', 'yg-config.yaml');
    try {
      // Drop the coverage block entirely — the state of every project that
      // predates the require-nothing default, and the one this bites.
      const wholeTree = MINIMAL_CONFIG.replace(/coverage:\n {2}required: \[\]\n {2}excluded: \[\]\n/, '');
      writeFileSync(configPath, wholeTree, 'utf-8');

      const res = run(['init', '--upgrade'], dir);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('AGENTS.md, CLAUDE.md, .clinerules/yggdrasil.md, .gitattributes');
      expect(res.stdout).toContain('coverage:');
      expect(res.stdout).toContain('  excluded:');
      expect(res.stdout).toContain('    - AGENTS.md');
      expect(res.stdout).toContain('    - .gitattributes');
      // Reports only — the user's configuration is never edited for them.
      expect(readFileSync(configPath, 'utf-8')).toBe(wholeTree);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('init --upgrade stays silent about coverage once the files are excluded', () => {
    const dir = greenfieldGraph('coverage-quiet');
    try {
      const wholeTree = MINIMAL_CONFIG.replace(
        /coverage:\n {2}required: \[\]\n {2}excluded: \[\]\n/,
        'coverage:\n  excluded:\n    - AGENTS.md\n    - CLAUDE.md\n    - .clinerules/\n    - .gitattributes\n',
      );
      writeFileSync(path.join(dir, '.yggdrasil', 'yg-config.yaml'), wholeTree, 'utf-8');
      const res = run(['init', '--upgrade'], dir);
      expect(res.status).toBe(0);
      expect(res.stdout).not.toContain('  excluded:');
      expect(res.stdout).not.toContain('belong to none');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Starting without a reviewer must be reachable by asking for it, not only
  // by having no terminal to be asked in.
  it('init --no-reviewer bootstraps the universal artifacts with no reviewer section', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-keyless-'));
    try {
      const res = run(['init', '--no-reviewer'], dir);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('no reviewer configured');
      const cfg = readFileSync(path.join(dir, '.yggdrasil', 'yg-config.yaml'), 'utf-8');
      expect(cfg).not.toContain('reviewer:');
      expect(readFileSync(agentsMdOf(dir), 'utf-8').match(ANCHOR_RE)?.groups?.sha256)
        .toBe(canonicalDigest().sha256);
      expect(readFileSync(claudeMdOf(dir), 'utf-8')).toContain('@AGENTS.md');
      expect(existsSync(clinerulesOf(dir))).toBe(true);
      expect(existsSync(gitattributesOf(dir))).toBe(true);
      // The project it leaves behind is one yg check accepts.
      const check = run(['check'], dir);
      expect(check.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('init --no-reviewer is refused, with guidance, where it could only mislead', () => {
    const fresh = mkdtempSync(path.join(tmpdir(), 'yg-keyless-conflict-'));
    const existing = bareUpgradeRepo('keyless-existing');
    try {
      const withProvider = run(['init', '--no-reviewer', '--provider', 'claude-code'], fresh);
      expect(withProvider.status).toBe(1);
      expect(withProvider.stderr).toContain('opposite things');
      expect(existsSync(path.join(fresh, '.yggdrasil'))).toBe(false);

      const withUpgrade = run(['init', '--no-reviewer', '--upgrade'], existing);
      expect(withUpgrade.status).toBe(1);
      expect(withUpgrade.stderr).toContain('never touches the reviewer configuration');

      const onExisting = run(['init', '--no-reviewer'], existing);
      expect(onExisting.status).toBe(1);
      expect(onExisting.stderr).toContain('already has a .yggdrasil/ graph');
    } finally {
      rmSync(fresh, { recursive: true, force: true });
      rmSync(existing, { recursive: true, force: true });
    }
  });
});
