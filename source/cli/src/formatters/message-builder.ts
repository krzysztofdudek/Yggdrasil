import type { IssueMessage } from '../model/validation.js';

export type { IssueMessage };

/**
 * A what/why/next message as the CLI's one grammar prints it:
 *
 *   <what>
 *     why:  <why>
 *   next: <next>
 *
 * The labels are always there and always lowercase, so a reader (or a
 * script) can tell the three parts apart without knowing which line is
 * which; a multi-line part keeps its later lines aligned under its first. An
 * empty `why` or `next` is left out. No severity heading: a command error adds
 * `error[code]: ` in front of `what` (cli/output.ts), a result states it as it
 * is.
 */
export function buildIssueMessage(msg: IssueMessage): string {
  const lines = [msg.what];
  // Later lines keep their own indentation: a snippet is only correct as written.
  if (msg.why) msg.why.split('\n').forEach((l, i) => lines.push(i === 0 ? `  why:  ${l}` : `        ${l.trimEnd()}`));
  const next = msg.next.replace(/^Run:?\s+(?=yg )/, '');
  if (next) next.split('\n').forEach((l, i) => lines.push(i === 0 ? `next: ${l}` : `      ${l.trimEnd()}`));
  return lines.join('\n');
}
