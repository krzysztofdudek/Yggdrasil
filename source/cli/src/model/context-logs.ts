/**
 * The shapes of the logs `yg context` carries: the decisions in force for the
 * subject's type and every type above it, and the component's own log. Pure
 * types in the model layer, so the renderer that prints them names them without
 * depending on the engine that reads the log files
 * (core/log/context-logs.ts).
 */

/** One entry as the context carries it: its datetime header and its text, verbatim. */
export interface ContextLogEntry {
  datetime: string;
  body: string;
}

/** Why a log could not be given, and what to do about it — the three parts every diagnostic of the CLI answers. */
export interface ContextLogUnreadable {
  what: string;
  why: string;
  next: string;
}

/** The decisions in force for one type of the cascade. */
export interface ContextTypeDecisions {
  typeId: string;
  /** The log's path relative to the project root, POSIX. */
  logPath: string;
  /** Entries no later entry replaced, oldest first. Empty when `unreadable` is set. */
  entries: ContextLogEntry[];
  /** Why the log could not be read entry by entry, when it could not. */
  unreadable?: ContextLogUnreadable;
}

/** A component's own log as its context carries it. */
export interface ContextNodeLog {
  nodePath: string;
  /** The log's path relative to the project root, POSIX. */
  logPath: string;
  /** The entries given, oldest first: every entry in force, or the newest of them when trimmed. */
  entries: ContextLogEntry[];
  /** True when the node's type requires an entry per source change, so the log is trimmed to its newest entries. */
  trimmed: boolean;
  /** Entries in force the trim left out (0 when nothing was left out). */
  omitted: number;
  /** Why the log could not be read entry by entry (a broken format or unresolved conflict markers), when it could not. */
  unreadable?: ContextLogUnreadable;
}

/** Every log the context of one subject carries. */
export interface ContextLogs {
  /** Nearest type first; a type with no decision in force is absent. */
  typeDecisions: ContextTypeDecisions[];
  /** Absent for a subject with no component, and for a component whose log has no entry. */
  nodeLog?: ContextNodeLog;
}
