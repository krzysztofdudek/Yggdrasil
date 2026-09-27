// Flags every synchronous file-system call (readFileSync, writeFileSync, ...).
export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    file.content.split("\n").forEach((line, i) => {
      const m = /fs\.(\w+Sync)\(/.exec(line);
      if (m) violations.push({ file: file.path, line: i + 1, message: `fs.${m[1]} is synchronous — use async equivalent` });
    });
  }
  return violations;
}
