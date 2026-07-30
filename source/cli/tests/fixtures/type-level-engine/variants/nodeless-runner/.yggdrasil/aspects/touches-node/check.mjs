// A rule with no owning component that touches ctx.node — unavailable: there
// is no yg-node.yaml behind a component-free file.
export function check(ctx) {
  void ctx.node.id;
  return [];
}
