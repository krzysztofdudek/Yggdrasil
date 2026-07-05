import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CONFIG, DEFAULT_ARCHITECTURE } from '../templates/default-config.js';
import { installRulesForPlatform, type Platform } from '../templates/platform.js';
import { debugWrite } from '../utils/debug-log.js';

// ---------------------------------------------------------------------------
// .gitattributes — mark the committed lock as generated
// ---------------------------------------------------------------------------

/** The exact .gitattributes line that marks the committed lock files as generated for
 *  diff/review tools. The glob covers the triad's committed members
 *  (yg-lock.nondeterministic.json, yg-lock.logs.json); the gitignored deterministic
 *  cache is never committed, so it needs no attribute. */
const GITATTRIBUTES_LOCK_LINE = '/.yggdrasil/yg-lock.*.json linguist-generated=true';

/**
 * Ensure the repo-root .gitattributes carries the lock's linguist-generated
 * line (spec §8). The lock is committed but machine-written — marking it
 * generated keeps it out of language stats and collapses it in review diffs.
 *
 * Idempotent: creates the file with the single line when absent; appends the
 * line exactly once when the file exists without it (preserving other content
 * and ensuring a separating newline); no-op when the line is already present.
 * Run on fresh init AND every --upgrade so existing adopters pick it up.
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
    await writeFile(gaPath, `${GITATTRIBUTES_LOCK_LINE}\n`, 'utf-8');
    return;
  }

  // Already present (anywhere, as a full line) → nothing to do.
  const hasLine = existing
    .split('\n')
    .some((line) => line.trim() === GITATTRIBUTES_LOCK_LINE);
  if (hasLine) return;

  // Append once, guaranteeing a newline boundary before and after.
  const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  await writeFile(gaPath, `${existing}${sep}${GITATTRIBUTES_LOCK_LINE}\n`, 'utf-8');
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
// Fresh .yggdrasil/ structure + platform rules
// ---------------------------------------------------------------------------

export async function createYggdrasilStructure(
  projectRoot: string,
  yggRoot: string,
  platform: Platform,
): Promise<void> {
  await mkdir(path.join(yggRoot, 'model'), { recursive: true });
  await mkdir(path.join(yggRoot, 'aspects'), { recursive: true });
  await mkdir(path.join(yggRoot, 'flows'), { recursive: true });

  await writeFile(path.join(yggRoot, 'yg-config.yaml'), DEFAULT_CONFIG, 'utf-8');
  await writeFile(path.join(yggRoot, 'yg-architecture.yaml'), DEFAULT_ARCHITECTURE, 'utf-8');
  await ensureYggdrasilGitignore(yggRoot);
  // yg-secrets.yaml is created by writeSecretsFile when user provides an API key

  await installRulesForPlatform(projectRoot, platform);
}
