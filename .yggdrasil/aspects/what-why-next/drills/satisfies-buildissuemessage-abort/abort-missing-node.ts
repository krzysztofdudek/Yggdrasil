// CLI command helper: aborts when the requested node does not exist in the graph.
import { buildIssueMessage } from '../formatters/message-builder.js';

export function abortMissingNode(nodePath: string): never {
  process.stderr.write(
    `Error: ${buildIssueMessage({
      what: `Node '${nodePath}' is not declared in the graph.`,
      why: 'A command that targets a node needs that node to exist, or it cannot resolve the node\'s aspects and source files.',
      next: 'Run `yg tree` to list declared nodes, then retry with a node path that exists.',
    })}\n`,
  );
  process.exit(1);
}
