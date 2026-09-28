import { mkdir, writeFile, readFile, readdir, chmod } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { toPosixPath } from '../utils/posix.js';
import path from 'node:path';
import { parseDocument, isMap, isScalar, isSeq, type Document } from 'yaml';
import { DEFAULT_CONFIG, DEFAULT_ARCHITECTURE } from '../templates/default-config.js';
import { installRules } from '../templates/platform.js';
import type { RulesArtifactsConfig } from '../model/graph.js';
import type { IssueMessage } from '../model/validation.js';
import { DEFAULT_RULES_ARTIFACTS } from '../model/graph.js';
import { debugWrite } from '../utils/debug-log.js';
import type { RetiredKeys } from '../utils/known-keys.js';
import { RETIRED_NODE_KEYS, RETIRED_NODE_PORT_KEYS, RETIRED_NODE_RELATION_KEYS } from '../io/node-parser.js';
import { RETIRED_NODE_TYPE_KEYS } from '../io/architecture-parser.js';
import { RETIRED_ASPECT_KEYS } from '../io/aspect-parser.js';
import { RETIRED_QUALITY_KEYS, RETIRED_TIER_CONFIG_KEYS } from '../io/config-parser.js';
import { FILL_DIVERGENCE_GITIGNORE_LINE, RUN_LOCK_GITIGNORE_LINE } from '../io/debug-log-writer.js';
import { PACKAGE_VERSIONS_CACHE_FILENAME } from '../io/package-versions-cache.js';
import { REFUSED_GITIGNORE_LINE } from '../io/refused-store.js';

// ---------------------------------------------------------------------------
// .gitattributes — mark the committed lock as generated
// ---------------------------------------------------------------------------

/** The exact .gitattributes lines Yggdrasil manages at the repo root, in order:
 *    - the lock's linguist-generated line — the committed lock triad
 *      (yg-lock.nondeterministic.json, yg-lock.logs.json) is machine-written, so
 *      marking it generated keeps it out of language stats and collapses it in
 *      review diffs (the gitignored deterministic cache is never committed, so it
 *      needs no attribute);
 *    - the advise-decisions register's merge=union line — that ledger is COMMITTED
 *      case law appended on many branches, so a union merge keeps every branch's
 *      decisions instead of forcing a conflict on the append-only file.
 *    - the imported-proposals register's merge=union line — proposals another tool
 *      measured are COMMITTED facts about the repository at a commit, appended on
 *      many branches for the same reason and needing the same union merge. (The
 *      file only exists once something has been imported; the attribute is
 *      harmless when it is absent.)
 *    - the committed LLM-fill events stream's line — that stream is a COMMITTED,
 *      opt-in shared record of LLM verification-fill events appended on many
 *      branches, so merge=union keeps every branch's events instead of forcing a
 *      conflict on the append-only file. The pattern covers the current file and
 *      the month files it is sealed into (two branches can each seal the same
 *      month). linguist-generated collapses it in review diffs, as for the lock:
 *      one line per reviewer verdict is a record, not a change to read. (The files
 *      only exist once a repo opts in via `events: { committed_llm: true }`; the
 *      attribute is harmless when they are absent.)
 *    - every node's and aspect's log.md pinned to LF — the log's append-only
 *      baseline is a prefix hash; the hash normalises line endings, and pinning
 *      the committed text to LF also keeps checkouts (Git for Windows defaults to
 *      core.autocrlf=true) byte-identical to what was baselined and appended.
 *    - every log.md (a rule adaptation's log too) merged by the `yg-log` driver
 *      and every committed lock file by the `yg-lock` driver (`yg merge-driver`,
 *      configured per clone by {@link ensureMergeDrivers}). The attribute is
 *      safe on a clone that never configured the drivers: git treats a driver
 *      it has no definition for as absent and merges with conflict markers.
 *  Single source of truth for what init writes into the repo-root .gitattributes
 *  (both fresh init and every --upgrade). */
const GITATTRIBUTES_LINES = [
  '/.yggdrasil/yg-lock.*.json linguist-generated=true',
  '/.yggdrasil/advise-decisions.jsonl merge=union',
  '/.yggdrasil/advise-imported.jsonl merge=union',
  '/.yggdrasil/yg-events.llm*.jsonl merge=union linguist-generated=true',
  '/.yggdrasil/**/log.md text eol=lf',
  '/.yggdrasil/**/log.md merge=yg-log',
  '/.yggdrasil/**/yg-aspect.adapt.log.md merge=yg-log',
  '/.yggdrasil/yg-lock.*.json merge=yg-lock',
] as const;

/**
 * Ensure the repo-root .gitattributes carries every line Yggdrasil manages (see
 * {@link GITATTRIBUTES_LINES}).
 *
 * Idempotent: creates the file with all lines when absent; appends only the
 * missing line(s), once each, when the file exists without them (preserving any
 * other content and ensuring a separating newline); no-op when every line is
 * already present. Run on fresh init AND every --upgrade so existing adopters
 * pick up the complete set. Returns the lines it wrote (empty on a no-op), so an
 * upgrade can say what it changed instead of claiming it changed nothing.
 */
export async function ensureGitattributes(repoRoot: string): Promise<string[]> {
  const gaPath = path.join(repoRoot, '.gitattributes');
  let existing: string | undefined;
  try {
    existing = await readFile(gaPath, 'utf-8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    debugWrite(`[init] ensureGitattributes: ${gaPath} not found (ENOENT), will create`);
    existing = undefined;
  }

  if (existing === undefined) {
    await writeFile(gaPath, `${GITATTRIBUTES_LINES.join('\n')}\n`, 'utf-8');
    return [...GITATTRIBUTES_LINES];
  }

  const presentLines = new Set(existing.split('\n').map((line) => line.trim()));
  const missing = GITATTRIBUTES_LINES.filter((line) => !presentLines.has(line));
  if (missing.length === 0) return [];

  // Append each missing line once, guaranteeing a newline boundary before and after.
  const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  await writeFile(gaPath, `${existing}${sep}${missing.join('\n')}\n`, 'utf-8');
  return missing;
}

// ---------------------------------------------------------------------------
// Merge drivers and the post-merge hook — local git configuration
// ---------------------------------------------------------------------------

/** The marker line that says a post-merge hook is the one `yg init` writes (and may rewrite). */
const POST_MERGE_MARKER = '# yg:post-merge';

/**
 * The CLI that is running, as a path a POSIX shell can test and node can run:
 * resolved through symlinks (a global `yg` is usually a link to the package's
 * bin), with forward slashes (Git for Windows' sh reads `C:/…`, not `C:\…`),
 * and with the characters a double-quoted sh word would interpret escaped.
 */
function runningCliPath(given?: string): string | null {
  const argv1 = given ?? process.argv[1];
  if (argv1 === undefined || argv1 === '') return null;
  let resolved = argv1;
  try {
    resolved = realpathSync(argv1);
  } catch {
    debugWrite(`[init] merge drivers: could not resolve ${argv1}, using it as given`);
  }
  return resolved.replace(/\\/g, '/').replace(/(["$`])/g, '\\$1');
}

/**
 * The command git runs for one driver. The CLI is named by the absolute path it
 * runs from now, and the command FALLS BACK to git's own text merge with
 * conflict markers whenever that CLI or node is gone (an npx cache cleared, a
 * global install removed): a driver git is told to run but cannot start leaves
 * the file conflicted with ours' side only and no markers, so staging it would
 * lose theirs without a word. The same holds for a CLI that is there but does
 * not start — a node too old for it, a half-finished upgrade, an older CLI with
 * no `merge-driver` command: it exits non-zero without writing, so a non-zero
 * exit that left no conflict markers in <ours> gets git's text merge too. (The
 * driver's own refusal always writes markers before exiting 1.) Git runs
 * driver commands through its own POSIX shell on every platform (Git for
 * Windows ships one, with grep), so `if … fi` is portable; nothing in it is bash.
 */
function mergeDriverCommand(cli: string, kind: 'log' | 'lock'): string {
  const textMerge = 'git merge-file -L ours -L base -L theirs %A %O %B';
  return `if [ -f "${cli}" ] && command -v node >/dev/null 2>&1; then node "${cli}" merge-driver ${kind} %O %A %B %P; s=$?; if [ $s -ne 0 ] && ! grep -q '^<<<<<<< ' %A; then ${textMerge}; exit 1; fi; exit $s; else ${textMerge}; fi`;
}

/** The post-merge hook `yg init` writes when the repository has none. */
function postMergeHook(cli: string): string {
  return [
    '#!/bin/sh',
    POST_MERGE_MARKER,
    '# Written by yg init. git merges log.md and the lock through the yg-log and yg-lock',
    '# drivers, but a driver sees one file and cannot record a merged log\'s baseline;',
    '# `yg log merge-resolve` with no log named records it for every log the merge changed.',
    '# It never fails the merge: what it could not reconcile it names, and yg check says the same.',
    `if [ -f "${cli}" ] && command -v node >/dev/null 2>&1; then`,
    `  node "${cli}" log merge-resolve || echo "yg: some merged logs are not reconciled - run yg log merge-resolve" >&2`,
    'fi',
    'exit 0',
    '',
  ].join('\n');
}

/**
 * The variables that point git at a repository other than the one its working
 * directory is in. Git sets them for the hooks it runs, so a `yg init` run from
 * inside one (a test suite in a pre-commit gate) would otherwise configure THAT
 * repository's drivers and hooks. The repository configured is always the one
 * the project root is in, found from the directory alone.
 */
const REPOSITORY_OVERRIDES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX', 'GIT_NAMESPACE'];

function gitLine(cwd: string, args: string[]): string | null {
  const env = { ...process.env };
  for (const name of REPOSITORY_OVERRIDES) delete env[name];
  try {
    return execFileSync('git', args, { cwd, env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * Configure this clone's `yg-log` and `yg-lock` merge drivers (in its local
 * `.git/config` — a driver's command is a local path, so it is never committed)
 * and install the post-merge hook that records merged logs' baselines, when the
 * repository has no post-merge hook of its own. Idempotent: a setting already
 * right is left alone, and returns what this run changed, so an upgrade can say
 * so. Outside a git repository, or with git missing, it does nothing. `cliPath`
 * names the CLI the commands run; absent, the one running now.
 *
 * A hook some other tool wrote is never replaced; a hooks directory outside the
 * git directory (`core.hooksPath`, usually a committed directory of the working
 * tree) is left alone too, since a file written there would be the
 * repository's — committed, and naming this machine's path to the CLI — not
 * this clone's. In both cases, and when a setting could not be written, the
 * returned notes say what was not done and the work left to do by hand: they
 * are never among the things configured.
 */
export async function ensureMergeDrivers(projectRoot: string, cliPath?: string): Promise<{ configured: string[]; notes: IssueMessage[] }> {
  const out = { configured: [] as string[], notes: [] as IssueMessage[] };
  const cli = runningCliPath(cliPath);
  if (cli === null || gitLine(projectRoot, ['rev-parse', '--is-inside-work-tree']) !== 'true') return out;
  const drivers: Array<[string, 'log' | 'lock', string]> = [
    ['yg-log', 'log', "Yggdrasil's append-only log.md"],
    ['yg-lock', 'lock', "Yggdrasil's committed lock files"],
  ];
  for (const [name, kind, label] of drivers) {
    for (const [key, value] of [[`merge.${name}.name`, label], [`merge.${name}.driver`, mergeDriverCommand(cli, kind)]] as const) {
      if (gitLine(projectRoot, ['config', '--local', '--get', key]) === value) continue;
      if (gitLine(projectRoot, ['config', '--local', key, value]) === null) {
        out.notes.push({
          what: `Could not set ${key} in the local git configuration.`,
          why: 'Without the driver, git merges that file as text: two branches that both changed it stop with conflict markers.',
          next: 'Run yg init --upgrade again; if it still fails, check that .git/config is writable.',
        });
        continue;
      }
      out.configured.push(key);
    }
  }
  const hookPath = gitLine(projectRoot, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks/post-merge']);
  const commonDir = gitLine(projectRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (hookPath === null || commonDir === null) return out;
  const hook = postMergeHook(cli);
  const existing = await readFile(hookPath, 'utf-8').catch(() => null);
  const ours = existing !== null && existing.includes(POST_MERGE_MARKER);
  if (existing !== null && !ours) {
    out.notes.push({
      what: `No post-merge hook installed: ${toPosixPath(hookPath)} exists and is not Yggdrasil's, so it was left as it is.`,
      why: "The hook records the baseline of every log.md a merge changed; without it, run yg log merge-resolve after each merge yourself.",
      next: `Add a line running yg log merge-resolve to ${toPosixPath(hookPath)}.`,
    });
    return out;
  }
  if (!toPosixPath(hookPath).startsWith(`${toPosixPath(commonDir)}/`)) {
    const hooksDir = toPosixPath(path.dirname(hookPath));
    out.notes.push({
      what: `No post-merge hook installed: git runs hooks from ${hooksDir} (core.hooksPath), outside this clone's git directory.`,
      why: "A hook written there would be the repository's or another tool's, not this clone's, and would carry this machine's path to the CLI; without one, the baseline of a log.md a merge changed is not recorded until yg log merge-resolve runs.",
      next: `Add a post-merge hook to ${hooksDir} that runs yg log merge-resolve, or run yg log merge-resolve after each merge.`,
    });
    return out;
  }
  if (existing === hook) return out;
  await mkdir(path.dirname(hookPath), { recursive: true });
  await writeFile(hookPath, hook, { encoding: 'utf-8', mode: 0o755 });
  await chmod(hookPath, 0o755);
  out.configured.push('hooks/post-merge');
  return out;
}

// ---------------------------------------------------------------------------
// .yggdrasil/.gitignore — local rebuildable/secret state
// ---------------------------------------------------------------------------

/** The lines `.yggdrasil/.gitignore` must carry, in order. All Yggdrasil-derived
 *  local state lives under `.yggdrasil/` and is rebuildable or secret — it must
 *  never be committed:
 *    - `yg-secrets.yaml`  — provider API keys
 *    - `.symbols-cache/`  — the relation pass's legacy per-language symbol-index cache
 *    - `.ast-cache/`      — the relation pass's content-addressed per-file AST fact cache
 *    - `.type-class-cache/` — the type-level classification lattice's path-and-content-keyed cache
 *    - `.debug.log`       — the opt-in command debug log
 *    - `.yg-events.jsonl` — the fill stage's append-only verdict-events telemetry sidecar
 *    - `.refused/`        — the fill stage's store of refused content, keyed by verdict hash
 *    - `.yg-fill-divergence.log` — the fill stage's convergence-sentinel evidence dump
 *    - `.feature-field.json` — `yg check`'s silent structural-deviation attention index
 *    - `.yg-packages-versions.json` — what each installed package's source was last seen to publish
 *    - `*.tmp`            — an atomic write's half-finished temp file, orphaned by a hard kill
 *    - `.yg-*.lock`       — the run-exclusion lock files held while an approval or a log write runs
 *  This is the single source of truth for what init writes into the local
 *  gitignore (both fresh init and every --upgrade). Paths are relative to the
 *  `.yggdrasil/` directory the file lives in. */
export const YGGDRASIL_GITIGNORE_LINES = [
  'yg-secrets.yaml',
  '.symbols-cache/',
  // Content-addressed per-file AST fact cache: a local speed cache the relation pass rebuilds
  // free on the next run; never committed.
  '.ast-cache/',
  // Path-and-content-keyed classification cache for the type-level lattice: a local
  // speed cache the coverage pass rebuilds free on the next run; never committed.
  '.type-class-cache/',
  '.debug.log',
  // Deterministic-verdict lock: a local cache rebuilt for free by
  // `yg check --approve --only-deterministic`; never committed.
  '.yg-lock.deterministic.json',
  // Append-only verdict-events telemetry sidecar: local, never committed. Unlike the
  // committed stream, this one keeps a refusal's full reason text, so a rotation must
  // never become committable: the trailing `*` covers the `.1` form the reader already
  // looks for, matching both the divergence dump's pattern below and what
  // `yg knowledge read configuration` states is ignored.
  '.yg-events.jsonl*',
  // Refused-content store: the bytes and reason of every refusal a fill records,
  // one JSON file per verdict hash (io/refused-store). Local and write-only, never
  // committed; the writer skips it where this line is missing, since a fill never
  // edits a tracked .gitignore.
  REFUSED_GITIGNORE_LINE,
  // Convergence-sentinel evidence dump: local, best-effort forensic log written
  // only when the fill detects a 0-fill divergence; never committed. The trailing
  // `*` also covers the single `.1` rotation. Pattern shared with the writer
  // (io/debug-log-writer) so the two can never drift.
  FILL_DIVERGENCE_GITIGNORE_LINE,
  // Silent feature-field deviation index: a local, rebuildable attention index `yg check`
  // maintains (files structurally unusual among their node's same-language peers); never
  // committed. A check never edits a tracked .gitignore: where this line is missing the writer
  // (core/feature-index-write) skips the index and the check says so.
  '.feature-field.json',
  // Family candidates: local analysis each producer writes into its own
  // `.family-candidates.<producer>.json` (and earlier releases into the shared
  // `.family-candidates.json`), freshness-gated when read and rebuilt by rerunning
  // the producer; never committed, whether a miner wrote it or `yg adopt` carried
  // it in with a proposal.
  '.family-candidates.json',
  '.family-candidates.*.json',
  // What each installed package's source was last seen to publish: a local,
  // rebuildable cache the package commands write while they are already talking
  // to a source, so the attention feed can mention a newer version without
  // reaching outside the repository itself. Knowledge about somebody else's
  // repository rather than this one — it would churn on every listing and two
  // machines would legitimately disagree — so it is never committed. The writer
  // (io/package-versions-cache) self-ensures this same line as a backstop.
  PACKAGE_VERSIONS_CACHE_FILENAME,
  // Half-finished atomic write (io/atomic-write.ts writes `<target>.<pid>-<n>-<hex>.tmp`
  // then renames). Its own cleanup covers a thrown error, but nothing can run on a hard
  // kill — a SIGKILL, an out-of-memory abort, a machine losing power — so a temp can
  // outlive the run that made it. `yg check` sweeps stale ones on startup; this line
  // keeps one from showing up as untracked noise in the window before that, and covers
  // any left by a run of an older CLI.
  '*.tmp',
  // Run-exclusion lock files: `.yg-approve.lock`, held by `yg check --approve` from its
  // lock read to its last write so a second approval cannot overwrite its verdicts, and
  // `.yg-log.lock`, held for the moment a log entry is read, composed and replaced. They
  // exist only while a command runs (or after a crash, until the next run replaces
  // them); never committed.
  RUN_LOCK_GITIGNORE_LINE,
] as const;

/**
 * Ensure `<yggRoot>/.gitignore` carries every required line. `.yggdrasil/` is the
 * single home for all Yggdrasil-derived local state (secrets, the relation
 * symbol-index cache, the debug log); none of it may be committed (a committed
 * cache trips the coverage gate as an unmapped file the moment it is tracked, and
 * secrets must never reach the repo).
 *
 * Idempotent: creates the file with all lines when absent; appends only the
 * missing line(s), once each, when the file exists without them (preserving any
 * other existing content and ensuring a separating newline); no-op when every
 * line is already present. Run on fresh init AND every --upgrade so existing
 * adopters pick up the complete set. Returns the lines it wrote (empty on a
 * no-op), so an upgrade can report a top-up rather than "nothing changed".
 */
export async function ensureYggdrasilGitignore(yggRoot: string): Promise<string[]> {
  const giPath = path.join(yggRoot, '.gitignore');
  let existing: string | undefined;
  try {
    existing = await readFile(giPath, 'utf-8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    debugWrite(`[init] ensureYggdrasilGitignore: ${giPath} not found (ENOENT), will create`);
    existing = undefined;
  }

  if (existing === undefined) {
    await writeFile(giPath, `${YGGDRASIL_GITIGNORE_LINES.join('\n')}\n`, 'utf-8');
    return [...YGGDRASIL_GITIGNORE_LINES];
  }

  const presentLines = new Set(existing.split('\n').map((line) => line.trim()));
  const missing = YGGDRASIL_GITIGNORE_LINES.filter((line) => !presentLines.has(line));
  if (missing.length === 0) return [];

  // Append each missing line once, guaranteeing a newline boundary before and after.
  const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  await writeFile(giPath, `${existing}${sep}${missing.join('\n')}\n`, 'utf-8');
  return missing;
}

// ---------------------------------------------------------------------------
// Fresh .yggdrasil/ structure + universal agent rules
// ---------------------------------------------------------------------------

/**
 * `cliVersionStr` is passed in rather than resolved here (via cli-version.ts's
 * `cliVersion()`) because this module's node type (`command-support`) may only
 * relate to [engine, parser-adapter, persistence-adapter, formatter, utility,
 * llm-shared, template] — NOT to another `command-support` node, which is what
 * cli-version.ts is. The caller (init.ts, a `command` node — allowed to call
 * any command-support node) resolves the version once and threads it through.
 */
export async function createYggdrasilStructure(
  projectRoot: string,
  yggRoot: string,
  cliVersionStr: string,
  artifacts: RulesArtifactsConfig = DEFAULT_RULES_ARTIFACTS,
): Promise<void> {
  // Git does not track empty directories. Without a placeholder, a graph
  // committed before its first node, rule or flow reaches every clone without
  // these directories, so each one carries an empty .gitkeep until real content
  // arrives. The loader tolerates their absence as well; the placeholder keeps
  // the clone looking like the tree init produced.
  for (const dir of ['model', 'aspects', 'flows']) {
    await mkdir(path.join(yggRoot, dir), { recursive: true });
    await writeFile(path.join(yggRoot, dir, '.gitkeep'), '', 'utf-8');
  }

  await writeFile(path.join(yggRoot, 'yg-config.yaml'), DEFAULT_CONFIG, 'utf-8');
  await writeFile(path.join(yggRoot, 'yg-architecture.yaml'), DEFAULT_ARCHITECTURE, 'utf-8');
  await ensureYggdrasilGitignore(yggRoot);
  // yg-secrets.yaml is created by writeSecretsFile when user provides an API key

  // A fresh project has no config to consult BEFORE this point — the file
  // scaffolded one line above is the first one there is — so a bootstrap
  // opt-out arrives as a flag and is RECORDED here, before the install reads
  // it. Recording is the whole point: without it the choice would live only in
  // that one invocation, `yg check` would go on reporting the artifact as
  // missing, and the next `yg init --upgrade` would write the file the user
  // just declined. Untouched defaults write nothing, so a plain `yg init`
  // produces the same config it always has, byte for byte.
  await writeRulesArtifactsConfig(yggRoot, artifacts);

  const report = await installRules(projectRoot, cliVersionStr, artifacts);
  await excludeScaffoldPlumbing(yggRoot, [...report.managed, '.gitattributes']);
}

/**
 * Write the repository plumbing a fresh init installs at the project root —
 * the agent-rules files it actually wrote, plus `.gitattributes` — into the
 * new config's `coverage.excluded`. These files are Yggdrasil's own, not
 * project source: left in coverage, the very first `yg check` lists them as
 * uncovered to-dos and every hint says to map or move them, which is the wrong
 * first move on every adoption. Only a FRESH scaffold does this — an existing
 * project's coverage settings are its owner's, and `yg init --upgrade` only
 * reports the stanza, never edits it.
 *
 * Edits the YAML document (not a re-serialized object) so the scaffold's
 * explanatory comments survive, exactly as writeRulesArtifactsConfig does.
 */
async function excludeScaffoldPlumbing(yggRoot: string, paths: string[]): Promise<void> {
  const configPath = path.join(yggRoot, 'yg-config.yaml');
  const doc = parseDocument(await readFile(configPath, 'utf-8'));
  doc.setIn(['coverage', 'excluded'], doc.createNode(paths));
  await writeFile(configPath, doc.toString(), 'utf-8');
}

/**
 * Record the repository's agent-rules artifact choice in its committed
 * `.yggdrasil/yg-config.yaml`, so `yg init` and `yg check` read the same
 * answer on every later run and on every teammate's machine.
 *
 * A no-op when all three artifacts are enabled: that is the default the absent
 * key already means, and writing it out would add a block to every config for
 * no change in behavior.
 *
 * Edits the YAML DOCUMENT rather than re-serializing a parsed object (which is
 * what the reviewer section's writer does): this file is scaffolded full of
 * explanatory comments and is meant to be read and hand-edited, so a write
 * that silently stripped every comment around the keys it did not touch would
 * cost the user more than the key is worth.
 */
export async function writeRulesArtifactsConfig(
  yggRoot: string,
  artifacts: RulesArtifactsConfig,
): Promise<void> {
  if (artifacts.agentsMd && artifacts.claudeMd && artifacts.clinerules) return;
  const configPath = path.join(yggRoot, 'yg-config.yaml');
  let existing = '';
  try {
    existing = await readFile(configPath, 'utf-8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    debugWrite(`[init] writeRulesArtifactsConfig: ${configPath} not found (ENOENT), starting fresh`);
  }
  const doc = parseDocument(existing);
  doc.setIn(['rules_artifacts', 'agents_md'], artifacts.agentsMd);
  doc.setIn(['rules_artifacts', 'claude_md'], artifacts.claudeMd);
  doc.setIn(['rules_artifacts', 'clinerules'], artifacts.clinerules);
  await writeFile(configPath, doc.toString(), 'utf-8');
}

/**
 * Whether the committed `.yggdrasil/yg-config.yaml` already says anything
 * about type-law ratification — on or off. Either answer is the owner's, and an
 * upgrade leaves it alone.
 */
export async function typeLawSettingPresent(yggRoot: string): Promise<boolean> {
  const doc = parseDocument(await readFile(path.join(yggRoot, 'yg-config.yaml'), 'utf-8'));
  return doc.has('type_law');
}

/**
 * Turn type-law ratification on in the committed configuration, with a comment
 * saying what it does. Edits the YAML document, like the writers above, so
 * every comment the owner kept survives.
 *
 * The block goes right after `version:`, not at the end: the last block of a
 * configuration is usually the reviewer's, and a key someone later appends to
 * the end of the file (a tier's setting) must still land where it was meant to.
 */
export async function writeTypeLawOn(yggRoot: string): Promise<void> {
  const configPath = path.join(yggRoot, 'yg-config.yaml');
  const doc = parseDocument(await readFile(configPath, 'utf-8'));
  if (!isMap(doc.contents)) {
    doc.setIn(['type_law', 'ratification'], true);
  } else {
    const pair = doc.createPair('type_law', { ratification: true });
    if (isScalar(pair.key)) {
      pair.key.commentBefore = ' A rule standing enforced on a node type needs a ratification of its current\n version in its own log (yg log add --aspect <id> --ratify); without one it\n is a blocking type-law-unratified finding. false asks for no ratification.';
    }
    const items = doc.contents.items;
    const afterVersion = items.findIndex((i) => isScalar(i.key) && i.key.value === 'version') + 1;
    items.splice(afterVersion, 0, pair as (typeof items)[number]);
  }
  await writeFile(configPath, doc.toString(), 'utf-8');
}

// ---------------------------------------------------------------------------
// Retired keys — removed by `yg init --upgrade`
// ---------------------------------------------------------------------------

/** One retired key an upgrade removed: the file (relative to the repository root) and where in it. */
export interface RetiredKeyRemoval {
  file: string;
  key: string;
  /** What became of the key, as the parser that refuses it words it. */
  reason: string;
}

/** Every file of `name` under `dir`, depth-first, sorted; symbolic links are never followed. */
async function filesNamed(dir: string, name: string, skipDir: (abs: string) => boolean = () => false): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e: unknown) {
    debugWrite(`[init] retired-key walk: ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    return out;
  }
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDir(abs)) out.push(...(await filesNamed(abs, name, skipDir)));
    } else if (entry.isFile() && entry.name === name) {
      out.push(abs);
    }
  }
  return out;
}

/** One file's planned edit: its new text and the keys it loses, or why it is left untouched. */
type FilePlan =
  | { kind: 'edit'; absPath: string; text: string; removals: RetiredKeyRemoval[] }
  | { kind: 'untouched'; file: string; reason: string };

/**
 * Plan the removal, from one YAML file, of every retired key the `targets`
 * callback finds in its parsed document. Nothing is written here: the caller
 * writes only once every file has been planned, so a file that cannot be
 * rewritten never leaves the others half-done.
 *
 * Edits the YAML DOCUMENT, so the comments and the other keys of the file stay
 * as written; a comment attached to a removed key goes with it, and the writer
 * may normalize indentation. A file that does not parse is left alone —
 * `yg check` names it — and so is one the writer cannot render back (an alias
 * whose anchor went with a removed key, say), which is reported as untouched.
 */
async function planFile(
  projectRoot: string,
  absPath: string,
  targets: (doc: Document) => Array<{ path: Array<string | number>; key: string; reason: string }>,
): Promise<FilePlan | null> {
  let text: string;
  try {
    text = await readFile(absPath, 'utf-8');
  } catch (e: unknown) {
    debugWrite(`[init] retired-key read: ${absPath}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return null;
  const found = targets(doc);
  if (found.length === 0) return null;
  const file = path.relative(projectRoot, absPath).split(path.sep).join('/');
  let rendered: string;
  try {
    for (const t of found) doc.deleteIn(t.path);
    rendered = doc.toString({ lineWidth: 0 });
  } catch (e: unknown) {
    return { kind: 'untouched', file, reason: e instanceof Error ? e.message : String(e) };
  }
  return { kind: 'edit', absPath, text: rendered, removals: found.map((t) => ({ file, key: t.key, reason: t.reason })) };
}

/** The keys of the mapping at `at` in `doc` that `retired` names, as removal targets. */
function retiredIn(doc: Document, at: Array<string | number>, retired: RetiredKeys, label: string): Array<{ path: Array<string | number>; key: string; reason: string }> {
  const node = at.length === 0 ? doc.contents : doc.getIn(at, true);
  if (!isMap(node)) return [];
  const out: Array<{ path: Array<string | number>; key: string; reason: string }> = [];
  for (const pair of node.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : undefined;
    if (key !== undefined && Object.prototype.hasOwnProperty.call(retired, key)) {
      out.push({ path: [...at, key], key: label === '' ? key : `${label}.${key}`, reason: retired[key] });
    }
  }
  return out;
}

/** The keys of the mapping at `at`; empty when it is not a mapping. */
function mapEntries(doc: Document, at: Array<string | number>): string[] {
  const node = doc.getIn(at, true);
  if (!isMap(node)) return [];
  return node.items.flatMap((pair) => (isScalar(pair.key) ? [String(pair.key.value)] : []));
}

/**
 * Remove every key an earlier release read and this one refuses, from every
 * graph and configuration file of the project: a node's `sizeExempt` and a
 * relation's `failure`, a node type's `sizeExempt`, a rule's `language`,
 * `stability`, `anchors` and `id`, and in `yg-config.yaml` and the local
 * `yg-secrets.yaml` the retired `quality.*` keys and the retired keys of each
 * tier's `config:`. The lists are the parsers' own, so an upgrade removes
 * exactly what `yg check` would otherwise refuse as retired, and nothing it
 * would refuse as a typo: a key nobody retired is the owner's to correct, and
 * guessing what it meant would be worse than naming it.
 *
 * Rules installed from a package are left alone: their files are the package's,
 * and editing them would break the record of what was installed.
 */
export interface RetiredKeysResult {
  /** Every retired key removed, one per key and file. */
  removed: RetiredKeyRemoval[];
  /** Files holding retired keys that were left as they were, and why. */
  untouched: Array<{ file: string; reason: string }>;
}

export async function stripRetiredKeys(projectRoot: string, yggRoot: string): Promise<RetiredKeysResult> {
  const plans: Array<FilePlan | null> = [];

  for (const name of ['yg-config.yaml', 'yg-secrets.yaml']) {
    plans.push((await planFile(projectRoot, path.join(yggRoot, name), (doc) => [
      ...retiredIn(doc, ['quality'], RETIRED_QUALITY_KEYS, 'quality'),
      ...mapEntries(doc, ['reviewer', 'tiers']).flatMap((tier) =>
        retiredIn(doc, ['reviewer', 'tiers', tier, 'config'], RETIRED_TIER_CONFIG_KEYS, `reviewer.tiers.${tier}.config`),
      ),
    ])));
  }

  plans.push((await planFile(projectRoot, path.join(yggRoot, 'yg-architecture.yaml'), (doc) =>
    mapEntries(doc, ['node_types']).flatMap((type) =>
      retiredIn(doc, ['node_types', type], RETIRED_NODE_TYPE_KEYS, `node_types.${type}`),
    ),
  )));

  for (const nodeFile of await filesNamed(path.join(yggRoot, 'model'), 'yg-node.yaml')) {
    plans.push((await planFile(projectRoot, nodeFile, (doc) => {
      const relations = doc.getIn(['relations'], true);
      const relationCount = isSeq(relations) ? relations.items.length : 0;
      return [
        ...retiredIn(doc, [], RETIRED_NODE_KEYS, ''),
        ...Array.from({ length: relationCount }, (_, i) => retiredIn(doc, ['relations', i], RETIRED_NODE_RELATION_KEYS, `relations[${i}]`)).flat(),
        ...mapEntries(doc, ['ports']).flatMap((port) => retiredIn(doc, ['ports', port], RETIRED_NODE_PORT_KEYS, `ports.${port}`)),
      ];
    })));
  }

  const packagesDir = path.join(yggRoot, 'aspects', 'packages');
  for (const aspectFile of await filesNamed(path.join(yggRoot, 'aspects'), 'yg-aspect.yaml', (abs) => abs === packagesDir)) {
    plans.push((await planFile(projectRoot, aspectFile, (doc) => retiredIn(doc, [], RETIRED_ASPECT_KEYS, ''))));
  }

  // Every file is planned before any is written: a file that cannot be rendered
  // back is found before anything changes on disk, and is the only one left as
  // it was.
  const result: RetiredKeysResult = { removed: [], untouched: [] };
  for (const plan of plans) {
    if (plan === null) continue;
    if (plan.kind === 'untouched') {
      result.untouched.push({ file: plan.file, reason: plan.reason });
      continue;
    }
    await writeFile(plan.absPath, plan.text, 'utf-8');
    result.removed.push(...plan.removals);
  }
  return result;
}
