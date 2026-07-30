// A rule with no owning component, reading a file OUTSIDE its
// architecture-derived allowance. The read must be refused, never silently
// skipped and never silently allowed.
export function check(ctx) {
  ctx.fs.read('src/forbidden/x.ts');
  return [];
}
