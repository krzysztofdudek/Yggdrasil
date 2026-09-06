/**
 * source/cli/src/io/drill-corpus-store.ts — the committed case corpus a rule is
 * drilled against, on disk.
 *
 * A corpus is hand-authored, committed evidence: the shapes a rule must refuse
 * and the shapes it must let through. It lives beside the rule it exercises, at
 * `.yggdrasil/aspects/<rule>/drills/<case>/<file>`, where the case directory's
 * name prefix carries the verdict the case expects. That layout is the reader's
 * contract, so this module writes into exactly it and never invents a shape of
 * its own.
 *
 * It is the WRITE side and the bulk-read side; discovery for a run stays in the
 * drill engine, which needs the labels and the expected verdicts rather than the
 * bytes. The two reads here answer only what a writer has to know: what the
 * corpus already holds (so the same bytes are never taken in twice), and how to
 * take a case back out when it turned out to measure nothing.
 */

import path from 'node:path';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';

import { atomicWriteFile } from './atomic-write.js';
import { debugWrite } from '../utils/debug-log.js';

/** One file already sitting in a rule's corpus. */
export interface CorpusFile {
  /** The case directory's name — the label a reader sees, verdict prefix and all. */
  caseLabel: string;
  /** The file's name inside that case directory. */
  filename: string;
  /** Its exact bytes. */
  content: Buffer;
}

/** Absolute path of a rule's corpus directory. */
export function corpusDir(yggRootPath: string, aspectId: string): string {
  return path.join(yggRootPath, 'aspects', ...aspectId.split('/'), 'drills');
}

/**
 * Every file the corpus already holds, with its bytes.
 *
 * Only the two verdict-carrying directory prefixes are read, because only those
 * hold cases; anything else beneath `drills/` is not a case and must not be
 * compared against one. A missing corpus is an empty one, not an error — a rule
 * with no cases yet is the normal starting point.
 */
export async function readCorpusFiles(
  yggRootPath: string,
  aspectId: string,
): Promise<CorpusFile[]> {
  const base = corpusDir(yggRootPath, aspectId);
  let caseDirs;
  try {
    caseDirs = await readdir(base, { withFileTypes: true });
  } catch (err) {
    debugWrite(`[drill-corpus] no corpus at ${base}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  const out: CorpusFile[] = [];
  for (const dir of [...caseDirs].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!dir.isDirectory()) continue;
    if (!dir.name.startsWith('violates-') && !dir.name.startsWith('satisfies-')) continue;
    let files;
    try {
      files = await readdir(path.join(base, dir.name), { withFileTypes: true });
    } catch (err) {
      debugWrite(`[drill-corpus] unreadable case ${dir.name}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!file.isFile()) continue;
      try {
        out.push({
          caseLabel: dir.name,
          filename: file.name,
          content: await readFile(path.join(base, dir.name, file.name)),
        });
      } catch (err) {
        debugWrite(`[drill-corpus] unreadable case file ${dir.name}/${file.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return out;
}

/**
 * Write one case into the corpus.
 *
 * The write itself is atomic (temp file + rename) like every other committed
 * artifact this tool produces, so an interrupt can never leave a half-written
 * case that a later drill would then measure a rule against.
 */
export async function writeCorpusCase(
  yggRootPath: string,
  aspectId: string,
  caseLabel: string,
  filename: string,
  content: string,
): Promise<string> {
  const caseDir = path.join(corpusDir(yggRootPath, aspectId), caseLabel);
  await mkdir(caseDir, { recursive: true });
  const filePath = path.join(caseDir, filename);
  await atomicWriteFile(filePath, content);
  return filePath;
}

/**
 * Remove one case from the corpus, whole.
 *
 * Used only to undo a case this same run just wrote and then could not measure:
 * leaving an unmeasurable case behind would put a fixture in the corpus that
 * says nothing about the rule and can never fail.
 */
export async function removeCorpusCase(
  yggRootPath: string,
  aspectId: string,
  caseLabel: string,
): Promise<void> {
  await rm(path.join(corpusDir(yggRootPath, aspectId), caseLabel), {
    recursive: true,
    force: true,
  });
}
