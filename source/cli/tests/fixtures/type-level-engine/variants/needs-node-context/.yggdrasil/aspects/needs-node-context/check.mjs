// Reads ctx.node unconditionally — legal for a rule scoped to a real
// component, but this aspect is also attached to a type-covered file with no
// component of its own, so this line runtime-errors every time it runs there.
export function check(ctx) {
  void ctx.node.id;
  return [];
}
