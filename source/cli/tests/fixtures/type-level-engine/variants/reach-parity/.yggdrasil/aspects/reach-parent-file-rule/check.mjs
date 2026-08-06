// Reads a file genuinely owned by reach-parent-type's directory mapping — the
// architecture permits reach-leaf to depend on reach-parent-type, so this read
// must be admitted.
export function check(ctx) {
  ctx.fs.read('src/reach/parent/foo.ts');
  return [];
}
