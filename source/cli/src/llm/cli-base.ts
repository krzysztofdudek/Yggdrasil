import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { LlmProvider, AspectResponse } from './types.js';
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
  abstract buildArgs(prompt: string): string[];
  abstract get stdinMode(): boolean;
  /** Variables a provider sets on top of the caller's environment. */
  protected get extraEnv(): Record<string, string> { return {}; }
  /**
   * Whether the binary must be started through a shell: a Windows `.cmd`/`.bat` shim cannot be
   * spawned directly. A provider that says yes passes only fixed flags and validated values as
   * arguments, and the prompt on stdin, so nothing a repository wrote reaches the shell.
   */
  protected get spawnShell(): boolean { return false; }

  /**
   * How to get this provider's CLI, for the unavailable reason — e.g. the npm
   * package that installs it. Each concrete provider names its own.
   */
  protected get installHint(): string { return `install '${this.binary}' and put it on PATH`; }

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

    return new Promise((resolve) => {
      const args = this.stdinMode ? this.buildArgs('') : this.buildArgs(prompt);
      const child = spawn(this.binary, args, {
        shell: this.spawnShell,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: this.timeout,
        cwd: tmpdir(),
        env: { ...process.env, ...this.extraEnv },
      });

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
        child.kill('SIGTERM');
        // Escalate: a child that ignores SIGTERM would otherwise hang yg check
        // indefinitely. Give it a short grace period, then force SIGKILL so the
        // reviewer call always terminates.
        sigkillTimer = setTimeout(() => {
          debugWrite(`[${this.binary}] still alive ${SIGKILL_GRACE_MS}ms after SIGTERM; sending SIGKILL`);
          child.kill('SIGKILL');
          // A grandchild that inherited the pipes can hold them open after the
          // child itself is gone, so 'close' may never come: answer now.
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
          settle(failed(this.describeFailure(code === null ? `was killed by ${signal ?? 'a signal'}` : `exited with code ${code}`, stderr, stdout)));
          return;
        }
        settle(parseAspectResponse(stdout) ?? failed(this.describeFailure('exited 0 without a verdict', stderr, '')));
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
