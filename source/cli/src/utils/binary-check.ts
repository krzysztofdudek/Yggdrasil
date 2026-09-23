import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { debugWrite } from './debug-log.js';
import { redactedTail } from './redact.js';

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Probe whether a CLI binary can be run on this machine, cross-platform.
 *
 * The previous approach shelled out to `which <binary>`, but `which` is a
 * Unix-only command. On Windows there is no `which` (the equivalent is `where`),
 * so the probe failed to spawn `which` itself (ENOENT) and reported every CLI
 * provider as absent even when the binary was installed and resolvable — a false
 * negative on every Windows machine.
 *
 * Instead we run the binary directly with `--version` and treat a clean exit as
 * "available". This needs no platform-specific lookup tool. On Windows `shell`
 * is enabled so the OS resolves PATHEXT shims (e.g. a `claude.cmd` installed by
 * npm) that a bare process spawn cannot launch; the binary name is always a
 * fixed internal constant, never user input, so there is no shell-injection
 * surface. The probe also confirms the binary actually runs, which `which`
 * (a mere path lookup) never did.
 */
export async function binaryAvailable(binary: string): Promise<boolean> {
  return (await probeBinary(binary)).ok;
}

/** What `<binary> --version` showed: success, or why it could not run, in words a reader can act on. */
export type BinaryProbe = { ok: true } | { ok: false; detail: string };

/**
 * The same probe as binaryAvailable, keeping the cause of a failure: not found
 * on PATH, no answer within the probe's 10 seconds, or the exit code with the
 * last line it printed. A reviewer that reports "unavailable" names this cause,
 * so a missing install and a broken one read differently.
 */
export async function probeBinary(binary: string): Promise<BinaryProbe> {
  try {
    await execFileAsync(binary, ['--version'], {
      timeout: PROBE_TIMEOUT_MS,
      shell: process.platform === 'win32',
    });
    return { ok: true };
  } catch (err) {
    debugWrite(`[binary-check] ${binary} --version: ${(err as Error).message}`);
    return { ok: false, detail: describeProbeFailure(binary, err) };
  }
}

function describeProbeFailure(binary: string, err: unknown): string {
  const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: string | number; stderr?: string };
  if (e.code === 'ENOENT') return `'${binary}' was not found on PATH`;
  if (e.code === 'EACCES') return `'${binary}' is not executable`;
  if (e.killed || e.signal) return `'${binary} --version' did not finish within ${PROBE_TIMEOUT_MS / 1000}s`;
  // Windows runs the probe through a shell, which reports a missing command as exit 1 / 9009 with this text.
  const printed = redactedTail(typeof e.stderr === 'string' ? e.stderr : '', 200);
  if (/not recognized as an internal or external command|command not found/i.test(printed)) return `'${binary}' was not found on PATH`;
  const code = typeof e.code === 'number' ? `exited with code ${e.code}` : 'failed';
  return `'${binary} --version' ${code}${printed ? `: ${printed}` : ''}`;
}
