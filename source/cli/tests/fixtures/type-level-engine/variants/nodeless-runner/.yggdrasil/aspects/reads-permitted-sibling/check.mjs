// A rule with no owning component, reading a sibling file the caller's
// architecture-derived allowance permits, via ctx.fs.read — the read folds a
// read: observation, so editing the sibling later makes the result need
// re-checking even though the sibling is never the subject.
export function check(ctx) {
  const sibling = ctx.fs.read('src/helper/h.ts');
  return sibling.length > 0 ? [] : [{ message: 'sibling content was empty' }];
}
