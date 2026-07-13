// CLI command helper: aborts when the requested node does not exist in the graph.
export function abortMissingNode(nodePath: string): never {
  process.stderr.write(`Error: node ${nodePath} not found. Try running yg tree and pick a real one.\n`);
  process.exit(1);
}
