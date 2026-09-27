/**
 * source/cli/src/core/advise-log-nominations.ts — two attention items about the
 * decisions the logs hold in force.
 *
 * `log-supersedes-conflict`: one entry of a log was replaced twice, by two
 * entries that are both still in force. One writer cannot produce it — `yg log
 * add` refuses to replace an entry that is already replaced — so it is always
 * two decisions that never saw each other, the shape two branches leave when
 * each superseded the same decision. `yg log merge-resolve` reports it at the
 * merge, and records the merged log all the same, since history is never
 * dropped; from the merge commit on, this item is what keeps saying it until one
 * entry supersedes both successors. Which decision holds is a person's call, so
 * the item names the command that records the answer and nothing else.
 *
 * `type-decision-budget`: a node's context carries every decision in force for
 * its type and for each type above it, in full. That is deliberate (a decision
 * recorded on a type holds for the whole subtree), and it is also how an area's
 * decisions grow until they crowd out the code and the rules an agent came to
 * read. The item fires past either of two lines, and never blocks anything:
 *
 *   - more than `TYPE_DECISIONS_MAX_IN_FORCE` (7) decisions in force, the count
 *     the design fixed: a list longer than a reader holds at once stops being
 *     read as a list of constraints and starts being skimmed;
 *   - more than `TYPE_DECISIONS_TOKEN_BUDGET` (2,000) estimated tokens, for a
 *     short list of long entries. The estimate is characters / 4, the usual
 *     rule of thumb for English prose under current model tokenizers; it needs
 *     no tokenizer (and so no dependency, and no model-specific answer), and an
 *     advisory line does not need more precision than that. 2,000 is seven
 *     entries of about 285 tokens — some 1,150 characters, a full paragraph —
 *     so the token line fires before the count line only when the entries run
 *     longer than a paragraph on average: essays rather than decisions, which
 *     is the other way an area's decisions swell.
 *
 * Only a type with decisions of its own in force is reported: a type with none
 * reads exactly what the nearest type above it reads, so that load is already
 * reported once, at the type whose log can change it. For the same reason a type
 * is not reported while a type above it is past a line on its own load: the
 * item on that type stands for its whole subtree.
 *
 * INJECTION HYGIENE (RZ-5): a log path, a node path, a rule id and a type id are
 * repo-derived strings; each is rendered through `quoteData`. A datetime has
 * already passed the strict entry-datetime shape before it reaches here.
 */

import type { Nomination } from './advise-shared.js';
import { CLASS_RANK, asApprovalNext, hashEvidence, quoteData } from './advise-shared.js';

/** Past this many decisions in force for one type's nodes, `type-decision-budget` fires. */
const TYPE_DECISIONS_MAX_IN_FORCE = 7;
/** Past this many estimated tokens of decisions in force for one type's nodes, `type-decision-budget` fires. */
const TYPE_DECISIONS_TOKEN_BUDGET = 2000;
/** Characters per token in the estimate — see the module doc. */
const CHARS_PER_TOKEN = 4;

/** One entry replaced by more than one entry in force, as the CLI boundary read it. */
export interface SupersedeClashSignal {
  /** The log file, relative to the project root. UNTRUSTED text. */
  logRel: string;
  /** The `yg log` target flag naming the log (`--node <path>`, `--type <id>`, `--aspect <id>`). UNTRUSTED text. */
  flag: string;
  /** The datetime of the entry replaced twice. */
  target: string;
  /** The datetimes of its successors in force, oldest first. */
  successors: string[];
}

/** What one type's nodes read from the type decision logs, nearest type first. */
export interface TypeDecisionLoadSignal {
  typeId: string;
  shares: ReadonlyArray<{ typeId: string; datetimes: readonly string[]; chars: number }>;
}

/** The estimated token count of a text of `chars` characters. */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function supersedeClashNominations(clashes: readonly SupersedeClashSignal[]): Nomination[] {
  return clashes.map((c) => {
    const logQ = quoteData(c.logRel);
    const successors = c.successors.join(' and ');
    return {
      id: `log-supersedes-conflict:${c.logRel}@${c.target}`,
      classRank: CLASS_RANK.logSupersedesConflict,
      what: `${c.successors.length} decisions in force in "${logQ}" each replaced the same entry, ${c.target}: ${successors}.`,
      why:
        `read from "${logQ}": each of them replaced ${c.target}, directly or through replacements of its own, and none was replaced since. ` +
        `One writer cannot leave this (an entry already replaced cannot be replaced again), so the two were written apart — ` +
        `the shape two branches leave when each superseded the same decision. Both read as in force, and they may contradict each other.`,
      next: asApprovalNext(
        `Record which decision holds — the user's call, not a merge's — in one entry that supersedes all of them: ` +
          `yg log add ${quoteData(c.flag)} --reason '<which decision holds, and why>' ${c.successors.map((s) => `--supersedes ${s}`).join(' ')}`,
      ),
      evidenceHash: hashEvidence({
        source: 'log-supersedes-conflict',
        log: c.logRel,
        target: c.target,
        successors: c.successors.join(','),
      }),
      evidenceTs: c.successors[c.successors.length - 1] ?? c.target,
    };
  });
}

/** The decisions and estimated tokens a list of shares adds up to, and whether that is past either line. */
function weigh(shares: TypeDecisionLoadSignal['shares']): { decisions: number; tokens: number; over: boolean } {
  const decisions = shares.reduce((n, s) => n + s.datetimes.length, 0);
  const tokens = estimateTokens(shares.reduce((n, s) => n + s.chars, 0));
  return { decisions, tokens, over: decisions > TYPE_DECISIONS_MAX_IN_FORCE || tokens > TYPE_DECISIONS_TOKEN_BUDGET };
}

export function typeDecisionBudgetNominations(loads: readonly TypeDecisionLoadSignal[]): Nomination[] {
  const out: Nomination[] = [];
  for (const load of loads) {
    const { decisions, tokens, over: past } = weigh(load.shares);
    if (!past) continue;
    // A type above that is past the budget on its own load is reported there;
    // every type below it is past the budget for the same reason, so one item
    // stands for the whole subtree until that load is folded.
    if (load.shares.some((_, i) => i > 0 && weigh(load.shares.slice(i)).over)) continue;
    const typeQ = quoteData(load.typeId);
    const breakdown = load.shares
      .map((s) => `'${quoteData(s.typeId)}' ${s.datetimes.length} (~${estimateTokens(s.chars)} tokens)`)
      .join(', ');
    const over = [
      ...(decisions > TYPE_DECISIONS_MAX_IN_FORCE ? [`more than ${TYPE_DECISIONS_MAX_IN_FORCE} decisions`] : []),
      ...(tokens > TYPE_DECISIONS_TOKEN_BUDGET ? [`more than ~${TYPE_DECISIONS_TOKEN_BUDGET} tokens (characters / ${CHARS_PER_TOKEN})`] : []),
    ].join(' and ');
    const newest = load.shares.flatMap((s) => s.datetimes).reduce((a, b) => (b > a ? b : a), '');
    out.push({
      id: `type-decision-budget:${load.typeId}`,
      classRank: CLASS_RANK.typeDecisionBudget,
      what: `A node of type '${typeQ}' reads ${decisions} decisions in force (~${tokens} tokens) from the type decision logs.`,
      why:
        `read from the type decision logs, nearest type first: ${breakdown}. Every one of them is put in full in front of an agent working on any node of the type, ` +
        `and this is ${over} — past that, the area's decisions start to crowd out the code and the rules the agent came to read.`,
      next: asApprovalNext(
        `Read them (yg log read --type ${typeQ}, and each type above it), then fold decisions that say one thing into a single entry ` +
          `that supersedes them (yg log add --type <type> --reason '<the merged decision>' --supersedes <datetime> …), and move a decision ` +
          `that concerns one component into that node's own log`,
      ),
      evidenceHash: hashEvidence({
        source: 'type-decision-budget',
        typeId: load.typeId,
        inForce: load.shares.map((s) => `${s.typeId}:${s.datetimes.join(',')}`).join(';'),
        tokens,
      }),
      evidenceTs: newest,
      // The heaviest load first within the class.
      rankWithinClass: -tokens,
    });
  }
  return out;
}
