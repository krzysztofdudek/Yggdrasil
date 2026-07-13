import { access, lstat, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, constants as fsConstants } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import { debugWrite } from '../utils/debug-log.js';

export async function readSortedDir(dirPath: string): Promise<Dirent[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readTextFile(filePath: string): Promise<string> {
  return readFile(filePath, 'utf-8');
}

export async function readSortedDirOrEmpty(dirPath: string): Promise<Dirent[]> {
  try {
    return await readSortedDir(dirPath);
  } catch (err) {
    debugWrite(`[graph-fs] readdir failed for ${dirPath}: ${(err as Error).message}`);
    return [];
  }
}

export async function writeTextFile(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content, 'utf-8');
}

export async function fileAccess(filePath: string): Promise<void> {
  await access(filePath);
}

/**
 * Probe whether a file is readable (R_OK). Returns null when readable, or the OS
 * error message when not (EACCES, vanished, EISDIR, …). A permission probe, not
 * a content read — cheap enough for the hot check path.
 */
export async function probeUnreadable(absPath: string): Promise<string | null> {
  try {
    await access(absPath, fsConstants.R_OK);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export async function lstatFile(filePath: string): Promise<Stats> {
  return lstat(filePath);
}

export async function statPath(targetPath: string): Promise<Stats> {
  return stat(targetPath);
}

export function fileExistsSync(filePath: string): boolean {
  return existsSync(filePath);
}

/**
 * Synchronous UTF-8 read that never throws: returns the file's text, or null when
 * the file is missing or unreadable. For read-only consumers that must resolve a
 * value inline (no async boundary) and treat an absent/garbled source as "nothing
 * to say" rather than an error — e.g. the silent feature-field index reader.
 */
export function readTextFileSyncOrNull(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export async function readFileBytes(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch {
    return null;
  }
}

export async function listDirEntries(
  dirPath: string,
): Promise<Array<{ name: string; kind: 'file' | 'dir' }> | null> {
  let dirents;
  try {
    dirents = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return null;
  }
  return dirents.map((d) => ({
    name: d.name,
    kind: d.isDirectory() ? ('dir' as const) : ('file' as const),
  }));
}

export async function statKind(targetPath: string): Promise<'file' | 'dir' | false> {
  try {
    const s = await stat(targetPath);
    if (s.isDirectory()) return 'dir';
    // Classify identically to the recorder side (ctx.fs.exists): a non-regular,
    // non-directory entry (socket, fifo, char/block device) is NEITHER 'file' nor
    // 'dir' and folds as 'false'. Mirroring the producer's three-token mapping
    // keeps the exists: observation byte-symmetric across record and re-observe
    // (spec §3.1 symmetry; without this a special file recorded 'false' would
    // re-observe 'file' and trip a spurious mismatch).
    if (s.isFile()) return 'file';
    return false;
  } catch {
    return false;
  }
}
