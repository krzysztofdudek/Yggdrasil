import type { ContextLogEntry, ContextLogs, ContextLogUnreadable } from '../model/context-logs.js';
import { buildIssueMessage } from './message-builder.js';
import { toPosixPath } from '../utils/posix.js';

/**
 * The text form of the logs a context package carries, under two headings of
 * their own: the decisions in force for the subject's type and each type above
 * it (nearest first, one heading per type), then the component's own log — the
 * WHY of that one component. Every line is prefixed with `indent`, so the
 * component view (flush left) and the type-covered file view (indented under
 * the file) render the same block. Returns no lines when there is nothing to
 * show, so a subject without logs reads exactly as before.
 */
export function formatContextLogs(logs: ContextLogs, indent = ''): string[] {
  const lines: string[] = [];
  logs.typeDecisions.forEach((t, i) => {
    const where = i === 0 ? '' : ' — a type above; its decisions hold for every type below it';
    lines.push(`${indent}Decisions in force for type '${t.typeId}'${where} (${toPosixPath(t.logPath)}):`);
    if (t.unreadable !== undefined) pushUnreadable(lines, t.unreadable, indent);
    else for (const e of t.entries) pushEntry(lines, e, indent);
    lines.push('');
  });
  const n = logs.nodeLog;
  if (n !== undefined) {
    const nodePath = toPosixPath(n.nodePath);
    lines.push(`${indent}Node log — why ${nodePath} is the way it is (${toPosixPath(n.logPath)}):`);
    if (n.unreadable !== undefined) {
      pushUnreadable(lines, n.unreadable, indent);
    } else {
      for (const e of n.entries) pushEntry(lines, e, indent);
      if (n.omitted > 0) {
        lines.push(`${indent}  ${n.omitted} older ${n.omitted === 1 ? 'entry' : 'entries'} not shown: this node's type requires an entry for every change, so only the newest ${n.entries.length} are given.`);
        lines.push(`${indent}  next: yg log read --node ${nodePath} --all`);
      }
    }
    lines.push('');
  }
  return lines;
}

/** One entry: its datetime, then its text indented beneath it, blank lines kept blank. */
function pushEntry(lines: string[], e: ContextLogEntry, indent: string): void {
  lines.push(`${indent}  [${e.datetime}]`);
  for (const line of e.body.replace(/^\n+/, '').replace(/\s+$/, '').split('\n')) {
    lines.push(line.trim() === '' ? '' : `${indent}    ${line}`);
  }
}

/** A log that could not be given, in the CLI's what / why / next grammar. */
function pushUnreadable(lines: string[], u: ContextLogUnreadable, indent: string): void {
  for (const line of buildIssueMessage({ what: `not shown — ${u.what}`, why: u.why, next: u.next }).split('\n')) {
    lines.push(`${indent}  ${line}`);
  }
}
