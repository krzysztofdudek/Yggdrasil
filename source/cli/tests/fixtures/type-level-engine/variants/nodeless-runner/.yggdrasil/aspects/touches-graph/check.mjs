// A rule with no owning component that calls ctx.graph — unavailable: there is
// no yg-node.yaml to resolve ancestors, descendants, or declared relations
// against for a component-free file.
export function check(ctx) {
  ctx.graph.node('anything');
  return [];
}
