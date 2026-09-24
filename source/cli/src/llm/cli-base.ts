import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LlmProvider, AspectResponse, ReviewerUsage } from './types.js';
import { debugWrite } from '../utils/debug-log.js';
import { probeBinary } from '../utils/binary-check.js';
import { redactedTail, redactSecrets } from '../utils/redact.js';

/**
 * Coerce a verdict value: a JSON boolean OR a quoted "true"/"false" string
 * (case-insensitive). Models emit both shapes; a bare `false` and a `"false"`
 * string must read identically. Returns undefined when it is neither.
 */
function coerceBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return undefined;
}

function normalizeResponse(raw: unknown): AspectResponse {
  const r = raw as Record<string, unknown>;
  return {
    satisfied: coerceBool(r.satisfied) ?? false,
    reason: typeof r.reason === 'string' ? r.reason : '',
    errorSource: 'codeViolation',
  };
}

/**
 * A syntactically valid JSON.parse result is only a VERDICT when it is a plain
 * object carrying a coercible boolean `satisfied` field — the same gate
 * extractLastVerdict applies (line: `coerceBool(obj.satisfied) !== undefined`).
 * Steps 1/2 use this so an array-wrapped verdict, a bare primitive, or an object
 * with a renamed/missing verdict field does NOT short-circuit into a false
 * `satisfied: false` codeViolation refusal; instead it falls through to the
 * recovery/fail-closed steps (3–5), matching the documented A3b contract.
 */
function isVerdictObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    coerceBool((v as Record<string, unknown>).satisfied) !== undefined
  );
}

/**
 * Last-resort salvage for a reply that is a CLEAR verdict object but invalid JSON
 * — an unescaped `"` inside the long `reason`, a missing closing `"}`, or
 * chain-of-thought leaked into the reason string. We read the verdict FIELD
 * itself (`"satisfied": true|false`, value optionally quoted) — never a bare word
 * in prose, so a garbled non-verdict reply still yields nothing here (A3b: no
 * false PASS from arbitrary text). The `reason` is grabbed best-effort as raw
 * text: it is only report copy, so it need not be valid JSON.
 */
function salvageVerdict(text: string): AspectResponse | undefined {
  if (!text.includes('{')) return undefined; // must be a JSON-object attempt
  const verdicts = [...text.matchAll(/"satisfied"\s*:\s*"?(true|false)"?/gi)];
  if (verdicts.length === 0) return undefined;
  const satisfied = verdicts[verdicts.length - 1][1].toLowerCase() === 'true';

  let reason = '';
  const rms = [...text.matchAll(/"reason"\s*:\s*"/g)];
  if (rms.length > 0) {
    const m = rms[rms.length - 1];
    reason = text
      .slice((m.index ?? 0) + m[0].length)
      .split(/"\s*,\s*"satisfied"\s*:/i)[0] // stop if a sibling verdict field follows
      .replace(/\s*}\s*$/, '') // trailing object close
      .replace(/"\s*$/, '') // reason's closing quote, if present
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\\\/g, '\\')
      .trim();
  }

  debugWrite('[parseAspectResponse] salvaged verdict from invalid-JSON reply');
  return {
    satisfied,
    reason: reason || '(verdict salvaged; reviewer reason was not valid JSON)',
    errorSource: 'codeViolation',
  };
}

/**
 * Scan `text` for balanced `{...}` spans (respecting string literals and escapes)
 * and return the LAST one that parses to an object carrying a boolean `satisfied`
 * field — i.e. the actual verdict. A greedy `\{[\s\S]*\}` cannot be used: a model
 * that wraps its JSON verdict in prose (markdown analysis, code snippets, the
 * literal text `{ what, why, next }`) has brace characters BEFORE the verdict, so
 * a greedy match spans unrelated braces and fails to parse. Requiring a boolean
 * `satisfied` key means brace-laden prose without a real verdict still yields
 * nothing here (→ fail closed), preserving the A3b guarantee.
 */
function extractLastVerdict(text: string): Record<string, unknown> | undefined {
  let last: Record<string, unknown> | undefined;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try {
            const obj = JSON.parse(text.slice(i, j + 1)) as Record<string, unknown>;
            if (obj && coerceBool(obj.satisfied) !== undefined) last = obj;
          } catch { /* not a JSON object — keep scanning */ }
          break;
        }
      }
    }
  }
  return last;
}

export function parseAspectResponse(output: string): AspectResponse | undefined {
  const trimmed = output.trim();
  if (!trimmed) {
    // Diagnostic (debug:true only): an empty reply is the common ollama failure
    // when a thinking model spends its whole budget in the reasoning channel and
    // emits no verdict in `content`. Note it so the failure is not invisible.
    debugWrite('[parseAspectResponse] reviewer returned an empty reply — nothing to parse');
    return undefined;
  }

  // 1. Direct JSON — only short-circuit when the parsed value is actually a
  // verdict object; a valid-but-wrong-shape reply (array-wrapped, primitive, or
  // renamed field) must fall through to recovery/fail-closed rather than becoming
  // a false codeViolation refusal.
  try { const parsed = JSON.parse(trimmed); if (isVerdictObject(parsed)) return normalizeResponse(parsed); } catch (err) { debugWrite(`[parseAspectResponse] direct JSON parse failed: ${(err as Error).message}`); }

  // 2. Markdown fence — same verdict-shape gate as step 1.
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try { const parsed = JSON.parse(fenceMatch[1].trim()); if (isVerdictObject(parsed)) return normalizeResponse(parsed); } catch (err) { debugWrite(`[parseAspectResponse] fence JSON parse failed: ${(err as Error).message}`); }
  }

  // 3. Embedded JSON verdict — the model may emit its JSON verdict surrounded by
  // prose that itself contains braces, so locate the balanced object that holds a
  // boolean `satisfied` rather than greedy-matching the outermost braces.
  const verdict = extractLastVerdict(trimmed);
  if (verdict) return normalizeResponse(verdict);

  // 4. Salvage a clear verdict FIELD from invalid JSON — an unescaped `"` in the
  // reason, a missing closing `"}`, or leaked chain-of-thought. Reads the
  // `"satisfied": true|false` field (not a prose word), so A3b still holds: a
  // garbled reply without that field yields nothing and falls through to (5).
  const salvaged = salvageVerdict(trimmed);
  if (salvaged) return salvaged;

  // 5. Unparseable response — no valid JSON verdict found. Do NOT heuristically
  // guess "satisfied" from a substring match: a garbled/non-JSON reply that happens
  // to contain the word would become a false code-PASS that commits green over
  // unverified code (A3b). Classify it as a PROVIDER (infrastructure) error so the
  // fail-closed gate refuses without committing.
  // Diagnostic (debug:true only): dump the FULL raw reply so an unparseable
  // verdict can actually be inspected — the provider-error `reason` carries only
  // the first 160 chars, which is rarely enough to see why parsing failed (e.g. a
  // leaked thinking wrapper, a differently-named field, a missing `satisfied`).
  // `output` is the raw text already in hand here; it is not one of the redaction-
  // gated identifier names (prompt/response/content/body), and the log is a
  // private, opt-in local file.
  debugWrite(`[parseAspectResponse] no parseable JSON verdict — classifying as provider error. Raw reply (${output.length} chars): ${output}`);
  return { satisfied: false, reason: `Unparseable reviewer response: ${trimmed.slice(0, 160)}`, errorSource: 'provider' };
}

// Grace period between SIGTERM and the escalated SIGKILL when a reviewer
// subprocess overruns its timeout. Bounds how long a SIGTERM-ignoring child can
// keep yg check waiting before it is force-killed.
const SIGKILL_GRACE_MS = 5_000;

/**
 * Whether a reviewer binary can only be started through a shell: an npm-installed
 * CLI on Windows is a `.cmd` shim (`claude.cmd`, `codex.cmd`, `gemini.cmd`), which
 * a bare process spawn cannot launch — the same reason the availability probe
 * (utils/binary-check.ts) runs through a shell there. A bare name on Windows is
 * resolved by the shell through PATHEXT; an `.exe` or any POSIX binary is spawned
 * directly.
 */
export function needsShellToSpawn(binary: string, platform: NodeJS.Platform = process.platform): boolean {
  if (/\.(cmd|bat)$/i.test(binary)) return true;
  return platform === 'win32' && path.extname(binary) === '';
}

/** A model name safe to pass as an argument when the reviewer starts through a shell. */
const SHELL_SAFE_MODEL = /^[A-Za-z0-9._:-]+$/;

/**
 * Reviewer process groups still running. On POSIX each reviewer is spawned as the
 * leader of its own process group, so a timeout can end everything it started (a
 * helper process that inherited its pipes would otherwise keep the call open).
 * The flip side is that a terminal's Ctrl-C no longer reaches those groups, so an
 * interrupt of this process ends them first, then takes its default course.
 */
const liveReviewerGroups = new Set<number>();

function endReviewerGroups(): void {
  for (const pid of liveReviewerGroups) {
    try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  liveReviewerGroups.clear();
}

function onInterrupt(signal: NodeJS.Signals): void {
  endReviewerGroups();
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onInterrupt);
  process.kill(process.pid, signal);
}

function trackReviewerGroup(child: ChildProcess): void {
  if (process.platform === 'win32' || child.pid === undefined) return;
  if (liveReviewerGroups.size === 0) {
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onInterrupt);
    process.once('exit', endReviewerGroups);
  }
  liveReviewerGroups.add(child.pid);
  child.once('exit', () => {
    if (child.pid !== undefined) liveReviewerGroups.delete(child.pid);
    if (liveReviewerGroups.size === 0) {
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onInterrupt);
      process.removeListener('exit', endReviewerGroups);
    }
  });
}

/** Remove a call's private working directory; best effort, never throws. */
function removeWorkDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch (err) {
    debugWrite(`[cli-base] could not remove ${dir}: ${(err as Error).message}`);
  }
}

/** Signal the reviewer's whole process group (POSIX), falling back to the child alone. */
function killReviewer(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch { /* the group is gone — signal the child itself */ }
  }
  child.kill(signal);
}

export abstract class CliAgentProvider implements LlmProvider {
  protected model: string;
  protected timeout: number;

  constructor(config: { model: string; timeout?: number }) {
    this.model = config.model;
    // Default 300s (was 120s). A large node's per-aspect prompt (many source
    // files + references) can take ~100-300s through a CLI provider; 120s was
    // tight enough that big-node reviews intermittently timed out as a spurious
    // "Reviewer unavailable". Keeping nodes small (node-size error) is the real
    // fix; this default just stops the boundary flakiness. Tunable via config.timeout.
    this.timeout = config.timeout ?? 300_000;
  }

  abstract get binary(): string;
  /**
   * The reviewer's argv. `workDir` is the call's private working directory when
   * the provider asks for one (see usesPrivateWorkDir), so flags can name files
   * written there; undefined otherwise.
   */
  abstract buildArgs(prompt: string, workDir?: string): string[];
  abstract get stdinMode(): boolean;
  /**
   * Whether each call runs in a fresh, empty directory of its own instead of the
   * shared temp directory. A CLI that loads instructions, settings, hooks or
   * policies from its working directory (an AGENTS.md, a .gemini/ or .codex/
   * folder that anything on the machine could have left in the shared temp
   * directory) must not find any there; the directory also holds whatever files
   * the provider's flags point at (prepareWorkDir), and is removed when the call
   * settles, whatever the outcome.
   */
  protected get usesPrivateWorkDir(): boolean { return false; }
  /** Write the files this provider's flags name into the call's private directory. */
  protected prepareWorkDir(_dir: string): void { /* nothing by default */ }
  /** Variables a provider sets on top of the caller's environment. */
  protected get extraEnv(): Record<string, string> { return {}; }
  /**
   * Whether the binary must be started through a shell: a Windows `.cmd`/`.bat` shim cannot be
   * spawned directly (see needsShellToSpawn). Through a shell, the arguments are fixed flags plus
   * the model name — checked in verifyAspect before it can reach the shell — and the prompt goes
   * on stdin, so nothing a repository wrote reaches the shell.
   */
  protected get spawnShell(): boolean { return needsShellToSpawn(this.binary); }

  /**
   * How to get this provider's CLI, for the unavailable reason — e.g. the npm
   * package that installs it. Each concrete provider names its own.
   */
  protected get installHint(): string { return `install '${this.binary}' and put it on PATH`; }

  /**
   * Split what the CLI printed into the model's reply and, when the CLI reports
   * it, what the call consumed. The default is the whole of stdout as the reply
   * with no usage; a provider that runs its CLI in a structured output mode
   * overrides this to unwrap the envelope (claude-code). A reply the override
   * cannot unwrap must come back as raw stdout, never as an error — the verdict
   * parser then decides, exactly as it did before the override existed.
   */
  protected extractReply(stdout: string): { reply: string; usage?: ReviewerUsage; error?: string } {
    return { reply: stdout };
  }

  /** Why the last isAvailable() said no, as the binary probe worded it. */
  protected lastProbeFailure = '';

  async isAvailable(): Promise<boolean> {
    const probe = await probeBinary(this.binary);
    this.lastProbeFailure = probe.ok ? '' : probe.detail;
    return probe.ok;
  }

  async unavailableReason(): Promise<string> {
    return `${this.lastProbeFailure || `'${this.binary}' could not be run`} — ${this.installHint}`;
  }

  /**
   * The reason a failed run reports: which way it failed (timed out, exit code,
   * killed by a signal, exited cleanly with no verdict) and the last few hundred
   * characters of what the CLI printed, credentials masked. The CLI's own words
   * are usually the diagnosis — "please run /login", "unknown model", a policy
   * refusal — so they go into the reason, not only into the debug log.
   */
  private describeFailure(how: string, stderr: string, stdout: string): string {
    const said = redactedTail(stderr) || redactedTail(stdout);
    return `'${this.binary}' ${how}${said ? `: ${said}` : ' and printed nothing'}`;
  }

  async verifyAspect(prompt: string): Promise<AspectResponse> {
    const failed = (reason: string): AspectResponse => ({ satisfied: false, reason, errorSource: 'provider' });
    const shell = this.spawnShell;
    if (shell && !SHELL_SAFE_MODEL.test(this.model)) {
      return failed(`${this.binary} model '${this.model}' is not a model name (letters, digits, '.', '_', ':' and '-' only)`);
    }

    let workDir: string | undefined;
    if (this.usesPrivateWorkDir) {
      try {
        workDir = mkdtempSync(path.join(tmpdir(), 'yg-reviewer-'));
        this.prepareWorkDir(workDir);
      } catch (err) {
        if (workDir !== undefined) removeWorkDir(workDir);
        return failed(`could not prepare a private working directory for '${this.binary}' (${err instanceof Error ? err.message : String(err)})`);
      }
    }

    return new Promise<AspectResponse>((resolveCall) => {
      const resolve = (r: AspectResponse): void => {
        if (workDir !== undefined) removeWorkDir(workDir);
        resolveCall(r);
      };
      const built = this.stdinMode ? this.buildArgs('', workDir) : this.buildArgs(prompt, workDir);
      // Through a shell the arguments are joined into one command line, so a
      // private directory under a temp path with a space in it (a Windows
      // profile name) would split in two; quote those. The rest are fixed flags
      // and a model name already checked above.
      const args = shell ? built.map((a) => (/\s/.test(a) && !a.includes('"') ? `"${a}"` : a)) : built;
      let child: ChildProcess & { stdin: NonNullable<ChildProcess['stdin']>; stdout: NonNullable<ChildProcess['stdout']>; stderr: NonNullable<ChildProcess['stderr']> };
      try {
        child = spawn(this.binary, args, {
          shell,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: this.timeout,
          cwd: workDir ?? tmpdir(),
          env: { ...process.env, ...this.extraEnv },
          // Its own process group on POSIX, so the timeout below can end
          // everything the reviewer started (see killReviewer).
          detached: process.platform !== 'win32',
        }) as typeof child;
      } catch (err) {
        // A spawn can also fail synchronously (an argument the OS rejects);
        // that is the same provider failure as an asynchronous spawn error.
        const msg = `'${this.binary}' could not be started (${err instanceof Error ? err.message : String(err)}) — ${this.installHint}`;
        debugWrite(`[${this.binary}] spawn threw: ${msg}`);
        resolve(failed(msg));
        return;
      }
      trackReviewerGroup(child);

      let stdout = '';
      let stderr = '';
      let killed = false;
      let settled = false;
      const started = Date.now();
      let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
      const settle = (r: AspectResponse): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(sigkillTimer);
        resolve(r);
      };
      const timedOut = (): AspectResponse => failed(this.describeFailure(
        `timed out after ${Math.round(this.timeout / 1000)}s (config.timeout, in seconds; default 300)`, stderr, stdout,
      ));

      const timer = setTimeout(() => {
        killed = true;
        debugWrite(`[${this.binary}] timeout after ${this.timeout}ms; stderr tail: ${redactSecrets(stderr.slice(-500))}`);
        killReviewer(child, 'SIGTERM');
        // Escalate: a child that ignores SIGTERM would otherwise hang yg check
        // indefinitely. Give it a short grace period, then force SIGKILL so the
        // reviewer call always terminates.
        sigkillTimer = setTimeout(() => {
          debugWrite(`[${this.binary}] still alive ${SIGKILL_GRACE_MS}ms after SIGTERM; sending SIGKILL`);
          killReviewer(child, 'SIGKILL');
          // A grandchild that inherited the pipes can hold them open after the
          // child itself is gone (outside the group, or on Windows), so 'close'
          // may never come: answer now.
          settle(timedOut());
        }, SIGKILL_GRACE_MS);
      }, this.timeout);

      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      // Drain stderr too. With stdio stderr piped but unread, a child that writes
      // more than the ~64KB pipe buffer blocks on its stderr write and never exits —
      // a deadlock that presents as a spurious timeout on large prompts. Reading it
      // keeps the pipe flowing and preserves diagnostics.
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      child.on('error', (err) => {
        const isE2BIG = (err as NodeJS.ErrnoException).code === 'E2BIG';
        const isENOENT = (err as NodeJS.ErrnoException).code === 'ENOENT';
        const msg = isE2BIG
          ? 'Prompt too large for CLI arg mode'
          : isENOENT
            ? `'${this.binary}' was not found on PATH — ${this.installHint}`
            : `'${this.binary}' could not be started (${err.message}) — ${this.installHint}`;
        debugWrite(`[${this.binary}] ${msg}`);
        settle(failed(msg));
      });
      child.on('close', (code, signal) => {
        // The spawn's own timeout option can kill the child a moment before our
        // timer marks it, so a signal at or past the deadline is a timeout too.
        if (killed || (signal !== null && Date.now() - started >= this.timeout)) {
          settle(timedOut());
          return;
        }
        if (code !== 0) {
          // The whole stderr goes to the debug log; the reason carries its tail.
          debugWrite(`[${this.binary}] exit_code=${code} signal=${signal ?? 'none'}; stderr: ${redactSecrets(stderr)}`);
          // A structured-output CLI puts its own error message inside the
          // envelope; quote that rather than the envelope's JSON tail.
          const said = this.extractReply(stdout).error ?? stdout;
          settle(failed(this.describeFailure(code === null ? `was killed by ${signal ?? 'a signal'}` : `exited with code ${code}`, stderr, said)));
          return;
        }
        const { reply, usage, error } = this.extractReply(stdout);
        if (error !== undefined) {
          settle(failed(`'${this.binary}' reported an error: ${redactSecrets(error).slice(0, 400)}`));
          return;
        }
        const parsed = parseAspectResponse(reply);
        settle(parsed === undefined
          ? failed(this.describeFailure('exited 0 without a verdict', stderr, ''))
          : usage !== undefined ? { ...parsed, usage } : parsed);
      });

      // A reviewer that exits without reading its prompt (an expired login, a
      // rejected flag) closes the pipe under this write: EPIPE. Without a
      // listener that is an unhandled 'error' that kills the whole run; with it,
      // the child's exit settles the call through 'close' as a provider failure
      // that carries what the CLI printed.
      child.stdin.on('error', (err) => {
        debugWrite(`[${this.binary}] stdin: ${err.message} — the reviewer exited before reading the prompt`);
      });
      if (this.stdinMode) {
        child.stdin.write(prompt);
        child.stdin.end();
      } else {
        child.stdin.end();
      }
    });
  }
}
