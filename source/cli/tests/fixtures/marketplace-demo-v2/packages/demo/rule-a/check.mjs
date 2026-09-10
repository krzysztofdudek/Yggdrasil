// Refuses a file with more lines than the repository allows.
//
// The limit is NOT written into this rule: it is read from ctx.config, which the
// installing repository sets in the yg-aspect.adapt.yaml beside the copy. Reading
// it here is what puts the value into this verdict's identity, so raising the
// limit sends this rule's verdicts back for judging and leaves every other rule's
// alone.
//
// 0.2.0 adds countBlankLines: a repository that does not count blank lines gets a
// limit on lines that carry something.
export function check(ctx) {
  const limit = ctx.config.threshold;
  const countBlank = ctx.config.countBlankLines;
  const violations = [];
  for (const file of ctx.subject) {
    const all = file.content.split('\n');
    const lines = countBlank ? all.length : all.filter((l) => l.trim() !== '').length;
    if (lines > limit) {
      violations.push({
        file: file.path,
        line: 1,
        message: `File has ${lines} lines to check; this repository allows ${limit}.`,
      });
    }
  }
  return violations;
}
