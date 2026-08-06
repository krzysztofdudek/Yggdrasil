/**
 * source/cli/src/core/drill-runner.ts — the `yg drill` orchestrator.
 *
 * A drill re-runs an aspect's REAL reviewer over a per-aspect corpus of case
 * files that encode an expected verdict: a `violates-*` case MUST be refused, a
 * `satisfies-*` case MUST pass. The runner discovers the corpus, dispatches each
 * case (deterministic checks locally; LLM cases through the production prompt
 * path), and classifies every outcome as pass / MISS / FALSE-ALARM / unrun /
 * unsupported. Drills are REGRESSION FIXTURES for sharpening a rule — never a
 * sensitivity/specificity measurement, and never a `yg check` gate.
 *
 * This module is deterministic and never touches the lock. The two genuinely
 * impure operations — executing a check.mjs over case files (which lives behind
 * the ast layer the engine may not import) and calling the network reviewer
 * (which is non-deterministic by nature) — are INJECTED by the command layer
 * (cli/drill.ts) as `DrillDeps`, so this file stays deterministic and ast-free,
 * exactly as `fill.ts` keeps provider creation at the command boundary. Prompt
 * assembly here is byte-identical to the production filler (core/fill-llm.ts):
 * same `buildPairPrompt`, same suppress-range resolution, same prompt-size gate.
 * By default every LLM case is assembled with a synthetic `drill:<aspectId>`
 * node, matching the shape a real COMPONENTED pair produces. `DrillRunContext.
 * nodeless` switches that off for the whole run, producing the shape a real
 * NODELESS pair produces instead (a file enforced by its architecture type
 * alone, no owning component — no `<node .../>` element, the single-file
 * intro sentence, and the nodeless framing paragraph on a `per: file` aspect).
 */

import path from 'node:path';

import type { AspectDef } from '../model/graph.js';
import type { DrillResultLine } from '../io/drill-results-store.js';
import { ruleHashFor, contentFor } from './pair-inputs.js';
import { hashBytes } from '../io/hash.js';
import { listDirEntries, readFileBytes } from '../io/graph-fs.js';
import { globMatch } from '../utils/mapping-path.js';
import { toPosixPath } from '../utils/posix.js';
import { buildPairPrompt, assembledPromptChars } from '../llm/prompt.js';
import type { PromptFileInput, PromptReferenceInput } from '../llm/prompt.js';
import { resolveSuppressedRangesForPrompt, SuppressMarkerError } from '../structure/index.js';

// ── Public types (frozen contract; consumed by later corpus-gate/analysis work) ──

export type DrillOutcome = 'pass' | 'miss' | 'false-alarm' | 'unrun' | 'unsupported';

export interface DrillCase {
  aspect: string;
  /** e.g. 'violates-namespace-import/star-minimatch' (dir/relfile, repo-relative POSIX, extension stripped). */
  caseLabel: string;
  /** decoded from the 'violates-'/'satisfies-' dir prefix. */
  expect: 'refused' | 'satisfied';
  /** repo-relative POSIX case source files. */
  files: string[];
  /** 'dev' = in-repo drills/; 'holdout' = --dir external. */
  src: 'dev' | 'holdout';
  /** --corpus label, else 'dev' or the --dir basename. */
  corpus: string;
}

export interface DrillResult {
  case: DrillCase;
  got: 'refused' | 'satisfied' | 'unrun' | 'unsupported';
  outcome: DrillOutcome;
  kind: 'deterministic' | 'llm';
  /** hash of concatenated case file contents. */
  caseHash: string;
  /** hash of the rule source (check.mjs | content.md) at run time. */
  ruleHash: string;
  /** LLM only. */
  tier?: string;
  /** LLM only. */
  votes?: { satisfied: number; total: number };
}

export interface DrillRunSummary {
  results: DrillResult[];
  counts: Record<DrillOutcome, number>;
  /** 1 = any miss/false-alarm; 2 = incomplete (unrun, no miss/false-alarm); 0 = clean. */
  exitCode: 0 | 1 | 2;
}

/** A single LLM unit review, injected by the command (wraps verifyWithConsensus). */
export interface DrillReviewResult {
  satisfied: boolean;
  votes: { satisfied: number; total: number };
}

/**
 * The two impure operations the runner cannot perform itself, injected by
 * cli/drill.ts. `runDet` wraps `runAstAspect` (the ast layer, which the engine
 * may not import); `reviewUnit` wraps the network reviewer (non-deterministic).
 * `onBudget` reports the reviewer-call budget just before the first review.
 */
export interface DrillDeps {
  /** Run the deterministic check over one case's files. Returns the observed
   *  verdict, 'unsupported' when the check read graph context, or 'unrun' when the
   *  check could not be evaluated (source parse / runtime / shape error). */
  runDet(caseFiles: string[]): Promise<'refused' | 'satisfied' | 'unsupported' | 'unrun'>;
  /** Review one assembled prompt. `'unrun'` = an infra/provider failure (no verdict). */
  reviewUnit(prompt: string, consensus: number): Promise<DrillReviewResult | 'unrun'>;
  /** Called exactly once with the budget line, BEFORE the first reviewUnit call. */
  onBudget(line: string): void;
  /** Called per case after classification, with the verbatim detail line for an
   *  unrun/unsupported case (undefined for pass/miss/false-alarm). The command
   *  renders; the runner owns the message text so it stays a single source. */
  onCaseResult(result: DrillResult, detail?: string): void;
}

/** Context the command resolves once (tier consensus, tier name, size limit). */
export interface DrillRunContext {
  /** tier.consensus ?? 1 for LLM aspects; 1 for deterministic. */
  consensus: number;
  /** resolved tier NAME (LLM only). */
  tierName?: string;
  /** tier.max_prompt_chars ?? DEFAULT_MAX_PROMPT_CHARS (LLM only). */
  maxPromptChars: number;
  /**
   * When true, every LLM unit's prompt is assembled WITHOUT a node: nodePath
   * and nodeDescription are both omitted, exactly as fill-llm.ts assembles a
   * real nodeless pair (a file enforced by its architecture type alone, no
   * owning component — `pair.nodePath === undefined`). This is what makes a
   * drill case exercise the SAME prompt shape `llm/prompt.ts`'s `hasNode`
   * branch produces for a real nodeless file (no `<node .../>` element, the
   * single-file intro sentence, and — for a `per: file` aspect — the nodeless
   * framing paragraph), rather than the pre-existing synthetic
   * `drill:<aspectId>` node every prior drill run carried. Absent/false ⇒
   * unchanged behavior (the synthetic node). Deterministic aspects ignore
   * this field — drill's det path never assembles a prompt.
   */
  nodeless?: boolean;
}

/** The fixed node description for a drill prompt — a synthetic fixture, not a graph node. */
function drillNodeDescription(aspectId: string): string {
  return `Drill case corpus for aspect '${aspectId}' — a synthetic fixture exercising the rule, not a graph node.`;
}

// ── Verbatim CLI lines (built here as plain strings so the command renders them;
//    the engine never calls buildIssueMessage or console). ──

function drillBudgetLine(
  aspectId: string,
  reviewerCalls: number,
  llmCases: number,
  consensus: number,
  detCases: number,
): string {
  return `yg drill: budgeting ${reviewerCalls} reviewer call(s) for '${aspectId}' — ${llmCases} LLM case(s) × consensus ${consensus}; ${detCases} deterministic case(s) run free.`;
}

function drillUnsupportedGraphCtxLine(aspectId: string): string {
  return `unsupported: check '${aspectId}' reads graph context (node/subject/graph/fs/parseAst/parseYaml/parseJson/parseToml); drill v1 runs check.mjs over case files only. Recorded, not scored.`;
}

function drillUnsupportedCompanionLine(aspectId: string): string {
  return `unsupported: aspect '${aspectId}' ships companion.mjs; drill v1 cannot assemble per-unit companions without a graph. Recorded, not scored.`;
}

function drillUnrunPromptTooLargeLine(chars: number, limit: number): string {
  return `unrun: assembled prompt is ${chars} chars, over the tier's limit of ${limit}. Split the case or raise the tier's max_prompt_chars.`;
}

function drillUnrunDeterministicLine(aspectId: string): string {
  return `unrun: check '${aspectId}' could not be evaluated over this case (source parse or runtime error). Recorded, not scored.`;
}

function drillUnrunReviewerLine(aspectId: string): string {
  return `unrun: reviewer could not evaluate aspect '${aspectId}' on this case (infrastructure error). Recorded, not scored.`;
}

function drillUnrunSuppressLine(aspectId: string): string {
  return `unrun: a case file for aspect '${aspectId}' has a yg-suppress marker missing its required reason. Recorded, not scored.`;
}

export function drillSummaryFooter(
  aspectId: string,
  counts: Record<DrillOutcome, number>,
  corpus: string,
  src: 'dev' | 'holdout',
): string {
  return `yg drill '${aspectId}': ${counts.pass} pass · ${counts.miss} MISS · ${counts['false-alarm']} FALSE-ALARM · ${counts.unrun} unrun · ${counts.unsupported} unsupported (corpus '${corpus}', ${src}).`;
}

// ── Discovery ──

export interface DiscoverDrillsOpts {
  aspectId: string;
  projectRoot: string;
  /** external holdout corpus dir (data-only — never imported). Absent ⇒ in-repo drills/. */
  dir?: string;
  /** --case glob, matched against each case label (repo-relative POSIX). */
  caseGlob?: string;
  /** --corpus label; else 'dev' (in-repo) or the --dir basename (holdout). */
  corpusLabel?: string;
}

/**
 * Discover the per-aspect case corpus. Each source FILE whose first path segment
 * under the corpus root is a `violates-*` / `satisfies-*` directory is one case;
 * its label is the file's corpus-relative POSIX path with the extension stripped.
 * Files literally named `yg-aspect.yaml` and any `.md` file are skipped (they are
 * never cases). Results are sorted by label for a stable, reproducible run.
 */
export async function discoverDrillCases(opts: DiscoverDrillsOpts): Promise<DrillCase[]> {
  const src: 'dev' | 'holdout' = opts.dir ? 'holdout' : 'dev';
  const baseAbs = opts.dir
    ? path.resolve(opts.projectRoot, opts.dir)
    : path.resolve(opts.projectRoot, '.yggdrasil', 'aspects', opts.aspectId, 'drills');
  const corpus = opts.corpusLabel ?? (opts.dir ? path.basename(baseAbs) : 'dev');

  const absFiles = await collectFiles(baseAbs);
  const cases: DrillCase[] = [];
  for (const abs of absFiles) {
    const relToBase = toPosixPath(path.relative(baseAbs, abs));
    const firstSeg = relToBase.split('/')[0];
    const expect: 'refused' | 'satisfied' | null = firstSeg.startsWith('violates-')
      ? 'refused'
      : firstSeg.startsWith('satisfies-')
        ? 'satisfied'
        : null;
    if (expect === null) continue; // not under a verdict-encoding directory
    const baseName = path.basename(abs);
    if (baseName === 'yg-aspect.yaml') continue; // reserved — never a case
    if (baseName.toLowerCase().endsWith('.md')) continue; // docs are not cases
    const ext = path.extname(relToBase);
    const caseLabel = ext.length > 0 ? relToBase.slice(0, -ext.length) : relToBase;
    if (opts.caseGlob !== undefined && !globMatch(caseLabel, opts.caseGlob)) continue;
    const relToRoot = toPosixPath(path.relative(opts.projectRoot, abs));
    cases.push({ aspect: opts.aspectId, caseLabel, expect, files: [relToRoot], src, corpus });
  }
  cases.sort((a, b) => (a.caseLabel < b.caseLabel ? -1 : a.caseLabel > b.caseLabel ? 1 : 0));
  return cases;
}

/** Recursively collect every file under `baseAbs` (sorted, deterministic). Missing dir ⇒ []. */
async function collectFiles(baseAbs: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await listDirEntries(dir);
    if (entries === null) return;
    for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(dir, e.name);
      if (e.kind === 'dir') await walk(child);
      else out.push(child);
    }
  };
  await walk(baseAbs);
  return out;
}

/**
 * Filter drill-result telemetry down to the lines that are ACTIONABLE on the
 * read-only advise / health surfaces. A recorded drill line is kept only when it is
 * BOTH:
 *   (a) `src === 'dev'` — an IN-REPO drill run, not an external `--dir` holdout
 *       measurement (a holdout line names a corpus that does not live in this repo,
 *       so there is nothing here to re-drill or retire); AND
 *   (b) its `(aspect, case)` is still present in that aspect's CURRENT in-repo
 *       `drills/` corpus (a case since removed or renamed, or an aspect with no
 *       corpus at all, has no drill left to re-run).
 * Every other line is an ORPHAN — dropped silently, so a stale case or a holdout
 * residue can never surface as a live "regression no longer caught" alarm or even a
 * stale re-drill note (there is nothing left to re-drill or retire).
 *
 * Corpus membership is resolved by the SAME read-only discovery `yg drill` uses
 * (`discoverDrillCases` — it LISTS the corpus files, never runs a case), once per
 * distinct aspect that has a dev line. The telemetry arrives as a plain-data
 * parameter (never a reader import), so the CLI boundary threads the drill lines
 * through here exactly as they already cross it, keeping the pure nomination /
 * health engines free of any corpus I/O.
 */
export async function filterInCorpusDevDrills(
  drillResults: readonly DrillResultLine[],
  projectRoot: string,
): Promise<DrillResultLine[]> {
  const devLines = drillResults.filter((line) => line.src === 'dev');
  if (devLines.length === 0) return [];

  // NUL byte separator: a NUL cannot occur in a POSIX filename or an aspect id, so
  // the composite key is collision-proof even when a case label legitimately
  // contains spaces or slashes. Built with String.fromCharCode so no raw control
  // byte appears in this source file.
  const nul = String.fromCharCode(0);
  const keyOf = (aspect: string, caseLabel: string): string => `${aspect}${nul}${caseLabel}`;
  const inCorpus = new Set<string>();
  const discovered = new Set<string>();
  for (const line of devLines) {
    if (discovered.has(line.aspect)) continue;
    discovered.add(line.aspect);
    const cases = await discoverDrillCases({ aspectId: line.aspect, projectRoot });
    for (const c of cases) inCorpus.add(keyOf(line.aspect, c.caseLabel));
  }
  return devLines.filter((line) => inCorpus.has(keyOf(line.aspect, line.case)));
}

// ── Hashing ──

/** sha256 of the concatenated case file contents (raw bytes, sorted by path). Drill-internal
 *  change-detection only — never a verdict/lock input, so no line-ending normalization is applied. */
export async function caseHashOf(files: string[], projectRoot: string): Promise<string> {
  const buffers: Buffer[] = [];
  for (const rel of [...files].sort()) {
    const bytes = await readFileBytes(path.resolve(projectRoot, rel));
    buffers.push(bytes ?? Buffer.alloc(0));
  }
  return hashBytes(Buffer.concat(buffers));
}

/** sha256 of the aspect's rule source (check.mjs for deterministic, content.md for LLM). */
function ruleHashOf(aspect: AspectDef): string {
  return ruleHashFor(aspect, aspect.reviewer.type === 'deterministic' ? 'check.mjs' : 'content.md');
}

// ── Classification + summary ──

export function classifyOutcome(expect: 'refused' | 'satisfied', got: DrillResult['got']): DrillOutcome {
  if (got === 'unrun') return 'unrun';
  if (got === 'unsupported') return 'unsupported';
  if (expect === 'refused') return got === 'refused' ? 'pass' : 'miss';
  return got === 'satisfied' ? 'pass' : 'false-alarm';
}

export function summarize(results: DrillResult[]): DrillRunSummary {
  const counts: Record<DrillOutcome, number> = { pass: 0, miss: 0, 'false-alarm': 0, unrun: 0, unsupported: 0 };
  for (const r of results) counts[r.outcome]++;
  const exitCode: 0 | 1 | 2 =
    counts.miss > 0 || counts['false-alarm'] > 0 ? 1 : counts.unrun > 0 ? 2 : 0;
  return { results, counts, exitCode };
}

// ── Orchestration ──

const GOT_RANK: Record<DrillResult['got'], number> = { satisfied: 0, refused: 1, unrun: 2, unsupported: 3 };
function worseGot(a: DrillResult['got'], b: DrillResult['got']): DrillResult['got'] {
  return GOT_RANK[a] >= GOT_RANK[b] ? a : b;
}

/**
 * Run every case and return the classified summary. Deterministic cases dispatch
 * through `deps.runDet`; LLM cases assemble the production prompt here and
 * dispatch through `deps.reviewUnit`. Companion aspects are recorded `unsupported`
 * wholesale (v1 cannot assemble per-unit companions without a graph). The budget
 * line is emitted via `deps.onBudget` immediately before the first review.
 */
export async function runDrills(
  aspect: AspectDef,
  projectRoot: string,
  cases: DrillCase[],
  ctx: DrillRunContext,
  deps: DrillDeps,
): Promise<DrillRunSummary> {
  const ruleHash = ruleHashOf(aspect);
  const results: DrillResult[] = [];

  const record = (result: DrillResult, detail?: string): void => {
    results.push(result);
    deps.onCaseResult(result, detail);
  };

  // ── Deterministic path — local, free, reproducible. ──
  if (aspect.reviewer.type !== 'llm') {
    for (const c of cases) {
      const caseHash = await caseHashOf(c.files, projectRoot);
      const got = await deps.runDet(c.files);
      const detail =
        got === 'unsupported'
          ? drillUnsupportedGraphCtxLine(aspect.id)
          : got === 'unrun'
            ? drillUnrunDeterministicLine(aspect.id)
            : undefined;
      record({ case: c, got, outcome: classifyOutcome(c.expect, got), kind: 'deterministic', caseHash, ruleHash }, detail);
    }
    return summarize(results);
  }

  // ── LLM path. A companion aspect cannot be assembled per-unit without a graph. ──
  if (aspect.hasCompanion === true) {
    for (const c of cases) {
      const caseHash = await caseHashOf(c.files, projectRoot);
      record(
        { case: c, got: 'unsupported', outcome: 'unsupported', kind: 'llm', caseHash, ruleHash, tier: ctx.tierName },
        drillUnsupportedCompanionLine(aspect.id),
      );
    }
    return summarize(results);
  }

  // Load references once (byte-identical to the verifier). A missing reference
  // makes every LLM case unrun — the prompt cannot be assembled faithfully.
  const references = await loadReferences(aspect, projectRoot);
  if (references === null) {
    for (const c of cases) {
      const caseHash = await caseHashOf(c.files, projectRoot);
      record(
        { case: c, got: 'unrun', outcome: 'unrun', kind: 'llm', caseHash, ruleHash, tier: ctx.tierName },
        drillUnrunReviewerLine(aspect.id),
      );
    }
    return summarize(results);
  }

  const aspectContent = contentFor(aspect, 'content.md');
  const perFile = aspect.scope?.per === 'file';

  // Budget BEFORE the first reviewer call (upper bound: one call per unit × consensus).
  if (cases.length > 0) {
    deps.onBudget(drillBudgetLine(aspect.id, cases.length * ctx.consensus, cases.length, ctx.consensus, 0));
  }

  for (const c of cases) {
    const caseHash = await caseHashOf(c.files, projectRoot);
    const caseFiles = await readCaseFiles(c.files, projectRoot);
    // per:file ⇒ one unit per case file; per:node ⇒ all case files in one unit.
    const units: PromptFileInput[][] = perFile ? caseFiles.map((f) => [f]) : [caseFiles];

    let got: DrillResult['got'] = 'satisfied';
    let voteSat = 0;
    let voteTotal = 0;
    let unrunDetail: string | undefined;
    for (const unit of units) {
      const outcome = await reviewOneUnit(
        aspect,
        aspectContent,
        references,
        unit,
        ctx,
        deps,
      );
      if ('kind' in outcome) {
        got = worseGot(got, 'unrun');
        unrunDetail ??= outcome.detail;
        continue;
      }
      voteSat += outcome.votes.satisfied;
      voteTotal += outcome.votes.total;
      got = worseGot(got, outcome.satisfied ? 'satisfied' : 'refused');
    }

    record(
      {
        case: c,
        got,
        outcome: classifyOutcome(c.expect, got),
        kind: 'llm',
        caseHash,
        ruleHash,
        tier: ctx.tierName,
        votes: voteTotal > 0 ? { satisfied: voteSat, total: voteTotal } : undefined,
      },
      got === 'unrun' ? unrunDetail : undefined,
    );
  }

  return summarize(results);
}

/** Assemble one unit's production prompt, apply the prompt-size gate, and review it. */
async function reviewOneUnit(
  aspect: AspectDef,
  aspectContent: string,
  references: PromptReferenceInput[],
  unit: PromptFileInput[],
  ctx: DrillRunContext,
  deps: DrillDeps,
): Promise<DrillReviewResult | { kind: 'unrun'; detail: string }> {
  let suppressedRanges;
  try {
    suppressedRanges = await resolveSuppressedRangesForPrompt(
      // Re-encoding the already-decoded content is byte-identical to fill's raw source bytes:
      // drill case files must be valid UTF-8, for which decode→encode round-trips exactly.
      unit.map((u) => ({ path: u.path, bytes: Buffer.from(u.content, 'utf8') })),
      aspect.id,
    );
  } catch (e) {
    // A reasonless suppress marker means the suppressed-line set is undefined —
    // the case cannot be assembled faithfully. Record it as unrun (infra).
    if (e instanceof SuppressMarkerError) return { kind: 'unrun', detail: drillUnrunSuppressLine(aspect.id) };
    throw e;
  }

  const promptInput = {
    aspect: { id: aspect.id, description: aspect.description ?? '', content: aspectContent },
    references,
    nodePath: ctx.nodeless ? undefined : `drill:${aspect.id}`,
    nodeDescription: ctx.nodeless ? undefined : drillNodeDescription(aspect.id),
    files: unit,
    companions: [],
    suppressedRanges,
    scope: aspect.scope,
  };

  const chars = assembledPromptChars(promptInput);
  if (chars > ctx.maxPromptChars) {
    return { kind: 'unrun', detail: drillUnrunPromptTooLargeLine(chars, ctx.maxPromptChars) };
  }

  const review = await deps.reviewUnit(buildPairPrompt(promptInput), ctx.consensus);
  if (review === 'unrun') return { kind: 'unrun', detail: drillUnrunReviewerLine(aspect.id) };
  return review;
}

/** Read case file contents as prompt inputs (missing ⇒ empty, mirroring the verifier). */
async function readCaseFiles(files: string[], projectRoot: string): Promise<PromptFileInput[]> {
  const out: PromptFileInput[] = [];
  for (const rel of files) {
    const bytes = await readFileBytes(path.resolve(projectRoot, rel));
    out.push({ path: rel, content: (bytes ?? Buffer.alloc(0)).toString('utf8') });
  }
  return out;
}

/** Read the aspect's references as prompt inputs. A single unreadable reference ⇒ null. */
async function loadReferences(aspect: AspectDef, projectRoot: string): Promise<PromptReferenceInput[] | null> {
  const refs = aspect.references ?? [];
  const out: PromptReferenceInput[] = [];
  for (const ref of refs) {
    const bytes = await readFileBytes(path.resolve(projectRoot, ref.path));
    if (bytes === null) return null;
    out.push({ path: ref.path, description: ref.description, content: bytes.toString('utf8') });
  }
  return out;
}
