import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { IssueMessage } from '../model/validation.js';
import type { LockFile, VerdictEntry, LockNodeEntry } from '../model/lock.js';
import {
  LOCK_FORMAT_VERSION,
  LOCK_FILE_NAME,
  LOCK_NONDET_FILE_NAME,
  LOCK_LOGS_FILE_NAME,
  LOCK_DET_FILE_NAME,
} from '../model/lock.js';
import { atomicWriteFile } from '../io/atomic-write.js';

/**
 * A lock file is unparseable, structurally invalid, or has an unrecognized
 * version. Fail closed — the runtime never returns a partial lock.
 *
 * Covers:
 * - Unparseable JSON
 * - git conflict markers (any of <<<<<<<, =======, >>>>>>>, line-leading)
 * - Unknown version number
 * - Structurally garbled content (missing version, wrong shape, unknown keys)
 */
export class LockInvalidError extends Error {
  readonly code = 'lock-invalid';
  readonly messageData: IssueMessage;

  constructor(messageData: IssueMessage) {
    super(messageData.what);
    this.name = 'LockInvalidError';
    this.messageData = messageData;
  }
}

// ── File layout (the 5.1.0 triad) ─────────────────────────────────────────────
// The lock is split across three files; the in-memory LockFile stays unified.
//   - nondeterministic.json (committed) → LLM verdicts
//   - logs.json             (committed) → the `nodes` section
//   - .deterministic.json   (gitignored) → deterministic verdicts
// readLock merges all three; writeLock partitions one LockFile back out, by
// ASPECT KIND (deterministicAspectIds), never by the `touched` field.

/** Absolute path to the LEGACY single-file lock. Kept for the 5.1.0 migration only. */
export function lockPath(yggRoot: string): string {
  return path.join(yggRoot, LOCK_FILE_NAME);
}
/** Absolute path to the committed LLM-verdict file. */
export function nondetLockPath(yggRoot: string): string {
  return path.join(yggRoot, LOCK_NONDET_FILE_NAME);
}
/** Absolute path to the committed log/closure-state file. */
export function logsLockPath(yggRoot: string): string {
  return path.join(yggRoot, LOCK_LOGS_FILE_NAME);
}
/** Absolute path to the gitignored deterministic-verdict file. */
export function detLockPath(yggRoot: string): string {
  return path.join(yggRoot, LOCK_DET_FILE_NAME);
}

/**
 * A content hash over the COMMITTED lock triad — the nondeterministic verdict file and the
 * per-node logs/closure file — read by their bytes and folded into one sha256. This is a
 * content-addressed digest of the committed lock ARTIFACT (for attestation / provenance), NOT
 * a re-derivation of any verdict or count. The gitignored deterministic cache is deliberately
 * EXCLUDED: it is absent on a fresh clone and never committed, so folding it would make the hash
 * differ across machines for the same commit. Returns '' when no committed lock exists yet (a
 * greenfield graph), so a caller states "no committed lock" rather than a fabricated hash.
 * Read-only.
 */
export function committedLockContentHash(yggRoot: string): string {
  const parts: Buffer[] = [];
  for (const file of [nondetLockPath(yggRoot), logsLockPath(yggRoot)]) {
    if (!existsSync(file)) continue;
    try {
      parts.push(readFileSync(file));
    } catch {
      // An unreadable committed lock file is treated as absent — the hash never fabricates
      // bytes it could not read; a missing/unreadable triad yields '' (no committed lock).
    }
  }
  if (parts.length === 0) return '';
  const hash = createHash('sha256');
  for (const p of parts) hash.update(p);
  return hash.digest('hex');
}

/** Per-file parse context: drives file-specific recovery guidance. */
interface ParseCtx {
  fileName: string;
  /** Committed files recover via git; the gitignored det file is rematerialized. */
  committed: boolean;
}

/** Recovery line for a corrupt/garbled lock file. */
function recoveryNext(ctx: ParseCtx): string {
  if (ctx.committed) {
    return (
      `restore the file from git (\`git checkout HEAD -- .yggdrasil/${ctx.fileName}\`), OR\n` +
      'delete the file and re-fill via `yg check --approve` — this re-verifies the affected pairs.'
    );
  }
  return (
    `delete the file and re-run \`yg check --approve --only-deterministic\` to rematerialize it ` +
    '(free, no LLM cost — deterministic verdicts are a local cache).'
  );
}

/**
 * Read the unified lock by merging the three on-disk files.
 *
 * - Each file is independently optional; an absent file contributes empty state
 *   (cold start — the det file is absent on a fresh clone, so its pairs read as
 *   unverified until `yg check --approve --only-deterministic` rematerializes it).
 * - Garbled / conflict-markered / wrong-version file → LockInvalidError (fail closed).
 * - Verdict namespaces are disjoint across the verdict files (an aspect is wholly
 *   one kind), so the merge is a plain union. On the rare kind-flip collision the
 *   deterministic (freshest local) entry wins; verify-lock re-hashes and self-heals.
 *
 * Never returns a partial lock from a garbled file.
 */
export function readLock(yggRoot: string): LockFile {
  const nondet = readOneLockFile(nondetLockPath(yggRoot), { fileName: LOCK_NONDET_FILE_NAME, committed: true });
  const logs = readOneLockFile(logsLockPath(yggRoot), { fileName: LOCK_LOGS_FILE_NAME, committed: true });
  const det = readOneLockFile(detLockPath(yggRoot), { fileName: LOCK_DET_FILE_NAME, committed: false });

  return {
    version: LOCK_FORMAT_VERSION,
    verdicts: { ...nondet.verdicts, ...det.verdicts },
    nodes: logs.nodes,
  };
}

/**
 * The aspectIds whose verdicts currently live in the gitignored deterministic
 * file, read directly from disk. {@link readLock} merges the committed and
 * gitignored verdict files into one map and discards which file each aspect
 * came from; this reads that provenance back out, independent of the current
 * graph. An aspect's verdicts stay in whichever file they were written to
 * until something rewrites or deletes them, so this is still correct even for
 * an aspect that no longer exists in the graph at all — the one case a
 * graph-derived `reviewer.type` lookup cannot answer.
 */
export function readDetLockAspectIds(yggRoot: string): Set<string> {
  const { verdicts } = readOneLockFile(detLockPath(yggRoot), { fileName: LOCK_DET_FILE_NAME, committed: false });
  return new Set(Object.keys(verdicts));
}

/**
 * Read the LEGACY single-file lock (pre-5.1.0), validated, as a unified LockFile —
 * or null if it is absent. Used ONLY by the 5.1.0 split migration; the live runtime
 * reads the triad via {@link readLock}.
 */
export function readLegacyLock(yggRoot: string): LockFile | null {
  const filePath = lockPath(yggRoot);
  try {
    readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const { verdicts, nodes } = readOneLockFile(filePath, { fileName: LOCK_FILE_NAME, committed: true });
  return { version: LOCK_FORMAT_VERSION, verdicts, nodes };
}

/**
 * Read, validate, and project a single lock file to its { verdicts, nodes } sections.
 * Each file carries the full { version, verdicts, nodes } shape (the irrelevant section
 * is an empty object); the caller selects which sections it cares about.
 */
function readOneLockFile(filePath: string, ctx: ParseCtx): { verdicts: Record<string, Record<string, VerdictEntry>>; nodes: Record<string, LockNodeEntry> } {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Absent file is valid cold-start state — contributes nothing.
      return { verdicts: {}, nodes: {} };
    }
    throw err;
  }

  // Detect git conflict markers before attempting JSON parse (committed files only —
  // the gitignored det file is never merged, so a stray marker there falls through to
  // the parse error with the rematerialize recovery).
  // Line-anchored regex: real git conflict markers START a line. The `^…/m` anchoring keeps
  // an embedded run of 7 angle brackets inside a `reason` string from false-positiving.
  if (ctx.committed && /^(?:<<<<<<<|=======|>>>>>>>)/m.test(raw)) {
    throw new LockInvalidError({
      what: `${ctx.fileName} contains git conflict markers — the file was not resolved after a merge`,
      why: 'a conflict-markered lock file cannot be parsed; allowing partial content would let stale or wrong verdicts pass as valid, silently breaking enforcement',
      next:
        'resolve the conflict by taking one side wholesale:\n' +
        `  git checkout --ours -- .yggdrasil/${ctx.fileName}\n` +
        '  OR\n' +
        `  git checkout --theirs -- .yggdrasil/${ctx.fileName}\n` +
        'Then run `yg check --approve` to re-verify all pairs whose verdicts may have changed.\n' +
        'Hand-stitching entries line-by-line is forbidden — structural damage makes the whole file lock-invalid.',
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LockInvalidError({
      what: `${ctx.fileName} contains unparseable JSON`,
      why: 'a garbled lock file cannot be read; allowing partial content would silently skip enforcement on unreadable entries',
      next: recoveryNext(ctx),
    });
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LockInvalidError({
      what: `${ctx.fileName} does not contain a JSON object`,
      why: 'the lock file must be a JSON object with a numeric version field; a non-object cannot be validated',
      next: recoveryNext(ctx),
    });
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.version !== 'number') {
    throw new LockInvalidError({
      what: `${ctx.fileName} is missing a numeric version field`,
      why: 'the lock file format requires a numeric version field to validate compatibility; without it the file cannot be trusted',
      next: recoveryNext(ctx),
    });
  }

  if (obj.version !== 1 && obj.version !== 2) {
    throw new LockInvalidError({
      what: `${ctx.fileName} has unsupported version ${obj.version} (this CLI reads version 1 or 2)`,
      why: 'an unrecognized lock version means the file was written by a different or newer CLI; parsing it would risk silently misinterpreting its structure',
      next: recoveryNext(ctx),
    });
  }

  // A stray relation_verdicts (from the unreleased alpha.6 v2 lock) is dropped:
  // relation conformance is computed live now, so the section is moot.
  if ('relation_verdicts' in obj) delete obj.relation_verdicts;

  // Validate the SHAPE. The lock is the only persisted verification state; a malformed
  // shape must fail CLOSED, never silently coerce to empty (which would be fail-open).
  // Strict-by-design: the format is fully enumerated and version-gated; unknown keys are
  // corruption, not forward-compatible extension.
  validateLockShape(obj, ctx);

  // Shape is valid — the cast is sound because validateLockShape threw on anything else.
  return {
    verdicts: obj.verdicts as Record<string, Record<string, VerdictEntry>>,
    nodes: obj.nodes as Record<string, LockNodeEntry>,
  };
}

/** True for a non-null, non-array object — the "plain object" shape every lock map/entry must be. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Raise the canonical fail-closed corruption error with file-specific recovery. */
function throwMalformed(detail: string, ctx: ParseCtx): never {
  throw new LockInvalidError({
    what: `${ctx.fileName} is structurally malformed — ${detail}`,
    why: 'the lock is the only persisted verification state; a malformed lock cannot be trusted, and silently treating it as empty would let unverified code pass as verified (fail open)',
    next: recoveryNext(ctx),
  });
}

/**
 * Validate the SHAPE of a parsed lock object (version already checked by the caller).
 *
 * Throws LockInvalidError on any structural deviation. Strict-by-design: only the known keys are
 * accepted at every level; unknown keys are rejected (the format is version-gated, so unknown
 * keys mean corruption, not forward-compatible extension).
 *
 * Accepted shape:
 * - top level: exactly { version, verdicts, nodes } (version validated by caller). Each split
 *   file carries all three keys; the section it does not own is an empty object.
 * - verdicts: plain object; every value is a plain object (aspectId → unitKey → entry); every
 *   entry is a plain object with string `verdict` ∈ {approved, refused} and string `hash`;
 *   optional string `reason`; optional `touched` = array of [string, string] pairs; optional
 *   non-negative integer `promptChars` (LLM only — the size of the prompt that produced the
 *   verdict; absent on a deterministic entry and on any entry written before the field existed).
 * - nodes: plain object; every value is a plain object with optional string `source` and optional
 *   `log` = plain object { last_entry_datetime: string, prefix_hash: string }.
 */
function validateLockShape(obj: Record<string, unknown>, ctx: ParseCtx): void {
  // Top-level keys: only version / verdicts / nodes are allowed.
  const TOP_KEYS = new Set(['version', 'verdicts', 'nodes']);
  for (const key of Object.keys(obj)) {
    if (!TOP_KEYS.has(key)) throwMalformed(`unexpected top-level key "${key}" (allowed: version, verdicts, nodes)`, ctx);
  }

  // verdicts must be a plain object of aspectId → (unitKey → entry).
  if (!isPlainObject(obj.verdicts)) {
    throwMalformed('"verdicts" must be a JSON object (found ' + describe(obj.verdicts) + ')', ctx);
  }
  for (const aspectId of Object.keys(obj.verdicts)) {
    const unitMap = obj.verdicts[aspectId];
    if (!isPlainObject(unitMap)) {
      throwMalformed(`"verdicts.${aspectId}" must be a JSON object (found ${describe(unitMap)})`, ctx);
    }
    for (const unitKey of Object.keys(unitMap)) {
      validateVerdictEntry(unitMap[unitKey], `verdicts.${aspectId}.${unitKey}`, ctx);
    }
  }

  // nodes must be a plain object of nodePath → node entry.
  if (!isPlainObject(obj.nodes)) {
    throwMalformed('"nodes" must be a JSON object (found ' + describe(obj.nodes) + ')', ctx);
  }
  for (const nodePath of Object.keys(obj.nodes)) {
    validateNodeEntry(obj.nodes[nodePath], `nodes.${nodePath}`, ctx);
  }
}

/** Validate a single VerdictEntry (verdict + hash required; reason + touched optional). */
function validateVerdictEntry(entry: unknown, at: string, ctx: ParseCtx): void {
  if (!isPlainObject(entry)) throwMalformed(`"${at}" must be a JSON object (found ${describe(entry)})`, ctx);

  const ENTRY_KEYS = new Set(['verdict', 'hash', 'reason', 'touched', 'promptChars']);
  for (const key of Object.keys(entry)) {
    if (!ENTRY_KEYS.has(key)) throwMalformed(`"${at}" has unexpected key "${key}" (allowed: verdict, hash, reason, touched, promptChars)`, ctx);
  }

  if (entry.verdict !== 'approved' && entry.verdict !== 'refused') {
    throwMalformed(`"${at}.verdict" must be "approved" or "refused" (found ${describe(entry.verdict)})`, ctx);
  }
  if (typeof entry.hash !== 'string') {
    throwMalformed(`"${at}.hash" must be a string (found ${describe(entry.hash)})`, ctx);
  }
  if (entry.reason !== undefined && typeof entry.reason !== 'string') {
    throwMalformed(`"${at}.reason" must be a string when present (found ${describe(entry.reason)})`, ctx);
  }
  if (entry.touched !== undefined) {
    if (!Array.isArray(entry.touched)) {
      throwMalformed(`"${at}.touched" must be an array when present (found ${describe(entry.touched)})`, ctx);
    }
    for (let i = 0; i < entry.touched.length; i++) {
      const pair = entry.touched[i];
      if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        typeof pair[0] !== 'string' ||
        typeof pair[1] !== 'string'
      ) {
        throwMalformed(`"${at}.touched[${i}]" must be a [string, string] pair (found ${describe(pair)})`, ctx);
      }
    }
  }
  // LLM only: the size of the prompt that produced this verdict. A non-negative
  // integer — it is a character count, so a fraction or a negative would mean
  // the entry was written by something other than this CLI, and a check that
  // then trusted it could gate the wrong way. Absent on every deterministic
  // entry and on any entry written before the field existed.
  if (entry.promptChars !== undefined) {
    if (typeof entry.promptChars !== 'number' || !Number.isInteger(entry.promptChars) || entry.promptChars < 0) {
      throwMalformed(`"${at}.promptChars" must be a non-negative integer when present (found ${describe(entry.promptChars)})`, ctx);
    }
  }
}

/** Validate a single LockNodeEntry (source optional string; log optional {datetime, prefix_hash}). */
function validateNodeEntry(entry: unknown, at: string, ctx: ParseCtx): void {
  if (!isPlainObject(entry)) throwMalformed(`"${at}" must be a JSON object (found ${describe(entry)})`, ctx);

  const NODE_KEYS = new Set(['source', 'log']);
  for (const key of Object.keys(entry)) {
    if (!NODE_KEYS.has(key)) throwMalformed(`"${at}" has unexpected key "${key}" (allowed: source, log)`, ctx);
  }

  if (entry.source !== undefined && typeof entry.source !== 'string') {
    throwMalformed(`"${at}.source" must be a string when present (found ${describe(entry.source)})`, ctx);
  }
  if (entry.log !== undefined) {
    if (!isPlainObject(entry.log)) {
      throwMalformed(`"${at}.log" must be a JSON object when present (found ${describe(entry.log)})`, ctx);
    }
    const LOG_KEYS = new Set(['last_entry_datetime', 'prefix_hash']);
    for (const key of Object.keys(entry.log)) {
      if (!LOG_KEYS.has(key)) throwMalformed(`"${at}.log" has unexpected key "${key}" (allowed: last_entry_datetime, prefix_hash)`, ctx);
    }
    if (typeof entry.log.last_entry_datetime !== 'string') {
      throwMalformed(`"${at}.log.last_entry_datetime" must be a string (found ${describe(entry.log.last_entry_datetime)})`, ctx);
    }
    if (typeof entry.log.prefix_hash !== 'string') {
      throwMalformed(`"${at}.log.prefix_hash" must be a string (found ${describe(entry.log.prefix_hash)})`, ctx);
    }
  }
}

/** Short human-readable type label for a value, used in malformed-shape messages. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Canonical serialization of a lock file (or a single split file — pass a LockFile
 * whose unused section is an empty object).
 *
 * Rules (spec §3):
 * - Keys sorted by code-point order (plain Array.prototype.sort(), never localeCompare) at every level.
 * - 2-space indent for the outer structure (version, verdicts, nodes sections).
 * - Each VerdictEntry and each LockNodeEntry rendered on a SINGLE line (compact JSON for leaf values).
 * - Trailing newline.
 *
 * This is a custom serializer — bare JSON.stringify with indent=2 puts entry fields on
 * separate lines, which is not acceptable.
 */
export function serializeLock(lock: LockFile): string {
  const lines: string[] = ['{'];

  lines.push(`  "version": ${lock.version},`);
  lines.push('  "verdicts": {');

  const aspectIds = Object.keys(lock.verdicts).sort();
  for (let ai = 0; ai < aspectIds.length; ai++) {
    const aspectId = aspectIds[ai];
    const unitMap = lock.verdicts[aspectId];
    lines.push(`    ${JSON.stringify(aspectId)}: {`);

    const unitKeys = Object.keys(unitMap).sort();
    for (let ui = 0; ui < unitKeys.length; ui++) {
      const unitKey = unitKeys[ui];
      const entry = unitMap[unitKey];
      const isLast = ui === unitKeys.length - 1;
      const comma = isLast ? '' : ',';
      lines.push(`      ${JSON.stringify(unitKey)}: ${serializeEntry(entry)}${comma}`);
    }

    const isLastAspect = ai === aspectIds.length - 1;
    lines.push(`    }${isLastAspect ? '' : ','}`);
  }

  lines.push('  },');
  lines.push('  "nodes": {');

  const nodePaths = Object.keys(lock.nodes).sort();
  for (let ni = 0; ni < nodePaths.length; ni++) {
    const nodePath = nodePaths[ni];
    const nodeEntry = lock.nodes[nodePath];
    const isLast = ni === nodePaths.length - 1;
    const comma = isLast ? '' : ',';
    lines.push(`    ${JSON.stringify(nodePath)}: ${serializeNodeEntry(nodeEntry)}${comma}`);
  }

  lines.push('  }'); // end nodes
  lines.push('}');
  lines.push(''); // trailing newline (join adds \n between, so this creates the trailing \n)

  return lines.join('\n');
}

/**
 * Serialize a VerdictEntry on a single line.
 * Fields are code-point sorted; optional fields omitted when absent.
 */
function serializeEntry(entry: VerdictEntry): string {
  // Collect all fields, sort keys code-point, render compactly.
  const obj: Record<string, unknown> = {};
  // Always-present fields first
  obj.verdict = entry.verdict;
  obj.hash = entry.hash;
  if (entry.reason !== undefined) obj.reason = entry.reason;
  // Pre-sorting touched (and the observation-key order) is the PRODUCER's contract — the store serializes the array as given.
  if (entry.touched !== undefined) obj.touched = entry.touched;
  // LLM only: the size of the prompt that produced this verdict. Enumerated here
  // like every other field because this serializer is an explicit allow-list, not
  // a pass-through — a field the producer sets but this function does not name is
  // silently dropped on write, and the round-trip then loses it without a word.
  if (entry.promptChars !== undefined) obj.promptChars = entry.promptChars;

  // Sort keys by code-point
  const sortedKeys = Object.keys(obj).sort();
  const pairs = sortedKeys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(obj[k])}`);
  return `{${pairs.join(',')}}`;
}

/**
 * Serialize a LockNodeEntry on a single line.
 * Fields are code-point sorted; optional fields omitted when absent.
 */
function serializeNodeEntry(entry: LockNodeEntry): string {
  const obj: Record<string, unknown> = {};
  if (entry.source !== undefined) obj.source = entry.source;
  if (entry.log !== undefined) obj.log = entry.log;

  const sortedKeys = Object.keys(obj).sort();
  if (sortedKeys.length === 0) return '{}';
  const pairs = sortedKeys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(obj[k])}`);
  return `{${pairs.join(',')}}`;
}

/** Split a verdicts map into deterministic vs nondeterministic by aspect kind. */
function partitionVerdicts(
  verdicts: Record<string, Record<string, VerdictEntry>>,
  deterministicAspectIds: Set<string>,
): { det: Record<string, Record<string, VerdictEntry>>; nondet: Record<string, Record<string, VerdictEntry>> } {
  const det: Record<string, Record<string, VerdictEntry>> = {};
  const nondet: Record<string, Record<string, VerdictEntry>> = {};
  for (const aspectId of Object.keys(verdicts)) {
    (deterministicAspectIds.has(aspectId) ? det : nondet)[aspectId] = verdicts[aspectId];
  }
  return { det, nondet };
}

/** Write atomically, skipping the write when on-disk content already matches (no churn). */
async function writeFileIfChanged(filePath: string, content: string): Promise<void> {
  try {
    if (readFileSync(filePath, 'utf-8') === content) return;
  } catch {
    // Absent or unreadable → write.
  }
  await atomicWriteFile(filePath, content);
}

/** Remove a file if it exists; absent is a no-op (ENOENT swallowed). */
function removeFileIfExists(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

/**
 * Write one split file, OR remove it when it would be empty. A split file is empty
 * when both its sections are empty objects — there is nothing to persist, so an
 * empty husk is not written (and an existing one is removed). readLock treats an
 * absent file as empty state, so this is transparent to every reader.
 */
async function writeOrRemoveSplitFile(
  filePath: string,
  version: number,
  verdicts: Record<string, Record<string, VerdictEntry>>,
  nodes: Record<string, LockNodeEntry>,
): Promise<void> {
  if (Object.keys(verdicts).length === 0 && Object.keys(nodes).length === 0) {
    removeFileIfExists(filePath);
    return;
  }
  await writeFileIfChanged(filePath, serializeLock({ version, verdicts, nodes }));
}

/** Options for {@link writeLock}. */
export interface WriteLockOptions {
  /**
   * Which files to (re)write:
   * - 'all' (default): all three files. Requires deterministicAspectIds.
   * - 'deterministic': ONLY the gitignored det file (committed files untouched —
   *   the `--only-deterministic` / CI path produces zero committed-lock churn).
   *   Requires deterministicAspectIds.
   * - 'logs': ONLY the logs file (the `nodes` section). No partition, so no set needed
   *   (used by `yg log merge-resolve`, which only mutates `nodes`).
   */
  scope?: 'all' | 'deterministic' | 'logs';
  /** Aspect ids whose verdicts belong in the gitignored deterministic file (reviewer.type === 'deterministic'). */
  deterministicAspectIds?: Set<string>;
}

/**
 * Serialize the unified lock to its split files and write atomically.
 *
 * The in-memory LockFile is partitioned by ASPECT KIND (deterministicAspectIds) — never by
 * the `touched` field, which a companion-backed LLM entry also carries. Each split file is a
 * full { version, verdicts, nodes } object with its unused section empty.
 */
export async function writeLock(yggRoot: string, lock: LockFile, opts: WriteLockOptions = {}): Promise<void> {
  const scope = opts.scope ?? 'all';

  // Every split file follows the same rule: when its section is empty there is
  // nothing to persist, so an empty husk is not written at all (an existing one is
  // removed). The LOGS file holds the per-node log/closure baseline; the two
  // verdict files hold the LLM and deterministic verdicts. readLock treats an
  // absent file as empty state, so this is transparent to every reader.
  if (scope === 'logs') {
    await writeOrRemoveSplitFile(logsLockPath(yggRoot), lock.version, {}, lock.nodes);
    return;
  }

  const detIds = opts.deterministicAspectIds;
  if (!detIds) {
    throw new Error(`writeLock: deterministicAspectIds is required for scope '${scope}'`);
  }
  const { det, nondet } = partitionVerdicts(lock.verdicts, detIds);

  if (scope === 'deterministic') {
    await writeOrRemoveSplitFile(detLockPath(yggRoot), lock.version, det, {});
    return;
  }

  // scope === 'all'
  await writeOrRemoveSplitFile(nondetLockPath(yggRoot), lock.version, nondet, {});
  await writeOrRemoveSplitFile(logsLockPath(yggRoot), lock.version, {}, lock.nodes);
  await writeOrRemoveSplitFile(detLockPath(yggRoot), lock.version, det, {});
}
