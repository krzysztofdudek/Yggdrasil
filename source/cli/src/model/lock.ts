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
  /**
   * LLM only: the size, in characters, of the gate-canonical prompt that
   * produced this verdict (`assembledPromptChars`, label-free — the exact
   * measurement the §4 prompt-size gate compares against a tier's
   * `max_prompt_chars`).
   *
   * NOT a hash ingredient — it is a RECORD of an input set the hash already
   * covers, never an input of its own, so writing/reading it invalidates
   * nothing. That containment is what makes it trustworthy: every ingredient
   * `llm/prompt.ts` assembles a prompt from is folded into `hash`, so an
   * entry whose hash still validates cannot have a different prompt size than
   * when it was written. `core/verify-lock.ts` relies on exactly that to skip
   * resolving companions and re-assembling the prompt on a valid pair — the
   * work that used to dominate a green `yg check`.
   *
   * Absent on a lock written before this field existed (and on every
   * deterministic entry, which has no prompt): the reader falls back to
   * assembling and measuring live, so an old lock keeps working untouched and
   * simply pays what it always paid until its pairs are next re-verified.
   *
   * The tier LIMIT is deliberately not stored alongside it. `max_prompt_chars`
   * is excluded from the verdict hash by design, so lowering a tier's ceiling
   * must re-gate existing verdicts — comparing this stored SIZE against the
   * CURRENT limit is what makes that happen.
   */
  promptChars?: number;
  /**
   * Provenance for a verdict recorded by a judge OUTSIDE the CLI's configured
   * reviewer — a person, or another tool that read the review package and
   * decided. Absent on every entry a configured provider produced, and on every
   * deterministic entry.
   *
   * NOT a hash ingredient — it is a RECORD of who decided, never an input of the
   * decision, so writing or reading it invalidates nothing. The verdict is bound
   * to the same inputHash a provider's would have been, which is what lets CI
   * re-prove it by hashing, with no key and no judge present.
   */
  judge?: { name: string; provider: 'external' };
}

/**
 * One port's contract baseline AT ONE VERSION: the test file that was the
 * contract, and what it hashed to when that version was recorded.
 *
 * Kept per version, and never overwritten once written. That is what makes the
 * rule enforceable in both directions: at an unchanged version the recorded hash
 * is the only thing the file may still be, and a version that has been used
 * before keeps its own record, so returning to it returns to the contract it
 * named rather than silently re-baselining whatever is on disk now.
 */
export interface PortContractRecord {
  /** Repo-relative POSIX path of the contract test, as declared when recorded. */
  test: string;
  /** sha256 of that file's normalized bytes at the moment the version was recorded. */
  hash: string;
}

export interface LockNodeEntry {
  /** Source fingerprint: sha256 fold over sorted [path, sha256(bytes)] of ALL mapped files
   *  (child carve-out applied, binaries included). Absent until first positive closure. */
  source?: string;
  /** Append-only log baseline (validateAppendOnly semantics, unchanged). */
  log?: { last_entry_datetime: string; prefix_hash: string };
  /**
   * Port contract baselines: port name → version (as a decimal string key) →
   * the record for that version. Absent on a node whose ports declare no `test`.
   *
   * This is COMMITTED state, in the logs file beside the source fingerprint and
   * the log baseline — deliberately, and for the same reason those are: a
   * baseline that a fresh clone rebuilds from whatever it finds is not a
   * baseline. It is written only by an approving run, and only for a (port,
   * version) pair that has none.
   */
  ports?: Record<string, Record<string, PortContractRecord>>;
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
