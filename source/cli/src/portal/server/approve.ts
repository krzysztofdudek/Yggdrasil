import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * server/approve — the portal's ONE write action, and its free cost preview.
 *
 * Approve is an OUT-OF-PROCESS shell of the existing CLI: it spawns the running `yg`
 * binary to run `check --approve` (plus `--only-deterministic` when the LLM checkbox is
 * off). The server NEVER re-implements fill, NEVER imports a lock writer, and NEVER reads
 * secrets — the spawned CLI owns keys and the lock write exactly as on the command line.
 * The dry-run preview shells the SAME command with `--dry-run`, so the count the button
 * shows is the engine's own budget, never a re-derived number.
 */

/**
 * Resolve the `yg` CLI binary the approve/dry-run shells re-enter — a constant bin
 * reference, never an env-impersonable value. In the published build this module is bundled
 * into dist/bin.js, so its own URL IS the bin. Running from source (tests), it walks up to
 * the sibling dist/bin.js. The launching entry script (process.argv[1]) is the final
 * fallback — the actual `yg` bin when invoked on the command line.
 */
function resolveCliBin(): string {
  const here = fileURLToPath(import.meta.url);
  if (path.basename(here) === 'bin.js') return here;
  // Walk up from src/portal/server/approve.ts to the package root, then dist/bin.js.
  let dir = path.dirname(here);
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'dist', 'bin.js');
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return process.argv[1];
}

// The running CLI binary, captured once at module load as the constant bin reference; the
// spawned child re-enters this same binary. Resolved without any env / runtime impersonation.
const CLI_BIN = resolveCliBin();

/** Result of a shelled approve: the child's exit code and captured output. */
export interface ApproveResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Build the literal CLI argument vector for an approve. `llm:false` adds the free flag. */
function approveArgs(llm: boolean): string[] {
  // Literal command + literal fill flag. `--only-deterministic` is the free, keyless path.
  return llm ? ['check', '--approve'] : ['check', '--approve', '--only-deterministic'];
}

/** The literal argument vector for the dry-run cost preview (never writes). */
function dryRunArgs(llm: boolean): string[] {
  return llm
    ? ['check', '--approve', '--dry-run', '--json']
    : ['check', '--approve', '--only-deterministic', '--dry-run', '--json'];
}

/** Spawn the CLI binary in `cwd` with `args`, capturing stdout/stderr and the exit code. */
function spawnCli(args: string[], cwd: string): Promise<ApproveResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf-8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf-8')));
    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}

/**
 * The approval lock file the CLI holds for the length of `yg check --approve`. Spelled
 * here rather than imported: the server declares no relation to the engine's stores (a
 * test pins this spelling to the store's own constant).
 */
export const APPROVE_LOCK_PATH = path.join('.yggdrasil', '.yg-approve.lock');

/** Approvals this server has spawned and not yet seen finish, per project root. */
const approvesInFlight = new Set<string>();

/**
 * Whether an approval is running in `projectRoot` right now: one this server spawned, or
 * one started anywhere else (a terminal, an agent) that holds the CLI's approval lock.
 * A lock whose holder process is gone on this machine does not count — the CLI replaces
 * such a lock itself. This is the early answer for the button; the spawned CLI's own
 * lock remains the guard that cannot race.
 */
export function approveInProgress(projectRoot: string): boolean {
  if (approvesInFlight.has(projectRoot)) return true;
  let holder: { pid?: unknown; host?: unknown };
  try {
    holder = JSON.parse(readFileSync(path.join(projectRoot, APPROVE_LOCK_PATH), 'utf-8')) as { pid?: unknown; host?: unknown };
  } catch {
    return false;
  }
  if (typeof holder.pid !== 'number' || holder.host !== hostname()) return true;
  try {
    process.kill(holder.pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Run the ONE write — shell `yg check --approve` (with `--only-deterministic` when `llm`
 * is false) in `projectRoot`. The spawned CLI fills the unverified pairs and owns secrets.
 * The caller checks {@link approveInProgress} first; this marks the run in flight until the
 * child exits, so a second click while it runs is refused rather than queued.
 */
export async function runApproveViaCli(projectRoot: string, llm: boolean): Promise<ApproveResult> {
  approvesInFlight.add(projectRoot);
  try {
    return await spawnCli(approveArgs(llm), projectRoot);
  } finally {
    approvesInFlight.delete(projectRoot);
  }
}

/** The dry-run cost preview, parsed from the CLI's own budget output. */
export interface DryRunPreview {
  /** Pairs the fill would touch (0 when everything is already verified). */
  pairs: number;
  /** Deterministic pairs in that set (free). */
  deterministic: number;
  /** Reviewer calls the fill would make (consensus included) — an upper bound. */
  reviewerCalls: number;
  /** The raw budget line, surfaced verbatim so the preview is never silently re-derived. */
  raw: string;
}

/**
 * Read the cost preview out of the CLI's `yg-check/1` document (stdout of
 * `--dry-run --json`), which carries it as numbers in `dryRunBudget`. The human
 * header the CLI prints on stderr is never parsed for numbers — its wording is free
 * to change — and is only carried verbatim as `raw` for display when present.
 * Pure (no I/O); throws when the document is unreadable or carries no budget (a
 * dry-run always carries one — its absence means no preview ran).
 */
export function parseDryRunBudget(stdout: string, stderr: string): DryRunPreview {
  let budget: { pairs?: unknown; deterministic?: unknown; reviewerCalls?: unknown } | undefined;
  try {
    budget = (JSON.parse(stdout) as { dryRunBudget?: typeof budget }).dryRunBudget;
  } catch {
    budget = undefined;
  }
  if (
    budget === undefined ||
    typeof budget.pairs !== 'number' ||
    typeof budget.deterministic !== 'number' ||
    typeof budget.reviewerCalls !== 'number'
  ) {
    throw new Error(
      `Could not read the dry-run cost preview from the CLI's JSON document. Raw output:\n${`${stdout}\n${stderr}`.trim()}`,
    );
  }
  // The fill's own first line (`fill  N pairs · D script (free) · R reviewer calls`),
  // after the dry-run line that says what the run is.
  const headerLine = stderr.split('\n').find((l) => /^fill {2}\d/.test(l));
  return {
    pairs: budget.pairs,
    deterministic: budget.deterministic,
    reviewerCalls: budget.reviewerCalls,
    raw: headerLine?.trim() ?? `${budget.pairs} pairs — ${budget.deterministic} deterministic (no cost), ${budget.reviewerCalls} reviewer calls`,
  };
}

/**
 * Preview the cost of an Approve without writing or calling the reviewer: shell
 * `yg check --approve --dry-run` and parse its budget header. The numbers are the engine's
 * own (never re-implemented); the raw line is carried verbatim for honest display.
 */
export async function dryRunApproveViaCli(projectRoot: string, llm: boolean): Promise<DryRunPreview> {
  const result = await spawnCli(dryRunArgs(llm), projectRoot);
  return parseDryRunBudget(result.stdout, result.stderr);
}
