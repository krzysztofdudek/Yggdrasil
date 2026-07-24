import { createHash } from 'node:crypto';
import type { ValidationIssue, IssueMessage } from '../../model/validation.js';
import { issueMsg } from './shared.js';
import { findMarkerBlockRanges, unfencedLineIndices } from '../../utils/marker-block.js';
import { AGENTS_FILENAME, CLAUDE_FILENAME, CLINERULES_RELATIVE_PATH, AGENTS_IMPORT_LINE_LOWER } from '../../utils/rules-artifact-names.js';

/**
 * Injected snapshot of the three committed rules-distribution artifacts, plus
 * the installed CLI's canonical digest hash. Read by the CLI boundary
 * (cli/check.ts) — this module is pure and does no fs of its own, matching the
 * `nowUtc` seam checkReviewOverdue uses (spec RZ-18): absent input ⇒ the
 * caller (runCheck) skips the whole gate rather than fabricating a result.
 */
export interface RulesArtifacts {
  /** Raw AGENTS.md content. null = file absent. */
  agentsMd: string | null;
  /** Raw CLAUDE.md content. null = file absent. */
  claudeMd: string | null;
  /** Raw .clinerules/yggdrasil.md content. null = file absent. */
  clinerules: string | null;
  /** sha256 of the installed CLI's canonical digest body (templates/digest.ts digestSha256()). */
  canonicalDigestHash: string;
}

/**
 * Strictly anchored (`^...$`) full-LINE match — the authority for JUDGING an
 * installed anchor. It isolates a single CANDIDATE LINE first (see
 * `splitFirstLine` below) and requires the WHOLE line to be a well-formed
 * anchor, so it can never be fooled by an anchor-shaped substring embedded
 * elsewhere in a block, nor by a corrupted anchor that happens to contain a
 * valid-looking `sha256=` fragment past the first line break.
 *
 * `templates/digest.ts` exports a deliberately LOOSE, unanchored `ANCHOR_RE`
 * for the different job of pulling an anchor's fields out of arbitrary text
 * (what a test, or a script grepping a committed file, needs). That looseness
 * is exactly why it is not the gate's parser, and why the two are separate
 * rather than shared.
 */
const ANCHOR_LINE_RE = /^<!-- yggdrasil:digest cli=(?<cli>\S+) sha256=(?<sha256>[0-9a-f]{64}) -->$/;

/** LF-normalize so a CRLF checkout hashes and matches identically to an LF one. */
const lf = (s: string): string => s.replace(/\r\n/g, '\n');

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf-8').digest('hex');

/** Split LF-normalized text into its first line and everything after the following `\n`. */
function splitFirstLine(text: string): { firstLine: string; rest: string } {
  const i = text.indexOf('\n');
  return i === -1 ? { firstLine: text, rest: '' } : { firstLine: text.slice(0, i), rest: text.slice(i + 1) };
}

type FindingKind = 'missing' | 'modified' | 'outdated';
interface Finding {
  kind: FindingKind;
  /** Human-facing name of the artifact this finding is about, e.g. "AGENTS.md digest block". */
  where: string;
}

/**
 * Inspect one already-LF-normalized "anchor line + body" blob — either the
 * AGENTS.md block's inner content, or the entire .clinerules/yggdrasil.md file
 * (both share the same shape: `digestAnchor(v) + "\n" + DIGEST_BODY`).
 * `null` means the artifact itself is absent (a distinct "missing" finding).
 * A present artifact whose first line is not a well-formed anchor — including
 * one whose anchor line was simply deleted — is "modified", never "missing":
 * the artifact exists, its content just does not match what was installed.
 */
function inspectAnchoredBlock(where: string, inner: string | null, canonicalHash: string, findings: Finding[]): void {
  if (inner === null) {
    findings.push({ kind: 'missing', where });
    return;
  }
  const { firstLine, rest } = splitFirstLine(inner);
  const m = firstLine.match(ANCHOR_LINE_RE);
  if (!m?.groups) {
    findings.push({ kind: 'modified', where });
    return;
  }
  if (sha256(rest) !== m.groups.sha256) {
    findings.push({ kind: 'modified', where });
    return;
  }
  if (m.groups.sha256 !== canonicalHash) {
    findings.push({ kind: 'outdated', where });
  }
}

/**
 * First marker block's inner content in an LF-normalized AGENTS.md, plus how
 * many such blocks exist. `null` when none are found. Only the first block is
 * authoritative — extra blocks are hand-edit debris reported as a duplication
 * finding, not separately inspected.
 *
 * Detection is delegated to `utils/marker-block.ts` — the SAME scanner the
 * installer uses to decide what to replace. A local `START\n...END` regex here
 * would disagree with the writer in exactly the cases the installer was
 * hardened against: markers must occupy their own line, and markers inside a
 * fenced (```) example are a quoted illustration, not an installed block. A
 * repo that documents its own tooling routinely carries such an example, and
 * the regex counted it as a second block (false "duplicated") and — when the
 * example came first — hashed the example's body instead of the real one
 * (false "modified"). Both survived `yg init --upgrade`, because the installer
 * correctly ignored the fenced example.
 */
function firstDigestBlock(agentsMdLf: string): { inner: string; count: number } | null {
  const ranges = findMarkerBlockRanges(agentsMdLf);
  if (ranges.length === 0) return null;
  return { inner: agentsMdLf.slice(ranges[0].innerFrom, ranges[0].innerTo), count: ranges.length };
}

/**
 * True when some line of an LF-normalized CLAUDE.md is exactly an `@AGENTS.md`
 * import — matched case-insensitively, since a repo whose file is `Agents.md`
 * gets an `@Agents.md` import line and both are the same commitment.
 *
 * Delegated to the SAME fence-aware line scan the installer writes through
 * (`utils/marker-block`), for the same reason the block detection is: a repo
 * that documents its own agent setup routinely shows `@AGENTS.md` inside a
 * fenced (```) example. Counting that example as an import made both sides
 * agree on a falsehood — the installer left CLAUDE.md untouched and reported
 * success, and this gate reported the import present — so a repo that LOOKED
 * installed silently gave Claude Code no rules at all, with nothing anywhere
 * to surface it.
 */
function hasAgentsImportLine(claudeMdLf: string): boolean {
  return unfencedLineIndices(claudeMdLf, (l) => l.toLowerCase() === AGENTS_IMPORT_LINE_LOWER).length > 0;
}

/** Human-facing label for the AGENTS.md digest block, used in both `missing` findings and the anchor inspection. */
const AGENTS_BLOCK_LABEL = `${AGENTS_FILENAME} digest block`;
/** Human-facing label for the CLAUDE.md import-line finding. */
const CLAUDE_IMPORT_LABEL = `${CLAUDE_FILENAME} @${AGENTS_FILENAME} import`;

/**
 * Committed-digest staleness gate (WARNING, never blocking). Before this
 * check, drift in the generated agent-rules distribution — a hand-edited
 * digest block, a digest left over from an older CLI, a missing
 * `.clinerules/yggdrasil.md` copy, or a dropped `@AGENTS.md` import in
 * CLAUDE.md — was entirely undetectable. This compares three committed
 * artifacts against the installed CLI's canonical digest hash and reports
 * whichever of four states applies, collapsed into ONE grouped warning:
 *
 *   - missing    — no digest block in AGENTS.md, no .clinerules/yggdrasil.md
 *                  file, or no `@AGENTS.md` import line in CLAUDE.md.
 *   - modified   — an artifact's body hash disagrees with its own anchor
 *                  (this also covers an anchor line that was deleted or
 *                  mangled beyond recognition — the artifact is present but
 *                  wrong, never reported as "missing").
 *   - outdated   — an artifact's anchor is internally consistent (its body
 *                  hashes to its own anchor) but that hash disagrees with the
 *                  installed CLI's canonical digest — the artifact is from an
 *                  older CLI. The anchor's `cli=` version token itself is
 *                  informational and never compared; only the sha256 is.
 *   - duplicated — AGENTS.md contains more than one digest block; the first
 *                  is authoritative and is what gets hashed above.
 *
 * All comparisons run over LF-normalized text (`lf()`), so a CRLF checkout
 * never trips the gate. Pure and read-only: it never writes the lock, never
 * changes a verdict, and is never suppressible — it is not an aspect.
 *
 * The finding carries NO `nodePath`: it is about three files at the repository
 * root, not about any component in the graph. Naming a synthetic one made
 * every node-shaped view report a component that does not exist — a pair and
 * node count in `yg check`, a row of its own in `--summary`, and an entry in
 * the web view's node lists linking to a page that cannot exist.
 */
export function checkDigestGate(a: RulesArtifacts): ValidationIssue[] {
  const findings: Finding[] = [];
  let duplicated = false;

  if (a.agentsMd === null) {
    findings.push({ kind: 'missing', where: AGENTS_BLOCK_LABEL });
  } else {
    const block = firstDigestBlock(lf(a.agentsMd));
    if (!block) {
      findings.push({ kind: 'missing', where: AGENTS_BLOCK_LABEL });
    } else {
      duplicated = block.count > 1;
      inspectAnchoredBlock(AGENTS_BLOCK_LABEL, block.inner, a.canonicalDigestHash, findings);
    }
  }

  inspectAnchoredBlock(
    CLINERULES_RELATIVE_PATH,
    a.clinerules === null ? null : lf(a.clinerules),
    a.canonicalDigestHash,
    findings,
  );

  const claudeOk = a.claudeMd !== null && hasAgentsImportLine(lf(a.claudeMd));
  if (!claudeOk) findings.push({ kind: 'missing', where: CLAUDE_IMPORT_LABEL });

  if (findings.length === 0 && !duplicated) return [];

  const parts = findings.map((f) => {
    switch (f.kind) {
      case 'missing': return `${f.where} is missing`;
      case 'modified': return `${f.where} was modified by hand (its content no longer matches the version it was generated from)`;
      case 'outdated': return `${f.where} is from an older CLI`;
    }
  });
  if (duplicated) parts.push(`${AGENTS_FILENAME} contains more than one yggdrasil block (first one is authoritative)`);

  const msgData: IssueMessage = {
    what: `Committed agent-rules digest is out of sync: ${parts.join('; ')}.`,
    why: 'Agents read the committed digest before running yg prime; a stale, hand-edited, or missing digest means agents may follow outdated rules or none at all.',
    next: 'yg init --upgrade',
  };

  return [{
    severity: 'warning',
    code: 'rules-digest-stale',
    rule: 'rules-digest-stale',
    ...issueMsg(msgData),
  }];
}
