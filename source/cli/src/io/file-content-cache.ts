import { readFile, stat, open } from 'node:fs/promises';

const SIZE_LIMIT_BYTES = 5 * 1024 * 1024;
const BINARY_PROBE_BYTES = 8 * 1024;

export type FileContentResult = {
  content?: string;
  isBinary: boolean;
  tooLarge: boolean;
  unreadable: boolean;
  unreadableReason?: string;
};

/**
 * Per-run cache of file content for predicate evaluation. Memoizes by
 * absolute path. Performs binary detection (null bytes in first 8KB) and
 * size guard (5MB). Files exceeding the size limit or detected as binary
 * are cached without `content` (predicate evaluators treat those as
 * content-not-evaluable).
 *
 * Binary detection always wins over the size guard. A `content:` predicate
 * treats a binary file as a deliberate, never-blocking non-match (there is
 * no text for a text regex to match), while a too-large file is UNEVALUABLE
 * and blocks (the filter could not be applied, so the file cannot be
 * silently excluded) — see file-when-evaluator.ts's atom-content handling.
 * For a file over the size limit that is also binary, reporting `tooLarge`
 * instead of `isBinary` would turn a legitimate non-match into a spurious
 * blocking error, so binary-ness is checked FIRST, off a bounded probe (at
 * most BINARY_PROBE_BYTES) rather than the whole file — an oversized file's
 * full bytes are never read just to answer that.
 */
export class FileContentCache {
  private readonly entries = new Map<string, Promise<FileContentResult>>();

  read(absPath: string): Promise<FileContentResult> {
    let entry = this.entries.get(absPath);
    if (entry === undefined) {
      entry = this.load(absPath);
      this.entries.set(absPath, entry);
    }
    return entry;
  }

  private async load(absPath: string): Promise<FileContentResult> {
    let stats;
    try {
      stats = await stat(absPath);
    } catch (e) {
      return {
        isBinary: false,
        tooLarge: false,
        unreadable: true,
        unreadableReason: e instanceof Error ? e.message : String(e),
      };
    }

    if (stats.size > SIZE_LIMIT_BYTES) {
      // Too large to read whole — probe only the first BINARY_PROBE_BYTES to
      // decide binary vs. too-large without loading the rest of the file.
      const probe = await readProbe(absPath);
      if (probe.unreadable) {
        return {
          isBinary: false,
          tooLarge: false,
          unreadable: true,
          unreadableReason: probe.unreadableReason,
        };
      }
      if (probe.isBinary) {
        return { isBinary: true, tooLarge: false, unreadable: false };
      }
      return { isBinary: false, tooLarge: true, unreadable: false };
    }

    let buf: Buffer;
    try {
      buf = await readFile(absPath);
    } catch (e) {
      return {
        isBinary: false,
        tooLarge: false,
        unreadable: true,
        unreadableReason: e instanceof Error ? e.message : String(e),
      };
    }

    if (isBinaryBuffer(buf)) {
      return { isBinary: true, tooLarge: false, unreadable: false };
    }

    return {
      content: buf.toString('utf8'),
      isBinary: false,
      tooLarge: false,
      unreadable: false,
    };
  }
}

/** Null byte anywhere in the first BINARY_PROBE_BYTES marks a buffer binary. */
function isBinaryBuffer(buf: Buffer): boolean {
  const probe = buf.subarray(0, BINARY_PROBE_BYTES);
  for (let i = 0; i < probe.length; i++) {
    if (probe[i] === 0) return true;
  }
  return false;
}

/**
 * Read only the first BINARY_PROBE_BYTES of a file for binary detection,
 * used when the file is too large to read in full. A file handle + bounded
 * read, never `readFile` — the whole point is to avoid paying an oversized
 * file's full I/O and memory cost just to answer "is this binary".
 */
async function readProbe(
  absPath: string,
): Promise<{ isBinary: boolean; unreadable: boolean; unreadableReason?: string }> {
  let handle;
  try {
    handle = await open(absPath, 'r');
    const buf = Buffer.alloc(BINARY_PROBE_BYTES);
    const { bytesRead } = await handle.read(buf, 0, BINARY_PROBE_BYTES, 0);
    return { isBinary: isBinaryBuffer(buf.subarray(0, bytesRead)), unreadable: false };
  } catch (e) {
    return { isBinary: false, unreadable: true, unreadableReason: e instanceof Error ? e.message : String(e) };
  } finally {
    if (handle) await handle.close();
  }
}
