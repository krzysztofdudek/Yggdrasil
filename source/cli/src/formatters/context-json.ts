import type { AspectStatus } from '../model/graph.js';

/**
 * The machine-readable form of a context package (`yg context --json`).
 *
 * The text view of `yg context` is written for a person and for an agent that
 * reads prose. A layer sitting ABOVE the agent — an orchestrator deciding what
 * to hand a worker, a dashboard, a CI step — needs the same facts without
 * parsing sentences, and above all it needs each rule's STATUS word, which the
 * text view is currently the only place in the product to carry per rule.
 *
 * The contract is deliberately narrow and versioned. `schema` is the only field
 * a consumer must branch on; new fields may be added freely within
 * `yg-context/1`, and only a change to an EXISTING field's shape takes a new
 * schema number. Every path is repo-relative POSIX, exactly as the text view
 * prints it.
 */
export const CONTEXT_JSON_SCHEMA = 'yg-context/1';

/** How an aspect reached the subject — one of the seven cascade channels. */
export type ContextJsonChannelKind =
  | 'own'
  | 'ancestor-node'
  | 'own-type'
  | 'ancestor-type'
  | 'flow'
  | 'port'
  | 'implies';

/**
 * One attachment path an aspect arrived by. An aspect can arrive through more
 * than one channel at once (the effective status is the strongest of them), so
 * this is a list rather than a single value — collapsing it to one would hide
 * exactly the second attachment that decided the status.
 */
export interface ContextJsonChannel {
  /** Channel number, 1–7, matching the cascade documented by `yg prime`. */
  number: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  kind: ContextJsonChannelKind;
  /** Machine-readable origin token, e.g. `own:orders/handler`, `type:command`, `flow:checkout`, `port:charge@payments`. */
  origin: string;
  /** Status declared AT this attachment site, when the site declares one. */
  declaredStatus?: AspectStatus;
}

/**
 * One link of the chain the subject inherits along: a component and its
 * architecture type, nearest first. For a file governed by its type alone there
 * is no component, so `node` is null and only the type is named.
 */
export interface ContextJsonChainLink {
  node: string | null;
  type: string;
}

/** One effective rule, with everything a consumer needs to route or render it. */
export interface ContextJsonAspect {
  id: string;
  /** Effective status on this subject — the strongest across every channel below. */
  status: AspectStatus;
  kind: 'llm' | 'deterministic' | 'aggregate';
  name: string;
  description: string;
  channels: ContextJsonChannel[];
  /** Aspects that imply this one on this subject (channel 7), when any do. */
  impliedBy?: string[];
  /** The files an agent must read before editing — the text view's `read:` lines. */
  read: string[];
}

/** What the subject's rules are anchored to. */
export type ContextJsonOwner =
  | { kind: 'node'; path: string; type: string }
  | { kind: 'type'; typeId: string; chainTermination: string }
  | { kind: 'none'; reason: 'unmapped' | 'excluded'; explanation: string };

/** One log entry: its datetime header and its text, verbatim. */
export interface ContextJsonLogEntry {
  datetime: string;
  body: string;
}

/** A log the context could not give: what is wrong, why nothing of it is given, and the step that repairs it. */
export interface ContextJsonLogUnreadable {
  what: string;
  why: string;
  next: string;
}

/** The decisions in force for one type of the subject's type chain. */
export interface ContextJsonTypeDecisions {
  type: string;
  /** The type log's path, repo-relative. */
  log: string;
  /** Entries no later entry replaced, oldest first. Empty when `unreadable` is set. */
  entries: ContextJsonLogEntry[];
  /** Why the log could not be read entry by entry, when it could not. */
  unreadable?: ContextJsonLogUnreadable;
}

/** The owning component's own log — the WHY of that component. */
export interface ContextJsonNodeLog {
  node: string;
  /** The node log's path, repo-relative. */
  log: string;
  /** The entries given, oldest first; replaced entries are never among them. */
  entries: ContextJsonLogEntry[];
  /** True when the node's type sets `log_required`, so only the newest entries in force are given. */
  trimmed: boolean;
  /** Entries in force the trim left out. */
  omitted: number;
  /** Why the log could not be read entry by entry, when it could not. */
  unreadable?: ContextJsonLogUnreadable;
}

export interface ContextJsonDocument {
  schema: typeof CONTEXT_JSON_SCHEMA;
  target: { kind: 'node' | 'file'; path: string };
  owner: ContextJsonOwner;
  chain: ContextJsonChainLink[];
  aspects: ContextJsonAspect[];
  /** Rules attached to the subject's type that do NOT apply here, with the reason. Type-governed files only. */
  dropped?: Array<{ id: string; reason: string }>;
  /** The advisory structural-attention sentence, when the text view would print one. */
  attention?: string;
  /** The decisions in force for the subject's type and every type above it, nearest first; absent when none is in force. */
  typeDecisions?: ContextJsonTypeDecisions[];
  /** The owning component's own log; absent for a file with no component and for a component whose log has no entry. */
  nodeLog?: ContextJsonNodeLog;
}

/** Render one context document as pretty-printed JSON with a trailing newline. */
export function formatContextJson(doc: ContextJsonDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
