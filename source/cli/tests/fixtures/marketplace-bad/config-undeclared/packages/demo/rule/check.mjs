// Reads a setting yg-package.yaml never declares, so it is undefined in every
// repository that installs this package.
export function check(ctx) {
  const limit = ctx.config.threshold;
  return ctx.subject.length > limit ? [] : [];
}
