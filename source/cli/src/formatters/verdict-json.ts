/**
 * The machine-readable forms of the external-judge channel.
 *
 * `yg-review/1` is the review package: everything a judge is given for one
 * (rule, subject) pair — the rule text, the subject files, the companions the
 * hook resolved, the constraints the tier imposes — and the hashes the verdict
 * will be bound to. It is what makes an outside judgement re-provable: the judge
 * attests to exactly these inputs, and CI later re-derives the same hash from
 * the same tree with no judge and no key present.
 *
 * `yg-verdicts/1` is the inventory: every verdict currently recorded by a judge
 * outside the configured reviewer, and whether each still holds against the
 * working tree.
 *
 * Both contracts are deliberately narrow and versioned. `schema` is the only
 * field a consumer must branch on; new fields may be added freely within a
 * version, and only a change to an EXISTING field's shape takes a new number.
 * Every path is repo-relative POSIX.
 */

export const REVIEW_JSON_SCHEMA = 'yg-review/1';
export const VERDICTS_JSON_SCHEMA = 'yg-verdicts/1';

/** One file handed to the judge, verbatim. */
export interface ReviewJsonFile {
  path: string;
  content: string;
}

/** One declared reference, with the description that explains why it is here. */
export interface ReviewJsonReference extends ReviewJsonFile {
  description?: string;
}

/**
 * What the tier imposes on the review, and nothing else about it. The provider,
 * the model and every credential are deliberately absent: they are not inputs to
 * the judgement (only the tier's NAME folds into the hash), and a review package
 * is handed to someone outside this repository.
 */
export interface ReviewJsonTier {
  name: string;
  /** Independent judgements a configured provider would take before deciding. */
  consensus: number;
  /** The assembled prompt's ceiling in characters, and what this package measures. */
  maxPromptChars: number;
  promptChars: number;
}

export interface ReviewJsonDocument {
  schema: typeof REVIEW_JSON_SCHEMA;
  /** The rule being judged. `kind` is always `llm` — a deterministic rule is machine-only. */
  aspect: { id: string; name: string; description: string; kind: 'llm'; status: string };
  /** The subject: one component, or one file. */
  unit: { kind: 'node' | 'file'; path: string };
  /** The component the subject belongs to, or null for a file governed by its type alone. */
  node: string | null;
  /** The pair's state right now — what makes it pending. */
  state: 'unverified' | 'refused';
  /** The rule's own text, as the judge must read it. */
  rule: { path: string; content: string };
  references: ReviewJsonReference[];
  /** Files a `companion.mjs` hook resolved for this pair; empty for a plain rule. */
  companions: ReviewJsonFile[];
  /** The code under judgement. */
  subjects: ReviewJsonFile[];
  tier: ReviewJsonTier;
  /**
   * The hash the recorded verdict will be stored under, one per verdict token.
   * The judge hands back the one it decided on; recording refuses if the tree
   * has moved since.
   */
  hashes: { pass: string; refused: string };
  /** The assembled prompt a configured provider would have received, verbatim. */
  prompt: string;
}

/** One externally recorded verdict, and whether it still holds. */
export interface VerdictsJsonEntry {
  aspect: string;
  unit: { kind: 'node' | 'file'; path: string };
  verdict: 'pass' | 'refused';
  judge: string;
  hash: string;
  /** False once the inputs moved — the verdict is no longer in force. */
  inForce: boolean;
  /** The violation report, on a refusal. */
  report?: string;
}

export interface VerdictsJsonDocument {
  schema: typeof VERDICTS_JSON_SCHEMA;
  verdicts: VerdictsJsonEntry[];
}

/** Render one review package as pretty-printed JSON with a trailing newline. */
export function formatReviewJson(doc: ReviewJsonDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Render the externally-recorded-verdict inventory as pretty-printed JSON with a trailing newline. */
export function formatVerdictsJson(doc: VerdictsJsonDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
