export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (/export\s+(const|function|class|let|var)\s/.test(file.content)) continue;
    violations.push({
      file: file.path,
      line: 1,
      column: 0,
      message: 'No named export — this file cannot be consumed as a module.',
    });
  }
  return violations;
}
