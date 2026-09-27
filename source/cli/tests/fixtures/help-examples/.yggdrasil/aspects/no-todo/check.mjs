// Flags every line that holds the token TODO.
export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    file.content.split("\n").forEach((line, i) => {
      if (line.includes("TODO")) violations.push({ file: file.path, line: i + 1, message: "TODO marker left in shipped code" });
    });
  }
  return violations;
}
