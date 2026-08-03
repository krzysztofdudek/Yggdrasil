export const LOCK_FORMAT_VERSION = 1;
/** Legacy single-file lock (pre-5.1.0). Kept so the 5.1.0 migration can find,
 *  partition, and delete it. The live runtime no longer reads or writes it. */
export const LOCK_FILE_NAME = 'yg-lock.json';

/** Committed: LLM verdicts (includes companion-backed LLM entries, which may carry
 *  `touched`). The bulk of the committed lock; merge-resolved like the old single file. */
export const LOCK_NONDET_FILE_NAME = 'yg-lock.nondeterministic.json';
/** Committed: the per-node `nodes` section (source fingerprint + log baseline). Written at
 *  positive closure and by `yg log merge-resolve`; isolated so log churn stays out of the
 *  verdict files. */
export const LOCK_LOGS_FILE_NAME = 'yg-lock.logs.json';
/** Gitignored: deterministic-aspect verdicts. Pure local cache — regenerated for free by
 *  `yg check --approve --only-deterministic`; never committed (dot-prefixed per the derived-state
 *  convention). Absent on a fresh clone = those pairs read as unverified until rematerialized. */
export const LOCK_DET_FILE_NAME = '.yg-lock.deterministic.json';

/** Partition discriminator: a verdict belongs to the deterministic (gitignored) file iff its
 *  aspect ships `check.mjs` (`reviewer.type === 'deterministic'`). NOT derivable from a
 *  VerdictEntry alone — a companion-backed LLM entry also carries `touched`. Callers that
 *  partition (writeLock, the migration) supply the deterministic aspectId set / classify by
 *  check.mjs presence; an entry's `touched` field is never the partition key. */

export type Verdict = 'approved' | 'refused';

export interface VerdictEntry {
  verdict: Verdict;
  /** inputHash per spec §3.1 — folds the verdict token. */
  hash: string;
  /** refused only: reviewer violation report (LLM) or rendered Violation[] (deterministic). */
  reason?: string;
  /** deterministic only: sorted [observationKey, observationHash] pairs for
   *  OUT-OF-SUBJECT observations (read:/list:/exists:/graph: keys, spec §3.1). */
  touched?: Array<[string, string]>;
}

export interface LockNodeEntry {
  /** Source fingerprint: sha256 fold over sorted [path, sha256(bytes)] of ALL mapped files
   *  (child carve-out applied, binaries included). Absent until first positive closure. */
  source?: string;
  /** Append-only log baseline (validateAppendOnly semantics, unchanged). */
  log?: { last_entry_datetime: string; prefix_hash: string };
}

export interface LockFile {
  version: number; // LOCK_FORMAT_VERSION
  verdicts: Record<string, Record<string, VerdictEntry>>; // aspectId → unitKey → entry
  nodes: Record<string, LockNodeEntry>; // nodePath → per-node facts
}

/** 'node:<model-relative path>' | 'file:<repo-relative POSIX path>' */
export type UnitKey = string;
export const nodeUnit = (nodePath: string): UnitKey => `node:${nodePath}`;
export const fileUnit = (repoRelPosix: string): UnitKey => `file:${repoRelPosix}`;
