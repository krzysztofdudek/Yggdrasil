/**
 * source/cli/src/cli/roots.ts — `yg roots index` and `yg roots status`, the
 * two commands R1-R3 ships (design §3, `integration-design.md:74-75`: naming
 * uses Yggdrasil's own vocabulary — index, like a build — not the prototype's
 * `learn`; `check`/`where`/`spectrum`/`report`/… are later packages). This is
 * the ONLY file that composes the roots engine (`src/roots/**`) with the
 * roots store (`src/roots/stores.ts`) — Task 1's seam: engine never imports
 * the store, so seeds/config/header assembly all happen here.
 *
 * CONFIG-ONLY LOAD (plan invariant I10): both commands compose
 * `findYggRoot` (`io/paths.ts`) + `parseConfig` (`io/config-parser.ts`)
 * directly and NEVER call `loadGraphOrAbort` / `loadGraph`. Mining touches no
 * graph — a repo with a `.yggdrasil/yg-config.yaml` and nothing else (no
 * `model/`, no aspects) is a complete, valid target for `index`, and loading
 * graph state these commands never read would make that valid target fail.
 *
 * `cli-command-contract`, applied precisely: the contract's graph-loading
 * rule is scoped to "commands REQUIRING GRAPH STATE", which neither of these
 * is — so the rule these commands answer to is the string-ownership one: no
 * command body inlines the missing-graph string or an ENOENT-shaped branch
 * of its own. Both satisfy it by delegation to `cli/preamble.ts`, the one
 * module that owns BOTH flavors of the missing-project case: `index`'s
 * refusal path (a build cannot proceed without a project) delegates to the
 * shared `abortUnlessYggdrasilExists` helper — which the contract itself
 * names as owning the canonical missing-graph string and the `exit(1)` —
 * and `status`'s report path (nothing to gate, so a missing project is an
 * honest exit-0 answer) delegates to the shared `missingProjectReport`
 * helper beside it. Neither command carries wording of its own for either
 * case.
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import type { Command } from 'commander';
import chalk from 'chalk';
import { findYggRoot, projectRootFromGraph } from '../io/paths.js';
import { parseConfig, ConfigParseError } from '../io/config-parser.js';
import { readFileOrDefault } from '../io/read-or-default.js';
import { hashString } from '../io/hash.js';
import {
  hashStoreFile,
  readSeeds,
  readLedger,
  writeModel,
  readModel,
  rootsStoreDir,
  rootsBlobCacheDir,
  rootsHistoryStateDir,
  rootsBuildLockPath,
  ROOTS_VERSION,
  SEEDS_FILENAME,
  DECISIONS_FILENAME,
  LEDGER_FILENAME,
  type RootsModel,
  type RootsModelHeader,
} from '../roots/stores.js';
import { rootsConfigHash } from '../roots/config.js';
import { runRootsIndex, computeUsedGrammarSetHash } from '../roots/pipeline.js';
import { isMinedModel } from '../roots/mine.js';
import { resolveWalkMode, type WalkMode, type HistoryProgressInfo } from '../roots/history.js';
import { acquireBuildLock, releaseBuildLock, BuildLockHeldError } from '../io/roots-build-lock-store.js';
import type { YggConfig, RootsConfig } from '../model/graph.js';
import { getHeadSha, getHeadCommitterTimestamp, getDirtyFiles } from '../utils/git.js';
import { countCommitsInRange } from '../utils/git-history.js';
import { toPosixPath } from '../utils/posix.js';
import { debugWrite } from '../utils/debug-log.js';
import { buildIssueMessage, type IssueMessage } from '../formatters/message-builder.js';
import { abortOnUnexpectedError, abortUnlessYggdrasilExists, missingProjectReport } from './preamble.js';

/** Emit a blocking what/why/next error to stderr and exit(1) — nothing is written. `never`-typed so a caller can `return failWith(...)` and keep its own return type. */
function failWith(msg: IssueMessage): never {
  process.stderr.write(chalk.red(`Error: ${buildIssueMessage(msg)}`) + '\n');
  process.exit(1);
}

function handleError(error: unknown): never {
  debugWrite(`[roots] command failed: ${(error as Error).message}`);
  abortOnUnexpectedError(error, 'running roots command');
}

/**
 * `findYggRoot`'s walk-up search for the nearest `.yggdrasil/` (so `index`,
 * like every other command, works from any subdirectory of the project) —
 * or the canonical what/why/next missing-graph error and `exit(1)`, OWNED by
 * the shared `abortUnlessYggdrasilExists` helper (`cli/preamble.ts`), never
 * inlined here (`cli-command-contract`: "commands must never inline that
 * string themselves"). This is the exact delegation shape `init --upgrade`'s
 * own missing-graph guard uses. By the time `findYggRoot` has walked from
 * `process.cwd()` all the way to the filesystem root without finding a
 * `.yggdrasil/` anywhere, `process.cwd()/.yggdrasil` — the very first
 * candidate `findYggRoot` itself checks — is guaranteed absent too, so the
 * helper's own `stat` always confirms that and always calls `exit(1)`; it
 * never returns on this path (`abortUnlessYggdrasilExists` only `stat`s a
 * directory — it never loads the graph, so I10 still holds).
 */
async function findYggRootOrFail(): Promise<string> {
  try {
    return await findYggRoot(process.cwd());
  } catch (err) {
    debugWrite(`[roots] index: no .yggdrasil/ found from ${process.cwd()}: ${(err as Error).message}`);
    await abortUnlessYggdrasilExists(path.join(process.cwd(), '.yggdrasil'), {
      why: '`yg roots index` reads and writes convention-mining state under .yggdrasil/, which requires an initialized graph at the project root.',
      next: "Run 'yg init' to bootstrap the graph, then re-run this command.",
    });
    // Unreachable: abortUnlessYggdrasilExists exits(1) on the only path that
    // reaches here (see doc comment above) — this only satisfies the
    // Promise<string> return type for the type checker.
    throw new Error('unreachable: abortUnlessYggdrasilExists should have exited', { cause: err });
  }
}

/** `parseConfig`, or the parser's own structured error and exit(1). Any OTHER error (a genuine I/O fault) is rethrown for the caller's catch-all. */
async function parseConfigOrFail(configPath: string): Promise<YggConfig> {
  try {
    return await parseConfig(configPath);
  } catch (err) {
    if (err instanceof ConfigParseError) {
      debugWrite(`[roots] index: yg-config.yaml parse failed: ${err.message}`);
      return failWith(err.messageData);
    }
    throw err;
  }
}

const ROOTS_SCAFFOLD_MESSAGE =
  'No `roots:` block found in .yggdrasil/yg-config.yaml — adding it with default settings.\n';

/**
 * Add an empty `roots: {}` block to the committed `yg-config.yaml`, leaving
 * every other key (and every comment) untouched — design
 * `integration-design.md:399-400`: "`yg roots index` on a repo without the
 * block scaffolds it with defaults, printed first." An empty mapping is
 * sufficient: `io/config-parser.ts`'s `parseRootsSection` fills every §4.5
 * key from its documented default the moment the block is merely PRESENT, so
 * writing `{}` and re-parsing is how the caller recovers the fully-defaulted
 * `RootsConfig` — no duplicated default table lives here.
 *
 * Follows the `writeReviewerConfig` precedent (`init-reviewer-setup.ts:263-
 * 301`) in spirit — read the committed file, merge in one new section, write
 * it back — but NOT in mechanism: that precedent round-trips through a plain
 * `yaml.parse`/`yaml.stringify` pair, which re-serializes the WHOLE document
 * and drops every comment in it (acceptable there, since `init` writes a
 * fresh `reviewer:` block on a config an adopter has rarely hand-annotated
 * yet). A `yg-config.yaml` `index` scaffolds into, by contrast, is routinely
 * an already-annotated, long-lived project file (this repository's own is a
 * working example) — silently deleting every comment in it on the FIRST run
 * of an unrelated command would be a surprising, unrecoverable side effect.
 * `yaml`'s `parseDocument`/`Document#set` CST-preserving API edits the
 * document in place instead: every existing key, value, and comment is
 * preserved (the YAML writer may re-space a flow collection's brackets, but
 * loses nothing), and only the new `roots: {}` mapping is appended.
 *
 * Idempotent by construction, not by an extra check here: the ONE call site
 * (`index`'s action, below) only ever invokes this when `config.roots` is
 * already `undefined`, so a project that already carries a `roots:` block
 * never reaches this function on a later run.
 */
export async function scaffoldRootsBlock(configPath: string): Promise<void> {
  const raw = await readFile(configPath, 'utf-8');
  const doc = parseDocument(raw);
  doc.set('roots', {});
  await writeFile(configPath, doc.toString(), 'utf-8');
}

/**
 * The roots model header's working-tree dirty-file content hash (spec
 * `v6-spec.md:80`, the field's ONLY definition): sha256 over the sorted
 * `relPath -> sha256(content)` map of every path {@link getDirtyFiles}
 * reports, with every path under `.yggdrasil/roots/**` EXCLUDED — `index`
 * itself writes that directory, so an unfiltered dirty list would make the
 * header churn on every run even when nothing the adopter touched actually
 * changed (this is exactly what the double-index byte-identity E2E case
 * catches if this exclusion ever regresses). A non-git repository ({@link
 * getDirtyFiles} returning `null`) folds to the hash of the EMPTY map — a
 * real, honest, non-null string (unlike `headSha`/`clock`/`lastIndexedSha`,
 * `dirtyHash`'s header field is never nullable), matching the "no dirty
 * files are knowable" fact for a repo with no git at all. A dirty path that
 * no longer exists on disk (a deletion `git status` reports) hashes as the
 * empty string, the same convention {@link hashStoreFile} uses for an absent
 * store file.
 */
export async function computeDirtyHash(yggRoot: string, repoRoot: string): Promise<string> {
  const dirty = getDirtyFiles(repoRoot) ?? [];
  const rootsRelDir = `${toPosixPath(path.relative(repoRoot, rootsStoreDir(yggRoot)))}/`;
  const filtered = dirty.filter((relPath) => !relPath.startsWith(rootsRelDir)).sort();

  const perFile: Record<string, string> = {};
  for (const relPath of filtered) {
    const content = await readFileOrDefault(path.join(repoRoot, relPath), '');
    perFile[relPath] = hashString(content);
  }
  return hashString(JSON.stringify(perFile, Object.keys(perFile).sort()));
}

/** Every already-computed piece {@link assembleRootsModelHeader} folds into one `RootsModelHeader` — split out so the ownership table's ASSEMBLY step (as opposed to each field's own computation) is a small, independently unit-testable mapping. */
export interface RootsHeaderInputs {
  configHash: string;
  seedsHash: string;
  decisionsHash: string;
  ledgerHash: string;
  headSha: string | null;
  /**
   * The commit the history is indexed THROUGH (spec §6.6 clause 3) — `null`
   * in every degraded mode: no git repository, a shallow clone, or a walk
   * that threw (`buildHistoryJoin` returns `undefined` for all three, T8
   * Step 2), and ALSO `null` when `index` is not attempting a history join at
   * all. The caller (`index`'s action, below) is the one place that can tell
   * these apart from "a successful index that walked history" — see that
   * call site's own comment for exactly how it decides.
   */
  lastIndexedSha: string | null;
  clock: string | null;
  dirtyHash: string;
  bindingHash: string;
  candidateCountLog2: number;
}

/**
 * Assembles the roots model header from its already-computed inputs, per
 * Task 1's ownership table (`integration-design.md:140-142`): `rootsVersion`
 * is this store's own schema constant; `rolesStale` is `false` (every build
 * fully re-induces roles, so staleness is always knowable and never claimed
 * as unknown). Every other field, `lastIndexedSha` included, is copied
 * straight from `inputs` — this function's only job is naming which input
 * fills which header slot, kept as its own small mapping so a field getting
 * swapped with another (e.g. `configHash` written where `bindingHash`
 * belongs) is a one-function bug with a one-function fix. `lastIndexedSha`'s
 * OWN honesty rule — null unless the walk actually ran and its state was
 * committed — is decided by the caller, never re-decided here (R4 Task 9):
 * this function trusts whatever it is handed.
 */
export function assembleRootsModelHeader(inputs: RootsHeaderInputs): RootsModelHeader {
  return {
    rootsVersion: ROOTS_VERSION,
    headSha: inputs.headSha,
    lastIndexedSha: inputs.lastIndexedSha,
    clock: inputs.clock,
    bindingHash: inputs.bindingHash,
    configHash: inputs.configHash,
    seedsHash: inputs.seedsHash,
    decisionsHash: inputs.decisionsHash,
    ledgerHash: inputs.ledgerHash,
    dirtyHash: inputs.dirtyHash,
    candidateCountLog2: inputs.candidateCountLog2,
    rolesStale: false,
  };
}

/**
 * `yg roots status`'s full report, as text — never throws, never signals
 * failure through its return value alone. Every state this repository can
 * genuinely be in (no project, unreadable config, dormant, configured but
 * never indexed, an unreadable or malformed committed model, or a real
 * indexed model) renders as its own honest, read-only paragraph; the
 * outermost catch is a last-resort safety net so a bug elsewhere in this
 * chain still reports SOMETHING rather than crashing the command — spec
 * `v6-spec.md:706` ("All read surfaces exit 0 by default") and design `:84`
 * (R7's `--exit-code` is the only gate-capable roots surface, and it is opt-
 * in, deliberately not shipped here): `status` on a dormant, unconfigured, or
 * even damaged repo is information, never a CI-gating failure.
 */
export async function renderRootsStatus(cwd: string): Promise<string> {
  try {
    return await renderRootsStatusInner(cwd);
  } catch (err) {
    debugWrite(`[roots] status failed unexpectedly: ${(err as Error).message}`);
    return `Roots: status could not be determined (${(err as Error).message}).\n`;
  }
}

async function renderRootsStatusInner(cwd: string): Promise<string> {
  let yggRoot: string;
  try {
    yggRoot = await findYggRoot(cwd);
  } catch (err) {
    debugWrite(`[roots] status: no .yggdrasil/ found from ${cwd}: ${(err as Error).message}`);
    // `status` never gates anything, so a missing project is an honest
    // read-only report (exit 0), not the missing-graph refusal `index`
    // uses. The report string itself is owned by the shared
    // `missingProjectReport` helper in `cli/preamble.ts`, beside the
    // canonical abort helper — this command body inlines no
    // missing-project wording of its own (`cli-command-contract`).
    return missingProjectReport('Roots', "Run 'yg init' to bootstrap a project, then 'yg roots index' to start mining conventions.");
  }

  const configPath = path.join(yggRoot, 'yg-config.yaml');
  let config: YggConfig;
  try {
    config = await parseConfig(configPath);
  } catch (err) {
    const message = err instanceof ConfigParseError ? err.messageData.what : (err as Error).message;
    debugWrite(`[roots] status: yg-config.yaml parse failed: ${message}`);
    return `Roots: .yggdrasil/yg-config.yaml could not be read (${message}).\nFix the config file, then re-run 'yg roots status'.\n`;
  }

  if (config.roots === undefined) {
    return (
      'Roots: dormant — no `roots:` block in .yggdrasil/yg-config.yaml.\n' +
      "Run 'yg roots index' to add it with default settings and start mining conventions.\n"
    );
  }

  let stored: RootsModel | undefined;
  try {
    stored = await readModel(yggRoot);
  } catch (err) {
    debugWrite(`[roots] status: model.json read failed: ${(err as Error).message}`);
    return (
      `Roots: configured, but the committed model at .yggdrasil/roots/model.json could not be read (${(err as Error).message}).\n` +
      "Run 'yg roots index' to regenerate it.\n"
    );
  }

  if (stored === undefined) {
    return (
      'Roots: configured, but never indexed.\n' +
      "Run 'yg roots index' to mine the repository for conventions.\n"
    );
  }

  if (!isMinedModel(stored.body)) {
    return (
      'Roots: the committed model at .yggdrasil/roots/model.json does not have the expected shape.\n' +
      "Run 'yg roots index' to regenerate it.\n"
    );
  }

  const body = stored.body;
  const header = stored.header;
  const totalFacts = body.partitions.reduce((n, p) => n + p.facts.length, 0);
  const totalRoles = body.partitions.reduce((n, p) => n + p.roles.length, 0);
  const totalSeeds = body.partitions.reduce((n, p) => n + p.seeds.length, 0);

  const lastIndexedLine =
    header.headSha !== null && header.clock !== null
      ? `  Last indexed at commit ${header.headSha.slice(0, 7)}, committed ${header.clock}.\n`
      : '  Last indexed outside version control (no git history).\n';

  return (
    `${chalk.green('Roots: indexed.')}\n` +
    lastIndexedLine +
    `  Partitions: ${body.partitions.length}\n` +
    `  Facts: ${totalFacts}\n` +
    `  Roles: ${totalRoles}\n` +
    `  Seeds: ${totalSeeds}\n`
  );
}

// -----------------------------------------------------------------------------
// D13 — the no-op index short-circuit. Computed BEFORE `acquireBuildLock`:
// creating and then deleting the lock file is itself a write to the cache
// directory, and §6.6 clause 6 allows a genuine no-op run ZERO writes
// (`v6-spec.md:260`).
// -----------------------------------------------------------------------------

/** The eight header INPUT fields D13 compares field by field — `candidateCountLog2`/`rolesStale`/`rootsVersion`/`lastIndexedSha` are OUTPUTS and are deliberately excluded (D13's own list). */
export interface NoOpShortCircuitHeaderInputs {
  headSha: string | null;
  clock: string | null;
  dirtyHash: string;
  configHash: string;
  seedsHash: string;
  decisionsHash: string;
  ledgerHash: string;
  bindingHash: string;
}

/**
 * D13's four conditions, as one pure predicate over already-computed values —
 * no I/O of its own, so a unit test can flip exactly one condition per case
 * (T9 Step 1's own requirement) without a real repository. `storedHeader`
 * being `undefined` is D13's own "no comparable header" case (an absent
 * model, or one `readModel` could not parse) — condition 1 fails immediately
 * and every other field is irrelevant, matching the short-circuit's own
 * short-circuiting `if` chain.
 */
export interface NoOpShortCircuitInputs {
  storedHeader: RootsModelHeader | undefined;
  currentHeaderInputs: NoOpShortCircuitHeaderInputs;
  /** `decideWalkMode`'s own verdict (via `resolveWalkMode`) — condition 2. */
  walkMode: WalkMode;
  /** `lastIndexedSha..HEAD` names no commit (`countCommitsInRange(...) === 0`) — condition 3's first half. */
  resumeRangeEmpty: boolean;
  /** `meta.json`'s `lastIndexedSha` equals `readHead().sha` — condition 3's second half, checked independently of the range count (see `countCommitsInRange`'s own doc for why the two are not redundant). */
  lastIndexedShaEqualsHead: boolean;
  /** The blob cache directory exists — condition 4. */
  blobCacheDirExists: boolean;
}

export function isNoOpShortCircuit(inputs: NoOpShortCircuitInputs): boolean {
  const header = inputs.storedHeader;
  if (!header) return false; // condition 1's own precondition: no comparable header at all
  const c = inputs.currentHeaderInputs;
  const inputsEqual =
    header.headSha === c.headSha &&
    header.clock === c.clock &&
    header.dirtyHash === c.dirtyHash &&
    header.configHash === c.configHash &&
    header.seedsHash === c.seedsHash &&
    header.decisionsHash === c.decisionsHash &&
    header.ledgerHash === c.ledgerHash &&
    header.bindingHash === c.bindingHash;
  if (!inputsEqual) return false; // condition 1
  if (inputs.walkMode !== 'resume') return false; // condition 2
  if (!inputs.resumeRangeEmpty) return false; // condition 3, first half
  if (!inputs.lastIndexedShaEqualsHead) return false; // condition 3, second half
  if (!inputs.blobCacheDirExists) return false; // condition 4
  return true;
}

/**
 * The live wrapper: reads the on-disk model header (an unreadable model —
 * unparseable JSON, a wrong `{header, body}` shape, a `rootsVersion`
 * mismatch — is caught here, logged once, and treated as "no comparable
 * header", D13's own rule for `readModel`'s throw), computes this run's own
 * would-be input fields (`bindingHash` through `computeUsedGrammarSetHash`,
 * the standalone fold `pipeline.ts` now exposes so this can run BEFORE
 * mining), resolves the walk mode, and probes the resume range — only when
 * `resolveWalkMode`'s own loaded state carries a comparable `meta.json`
 * `lastIndexedSha` at all, since `countCommitsInRange`/the equality check are
 * meaningless otherwise and `isNoOpShortCircuit`'s own condition 1/2 checks
 * would already fail first regardless.
 *
 * Condition 3's anchor is deliberately `meta.json`'s `lastIndexedSha` (off
 * `resolveWalkMode`'s returned `state`), NEVER the stored model header's
 * `lastIndexedSha` — D13 classifies the header's `lastIndexedSha` as an
 * OUTPUT (this file's own `RootsHeaderInputs` doc comment), and every
 * successful walk writes it as `headSha` unconditionally (the `index`
 * action, below), so comparing it back against the current `headSha` would
 * be a tautology, not a check: it would hold on every run that ever
 * completed at HEAD, even one whose replay STATE (`.cache/history/`, the
 * thing condition 3 actually needs to be safely resumable) is torn or stale
 * behind it (T1's per-file writes are individually best-effort, R4-I10). The
 * loaded `meta.json` is the one place that actually says how far the
 * resumable state itself has been walked.
 */
export async function evaluateNoOpShortCircuit(params: {
  yggRoot: string;
  repoRoot: string;
  rootsConfig: RootsConfig;
  full: boolean;
  seedsHash: string;
  decisionsHash: string;
  ledgerHash: string;
  dirtyHash: string;
  configHash: string;
}): Promise<boolean> {
  let storedHeader: RootsModelHeader | undefined;
  try {
    const stored = await readModel(params.yggRoot);
    storedHeader = stored?.header;
  } catch (err) {
    debugWrite(`[roots] index: model.json unreadable — no comparable header for the no-op short-circuit, proceeding: ${(err as Error).message}`);
    storedHeader = undefined;
  }
  if (!storedHeader) return false;

  const headSha = getHeadSha(params.repoRoot);
  const clock = getHeadCommitterTimestamp(params.repoRoot);
  const bindingHash = await computeUsedGrammarSetHash(params.repoRoot, params.rootsConfig);

  const { mode, state } = await resolveWalkMode(params.repoRoot, params.rootsConfig, rootsHistoryStateDir(params.yggRoot), params.full);

  const metaLastIndexedSha = typeof state?.meta.lastIndexedSha === 'string' ? state.meta.lastIndexedSha : undefined;
  let resumeRangeEmpty = false;
  let lastIndexedShaEqualsHead = false;
  if (metaLastIndexedSha !== undefined && headSha !== null) {
    lastIndexedShaEqualsHead = metaLastIndexedSha === headSha;
    resumeRangeEmpty = countCommitsInRange(params.repoRoot, metaLastIndexedSha) === 0;
  }

  return isNoOpShortCircuit({
    storedHeader,
    currentHeaderInputs: {
      headSha,
      clock,
      dirtyHash: params.dirtyHash,
      configHash: params.configHash,
      seedsHash: params.seedsHash,
      decisionsHash: params.decisionsHash,
      ledgerHash: params.ledgerHash,
      bindingHash,
    },
    walkMode: mode,
    resumeRangeEmpty,
    lastIndexedShaEqualsHead,
    blobCacheDirExists: existsSync(rootsBlobCacheDir(params.yggRoot)),
  });
}

// -----------------------------------------------------------------------------
// Progress rendering (D12) and the run summary — the ENGINE stays
// `no-direct-console` (`history.ts` only emits structured `HistoryProgressInfo`
// callbacks); this command is the one place that turns those numbers into
// stderr text.
// -----------------------------------------------------------------------------

/** §20.1/§13.1's own rate figure (`v6-spec.md:602`, `:712`) — a NAMED constant, never a magic literal, for the >60s progress-line projection. */
const HISTORICAL_BLOB_FETCH_MS_PER_BLOB = 12;
/** D12's own threshold: only announce a fetch whose projected duration clears one minute. */
const PROGRESS_ETA_THRESHOLD_MS = 60_000;

/**
 * Builds one `onProgress` handler for a single `index` run plus a `summary()`
 * reader for after the run completes. Renders the >60s ETA line (once, the
 * first time the projected fetch time clears the threshold) and a periodic
 * `blobsParsed`/`totalUncachedBlobs` update every time `history.ts` emits one
 * (already throttled to every 500 misses there) — both to STDERR, in plain
 * user terms: no command name, no flag name, no internal mechanism word.
 * `summary()` reads back the LAST `commitsWalked`/`blobsParsed` numbers seen
 * on any phase, which is what Step 4's post-run stderr summary line reports.
 */
function makeHistoryProgressRenderer(): {
  onProgress: (info: HistoryProgressInfo) => void;
  summary: () => { commitsWalked?: number; blobsParsed?: number };
} {
  let etaAnnounced = false;
  let lastCommitsWalked: number | undefined;
  let lastBlobsParsed: number | undefined;

  function onProgress(info: HistoryProgressInfo): void {
    if (info.commitsWalked !== undefined) lastCommitsWalked = info.commitsWalked;
    if (info.blobsParsed !== undefined) lastBlobsParsed = info.blobsParsed;
    if (info.phase !== 'fetching' || info.totalUncachedBlobs === undefined) return;

    const total = info.totalUncachedBlobs;
    if (info.blobsParsed === 0) {
      // The pre-fetch announcement moment (history.ts's own first 'fetching' call).
      const projectedMs = total * HISTORICAL_BLOB_FETCH_MS_PER_BLOB;
      if (projectedMs > PROGRESS_ETA_THRESHOLD_MS) {
        etaAnnounced = true;
        process.stderr.write(`Reading ${total} historical file version(s) not seen before — about ${Math.ceil(projectedMs / 1000)}s...\n`);
      }
      return;
    }
    if (etaAnnounced) {
      process.stderr.write(`  ...${info.blobsParsed}/${total}\n`);
    }
  }

  return {
    onProgress,
    summary: () => ({ commitsWalked: lastCommitsWalked, blobsParsed: lastBlobsParsed }),
  };
}

export function registerRootsCommand(program: Command): void {
  const roots = program
    .command('roots')
    .description(
      'Convention mining — discovers the naming, structural, and API patterns your codebase already follows and reports on them. Dormant until configured (see `yg roots status`).',
    );

  roots
    .command('index')
    .description(
      'Mine the repository for conventions and write the committed model under .yggdrasil/roots/. Adds a `roots:` block with default settings first, if the project has none.',
    )
    .option(
      '--full',
      'Force a full history walk, discarding any incremental state on disk — the determinism reference (also what to run after a merge conflict on model.json).',
    )
    .action(async (opts: { full?: boolean }) => {
      const fullFlag = opts.full ?? false;
      try {
        const yggRoot = await findYggRootOrFail();
        const configPath = path.join(yggRoot, 'yg-config.yaml');
        let config = await parseConfigOrFail(configPath);

        if (config.roots === undefined) {
          await scaffoldRootsBlock(configPath);
          process.stdout.write(ROOTS_SCAFFOLD_MESSAGE);
          config = await parseConfigOrFail(configPath);
        }
        const rootsConfig = config.roots;
        if (rootsConfig === undefined) {
          // parseRootsSection fills every key of an empty `roots: {}` mapping
          // from its documented default — the only way this branch is reached
          // is a genuine I/O fault (the scaffold write silently did not take
          // effect), never a config shape the parser would reject.
          throw new Error(
            `Scaffolded a roots: block into ${configPath} but re-reading it still reports no roots configuration.`,
          );
        }

        const repoRoot = projectRootFromGraph(yggRoot);
        const seeds = await readSeeds(yggRoot);
        const ledger = await readLedger(yggRoot);
        const dirtyPaths = new Set((getDirtyFiles(repoRoot) ?? []).map(toPosixPath));

        // Every header INPUT field this run would write, computed up front —
        // needed both for D13's short-circuit comparison (below) and for the
        // real header assembly a non-short-circuited run performs later, so
        // there is exactly one computation of each, never two that could
        // silently diverge.
        const [seedsHash, decisionsHash, ledgerHash, dirtyHash] = await Promise.all([
          hashStoreFile(yggRoot, SEEDS_FILENAME),
          hashStoreFile(yggRoot, DECISIONS_FILENAME),
          hashStoreFile(yggRoot, LEDGER_FILENAME),
          computeDirtyHash(yggRoot, repoRoot),
        ]);
        const configHash = rootsConfigHash(rootsConfig);

        // D13: computed and checked BEFORE acquireBuildLock — creating and
        // then releasing the lock is itself a write to the cache directory,
        // and a genuine no-op run may write NOTHING (`v6-spec.md:260`).
        // `--full` bypasses the short-circuit outright (D2/D13): it is the
        // explicit determinism reference and always recomputes and rewrites.
        if (!fullFlag) {
          const isNoOp = await evaluateNoOpShortCircuit({
            yggRoot,
            repoRoot,
            rootsConfig,
            full: fullFlag,
            seedsHash,
            decisionsHash,
            ledgerHash,
            dirtyHash,
            configHash,
          });
          if (isNoOp) {
            process.stderr.write('Already current — nothing has changed since the last index. No files were written.\n');
            return;
          }
        }

        // Every writer takes the exclusive build lock (R4-I12, spec §4.4) —
        // acquired only now, after D13 has already decided this run has work
        // to do. A held FRESH lock is waited on for the bounded window and
        // only then refused, naming the holder's pid.
        let lockHandle;
        try {
          lockHandle = await acquireBuildLock(rootsBuildLockPath(yggRoot));
        } catch (err) {
          if (err instanceof BuildLockHeldError) {
            debugWrite(`[roots] index: build lock held: ${err.message}`);
            return failWith(err.messageData);
          }
          throw err;
        }

        try {
          const progress = makeHistoryProgressRenderer();
          const result = await runRootsIndex(repoRoot, rootsConfig, seeds, {
            historyDeps: {
              cacheDir: rootsBlobCacheDir(yggRoot),
              stateDir: rootsHistoryStateDir(yggRoot),
              ledger,
              dirtyPaths,
              full: fullFlag,
            },
            onProgress: progress.onProgress,
          });

          const headSha = getHeadSha(repoRoot);
          // `lastIndexedSha`'s spec meaning is the resume anchor — the commit
          // the history is indexed THROUGH (§6.6 clause 3) — so it is written
          // ONLY when the history walk actually ran. `body.historyStats` is
          // set if and only if `runRootsIndex`'s own history join succeeded
          // (`pipeline.ts`'s `if (join) { body.historyStats = join.historyStats;
          // ... }`) — `buildHistoryJoin` returns `undefined` for every
          // degraded mode (no git, a shallow clone, a walk that threw, T8
          // Step 2) and, on its one success path, attempts to persist its
          // replay state before returning a real join (`history.ts`, R4 Task
          // 9) — so this one condition is exactly "the walk ran and a state
          // write was attempted", never "any successful index in a git repo"
          // (a shallow clone is a git repo too, and so is one whose walk
          // threw). It is also NOT a guarantee every one of the six state
          // files landed: each write is individually best-effort (R4-I10), so
          // a torn result is rejected wholesale on the next read via the
          // epoch check (D15) rather than being caught here.
          const historyEngaged = result.body.historyStats !== undefined;

          const header = assembleRootsModelHeader({
            configHash,
            seedsHash,
            decisionsHash,
            ledgerHash,
            headSha,
            lastIndexedSha: historyEngaged ? headSha : null,
            clock: getHeadCommitterTimestamp(repoRoot),
            dirtyHash,
            bindingHash: result.bindingSetHash,
            candidateCountLog2: result.candidateCountLog2,
          });

          await writeModel(yggRoot, header, result.body);

          const totalFacts = result.body.partitions.reduce((n, p) => n + p.facts.length, 0);
          const totalRoles = result.body.partitions.reduce((n, p) => n + p.roles.length, 0);
          process.stdout.write(
            chalk.green(
              `Indexed ${result.body.partitions.length} partition(s), ${totalFacts} fact(s), ${totalRoles} role(s). ` +
                `Model written to .yggdrasil/roots/model.json\n`,
            ),
          );

          // Step 4's own run summary — commits walked and file versions read
          // this run, in plain user terms, printed for every run that walked
          // (never for a degraded no-history run, which has nothing to
          // summarize).
          if (historyEngaged) {
            const { commitsWalked, blobsParsed } = progress.summary();
            process.stderr.write(
              `Reviewed ${commitsWalked ?? 0} commit(s) of history; read ${blobsParsed ?? 0} historical file version(s) not seen before.\n`,
            );
          }
        } finally {
          releaseBuildLock(lockHandle);
        }
      } catch (error) {
        handleError(error);
      }
    });

  roots
    .command('status')
    .description(
      'Report what `yg roots index` has mined so far — dormancy, configuration, or the current field/fact counts. Always exits 0; never gates a build.',
    )
    .action(async () => {
      try {
        process.stdout.write(await renderRootsStatus(process.cwd()));
      } catch (error) {
        // `status` never gates a build on anything it can determine:
        // `renderRootsStatus` already turns every internal failure (no
        // project, unreadable config, corrupt model, even its own unexpected
        // throws) into an honest fallback string and returns normally, so
        // every reachable state exits 0. Reaching THIS catch means something
        // failed outside that whole pipeline — e.g. the stdout write itself —
        // which is a genuinely unexpected fault, not a status the command
        // could report; the canonical handler is correct here.
        debugWrite(`[roots] status action failed unexpectedly: ${(error as Error).message}`);
        abortOnUnexpectedError(error, 'reporting roots status');
      }
    });
}
