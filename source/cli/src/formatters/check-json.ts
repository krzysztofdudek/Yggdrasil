/**
 * The machine-readable form of a check run (`yg check --json`).
 *
 * The text report is written for a person and for an agent that reads prose. A
 * layer sitting ABOVE the agent — a wave close computing a quality index, a
 * dashboard, a CI step deciding what to schedule — needs the same facts without
 * parsing that report. Parsing it is the fragility this document removes: the
 * report is written to be READ, so every wording improvement in it is a breaking
 * change to anyone who scraped it.
 *
 * The contract is deliberately narrow and versioned. `schema` is the only field
 * a consumer must branch on; new fields may be added freely within `yg-check/1`,
 * and only a change to an EXISTING field's shape takes a new schema number.
 * Every path is repo-relative POSIX, and every count is the TRUE one for the
 * whole run — the text view's narrowing flags never reach this document.
 */

import type { AspectStatus } from '../model/graph.js';

export const CHECK_JSON_SCHEMA = 'yg-check/1';

/**
 * What the lock currently says about one pair.
 *
 * `unverified` and `stale` are one state as far as the gate is concerned — both
 * block, both are cleared by the same command — but they are different facts: a
 * pair the lock has never seen was never judged, while a stale one was judged
 * and the code moved since.
 */
export type CheckJsonVerdict =
  | 'approved'
  | 'refused'
  | 'unverified'
  | 'stale'
  | 'prompt-too-large'
  | 'companion-error';

/** One expected (rule, unit) pair and what the lock says about it. */
export interface CheckJsonPair {
  aspect: string;
  /** The subject: one component, or one file governed by its architecture type. */
  unit: { kind: 'node' | 'file'; path: string };
  /** The owning component, or null for a file no component owns. */
  node: string | null;
  /** Which reviewer kind answers for this pair. */
  kind: 'llm' | 'deterministic';
  /** Effective status on this subject — what decides whether a finding blocks. */
  status: AspectStatus;
  verdict: CheckJsonVerdict;
  /**
   * Who answered: `deterministic` for a local check, the judge's name for a
   * verdict recorded outside the configured reviewer, otherwise the reviewer
   * tier the rule resolves to. Null when nothing has answered yet.
   */
  reviewer: string | null;
  /** The hash the recorded verdict is bound to, when the lock holds an entry at all. */
  hash: string | null;
  /** The violation report, on a refusal in force. */
  report?: string;
}

/** One finding, exactly as the text report counts it. */
export interface CheckJsonIssue {
  code: string;
  severity: 'error' | 'warning';
  aspect?: string;
  node?: string;
  unit?: string;
  what: string;
  why: string;
  next: string;
}

/** Who judged outside the configured reviewer, and how many pairs in force are theirs. */
export interface CheckJsonJudge {
  name: string;
  pairs: number;
}

/**
 * What this report stands on that the change never touched — present only when
 * the project measures changes against a branch. With nothing to measure
 * against there is no untouched code to speak of, and a zero would claim one.
 */
export interface CheckJsonProgressive {
  /** The branch or ref the change was measured against. */
  reference: string | null;
  /** How many changed paths the measurement accounted for. */
  changedInputs: number | null;
  /** Enforced obligations held outside the change. */
  outside: number | null;
  /** Findings the content guard kept blocking despite git reporting their files unchanged. */
  byteGuardKept: number | null;
  /** The reference tree's object ids could not be reproduced, so no content check was made. */
  byteGuardUnavailable: boolean;
  /** The standing floor: advisory refusals, and enforced findings, on untouched code. */
  noiseFloor: { advisory: number; enforcedOutside: number } | null;
}

export interface CheckJsonDocument {
  schema: typeof CHECK_JSON_SCHEMA;
  project: { name: string; nodes: number; aspects: number; flows: number };
  /** Whether the run blocks, and the exit code it leaves — the same one the text run leaves. */
  exit: { code: 0 | 1; status: 'pass' | 'fail'; reason: string };
  coverage: {
    files: number;
    covered: number;
    /** Owned by a component's mapping. Null when the type-level tier is off. */
    nodeOwned: number | null;
    /** Satisfied by an architecture type alone. Null when the type-level tier is off. */
    typeCovered: number | null;
    /** Excluded from coverage by design. Null when the type-level tier is off. */
    excluded: number | null;
    /** True when nothing is required to be covered, so an uncovered file can never fail. */
    requiresNothing: boolean;
  };
  totals: {
    errors: number;
    warnings: number;
    /** Pairs removed from the expected set entirely by a draft rule. */
    draftSkipped: number;
    /** Pair counts by what the lock says, summing to `pairs.length`. */
    verdicts: Record<CheckJsonVerdict, number>;
    /** Verified pairs split by reviewer kind, as the header reports them. */
    verified: { deterministic: number; llm: number };
  };
  pairs: CheckJsonPair[];
  issues: CheckJsonIssue[];
  judges: CheckJsonJudge[];
  /** Null on a project that does not measure changes against a branch. */
  progressive: CheckJsonProgressive | null;
  /** The one concrete step the run points at, or null when there is nothing to do. */
  suggestedNext: string | null;
}

/** Render one check document as pretty-printed JSON with a trailing newline. */
export function formatCheckJson(doc: CheckJsonDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
