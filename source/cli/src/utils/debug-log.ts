import { appendFileSync } from 'node:fs';
import path from 'node:path';

let logPath: string | null = null;
let originalStdoutWrite: typeof process.stdout.write | null = null;
let originalStderrWrite: typeof process.stderr.write | null = null;
let stderrHeaderWritten = false;
let exitHandler: ((code: number) => void) | null = null;

/**
 * Initialize the debug log. When enabled, creates `.debug.log` in yggRoot,
 * writes a header, and tees stdout/stderr into the log.
 * When disabled (or before init), all operations are no-ops.
 * Safe to call multiple times — second call is a no-op if already active.
 */
export function initDebugLog(yggRoot: string, enabled: boolean): void {
  if (!enabled || logPath !== null) return;

  logPath = path.join(yggRoot, '.debug.log').replace(/\\/g, '/').replace(/\/+$/, '');
  stderrHeaderWritten = false;

  // Write header (append — log accumulates across invocations)
  const sep = '═'.repeat(56);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const argv = process.argv.slice(2).join(' ');
  appendFileSync(logPath, `${sep}\n${now}  yg ${argv}\n${sep}\n`, 'utf-8');

  // Tee stdout
  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = function (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    if (logPath) appendFileSync(logPath, text, 'utf-8');
    return originalStdoutWrite!(chunk as string, encodingOrCb as BufferEncoding, cb);
  } as typeof process.stdout.write;

  // Tee stderr
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = function (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    if (logPath) {
      if (!stderrHeaderWritten) {
        appendFileSync(logPath, '\n[stderr]\n', 'utf-8');
        stderrHeaderWritten = true;
      }
      appendFileSync(logPath, text, 'utf-8');
    }
    return originalStderrWrite!(chunk as string, encodingOrCb as BufferEncoding, cb);
  } as typeof process.stderr.write;

  // Named exit handler so _resetForTesting can remove it
  exitHandler = (code: number) => {
    if (logPath) {
      if (code !== 0) appendFileSync(logPath, `\n[exit ${code}]\n`, 'utf-8');
      appendFileSync(logPath, '\n', 'utf-8');
    }
  };
  process.on('exit', exitHandler);
}

/**
 * Append a message to the debug log. No-op if not initialized.
 */
export function debugWrite(message: string): void {
  if (!logPath) return;
  appendFileSync(logPath, message + '\n', 'utf-8');
}

/**
 * Restore original stdout/stderr, remove exit handler, and reset state.
 * For testing only.
 */
export function _resetForTesting(): void {
  if (originalStdoutWrite) {
    process.stdout.write = originalStdoutWrite;
    originalStdoutWrite = null;
  }
  if (originalStderrWrite) {
    process.stderr.write = originalStderrWrite;
    originalStderrWrite = null;
  }
  if (exitHandler) {
    process.off('exit', exitHandler);
    exitHandler = null;
  }
  logPath = null;
  stderrHeaderWritten = false;
}
