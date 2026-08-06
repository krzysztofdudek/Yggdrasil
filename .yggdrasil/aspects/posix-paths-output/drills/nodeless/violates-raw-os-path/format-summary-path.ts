// Formats a node's relative path for display in a CLI summary line.
import path from 'node:path';

export function formatNodeSummaryPath(nodePath: string, root: string): string {
  return path.relative(root, nodePath);
}
