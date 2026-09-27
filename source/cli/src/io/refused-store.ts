/**
 * source/cli/src/io/refused-store.ts — the local, content-addressed store of
 * refused content. Every refusal a fill records keeps, beside the lock's verdict,
 * the bytes the refused unit held and the reason it was refused, in
 * `.yggdrasil/.refused/<hash>.json` — `<hash>` being the verdict's own input hash,
 * the one the lock entry and the verdict-events line carry, so a reader joins the
 * three on it. A refusal followed by an approval of the same unit is a labelled
 * refusal→fix pair: what a rule rejected and what satisfied it. The lock keeps only
 * hashes and the reason, so without this store those bytes are gone the moment the
 * code is fixed; Grain reads the pairs to derive checks from a rule's own verdicts.
 *
 * Local and write-only: gitignored, never committed, and never read back by any
 * check, verification or render path. A failed write loses one record and nothing
 * else — it MUST NEVER throw into the fill. The writer never edits a tracked
 * `.gitignore` during a fill: where the store's directory is not ignored (a graph
 * whose `.yggdrasil/.gitignore` predates the store, until `yg init --upgrade` adds
 * the line) it writes nothing.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from './atomic-write.js';
import { debugWrite } from '../utils/debug-log.js';
import { toPosixPath } from '../utils/posix.js';

/** The store's directory, relative to the `.yggdrasil/` graph root. Gitignored. */
export const REFUSED_DIRNAME = '.refused';

/** The `.yggdrasil/.gitignore` line that keeps the store out of the repository. */
export const REFUSED_GITIGNORE_LINE = `${REFUSED_DIRNAME}/`;

/**
 * A unit whose subject files together exceed this many bytes is not stored: the
 * store keeps refusal→fix material, not copies of whole trees, and a record this
 * large would be a poor pair to learn from anyway. The refusal itself is recorded
 * in the lock and the events line as always.
 */
export const REFUSED_MAX_BYTES = 2 * 1024 * 1024;

/** One stored refusal. `v` is the record-schema version. */
export interface RefusedRecord {
  v: 1;
  /** The verdict's input hash — the lock entry's `hash`, the events line's `hash`, and this record's file name. */
  hash: string;
  /** ISO 8601 UTC timestamp, from the fill's injected clock. */
  ts: string;
  /** Commit the fill ran at, when resolvable. */
  sha?: string;
  aspectId: string;
  /** POSIX unit key: 'node:<path>' or 'file:<path>'. */
  unitKey: string;
  kind: 'llm' | 'deterministic';
  /** The reason the lock records for the refusal. */
  reason: string;
  /** The subject files as they were when refused, sorted by path. A file whose bytes are not valid UTF-8 carries `base64` instead of `content`. */
  files: Array<{ path: string; content?: string; base64?: string }>;
}

/** What the fill knows about a refusal when it records one. */
export interface RefusedInput {
  hash: string;
  ts: string;
  sha?: string;
  aspectId: string;
  unitKey: string;
  kind: 'llm' | 'deterministic';
  reason: string;
  /** Repo-relative subject file paths. */
  subjectFiles: readonly string[];
}

function fileEntry(rel: string, bytes: Buffer): RefusedRecord['files'][number] {
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? { path: rel, content: text } : { path: rel, base64: bytes.toString('base64') };
}

/**
 * Store one refusal. Best-effort and write-only; `enabled` is the caller's answer
 * to whether the store's directory is gitignored (see the module doc). A record
 * already present is left alone: its name is the hash of the same inputs. Returns
 * true when a record was written.
 */
export function storeRefusedContent(yggRootPath: string, projectRoot: string, input: RefusedInput, enabled: boolean): boolean {
  if (!enabled) return false;
  try {
    if (!/^[0-9a-f]{64}$/.test(input.hash)) return false;
    const dir = path.join(yggRootPath, REFUSED_DIRNAME);
    const target = path.join(dir, `${input.hash}.json`);
    if (existsSync(target)) return false;
    const files: RefusedRecord['files'] = [];
    let total = 0;
    for (const rel of [...input.subjectFiles].map(toPosixPath).sort()) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(path.resolve(projectRoot, rel));
      } catch {
        bytes = Buffer.alloc(0); // a deleted subject hashes as empty bytes, as the verdict did
      }
      total += bytes.length;
      if (total > REFUSED_MAX_BYTES) {
        debugWrite(`[refused-store] ${input.aspectId} @ ${input.unitKey}: subject files exceed ${REFUSED_MAX_BYTES} bytes, not stored`);
        return false;
      }
      files.push(fileEntry(rel, bytes));
    }
    const record: RefusedRecord = {
      v: 1,
      hash: input.hash,
      ts: input.ts,
      ...(input.sha !== undefined ? { sha: input.sha } : {}),
      aspectId: input.aspectId,
      unitKey: toPosixPath(input.unitKey),
      kind: input.kind,
      reason: input.reason,
      files,
    };
    atomicWriteFileSync(target, `${JSON.stringify(record)}\n`);
    return true;
  } catch (e) {
    debugWrite(`[refused-store] write failed (best-effort, ignored): ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
