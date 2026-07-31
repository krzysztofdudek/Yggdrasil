import { Command } from 'commander';
import chalk from 'chalk';
import { spawnSync } from 'node:child_process';
import { statSync, existsSync, mkdtempSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findYggRoot, getPackageRoot, resolveFileArg, projectRootFromGraph } from '../io/paths.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { debugWrite } from '../utils/debug-log.js';
import { loadGraphOrAbort } from './preamble.js';

/**
 * yg simulate — replay a candidate DETERMINISTIC rule over the history it can
 * HONESTLY reach.
 *
 * The question it answers: "if I had shipped this rule, what would it have caught
 * across the commits I can compare against?" It replays the candidate's check.mjs
 * over each recent commit, in an ISOLATED clone, one FRESH subprocess per commit,
 * strictly read-only — the real repository tree is never touched.
 *
 * Five properties make the replay trustworthy rather than a false comfort:
 *
 *  1. CLONE-IN-TEMP, NEVER IN-PLACE. Every checkout and the candidate overlay
 *     happen in a throwaway clone under the OS temp dir. The real working tree is
 *     left byte-for-byte unchanged (proven by an e2e byte-compare).
 *
 *  2. CLONE-BOUNDARY GUARD (the security crux). findYggRoot walks UP the directory
 *     tree; a checked-out commit that PRE-DATES `yg init` has no `.yggdrasil/` in
 *     the clone, so a naive resolve would walk OUT of the clone and silently find
 *     the REAL repo's graph — simulating against the wrong graph. resolveYggRoot-
 *     WithinClone refuses to escape: it only accepts the clone's OWN `.yggdrasil/`
 *     and never walks up past it, so a pre-init commit is `non-comparable`, never
 *     silently the real graph.
 *
 *  3. OVERLAY = THE CANDIDATE RULE ONLY. Only the candidate aspect directory is
 *     written into the clone's `.yggdrasil/aspects/`. Nothing else in the graph is
 *     touched, and the overlay can never target the real repo.
 *
 *  4. DET-ONLY. An LLM or companion candidate is refused up front: an LLM verdict
 *     is a point-in-time testimony, not a reproducible replay. Only a deterministic
 *     check.mjs is replayable.
 *
 *  5. HONEST HORIZON. Replay reaches only commits whose committed graph schema
 *     EQUALS the schema this graph is at now — the world the candidate would ship
 *     into. A commit that would need a migration is `non-comparable`, never
 *     silently upgraded in the throwaway tree.
 *
 * It is a REPORT tool: it exits 0 whatever it finds. Only a precondition failure on
 * the real repo (no graph, missing candidate, wrong candidate kind, cannot clone)
 * exits non-zero — a finding never does.
 */

/**
 * The Wald caveat, printed VERBATIM under every replay. Survivorship bias: the old
 * commit gate already refused some code that never became a commit, so history is a
 * filtered sample. A rule that only ever REFUSES (a tightening rule) can therefore
 * undercount — the code it would have caught may never have landed — so its replay
 * count is a LOWER bound; a rule that mostly APPROVES (a loosening rule) reads as an
 * UPPER bound. Naming the bias keeps a replay count from being read as ground truth.
 */
export const WALD_LABEL =
  'history is censored by the old regime — a tightening replay is a LOWER bound on true catches, a loosening replay an UPPER bound.';

/** The classified result of replaying the candidate at one commit. */
export type CommitOutcome =
  | { sha: string; subject: string; kind: 'ran-clean' }
  | { sha: string; subject: string; kind: 'violations'; count: number }
  | { sha: string; subject: string; kind: 'non-comparable'; reason: string };

/**
 * What the candidate replays over: a real component (--node, the original,
 * unchanged form) or a file enforced by its architecture type alone (--file,
 * E2). `--file` replays over the file's HISTORICAL content but the CURRENT
 * architecture and coverage settings — see overlayCurrentArchitectureAndCoverage
 * — so the report must say so; --node's replay stays entirely historical.
 */
export type SimulateTarget =
  | { kind: 'node'; nodePath: string }
  | { kind: 'file'; file: string };

/** One commit of the replay window (newest-first from git, displayed oldest-first). */
interface Commit {
  sha: string;
  subject: string;
}

// ---------------------------------------------------------------------------
// Path safety (SECURITY-CRITICAL). The candidate id and node path are untrusted
// inputs that reach filesystem operations (the overlay's rmSync/cpSync run inside
// the clone at `.yggdrasil/aspects/<candidateId>`). A `..` or absolute component
// would let those operations escape the clone onto the REAL tree — an
// `rmSync(recursive, force)` on real files. Two defences: reject a traversing
// value up front (isPlainRelativeName), and hard-assert containment before any
// fs op (pathIsWithin).
// ---------------------------------------------------------------------------

/**
 * True iff `value` is a plain relative name: not empty, not absolute, no `..`
 * segment, no Windows drive-letter (`C:`) or UNC / leading-separator prefix. Used
 * to reject a traversing candidate id or node path BEFORE any clone or fs op.
 */
export function isPlainRelativeName(value: string): boolean {
  if (value.trim() === '') return false;
  if (path.isAbsolute(value)) return false;
  if (/^[a-zA-Z]:/.test(value)) return false; // C:\... drive-letter form
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  return !value.split(/[/\\]/).some((seg) => seg === '..');
}

/** True iff `target` resolves to `baseDir` itself or a path strictly inside it. */
export function pathIsWithin(baseDir: string, target: string): boolean {
  const rel = path.relative(path.resolve(baseDir), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Realpath a path whose LEAF may not exist yet: realpath the longest existing
 * ANCESTOR, then re-append the not-yet-created remainder. The overlay destination
 * (`.../aspects/<candidateId>`, whose leaf does not exist before the copy) can thus
 * still be resolved through any symlink in its existing prefix. Returns null only if
 * no ancestor at all can be resolved — degrade to refuse, never let a realpath throw
 * crash this read-only tool.
 */
function realpathOfExistingPrefix(target: string): string | null {
  let existing = path.resolve(target);
  const remainder: string[] = []; // collected leaf-first while walking up
  for (;;) {
    try {
      const real = realpathSync(existing);
      return remainder.length === 0 ? real : path.join(real, ...remainder.slice().reverse());
    } catch (err) {
      const parent = path.dirname(existing);
      if (parent === existing) {
        debugWrite(`[simulate] realpath found no existing ancestor of '${target}': ${(err as Error).message}`);
        return null;
      }
      remainder.push(path.basename(existing));
      existing = parent;
    }
  }
}

/**
 * Realpath-based containment: true iff `target`, resolved through the filesystem
 * (FOLLOWING SYMLINKS), lands on `baseDir` itself or a path inside it — the
 * symlink-aware counterpart to the lexical pathIsWithin. It catches a checked-out
 * commit that committed `.yggdrasil` (or the overlay's `aspects/` dir, or the leaf)
 * as a SYMLINK whose real target escapes the clone: a purely lexical `path.relative`
 * check waves that through, while the destructive rmSync/cpSync would act on the real
 * target OUTSIDE the clone. Resolving both sides through realpathSync first refuses
 * it. A realpath failure degrades to false (refuse) — never a throw.
 */
export function realpathIsWithin(baseDir: string, target: string): boolean {
  let realBase: string;
  try {
    realBase = realpathSync(path.resolve(baseDir));
  } catch (err) {
    debugWrite(`[simulate] realpath(base) failed for '${baseDir}': ${(err as Error).message}`);
    return false;
  }
  const realTarget = realpathOfExistingPrefix(target);
  if (realTarget === null) return false;
  return pathIsWithin(realBase, realTarget);
}

// ---------------------------------------------------------------------------
// Candidate-kind detection (filenames only — kind is inferred from the rule
// source, exactly as the graph loader infers it, so simulate never needs to
// parse or load the graph).
// ---------------------------------------------------------------------------

/**
 * Infer the candidate aspect's reviewer kind from its rule source, the same way
 * the graph does: content.md ⇒ LLM, companion.mjs (without content.md) ⇒ companion,
 * check.mjs ⇒ deterministic, none of these ⇒ not a runnable rule (e.g. an
 * aggregate). Only `deterministic` is replayable.
 */
export function detectCandidateKind(candidateDir: string): 'llm' | 'companion' | 'deterministic' | 'none' {
  const has = (f: string): boolean => existsSync(path.join(candidateDir, f));
  if (has('content.md')) return 'llm';
  if (has('companion.mjs')) return 'companion';
  if (has('check.mjs')) return 'deterministic';
  return 'none';
}

// ---------------------------------------------------------------------------
// Schema version read (regex, no YAML parser — stays inside the import fence).
// ---------------------------------------------------------------------------

/**
 * Read the committed graph's declared schema version from `<yggRoot>/yg-config.yaml`
 * — the same `version:` field the migrator keys on. A regex read (not the YAML
 * parser) keeps simulate's dependency surface to io/paths, message-builder, and Node
 * built-ins. Returns null when the file or the version line is absent.
 */
export function readConfigVersion(yggRoot: string): string | null {
  const configPath = path.join(yggRoot, 'yg-config.yaml');
  const st = statSync(configPath, { throwIfNoEntry: false });
  if (!st || !st.isFile()) return null;
  let content: string;
  try {
    content = readFileSync(configPath, 'utf-8');
  } catch (err) {
    debugWrite(`[simulate] could not read ${configPath}: ${(err as Error).message}`);
    return null;
  }
  const m = content.match(/^version:\s*["']?([^"'#\n]+?)["']?\s*(?:#.*)?$/m);
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Clone-boundary guard (THE security-critical helper).
// ---------------------------------------------------------------------------

/**
 * Resolve the graph root for a checked-out clone, REFUSING to escape the clone.
 *
 * findYggRoot walks UP the directory tree. If the clone lacks its own
 * `.yggdrasil/` at this commit (a pre-init checkout, or one whose graph was
 * removed), that walk would climb OUT of the clone and resolve an ANCESTOR graph —
 * in the worst case the real repository the clone was made from. This guard never
 * lets that happen:
 *
 *   - If the clone has no `.yggdrasil/` of its own, it returns null WITHOUT walking
 *     up at all — the resolver is never given the chance to escape, so no ancestor
 *     (and in particular the real repo) is ever consulted.
 *   - Otherwise it resolves via findYggRoot and, as defence in depth, CONFIRMS the
 *     resolved path is inside the clone before accepting it — both LEXICALLY and
 *     through the filesystem (realpath, following symlinks). A checkout that committed
 *     `.yggdrasil` as a SYMLINK escaping the clone passes the lexical test (statSync
 *     follows the link, so the naive check sees a directory "inside" the clone) but is
 *     refused by the realpath layer; anything outside is refused (null).
 *
 * null means the commit is `non-comparable`, never zero and never the real graph.
 */
export async function resolveYggRootWithinClone(cloneDir: string): Promise<string | null> {
  const own = path.join(cloneDir, '.yggdrasil');
  const ownStat = statSync(own, { throwIfNoEntry: false });
  // No graph of the clone's own at this commit → do NOT walk up (the walk would
  // escape into an ancestor graph). This is the pre-init / removed-graph case.
  if (!ownStat || !ownStat.isDirectory()) return null;

  // The clone HAS its own `.yggdrasil/`, so findYggRoot resolves it on the first
  // step and cannot climb past it. Confirm containment anyway, in two layers:
  //   - Lexical (pathIsWithin): the resolved path must sit under the clone by name.
  //   - Realpath (realpathIsWithin): AND it must still sit under the clone once every
  //     symlink is followed. A checkout that committed `.yggdrasil` as a symlink
  //     escaping the clone (e.g. into the real repo, or /etc) passes the lexical test
  //     but not this one — statSync follows the link so the naive check sees a
  //     directory "inside" the clone, while every later read/overlay would act on the
  //     real target OUTSIDE it. Refusing here makes the commit non-comparable and no
  //     fs op ever touches the link target.
  const resolved = await findYggRoot(cloneDir);
  if (!pathIsWithin(cloneDir, resolved)) return null;
  if (!realpathIsWithin(cloneDir, resolved)) return null;
  return resolved;
}

// ---------------------------------------------------------------------------
// Per-commit run classification (reads the spawned aspect-test's verdict stamp).
// ---------------------------------------------------------------------------

/** First non-empty stderr line, `Error:` prefix stripped, clamped for display. */
function firstErrorLine(stderr: string): string | undefined {
  for (const raw of stderr.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (line === '') continue;
    const stripped = line.replace(/^Error:\s*/, '');
    return stripped.length > 160 ? stripped.slice(0, 157) + '…' : stripped;
  }
  return undefined;
}

/**
 * Classify one deterministic single-candidate run (a spawned `yg aspect-test`) into
 * a first-class per-commit outcome. The run's own verdict stamp is the signal:
 * `satisfied` ⇒ ran-clean, `refused — N violations` ⇒ violations(N). Anything else
 * — no recognizable stamp, an error on stderr (e.g. the node did not exist at this
 * commit, or the graph could not load) — is `non-comparable`, never silently zero.
 */
export function classifyAspectTestRun(
  status: number | null,
  stdout: string,
  stderr: string,
): { kind: 'ran-clean' } | { kind: 'violations'; count: number } | { kind: 'non-comparable'; reason: string } {
  const refused = /yg aspect-test:\s*refused\b[^\n]*?(\d+)\s*violation/i.exec(stdout);
  if (refused) return { kind: 'violations', count: Number(refused[1]) };
  if (/yg aspect-test:\s*satisfied\b/i.test(stdout)) return { kind: 'ran-clean' };
  return {
    kind: 'non-comparable',
    reason: firstErrorLine(stderr) ?? `the candidate produced no verdict here (exit ${status ?? 'null'})`,
  };
}

// ---------------------------------------------------------------------------
// git helpers (spawnSync — never throws on a non-zero git exit).
// ---------------------------------------------------------------------------

function git(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  // `-c color.ui=false` makes git output plain regardless of the repo's color config
  // (a repo with `color.ui=always` would otherwise colour output we parse). Combined
  // with a non-TTY pipe, git output is deterministic plain text.
  const r = spawnSync('git', ['-c', 'color.ui=false', ...args], { cwd, encoding: 'utf-8', maxBuffer: 128 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Field separator between %H and %s in the git log format (ASCII unit separator). */
const US = "\x1f";

/** Parse `git log --format=%H<US>%s` output into commits (newest-first, as git emits). */
function parseCommitLog(output: string): Commit[] {
  const commits: Commit[] = [];
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '') continue;
    const sep = line.indexOf(US);
    if (sep === -1) {
      commits.push({ sha: line.trim(), subject: '' });
    } else {
      commits.push({ sha: line.slice(0, sep).trim(), subject: line.slice(sep + 1).trim() });
    }
  }
  return commits;
}

/** Write the candidate aspect (and only the candidate) into the clone's graph. */
function overlayCandidate(candidateDir: string, cloneYggRoot: string, candidateId: string): void {
  const dest = path.join(cloneYggRoot, 'aspects', candidateId);
  // Hard containment guard, immediately before the destructive fs ops: if `dest` ever
  // resolved outside the clone, the recursive rmSync could delete REAL files. Two
  // layers, both must hold:
  //   - Lexical (pathIsWithin): catches a traversing candidateId that slipped past the
  //     upfront isPlainRelativeName check.
  //   - Realpath (realpathIsWithin): catches a committed `aspects/` dir (or the leaf)
  //     that is a SYMLINK escaping the clone — the lexical check waves it through, but
  //     the rmSync/cpSync would act on the real target outside. Resolving the existing
  //     prefix through realpathSync refuses it. Refusing throws → the commit degrades
  //     to non-comparable and no fs op touches the link target.
  if (!pathIsWithin(cloneYggRoot, dest) || !realpathIsWithin(cloneYggRoot, dest)) {
    throw new Error(`overlay destination escapes the clone (candidate '${candidateId}') — refusing to touch the filesystem`);
  }
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(candidateDir, dest, { recursive: true });
}

// ---------------------------------------------------------------------------
// --file target: overlay TODAY's architecture + coverage settings into the
// clone (E2). The file's CONTENT stays historical (checked out from the
// commit); only how the architecture classifies it and whether type-level
// coverage is even on come from today — otherwise a historical commit that
// predates coverage.type_level (or the matching architecture type) could
// never classify the file at all, and the replay would spuriously read as
// non-comparable for every commit instead of testing the rule.
// ---------------------------------------------------------------------------

/**
 * Extract the top-level `coverage:` block from a yg-config.yaml's raw text:
 * the `coverage:` key line itself plus every following line that is either
 * MORE indented than column 0 or blank, up to (not including) the next
 * column-0, non-blank line. Returns null when no `coverage:` key exists at
 * column 0. A regex/line scan, not a YAML parser — mirrors readConfigVersion's
 * own stated reason for staying inside the import fence.
 */
function extractCoverageBlock(content: string): string | null {
  const lines = content.split('\n');
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1) {
      if (/^coverage:\s*(#.*)?$/.test(lines[i])) { start = i; }
      continue;
    }
    if (lines[i].trim() === '' || /^\s/.test(lines[i])) continue; // inside the block
    end = i;
    break;
  }
  if (start === -1) return null;
  // Trim trailing blank lines from the captured block (they belong to the
  // surrounding file's spacing, not to the block's own content).
  while (end > start + 1 && lines[end - 1].trim() === '') end--;
  return lines.slice(start, end).join('\n');
}

/** Remove the top-level `coverage:` block (see extractCoverageBlock) from `content`, if present. */
function removeCoverageBlock(content: string): string {
  const lines = content.split('\n');
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1) {
      if (/^coverage:\s*(#.*)?$/.test(lines[i])) { start = i; }
      continue;
    }
    if (lines[i].trim() === '' || /^\s/.test(lines[i])) continue;
    end = i;
    break;
  }
  if (start === -1) return content;
  lines.splice(start, end - start);
  return lines.join('\n');
}

/**
 * Splice `block` (as returned by extractCoverageBlock, or null) into `content`
 * in place of whatever `coverage:` block `content` already has (removing it
 * first, if any) — `block === null` means today's config has none either, so
 * the clone's own historical block (if any) is simply dropped.
 */
function spliceCoverageBlock(content: string, block: string | null): string {
  const stripped = removeCoverageBlock(content);
  if (block === null) return stripped;
  const sep = stripped === '' || stripped.endsWith('\n') ? '' : '\n';
  return `${stripped}${sep}${block}\n`;
}

/**
 * Overlay TODAY's yg-architecture.yaml (wholesale) and TODAY's `coverage:`
 * settings (spliced into yg-config.yaml, replacing whatever the clone's
 * historical checkout had — every OTHER key, including the clone's own
 * `version:`, is left untouched) into the clone's graph — --file's addition
 * to the per-commit overlay (--node's own overlay is unchanged: only
 * overlayCandidate runs for it).
 *
 * Called AFTER the schema-version equality guard already passed for this
 * commit, so the clone's `version:` is already known to equal today's —
 * overwriting only `coverage:` (never `version:` or any other key) cannot
 * desync that already-verified fact.
 *
 * Same containment discipline as overlayCandidate: both destinations are
 * checked lexically AND through realpath (a committed yg-architecture.yaml or
 * yg-config.yaml that is a SYMLINK escaping the clone must never be written
 * through). Fails closed (throws) rather than silently skipping — a caller
 * that ignores the guard would report a "current-architecture" replay that
 * silently used stale, historical settings instead.
 */
export function overlayCurrentArchitectureAndCoverage(realYggRoot: string, cloneYggRoot: string): void {
  const archDest = path.join(cloneYggRoot, 'yg-architecture.yaml');
  const cfgDest = path.join(cloneYggRoot, 'yg-config.yaml');
  for (const dest of [archDest, cfgDest]) {
    if (!pathIsWithin(cloneYggRoot, dest) || !realpathIsWithin(cloneYggRoot, dest)) {
      throw new Error(`current-architecture overlay destination escapes the clone ('${dest}') — refusing to touch the filesystem`);
    }
  }

  const archSrc = path.join(realYggRoot, 'yg-architecture.yaml');
  if (existsSync(archSrc)) {
    cpSync(archSrc, archDest);
  } else {
    // Today's repo declares no architecture types at all — the clone must not
    // keep a stale historical one that would let a file classify when the
    // CURRENT repo could never have matched it.
    rmSync(archDest, { force: true });
  }

  const cfgSrc = path.join(realYggRoot, 'yg-config.yaml');
  const todayCoverage = existsSync(cfgSrc) ? extractCoverageBlock(readFileSync(cfgSrc, 'utf-8')) : null;
  const cloneCfg = existsSync(cfgDest) ? readFileSync(cfgDest, 'utf-8') : '';
  writeFileSync(cfgDest, spliceCoverageBlock(cloneCfg, todayCoverage));
}

// ---------------------------------------------------------------------------
// Report rendering.
// ---------------------------------------------------------------------------

/** Human token for one outcome (uncolored — colors are applied at render time). */
function outcomeToken(o: CommitOutcome): string {
  if (o.kind === 'ran-clean') return 'ran-clean';
  if (o.kind === 'violations') return `violations (${o.count})`;
  return 'non-comparable';
}

function colorForOutcome(kind: CommitOutcome['kind'], token: string): string {
  if (kind === 'ran-clean') return chalk.green(token);
  if (kind === 'violations') return chalk.yellow(token);
  return chalk.dim(token);
}

/**
 * Render the full replay report: a header naming the candidate / node / horizon, a
 * per-commit table (oldest first), a one-line summary of the outcome counts, a
 * plain caveat, and the VERBATIM Wald label.
 */
export function renderReport(params: {
  candidateId: string;
  target: SimulateTarget;
  referenceSchema: string;
  outcomes: CommitOutcome[];
}): string {
  const { candidateId, target, referenceSchema, outcomes } = params;
  const lines: string[] = [];

  lines.push(
    chalk.bold(
      target.kind === 'node'
        ? `Replay of candidate rule '${candidateId}' over node '${target.nodePath}'`
        : `Replay of candidate rule '${candidateId}' over file '${target.file}' (enforced by its architecture type alone)`,
    ),
  );
  lines.push(
    chalk.dim(
      `Reaches only commits whose committed graph schema equals this graph's (${referenceSchema}); ` +
        `every other commit is reported as non-comparable, never as a clean pass.`,
    ),
  );
  if (target.kind === 'file') {
    // E2: the file's CONTENT at each commit is historical, but the rule and
    // how it attaches (architecture + coverage settings) come from TODAY —
    // stated plainly so a reader never mistakes the result for pure history.
    lines.push(
      chalk.dim(
        'The rule and the way it attaches (architecture + coverage settings) come from TODAY; only the file\'s code comes from history.',
      ),
    );
  }
  lines.push('');

  if (outcomes.length === 0) {
    lines.push('  No commits to replay — this project has no git history to reach.');
  } else {
    const width = outcomes.reduce((w, o) => Math.max(w, outcomeToken(o).length), 0);
    for (const o of outcomes) {
      const token = outcomeToken(o);
      const padded = colorForOutcome(o.kind, token.padEnd(width));
      const shortSha = o.sha.slice(0, 8);
      const subject = o.subject === '' ? chalk.dim('(no subject)') : o.subject;
      lines.push(`  ${chalk.dim(shortSha)}  ${padded}  ${subject}`);
      if (o.kind === 'non-comparable') {
        lines.push(chalk.dim(`              ↳ ${o.reason}`));
      }
    }
  }

  const ranClean = outcomes.filter((o) => o.kind === 'ran-clean').length;
  const violations = outcomes.filter((o) => o.kind === 'violations').length;
  const nonComparable = outcomes.filter((o) => o.kind === 'non-comparable').length;
  lines.push('');
  lines.push(
    `Replayed ${outcomes.length} commit${outcomes.length === 1 ? '' : 's'}: ` +
      `${chalk.green(`ran-clean ${ranClean}`)} · ` +
      `${chalk.yellow(`violations ${violations}`)} · ` +
      `${chalk.dim(`non-comparable ${nonComparable}`)}`,
  );
  lines.push('');
  lines.push(
    chalk.dim(
      'Caveat: the old rule gate already refused some code that never landed, so this history is a ' +
        'filtered sample — the counts above are bounds, not the whole truth.',
    ),
  );
  lines.push(chalk.dim(WALD_LABEL));
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------

/** Emit a structured what/why/next error to stderr (never touches the real tree). */
function emitError(msg: { what: string; why: string; next: string }): void {
  process.stderr.write(chalk.red(`Error: ${buildIssueMessage(msg)}`) + '\n');
}

export interface SimulateArgs {
  candidateId: string;
  target: SimulateTarget;
  maxCommits: number;
  /** The directory to resolve the real graph from (normally process.cwd()). */
  cwd: string;
  /** Absolute path to the built bin.js to spawn per commit (injected for tests). */
  binPath: string;
  /** Where the report is written (injected so tests can capture it). */
  emit: (chunk: string) => void;
}

/**
 * Run the replay. Returns the process exit code: 0 for any completed report
 * (whatever it found), 1 for a precondition failure on the real repo (no graph,
 * missing candidate, wrong candidate kind, unreadable schema, cannot clone).
 */
export async function runSimulation(args: SimulateArgs): Promise<number> {
  const { candidateId, target, maxCommits, cwd, binPath, emit } = args;
  const targetValue = target.kind === 'node' ? target.nodePath : target.file;
  const targetLabel = target.kind === 'node' ? '--node path' : '--file path';

  // ── Input sanitisation (SECURITY, before any graph load or fs op) ───────────
  // The candidate id and target value are untrusted and reach filesystem
  // operations (the overlay's rmSync/cpSync at `<clone>/.yggdrasil/aspects/<candidateId>`,
  // and — for a --file target — the current-architecture overlay). A `..` or
  // absolute component could make those operations escape the clone onto the
  // REAL tree, so reject a traversing value up front — before cloning, before
  // any read or write. This is input validation, not graph-state handling;
  // the graph load (below) still owns the missing-graph error.
  for (const [label, value] of [['candidate id', candidateId], [targetLabel, targetValue]] as const) {
    if (!isPlainRelativeName(value)) {
      emitError({
        what: `The ${label} '${value}' is not a plain relative name.`,
        why: 'simulate writes the candidate only inside an isolated clone and must never resolve a path outside it; a value with a `..`, absolute, or drive-letter component could escape onto the real tree.',
        next: `Pass a plain aspect id and a plain ${target.kind === 'node' ? '--node' : '--file'} path with no \`..\` segments and no absolute or drive-letter components.`,
      });
      return 1;
    }
  }

  // ── Real-repo preconditions (the only paths that can exit non-zero) ─────────
  // Start from the shared graph-load helper (the CLI command contract): it owns the
  // canonical missing-graph error and exit, so simulate inlines no ENOENT branch of
  // its own. We use only the resolved graph ROOT — simulate operates on the graph's
  // files and the project's git history, never mutating the loaded graph. (This load
  // is of the REAL project and is strictly read-only; every write in this command
  // happens later, in the isolated clone.)
  const graph = await loadGraphOrAbort(cwd);
  const realYggRoot = graph.rootPath;

  const candidateDir = path.join(realYggRoot, 'aspects', candidateId);
  // Belt-and-suspenders: even after the plain-name check above, hard-assert the
  // candidate directory stays within the graph's aspects tree before we read it.
  if (!pathIsWithin(realYggRoot, candidateDir)) {
    emitError({
      what: `The candidate id '${candidateId}' resolves outside the graph's aspects directory.`,
      why: 'simulate reads and overlays the candidate only inside the project graph and its clone; a path that escapes that boundary is refused.',
      next: 'Pass a plain aspect id with no `..` or absolute components.',
    });
    return 1;
  }
  const candidateStat = statSync(candidateDir, { throwIfNoEntry: false });
  if (!candidateStat || !candidateStat.isDirectory()) {
    emitError({
      what: `Candidate rule '${candidateId}' was not found.`,
      why: 'simulate replays an existing aspect from this project as the candidate; there is no aspect with that id to replay.',
      next: 'Pass the id of an existing deterministic aspect (a directory under .yggdrasil/aspects/ with a check.mjs).',
    });
    return 1;
  }

  const kind = detectCandidateKind(candidateDir);
  if (kind === 'llm' || kind === 'companion') {
    emitError({
      what: `Candidate '${candidateId}' is an ${kind === 'llm' ? 'LLM' : 'LLM companion'}-reviewed rule, which simulate cannot replay.`,
      why: 'A replay must be deterministic and reproducible; an LLM verdict is a point-in-time testimony of a reviewer, not a value a rerun over history can reproduce.',
      next: 'Supply a deterministic (check.mjs) candidate to replay here, or use `yg drill` to test an LLM rule\'s falsifiability against a case corpus.',
    });
    return 1;
  }
  if (kind === 'none') {
    emitError({
      what: `Candidate '${candidateId}' has no deterministic check to replay.`,
      why: 'simulate replays a deterministic rule\'s check.mjs; this aspect ships no check.mjs (it may be an aggregate that only bundles other aspects).',
      next: 'Pass a deterministic aspect that ships a check.mjs, or one of an aggregate\'s atomic children.',
    });
    return 1;
  }

  const referenceSchema = readConfigVersion(realYggRoot);
  if (referenceSchema === null) {
    emitError({
      what: 'The current graph declares no readable schema version in yg-config.yaml.',
      why: 'The replay horizon is the set of commits sharing this graph\'s schema; without a current version there is nothing to compare a commit\'s schema against.',
      next: 'Ensure .yggdrasil/yg-config.yaml has a `version:` field, then re-run.',
    });
    return 1;
  }

  const projectRoot = projectRootFromGraph(realYggRoot);

  // ── --file path normalization (same rule every --file-accepting command
  // follows: resolveFileArg(repoRoot, rawPath), never process.cwd() directly)
  // — done here, not before the graph load above, because repoRoot comes from
  // the loaded graph's own root. A --node target needs no such resolution
  // (a node path is already graph-relative, not filesystem-relative). ──
  const resolvedTarget: SimulateTarget = target.kind === 'node'
    ? target
    : { kind: 'file', file: resolveFileArg(projectRoot, target.file) };
  if (resolvedTarget.kind === 'file' && !isPlainRelativeName(resolvedTarget.file)) {
    emitError({
      what: `The --file path '${resolvedTarget.file}' resolves outside the project root.`,
      why: 'simulate resolves --file the same way every other --file-accepting command does (relative to the graph root, not the current directory) — a value that escapes the project root cannot be a subject in this project\'s history.',
      next: 'Pass a --file path inside the project root.',
    });
    return 1;
  }

  // ── Clone-in-temp (all mutation happens here, never in the real tree) ───────
  const cloneDir = mkdtempSync(path.join(tmpdir(), 'yg-simulate-'));
  try {
    const cloned = git(['clone', '--quiet', projectRoot, cloneDir], projectRoot);
    if (cloned.status !== 0) {
      emitError({
        what: 'yg simulate could not make an isolated clone of this project.',
        why: `Replay runs in a throwaway clone so the real tree is never touched; the clone failed (${firstErrorLine(cloned.stderr) ?? 'git clone did not succeed'}). Git and a committed history are required.`,
        next: 'Ensure git is installed and this project is a git repository with at least one commit, then re-run.',
      });
      return 1;
    }

    const logged = git(['log', '-n', String(maxCommits), `--format=%H${US}%s`], cloneDir);
    const commits = logged.status === 0 ? parseCommitLog(logged.stdout) : [];
    // git log emits newest-first; replay oldest-first so the report reads forward.
    commits.reverse();

    const outcomes: CommitOutcome[] = [];
    for (const commit of commits) {
      outcomes.push(await replayOneCommit({ commit, cloneDir, referenceSchema, candidateDir, candidateId, target: resolvedTarget, realYggRoot, binPath }));
    }

    emit(renderReport({ candidateId, target: resolvedTarget, referenceSchema, outcomes }));
    return 0;
  } finally {
    rmSync(cloneDir, { recursive: true, force: true });
  }
}

/**
 * Replay the candidate at ONE commit in the clone and classify the outcome. Fully
 * exception-contained: any unexpected failure of a single commit degrades to
 * `non-comparable` (with a debug note) so one bad commit never aborts the report.
 */
async function replayOneCommit(params: {
  commit: Commit;
  cloneDir: string;
  referenceSchema: string;
  candidateDir: string;
  candidateId: string;
  target: SimulateTarget;
  /** The REAL project's .yggdrasil root — read-only source for a --file
   *  target's current-architecture overlay. Never written to. */
  realYggRoot: string;
  binPath: string;
}): Promise<CommitOutcome> {
  const { commit, cloneDir, referenceSchema, candidateDir, candidateId, target, realYggRoot, binPath } = params;
  const base = { sha: commit.sha, subject: commit.subject };
  try {
    const checkout = git(['checkout', '-f', commit.sha], cloneDir);
    if (checkout.status !== 0) {
      return { ...base, kind: 'non-comparable', reason: `could not check out this commit (${firstErrorLine(checkout.stderr) ?? 'git checkout failed'})` };
    }
    // Strip any leftover overlay from the previous commit BEFORE the boundary guard,
    // so a pre-init commit is not masked by a stale `.yggdrasil/` from the last run.
    git(['clean', '-ffdq'], cloneDir);

    const cloneYggRoot = await resolveYggRootWithinClone(cloneDir);
    if (cloneYggRoot === null) {
      return {
        ...base,
        kind: 'non-comparable',
        reason: 'this commit has no graph of its own (it predates yg init, or its graph was removed); the real repo is never consulted',
      };
    }

    const version = readConfigVersion(cloneYggRoot);
    if (version !== referenceSchema) {
      return {
        ...base,
        kind: 'non-comparable',
        reason:
          version === null
            ? 'this commit\'s graph records no schema version'
            : `this commit's graph is schema ${version}, not ${referenceSchema} — it would need a migration this replay never performs`,
      };
    }

    overlayCandidate(candidateDir, cloneYggRoot, candidateId);
    // --file (E2): additionally overlay TODAY's architecture + coverage
    // settings — the schema-equality guard above already confirmed this
    // commit's graph shares today's schema, so overwriting only `coverage:`
    // (never `version:` or any other key) cannot desync that fact. --node's
    // own overlay is unchanged: only overlayCandidate runs for it.
    if (target.kind === 'file') {
      overlayCurrentArchitectureAndCoverage(realYggRoot, cloneYggRoot);
    }

    // ONE fresh subprocess per commit — a reused process would pin the previous
    // commit's check.mjs in the ESM module cache and replay stale logic.
    const targetArgs = target.kind === 'node' ? ['--node', target.nodePath] : ['--file', target.file];
    const run = spawnSync(process.execPath, [binPath, 'aspect-test', '--aspect', candidateId, ...targetArgs], {
      cwd: cloneDir,
      encoding: 'utf-8',
      maxBuffer: 128 * 1024 * 1024,
      // Force plain output: the classifier matches aspect-test's chalk-coloured
      // verdict stamp, and the child inherits the parent env — with FORCE_COLOR set
      // in the parent the stamp would gain ANSI escapes and every commit would
      // silently degrade to non-comparable. Pin colour OFF so the stamp is plain
      // regardless of the parent env.
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    const classified = classifyAspectTestRun(run.status, run.stdout ?? '', run.stderr ?? '');
    return { ...base, ...classified };
  } catch (err) {
    debugWrite(`[simulate] commit ${commit.sha} could not be replayed: ${(err as Error).message}`);
    return { ...base, kind: 'non-comparable', reason: 'an unexpected error prevented this commit from being compared' };
  }
}

/** Parse and validate `--max-commits`; returns null on a non-positive-integer. */
export function parseMaxCommits(raw: string): number | null {
  const s = String(raw).trim();
  if (!/^[0-9]+$/.test(s)) return null;
  const n = Number.parseInt(s, 10);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

export function registerSimulateCommand(program: Command): void {
  program
    .command('simulate')
    .description(
      'Replay a candidate deterministic rule over the history it can honestly reach (read-only, in an isolated clone; reports per-commit outcomes, never gates)',
    )
    .argument('<candidate>', 'aspect id of the candidate deterministic rule to replay')
    .option('--node <path>', 'the node whose files the candidate replays over at each commit — mutually exclusive with --file')
    .option('--file <path>', 'a file enforced by its architecture type alone (no owning component) — replays over its HISTORICAL content, classified against the CURRENT architecture; mutually exclusive with --node')
    .option('--max-commits <n>', 'how many most-recent commits to consider', '20')
    .action(async (candidate: string, opts: { node?: string; file?: string; maxCommits: string }) => {
      try {
        const hasNode = typeof opts.node === 'string';
        const hasFile = typeof opts.file === 'string';
        if (hasNode === hasFile) {
          emitError({
            what: hasNode
              ? 'Both --node and --file were provided.'
              : 'Neither --node nor --file was provided.',
            why: 'yg simulate replays over exactly one target: --node (a component) or --file (a file enforced by its architecture type alone, no component).',
            next: 'Re-run with exactly one of --node <path> or --file <path>.',
          });
          process.exit(1);
          return;
        }
        const candidateId = candidate.trim().replace(/\/$/, '');
        const target: SimulateTarget = hasNode
          ? { kind: 'node', nodePath: opts.node!.trim().replace(/\/$/, '') }
          : { kind: 'file', file: opts.file!.trim() };
        const maxCommits = parseMaxCommits(opts.maxCommits);
        if (maxCommits === null) {
          emitError({
            what: `--max-commits must be a positive whole number (got '${opts.maxCommits}').`,
            why: 'The value bounds how many recent commits the replay considers; a non-positive or non-numeric value has no meaning.',
            next: 'Re-run with --max-commits <n> where n is 1 or greater.',
          });
          process.exit(1);
          return;
        }
        const binPath = path.join(getPackageRoot(), 'bin.js');
        const code = await runSimulation({
          candidateId,
          target,
          maxCommits,
          cwd: process.cwd(),
          binPath,
          emit: (chunk) => process.stdout.write(chunk),
        });
        if (code !== 0) process.exit(code);
      } catch (error) {
        debugWrite(`[simulate] command failed: ${(error as Error).message}`);
        emitError({
          what: `yg simulate could not complete: ${(error as Error).message}`,
          why: 'The replay hit an error it does not classify; nothing in the real repository was modified — all work happens in an isolated clone.',
          next: 'Re-run the command; if it recurs, this is a bug — report it with the command you ran.',
        });
        process.exit(1);
      }
    });
}
