import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { LlmProvider, AspectResponse } from './types.js';
import { debugWrite } from '../utils/debug-log.js';
import { binaryAvailable } from '../utils/binary-check.js';

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

  // 1. Direct JSON
  try { return normalizeResponse(JSON.parse(trimmed)); } catch (err) { debugWrite(`[parseAspectResponse] direct JSON parse failed: ${(err as Error).message}`); }

  // 2. Markdown fence
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try { return normalizeResponse(JSON.parse(fenceMatch[1].trim())); } catch (err) { debugWrite(`[parseAspectResponse] fence JSON parse failed: ${(err as Error).message}`); }
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

  async isAvailable(): Promise<boolean> {
    return binaryAvailable(this.binary);
  }

  async verifyAspect(prompt: string): Promise<AspectResponse> {
    const fallback: AspectResponse = { satisfied: false, reason: 'Reviewer unavailable', errorSource: 'provider' };

    return new Promise((resolve) => {
      const args = this.stdinMode ? this.buildArgs('') : this.buildArgs(prompt);
      const child = spawn(this.binary, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: this.timeout,
        cwd: tmpdir(),
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';
      let killed = false;
      let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

      const timer = setTimeout(() => {
        killed = true;
        debugWrite(`[${this.binary}] timeout after ${this.timeout}ms; stderr tail: ${stderr.slice(-500)}`);
        child.kill('SIGTERM');
        // Escalate: a child that ignores SIGTERM would otherwise hang yg check
        // indefinitely. Give it a short grace period, then force SIGKILL so the
        // reviewer call always terminates.
        sigkillTimer = setTimeout(() => {
          debugWrite(`[${this.binary}] still alive ${SIGKILL_GRACE_MS}ms after SIGTERM; sending SIGKILL`);
          child.kill('SIGKILL');
        }, SIGKILL_GRACE_MS);
      }, this.timeout);

      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      // Drain stderr too. With stdio stderr piped but unread, a child that writes
      // more than the ~64KB pipe buffer blocks on its stderr write and never exits —
      // a deadlock that presents as a spurious timeout / "Reviewer unavailable" on
      // large prompts. Reading it keeps the pipe flowing and preserves diagnostics.
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      child.on('error', (err) => {
        clearTimeout(timer);
        clearTimeout(sigkillTimer);
        const isE2BIG = (err as NodeJS.ErrnoException).code === 'E2BIG';
        const msg = isE2BIG
          ? 'Prompt too large for CLI arg mode'
          : `spawn error — is '${this.binary}' installed and on PATH?`;
        debugWrite(`[${this.binary}] ${msg}`);
        resolve({ satisfied: false, reason: msg, errorSource: 'provider' });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        clearTimeout(sigkillTimer);
        if (killed || code !== 0) {
          if (!killed && code !== 0) debugWrite(`[${this.binary}] exit_code=${code}`);
          resolve(fallback);
          return;
        }
        resolve(parseAspectResponse(stdout) ?? fallback);
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
