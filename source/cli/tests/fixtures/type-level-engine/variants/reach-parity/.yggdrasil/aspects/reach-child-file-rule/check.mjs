// Reads a file genuinely owned by reach-child-type (child-wins: it sits
// inside reach-parent-type's mapped directory, but the nested child component
// owns it). reach-leaf may not depend on reach-child-type, so this read must
// be refused — if it ever succeeds, the read allowance has stopped matching
// the live type gate's ownership resolution.
export function check(ctx) {
  ctx.fs.read('src/reach/parent/child.ts');
  return [];
}
