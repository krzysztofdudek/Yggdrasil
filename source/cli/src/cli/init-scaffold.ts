import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CONFIG, DEFAULT_ARCHITECTURE } from '../templates/default-config.js';
import { installRules } from '../templates/platform.js';
import { debugWrite } from '../utils/debug-log.js';
import { FILL_DIVERGENCE_GITIGNORE_LINE } from '../io/debug-log-writer.js';

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
 *    - the committed LLM-fill events stream's merge=union line — that stream is a
 *      COMMITTED, opt-in shared record of LLM verification-fill events appended on
 *      many branches, so a union merge keeps every branch's events instead of
 *      forcing a conflict on the append-only file. (The file itself only exists
 *      once a repo opts in via `events: { committed_llm: true }`; the attribute is
 *      harmless when the file is absent.)
 *  Single source of truth for what init writes into the repo-root .gitattributes
 *  (both fresh init and every --upgrade). */
const GITATTRIBUTES_LINES = [
  '/.yggdrasil/yg-lock.*.json linguist-generated=true',
  '/.yggdrasil/advise-decisions.jsonl merge=union',
  '/.yggdrasil/yg-events.llm.jsonl merge=union',
] as const;

/**
 * Ensure the repo-root .gitattributes carries every line Yggdrasil manages (see
 * {@link GITATTRIBUTES_LINES}).
 *
 * Idempotent: creates the file with all lines when absent; appends only the
 * missing line(s), once each, when the file exists without them (preserving any
 * other content and ensuring a separating newline); no-op when every line is
 * already present. Run on fresh init AND every --upgrade so existing adopters
 * pick up the complete set.
 */
export async function ensureGitattributes(repoRoot: string): Promise<void> {
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
    return;
  }

  const presentLines = new Set(existing.split('\n').map((line) => line.trim()));
  const missing = GITATTRIBUTES_LINES.filter((line) => !presentLines.has(line));
  if (missing.length === 0) return;

  // Append each missing line once, guaranteeing a newline boundary before and after.
  const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  await writeFile(gaPath, `${existing}${sep}${missing.join('\n')}\n`, 'utf-8');
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
 *    - `.debug.log`       — the opt-in command debug log
 *    - `.yg-events.jsonl` — the fill stage's append-only verdict-events telemetry sidecar
 *    - `.yg-fill-divergence.log` — the fill stage's convergence-sentinel evidence dump
 *    - `.feature-field.json` — `yg check`'s silent structural-deviation attention index
 *  This is the single source of truth for what init writes into the local
 *  gitignore (both fresh init and every --upgrade). Paths are relative to the
 *  `.yggdrasil/` directory the file lives in. */
const YGGDRASIL_GITIGNORE_LINES = [
  'yg-secrets.yaml',
  '.symbols-cache/',
  // Content-addressed per-file AST fact cache: a local speed cache the relation pass rebuilds
  // free on the next run; never committed.
  '.ast-cache/',
  '.debug.log',
  // Deterministic-verdict lock: a local cache rebuilt for free by
  // `yg check --approve --only-deterministic`; never committed.
  '.yg-lock.deterministic.json',
  // Append-only verdict-events telemetry sidecar: local, write-only, never read by
  // any check/verify/render path; never committed.
  '.yg-events.jsonl',
  // Convergence-sentinel evidence dump: local, best-effort forensic log written
  // only when the fill detects a 0-fill divergence; never committed. The trailing
  // `*` also covers the single `.1` rotation. Pattern shared with the writer
  // (io/debug-log-writer) so the two can never drift.
  FILL_DIVERGENCE_GITIGNORE_LINE,
  // Silent feature-field deviation index: a local, rebuildable attention index `yg check`
  // maintains (files structurally unusual among their node's same-language peers); never
  // committed. The writer (core/feature-index-write) self-ensures this same line as a backstop.
  '.feature-field.json',
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
 * adopters pick up the complete set.
 */
export async function ensureYggdrasilGitignore(yggRoot: string): Promise<void> {
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
    return;
  }

  const presentLines = new Set(existing.split('\n').map((line) => line.trim()));
  const missing = YGGDRASIL_GITIGNORE_LINES.filter((line) => !presentLines.has(line));
  if (missing.length === 0) return;

  // Append each missing line once, guaranteeing a newline boundary before and after.
  const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  await writeFile(giPath, `${existing}${sep}${missing.join('\n')}\n`, 'utf-8');
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
): Promise<void> {
  await mkdir(path.join(yggRoot, 'model'), { recursive: true });
  await mkdir(path.join(yggRoot, 'aspects'), { recursive: true });
  await mkdir(path.join(yggRoot, 'flows'), { recursive: true });

  await writeFile(path.join(yggRoot, 'yg-config.yaml'), DEFAULT_CONFIG, 'utf-8');
  await writeFile(path.join(yggRoot, 'yg-architecture.yaml'), DEFAULT_ARCHITECTURE, 'utf-8');
  await ensureYggdrasilGitignore(yggRoot);
  // yg-secrets.yaml is created by writeSecretsFile when user provides an API key

  await installRules(projectRoot, cliVersionStr);
}
