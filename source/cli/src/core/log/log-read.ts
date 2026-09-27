import path from 'node:path';
import type { Graph } from '../../model/graph.js';
import type { CodedIssueMessage } from '../../model/validation.js';
import { validateNodePath } from '../../utils/node-path-validator.js';
import { parseLog } from '../parsing/log-parser.js';
import { validateFormat } from '../log-format.js';
import { readLogSafe } from '../../io/log-store.js';
import { toPosixPath } from '../../utils/posix.js';
import { withStanding, type EntryStanding } from './log-supersedes.js';

export interface LogReadInput {
  graph: Graph;
  nodePath: string;
  top?: number;
  all?: boolean;
}

/** One entry, with what it replaces and what replaced it (see log-supersedes.ts). */
export type LogEntry = EntryStanding;

export type LogReadResult =
  | { ok: true; entries: LogEntry[] }
  | { ok: false; error: CodedIssueMessage };

const DEFAULT_TOP = 10;

export async function logRead(input: LogReadInput): Promise<LogReadResult> {
  const { graph } = input;

  if (input.top !== undefined && input.all === true) {
    return {
      ok: false,
      error: {
        code: 'usage',
        what: 'Cannot combine --top with --all',
        why: '--all overrides --top; provide one or the other.',
        next: 'Drop one of the flags and retry.',
      },
    };
  }
  if (input.top !== undefined && (!Number.isInteger(input.top) || input.top <= 0)) {
    return {
      ok: false,
      error: {
        code: 'usage',
        what: `Invalid --top value: ${input.top}`,
        why: '--top must be a positive integer.',
        next: 'Use --top 10 or --all.',
      },
    };
  }

  const nv = validateNodePath(toPosixPath(input.nodePath.trim().replace(/\/$/, '')));
  if (!nv.ok) {
    return {
      ok: false,
      error: {
        code: 'node-path-invalid',
        what: `Invalid --node value: ${nv.reason}`,
        why: 'Node path must be POSIX-relative to .yggdrasil/model/ without .. or absolute prefixes.',
        next: 'Use a path like billing/cancel (no leading slash, no model/ prefix).',
      },
    };
  }
  const nodePath = nv.normalized;

  if (!graph.nodes.has(nodePath)) {
    return {
      ok: false,
      error: {
        code: 'node-not-found',
        what: `node '${nodePath}' is not in the graph`,
        why: 'A log belongs to a node, so the node must exist before its log can be read.',
        next: `yg find "${nodePath}"`,
      },
    };
  }

  const logPath = path.join(graph.rootPath, 'model', nodePath, 'log.md');
  const content = await readLogSafe(logPath);

  if (content === '') {
    return { ok: true, entries: [] };
  }

  const violations = validateFormat(content);
  if (violations.length > 0) {
    return {
      ok: false,
      error: {
        code: 'command-error',
        what: `log.md format violation at line ${violations[0].line}: ${violations[0].reason}`,
        why: violations[0].detail,
        next: `Fix log.md for node ${nodePath} and retry.`,
      },
    };
  }

  // Standing is read off the WHOLE log before any limit is applied, so a limit
  // never changes what an entry reads as.
  const entries = withStanding(parseLog(content));
  const limit = input.all ? entries.length : (input.top ?? DEFAULT_TOP);
  const selected = entries.slice(-limit).reverse();

  return { ok: true, entries: selected };
}
