// A rule on a file with no owning component, reading only its own subject
// content via ctx.subject — never ctx.fs. The read never crosses the
// allowed-reads boundary and folds no observation, so the result re-verifies
// with nothing beyond the subject file itself touched.
export function check(ctx) {
  const ok = ctx.subject[0].content.length > 0;
  return ok ? [] : [{ message: 'subject content was empty' }];
}
