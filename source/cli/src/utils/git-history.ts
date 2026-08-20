/**
 * source/cli/src/utils/git-history.ts — the raw git plumbing R4's history walk
 * is built on: a streamed, typed `git log --raw` walk (full or resumed), a
 * long-lived `git cat-file --batch` blob reader, shallow-clone detection and
 * commit reachability (design §12's fidelity-fix row
 * `integration-design.md:457-458`; spec §13.1 `v6-spec.md:598-602`, §13.2
 * `:604-607`, §6.6 `:257`, §21.1 `:719`, Appendix G.1 `:1014`, G.2 `:1016`).
 *
 * NO roots concepts live here — no lifecycle rows, no scope keys, no cache
 * reads/writes. This module answers exactly one question, "what did the
 * commits between two points do to which paths and blobs", and answers it the
 * same way whether the caller is replaying history, testing a hypothesis
 * about a merge, or probing whether a stored sha is still reachable.
 *
 * FRAMING IS EMPIRICAL, NOT ASSUMED. Every byte shape this file parses —
 * the `-z` record framing, the `--date-order` ordering guarantee, the
 * `cat-file --batch` response framing — was captured from a real `git
 * version 2.43.0` and is pinned in `git-history.test.ts` against literal
 * captured samples, never against this comment's prose. Two claims an
 * earlier design leaned on turned out to be false against real repositories
 * and are recorded, and replaced, in the walk's own construction below:
 * `--reverse --date-order` does NOT deliver ascending committer timestamps
 * (its topological constraint outranks the date — a linear chain dated
 * day 60 → day 0 → day 121 walks in exactly that dipping order), and a
 * resumed walk's range is NOT a suffix of the full walk's order (it is a
 * SET DIFFERENCE — merging a branch started before the last index reorders
 * it relative to the full walk). The replay this file feeds needs neither
 * property: every file record below carries its OWN pre-image blob sha
 * (`preSha`), so a consumer never carries state between commits and never
 * depends on the order commits arrive in.
 *
 * STREAMED, NEVER BUFFERED WHOLE. A full `--raw` log over a real history is
 * hundreds of MB; `walkHistory` and the blob reader both parse their child's
 * stdout incrementally as chunks arrive, keeping only the trailing partial
 * token (never the whole output) in memory between chunks.
 *
 * ONE `cat-file --batch` CHILD PER OPEN HANDLE, never per read or per commit
 * (§13.2's "a single `cat-file --batch` child", `v6-spec.md:605`) —
 * `openBlobReader` opens the child once; `read()` may be called many times
 * (a caller windowing its fetches across a walk) and every call still
 * chunks its SHAs into <= 400-SHA writes into the SAME live child.
 * `readBlobs` is the one-shot `open → read → close` convenience wrapper for
 * every caller (every test in this file included) that only needs a single
 * batch.
 */

import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { toPosixPath } from './posix.js';
import { debugWrite } from './debug-log.js';
import { getHeadSha, getHeadCommitterTimestamp } from './git.js';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface HistoryFileRecord {
  // `--raw`'s status letter with any similarity SCORE STRIPPED: `-M` emits
  // `R100`, `R087`, `C075` and so on, never a bare `R`/`C` (verified against a
  // whole-directory `git mv`, which yields six `R100` records). This module
  // parses the leading letter and discards the digits.
  //
  // `'T'` (typechange — a regular file becoming a symlink or a submodule, or
  // the reverse) is in the union because git emits it. A `T` record is a
  // TOUCH and nothing more: it never resolves a scope set (no key is ever
  // derived from it), so it is never blob-resolved and never event-producing
  // in whatever replay consumes these records — that rule belongs to the
  // consumer, not this plumbing layer, but the shape here is what makes it
  // expressible: a `T` carries both shas non-null and no `newPath`, exactly
  // like an `M`.
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T';
  path: string; // POSIX, repo-relative; for R/C this is the OLD path
  newPath?: string; // present for R/C
  // The blob in THIS COMMIT'S OWN PARENT — by definition the pre-image `--raw`
  // itself hands over, which is what lets a consumer compare
  // `signature(postSha)` against `signature(preSha)` per record, with nothing
  // carried between commits. Null for A (the all-zero sha normalizes to null).
  preSha: string | null;
  postSha: string | null; // null for D
}

export interface HistoryCommitRecord {
  sha: string;
  committerTs: number; // epoch seconds
  authorHash: string; // sha256(name ∥ email), full hex
  authorKind: 'human' | 'agent';
  isFix: boolean;
  files: HistoryFileRecord[];
}

export interface WalkOptions {
  sinceSha?: string; // resume: walk sinceSha..HEAD (exclusive of sinceSha)
  maxCommits?: number; // 0 / undefined = uncapped
  sinceMonths?: number; // only when history.full === false
  agentIdentities: string[]; // config, compiled case-insensitively
}

// `onCommit` is a streaming callback: called once per walked commit, before
// the returned promise resolves, and NOTHING beyond that — no ordering
// promise in particular (the walk's own order is git's, not a contract this
// file can make, and a resumed walk's range is a set difference from a full
// walk's, never a suffix — see this file's header comment).
export function walkHistory(
  repoRoot: string,
  opts: WalkOptions,
  onCommit: (c: HistoryCommitRecord) => void,
): Promise<{ commits: number }> {
  return runWalk(repoRoot, opts, onCommit, spawn);
}

// HEAD is read OUTSIDE the walk and never derived from it: the walk is
// `--no-merges`, so when HEAD is a merge commit — the common case on any
// repository that merges PRs — the walk's last record is neither HEAD's sha
// nor HEAD's timestamp, while the model header's clock is HEAD's committer
// timestamp, full stop. Implemented through the landed helpers, never
// beside them: `getHeadSha`/`getHeadCommitterTimestamp`
// (`utils/git.ts:81-111`, deliberately without `--no-merges`, deliberately
// outside any walk), so a merge HEAD is visible here even though the walk
// itself never emits a record for it. `committerTs` is derived from
// `committerIso` (a parse of the same `%cI` string `utils/git.ts` already
// reads, rather than a second `rev-parse`/`log -1` pair that could drift
// from it) — see this file's own report for which of the two legal shapes
// (a `%ct` sibling in `git.ts`, or this parse) was taken.
export function readHead(repoRoot: string): {
  sha: string | null;
  committerTs: number | null;
  committerIso: string | null;
} {
  const sha = getHeadSha(repoRoot);
  const committerIso = getHeadCommitterTimestamp(repoRoot);
  if (sha === null || committerIso === null) {
    debugWrite(`[git-history] readHead: HEAD unavailable for ${repoRoot} (no repository, or no commits yet)`);
    return { sha, committerTs: null, committerIso };
  }
  const parsedMs = Date.parse(committerIso);
  const committerTs = Number.isNaN(parsedMs) ? null : Math.floor(parsedMs / 1000);
  return { sha, committerTs, committerIso };
}

export interface BlobReader {
  read(shas: readonly string[], onBlob: (sha: string, content: Buffer) => void | Promise<void>): Promise<void>;
  close(): void;
}

// One long-lived `git cat-file --batch` child, opened here and closed by the
// caller's `close()`. `read()` may be called many times against the same
// handle — each call chunks its own SHAs into <= 400-SHA writes into the
// SAME child, which is what lets a windowed walk (many `read()` rounds) stay
// under §13.2's "a single child" while still bounding any one write.
export function openBlobReader(repoRoot: string): BlobReader {
  return openBlobReaderWith(repoRoot, spawn);
}

// The one-shot convenience wrapper (open → read → close in a `finally`) for
// callers with a single batch — every test in this file, and nothing on a
// production walk's hot path (that path is T8's windowed probe-then-fetch,
// which holds one handle for the whole walk instead).
export async function readBlobs(
  repoRoot: string,
  shas: readonly string[],
  onBlob: (sha: string, content: Buffer) => void | Promise<void>,
): Promise<void> {
  const reader = openBlobReader(repoRoot);
  try {
    await reader.read(shas, onBlob);
  } finally {
    reader.close();
  }
}

/** `git rev-parse --is-shallow-repository` — `true` for a `--depth N` clone. */
export function isShallowRepository(repoRoot: string): boolean {
  try {
    const out = execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.trim() === 'true';
  } catch (e) {
    debugWrite(`[git-history] isShallowRepository failed for ${repoRoot}: ${errMsg(e)}`);
    return false;
  }
}

/** `git rev-parse --verify <sha>^{commit}` succeeding — a sha that still resolves to a real commit. */
export function isCommitReachable(repoRoot: string, sha: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', `${sha}^{commit}`], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch (e) {
    debugWrite(`[git-history] isCommitReachable(${sha}) failed for ${repoRoot}: ${errMsg(e)}`);
    return false;
  }
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/**
 * A `git log`/`git cat-file` child that spawned successfully (git IS present
 * and runnable) but exited non-zero — a genuine problem the caller must
 * interpret, never silently swallowed into "zero commits" or "zero blobs".
 * Contrast the OTHER failure shape both `walkHistory` and the blob reader
 * handle: the child failing to spawn AT ALL (`ENOENT` — no `git` binary on
 * `PATH`) is git being unavailable outright, which both fail SOFT on (an
 * empty walk / an empty read, one `debugWrite`, matching `utils/git.ts`'s
 * own "null on ANY git failure, missing binary included" contract for its
 * one-shot probes) — that case never reaches this class. The distinction
 * matters on a model-visible field: an unreachable `sinceSha` or a corrupt
 * repository must not be indistinguishable from "no new commits since the
 * last index", which a silent empty-walk return would make them.
 */
export class GitLogError extends Error {
  readonly stderrTail: string;
  constructor(message: string, stderrTail: string) {
    super(message);
    this.name = 'GitLogError';
    this.stderrTail = stderrTail;
  }
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** §13.2's chunk size for `cat-file --batch` request batches. */
const BLOB_BATCH_SIZE = 400;

/** Bound on the stderr tail kept for an error message — never the whole stream. */
const STDERR_TAIL_MAX = 4000;

/**
 * Field separator between the 5 header placeholders in this walk's
 * `--format` string. `%x00` inserts a LITERAL NUL byte — distinct from `-z`'s
 * own NUL record terminator, and what turns a commit's header into 5 clean,
 * unambiguous NUL-delimited tokens (sha, committer-ts, author name, author
 * email, raw body) rather than one string this module would have to
 * re-split with its own (locale/content-fragile) delimiter. Captured and
 * pinned against real git output in `git-history.test.ts` (Step 1).
 */
const HEADER_FIELD_SEP = '%x00';

/**
 * A `--raw -z` file-record status line:
 * `:<oldmode> <newmode> <oldsha> <newsha> <statusToken>`. The status letter
 * is captured broadly (`[A-Z]`, not the closed `AMDRCT` set the flag
 * combination `--raw --no-abbrev --no-merges -M` is empirically known to
 * produce) so an unexpected letter still parses as A RECORD LINE — the
 * alternative, narrowing the class, would make an unrecognized letter fail
 * this pattern and be silently misread as the SHA of the next commit's
 * header, desynchronizing the rest of the parse. `RAW_RECORD_RE.exec` losing
 * the match entirely is the failure this module cannot recover from cleanly;
 * matching with an odd letter is the failure it can shrug off structurally.
 */
const RAW_RECORD_RE = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z]\d*)$/;

/** G.1's fix classifier, exactly (`v6-spec.md:1014`) — the prototype's looser regex does not port. */
const FIX_SUBJECT_OR_REVERT_RE = /^(fix|hotfix|bugfix)\b|(^|\s)revert(s|ed)?\b/i;
/** The `git revert` auto-generated footer — the third of G.1's three fix clauses. */
const REVERTS_FOOTER_RE = /This reverts commit/;
/** A `Co-Authored-By:` trailer line, case-insensitive key, one capture per line (G.2, `v6-spec.md:1016`). */
const CO_AUTHORED_BY_RE = /^co-authored-by:\s*(.+)$/gim;

// -----------------------------------------------------------------------------
// Classifiers (Step 3)
// -----------------------------------------------------------------------------

/** sha256 of the `"name <email>"` identity string — full hex, never truncated. */
function computeAuthorHash(name: string, email: string): string {
  return createHash('sha256').update(`${name} <${email}>`).digest('hex');
}

/**
 * G.2: agent iff the commit's OWN author identity, or any `Co-Authored-By`
 * trailer in the body, matches any compiled `agentIdentities` pattern. Both
 * are tested against the same `"name <email>"` shape so a pattern anchored
 * on either half (a bot's login name, or its noreply email domain) matches
 * without this module needing to know which half a given identity lives in.
 */
function classifyAuthorKind(name: string, email: string, body: string, agentPatterns: RegExp[]): 'human' | 'agent' {
  const authorIdentity = `${name} <${email}>`;
  if (agentPatterns.some((re) => re.test(authorIdentity))) return 'agent';
  for (const trailerMatch of body.matchAll(CO_AUTHORED_BY_RE)) {
    if (agentPatterns.some((re) => re.test(trailerMatch[1]))) return 'agent';
  }
  return 'human';
}

/**
 * G.1 exactly: the fix/hotfix/bugfix/revert regex OR a body containing the
 * `git revert` footer. Tested against the WHOLE raw body (`%B`), not just
 * the subject line — `FIX_SUBJECT_OR_REVERT_RE`'s `(^|\s)revert` branch
 * already reads correctly over a multi-line string with no `/m` flag needed
 * (an embedded newline IS `\s`), so this one test covers "starts with a fix
 * prefix" (anchored at the true start of the whole message, i.e. the
 * subject) and "contains revert anywhere" (any line) without a separate
 * subject-only pass.
 */
function classifyIsFix(body: string): boolean {
  return FIX_SUBJECT_OR_REVERT_RE.test(body) || REVERTS_FOOTER_RE.test(body);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The all-zero sha `--raw` emits for "no blob on this side" (an `A`'s pre-image, a `D`'s post-image) — normalized to `null`. */
function normalizeSha(sha: string): string | null {
  return /^0+$/.test(sha) ? null : sha;
}

// -----------------------------------------------------------------------------
// The walk (Step 1 framing, Step 2 streaming, Step 5 resume/windowing)
// -----------------------------------------------------------------------------

/**
 * Builds the `git log` argument vector. The flag set is R4's binding one
 * (`--reverse --raw --no-abbrev --no-merges -M`) plus `--date-order`, stated
 * explicitly rather than left as git's own default: it turns "no commit is
 * delivered before its own parent; among commits with no ancestry relation
 * the committer date decides" into a STATED contract a future git cannot
 * silently change out from under this walk (verified: `--reverse`,
 * `--reverse --date-order` and `--reverse --topo-order` are IDENTICAL on a
 * linear chain dated day 60 → day 0 → day 121 — all three walk in that
 * exact dipping order — because the topological constraint outranks the
 * date on every one of them). `--topo-order` stays forbidden anywhere in
 * this walk, exactly as `--follow` is.
 *
 * `--max-count=N`, when set, is NOT "the newest N commits by committer
 * date" — that reading is empirically false and is not this walk's
 * contract. `--max-count` truncates the TRAVERSAL at N commits and
 * `--reverse` is applied afterwards; with `--date-order` the traversal is
 * date-ordered subject to the child-before-parent constraint, so the capped
 * set is the newest N IN TRAVERSAL ORDER, which coincides with "newest N by
 * date" only on a history whose dates never dip below a parent's (verified:
 * on the day 60 → day 0 → day 121 chain, `--max-count=2` yields day 0 and
 * day 121 — EXCLUDING day 60, the newer commit). Naming the flag makes the
 * capped set stated rather than inherited from a default; it does not make
 * it "newest by date".
 */
function buildLogArgs(opts: WalkOptions): string[] {
  const format = ['%H', '%ct', '%an', '%ae', '%B'].join(HEADER_FIELD_SEP);
  const args = ['log', '--reverse', '--date-order', '--raw', '--no-abbrev', '--no-merges', '-M', '-z', `--format=${format}`];
  if (opts.maxCommits && opts.maxCommits > 0) args.push(`--max-count=${opts.maxCommits}`);
  if (opts.sinceMonths !== undefined) args.push(`--since=${opts.sinceMonths} months ago`);
  if (opts.sinceSha) args.push(`${opts.sinceSha}..HEAD`);
  return args;
}

type SpawnFn = typeof spawn;

/** In-progress state for one file record whose status line is parsed but whose path(s) have not all arrived yet. */
interface PendingRecordState {
  status: string;
  oldSha: string | null;
  newSha: string | null;
  isRenameOrCopy: boolean;
  pathsNeeded: number; // 2 immediately after an R/C status line (old path still to come), 1 otherwise
  firstPath: string;
}

interface PendingCommitState {
  sha: string;
  ct: number;
  an: string;
  ae: string;
  body: string;
  files: HistoryFileRecord[];
}

function runWalk(
  repoRoot: string,
  opts: WalkOptions,
  onCommit: (c: HistoryCommitRecord) => void,
  spawnFn: SpawnFn,
): Promise<{ commits: number }> {
  const agentPatterns = opts.agentIdentities.map((p) => new RegExp(p, 'i'));
  const args = buildLogArgs(opts);

  return new Promise((resolve, reject) => {
    const child = spawnFn('git', args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });

    let settled = false;
    let commits = 0;
    let stderrTail = '';
    let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);

    let mode: 'header' | 'diff' = 'header';
    let headerFields: string[] = [];
    let pendingCommit: PendingCommitState | null = null;
    let pendingRecord: PendingRecordState | null = null;

    function flushPendingCommit(): void {
      if (!pendingCommit) return;
      const c = pendingCommit;
      onCommit({
        sha: c.sha,
        committerTs: c.ct,
        authorHash: computeAuthorHash(c.an, c.ae),
        authorKind: classifyAuthorKind(c.an, c.ae, c.body, agentPatterns),
        isFix: classifyIsFix(c.body),
        files: c.files,
      });
      commits++;
      pendingCommit = null;
    }

    function pushFileRecord(rec: PendingRecordState, lastPath: string): void {
      if (!pendingCommit) return;
      const status = rec.status as HistoryFileRecord['status'];
      if (rec.isRenameOrCopy) {
        pendingCommit.files.push({
          status,
          path: toPosixPath(rec.firstPath),
          newPath: toPosixPath(lastPath),
          preSha: rec.oldSha,
          postSha: rec.newSha,
        });
      } else {
        pendingCommit.files.push({
          status,
          path: toPosixPath(lastPath),
          preSha: rec.oldSha,
          postSha: rec.newSha,
        });
      }
    }

    function handleToken(raw: string): void {
      if (mode === 'header') {
        headerFields.push(raw);
        if (headerFields.length === 5) {
          const [sha, ctStr, an, ae, body] = headerFields;
          pendingCommit = { sha, ct: Number(ctStr), an, ae, body, files: [] };
          headerFields = [];
          mode = 'diff';
        }
        return;
      }

      // mode === 'diff'
      if (pendingRecord) {
        if (pendingRecord.isRenameOrCopy && pendingRecord.pathsNeeded === 2) {
          pendingRecord.firstPath = raw;
          pendingRecord.pathsNeeded = 1;
          return;
        }
        pushFileRecord(pendingRecord, raw);
        pendingRecord = null;
        return;
      }

      // A leading `\n` is git's blank separator line between the format
      // output and the first raw record of a commit's diff — present ONLY
      // on that first record's own token, never on later ones (verified:
      // Step 1's captures). Stripping it unconditionally here is safe: a
      // later token that never had one is unaffected.
      const bare = raw.startsWith('\n') ? raw.slice(1) : raw;
      const m = RAW_RECORD_RE.exec(bare);
      if (m) {
        const [, , , oldShaRaw, newShaRaw, statusToken] = m;
        const letter = statusToken[0];
        const isRenameOrCopy = letter === 'R' || letter === 'C';
        pendingRecord = {
          status: letter,
          oldSha: normalizeSha(oldShaRaw),
          newSha: normalizeSha(newShaRaw),
          isRenameOrCopy,
          pathsNeeded: isRenameOrCopy ? 2 : 1,
          firstPath: '',
        };
        return;
      }

      // Not a record line: this token is the SHA of the NEXT commit's
      // header (reachable both when the previous commit had file records —
      // this is simply the token right after its last one — and when it had
      // NONE at all, e.g. an `--allow-empty` commit, in which case this
      // token follows directly after the body field with no diff tokens in
      // between). Either way, the commit just finished is now complete.
      flushPendingCommit();
      headerFields = [raw];
      mode = 'header';
    }

    child.stdout!.on('data', (chunk: Buffer) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      for (;;) {
        const idx = buf.indexOf(0);
        if (idx === -1) break;
        const tokenBuf = buf.subarray(0, idx);
        buf = buf.subarray(idx + 1);
        handleToken(tokenBuf.toString('utf-8'));
      }
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf-8')).slice(-STDERR_TAIL_MAX);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      // Git itself unavailable (ENOENT — no `git` on PATH): the fail-soft
      // degrade, matching `utils/git.ts`'s own "null/empty on ANY git
      // failure, missing binary included" contract for its one-shot probes.
      // An empty walk, never a rejection — a caller cannot meaningfully
      // "degrade" from a walk that never started any other way.
      debugWrite(`[git-history] walkHistory: git unavailable for ${repoRoot}: ${errMsg(err)}`);
      resolve({ commits: 0 });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0 && code !== null) {
        debugWrite(`[git-history] walkHistory: git log exited ${code} for ${repoRoot}; stderr tail: ${stderrTail}`);
        reject(new GitLogError(`git log exited with code ${code}`, stderrTail));
        return;
      }
      flushPendingCommit();
      resolve({ commits });
    });
  });
}

// -----------------------------------------------------------------------------
// Blob reader (Step 4)
// -----------------------------------------------------------------------------

type BlobDispatch = (sha: string, content: Buffer) => void;

/**
 * Attaches the byte-counted `cat-file --batch` response parser to a live
 * child: `<sha> <type> <size>\n<content>\n` for a hit, `<sha> missing\n` for
 * a miss. Framing is read by BYTE COUNT once `size` is known, never by
 * scanning for the next newline — blob content routinely contains blank
 * lines, and a newline-scanning parser truncates at the first one inside the
 * content (verified: a blob containing an embedded blank line is byte-exact
 * under this parser and would NOT be under a newline-split one).
 */
function attachBlobResponseParser(stdout: NodeJS.ReadableStream, dispatch: BlobDispatch): void {
  let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let awaiting: { sha: string; size: number } | null = null;

  stdout.on('data', (chunk: Buffer) => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    for (;;) {
      if (!awaiting) {
        const nl = buf.indexOf(0x0a);
        if (nl === -1) break;
        const line = buf.subarray(0, nl).toString('utf-8');
        buf = buf.subarray(nl + 1);
        const spaceIdx = line.indexOf(' ');
        /* v8 ignore next 4 -- defense against a corrupt/future cat-file response
         * shape; every real `git cat-file --batch` response line is either
         * `<sha> missing` or `<sha> <type> <size>`, both of which always
         * contain a space, so this branch is unreachable against any real git. */
        if (spaceIdx === -1) {
          debugWrite(`[git-history] cat-file: unparseable response header (no space): ${line}`);
          continue;
        }
        const sha = line.slice(0, spaceIdx);
        const rest = line.slice(spaceIdx + 1);
        if (rest === 'missing') {
          debugWrite(`[git-history] cat-file: object missing: ${sha}`);
          dispatch(sha, Buffer.alloc(0));
          continue;
        }
        const typeAndSize = /^\S+ (\d+)$/.exec(rest);
        /* v8 ignore next 4 -- same defense as above: a real response line that
         * is not `missing` is always `<type> <size>` (`blob 123`, `tree 0`, …);
         * unreachable against any real git. */
        if (!typeAndSize) {
          debugWrite(`[git-history] cat-file: unparseable response header: ${line}`);
          continue;
        }
        awaiting = { sha, size: Number(typeAndSize[1]) };
        continue;
      }
      const need = awaiting.size + 1; // +1 for the trailing '\n' after content
      if (buf.length < need) break;
      const content = Buffer.from(buf.subarray(0, awaiting.size));
      buf = buf.subarray(need);
      const sha = awaiting.sha;
      awaiting = null;
      dispatch(sha, content);
    }
  });
}

function openBlobReaderWith(repoRoot: string, spawnFn: SpawnFn): BlobReader {
  const child = spawnFn('git', ['cat-file', '--batch'], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });

  let closed = false;
  let fatalError: Error | null = null;
  let activeReject: ((err: Error) => void) | null = null;
  let activeDispatch: BlobDispatch | null = null;
  let stderrTail = '';

  const onFatal = (err: Error): void => {
    fatalError = err;
    debugWrite(`[git-history] cat-file --batch: ${errMsg(err)}`);
    if (activeReject) {
      const reject = activeReject;
      activeReject = null;
      activeDispatch = null;
      reject(err);
    }
  };

  attachBlobResponseParser(child.stdout!, (sha, content) => {
    if (activeDispatch) activeDispatch(sha, content);
  });

  child.stderr!.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf-8')).slice(-STDERR_TAIL_MAX);
  });

  child.on('error', (err) => onFatal(err));
  // Without this listener, a write into a child that has already exited (a
  // non-git `repoRoot`, where `cat-file --batch` fails and exits before ever
  // reading stdin, is the common trigger) raises an EPIPE on `child.stdin`
  // itself — a stream distinct from the child process object `child.on(
  // 'error', ...)` above covers. An EventEmitter's unhandled 'error' event
  // throws synchronously, which here becomes an UNCAUGHT EXCEPTION that
  // aborts the whole process — exactly what R4-I10 forbids for a planned
  // degraded mode (no git / no repository, R4-I4). Routing it through the
  // same `onFatal` degrades it into the in-flight `read()`'s rejection
  // instead, identically to the ENOENT (spawn-failure) case above.
  child.stdin!.on('error', (err) => onFatal(err));
  child.on('close', (code, signal) => {
    if (code !== 0 && code !== null) {
      onFatal(new Error(`git cat-file --batch exited with code ${code}. stderr tail: ${stderrTail}`));
      return;
    }
    // A mid-stream death by signal (killed, OOM-killed, ...) reports `code:
    // null` exactly like a clean `stdin.end()`-triggered exit does, so `code`
    // alone cannot distinguish them; `signal` is non-null only for the
    // former. Left unhandled, a read() already in flight when the child dies
    // this way would never settle (no more `close`/`error` event ever
    // arrives) — the exact unbounded hang R4-I10 forbids as much as a crash.
    if (signal) {
      onFatal(new Error(`git cat-file --batch terminated by signal ${signal}. stderr tail: ${stderrTail}`));
    }
  });

  let queue: Promise<void> = Promise.resolve();

  function doRead(shas: readonly string[], onBlob: (sha: string, content: Buffer) => void | Promise<void>): Promise<void> {
    if (fatalError) return Promise.reject(fatalError);
    if (closed) return Promise.reject(new Error('BlobReader is closed'));
    if (shas.length === 0) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      let remaining = shas.length;
      const pending: Promise<void>[] = [];
      activeReject = reject;
      activeDispatch = (sha, content) => {
        let result: void | Promise<void>;
        try {
          result = onBlob(sha, content);
        } catch (e) {
          activeDispatch = null;
          activeReject = null;
          reject(e as Error);
          return;
        }
        if (result && typeof (result as Promise<void>).then === 'function') pending.push(result as Promise<void>);
        remaining--;
        if (remaining === 0) {
          activeDispatch = null;
          activeReject = null;
          Promise.all(pending).then(
            () => resolve(),
            (e) => reject(e as Error),
          );
        }
      };
      // Chunked into <= BLOB_BATCH_SIZE-line writes (§13.2) — several writes
      // into the SAME live child rather than one write per read() call, so a
      // single read() over more than the chunk size still respects the
      // stated per-request-batch bound.
      for (let i = 0; i < shas.length; i += BLOB_BATCH_SIZE) {
        const chunk = shas.slice(i, i + BLOB_BATCH_SIZE);
        child.stdin!.write(chunk.map((s) => `${s}\n`).join(''));
      }
    });
  }

  function read(shas: readonly string[], onBlob: (sha: string, content: Buffer) => void | Promise<void>): Promise<void> {
    // Serialized: a caller issuing overlapping read() calls without
    // awaiting still gets each batch's responses routed to the RIGHT
    // callback, since only one read is ever "active" against the shared
    // response stream at a time.
    const run = queue.then(() => doRead(shas, onBlob));
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function close(): void {
    if (closed) return;
    closed = true;
    try {
      child.stdin!.end();
    } catch {
      // Already ended/destroyed — closing an already-closed handle is a no-op.
    }
  }

  return { read, close };
}
