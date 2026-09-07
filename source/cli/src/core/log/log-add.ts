import path from 'node:path';
import type { Graph } from '../../model/graph.js';
import type { IssueMessage } from '../../model/validation.js';
import { validateNodePath } from '../../utils/node-path-validator.js';
import { readLogSafe, statLogFile, writeLogFile } from '../../io/log-store.js';
import { composeLogEntry } from './log-entry.js';
import { toPosixPath } from '../../utils/posix.js';

export interface LogAddInput {
  graph: Graph;
  nodePath: string;
  reasonText: string;
  nowMs: number;
}

export type LogAddResult =
  | { ok: true; datetime: string; nodePath: string }
  | { ok: false; error: IssueMessage };

export async function logAdd(input: LogAddInput): Promise<LogAddResult> {
  const { graph, reasonText, nowMs } = input;

  const nv = validateNodePath(toPosixPath(input.nodePath.trim()));
  if (!nv.ok) {
    return {
      ok: false,
      error: {
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
        what: `Node not found: ${nodePath}`,
        why: 'Node must exist in the graph before log entries can be added.',
        next: 'Create yg-node.yaml first, or fix the --node argument.',
      },
    };
  }

  const logPath = path.join(graph.rootPath, 'model', nodePath, 'log.md');

  const stats = await statLogFile(logPath);
  if (stats !== null) {
    if (stats.isSymbolicLink) {
      return {
        ok: false,
        error: {
          what: 'log.md is a symbolic link',
          why: 'Symlinks bypass append-only guarantees and break integrity hashing.',
          next: 'Remove the symlink and let yg log add create a regular file.',
        },
      };
    }
    if (stats.hardLinkCount > 1) {
      return {
        ok: false,
        error: {
          what: 'log.md has multiple hard links (st_nlink > 1)',
          why: 'Hardlinks would orphan integrity baselines on atomic rename.',
          next: 'Copy to a unique file and replace the hardlink.',
        },
      };
    }
  }

  const existing = await readLogSafe(logPath);
  // One composer for every log this tool keeps: entry shape, the guards against a
  // body that would destroy the entry boundary, and the forward-only timestamp.
  const composed = composeLogEntry(existing, reasonText, nowMs);
  if (!composed.ok) return { ok: false, error: composed.error };

  await writeLogFile(logPath, composed.content);

  return { ok: true, datetime: composed.datetime, nodePath };
}
