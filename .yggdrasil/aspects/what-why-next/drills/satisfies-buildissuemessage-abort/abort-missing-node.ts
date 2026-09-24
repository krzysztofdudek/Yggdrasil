// CLI command helper: aborts when the requested node does not exist in the graph.
import { fail } from './output.js';

export function abortMissingNode(nodePath: string): never {
  fail({
    what: `node '${nodePath}' is not in the graph`,
    why: "A command that targets a node needs that node to exist, or it cannot resolve the node's aspects and source files.",
    next: `yg find "${nodePath}"`,
  }, 'node-not-found');
  process.exit(1);
}
