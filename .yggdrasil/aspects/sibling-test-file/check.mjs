// Every file of a command node is a command source file: the `command` type is
// strict and classifies only files that export register<X>Command. A node may
// hold more than one of them (drill + drill-add, aspects + aspects-log), so each
// file is judged on its own — checking only the first would let every later
// command in a multi-file node lose its test unnoticed.
export function check(ctx) {
  const violations = [];
  const commandFiles = ctx.node.files.filter((f) => !f.path.endsWith('.test.ts'));
  if (commandFiles.length === 0) return violations;

  let testSuite;
  try {
    testSuite = ctx.graph.node('cli/tests/unit/cli');
  } catch (err) {
    violations.push({
      file: commandFiles[0].path,
      message: `Command node cannot reach 'cli/tests/unit/cli'. Add 'relations: [{ type: uses, target: cli/tests/unit/cli }]' to this node's yg-node.yaml.`,
      kind: 'missing-relation',
    });
    return violations;
  }
  if (!testSuite) return violations;

  const allTests = collectTestFiles(testSuite, ctx);
  for (const commandFile of commandFiles) {
    const basename = commandFile.path.split('/').pop();
    const stem = basename.replace(/\.ts$/, '');
    const expectedTestSuffix = `/${stem}.test.ts`;
    const hasSibling = allTests.some((f) => f.path.endsWith(expectedTestSuffix));
    if (!hasSibling) {
      violations.push({
        file: commandFile.path,
        message: `Missing sibling test '${stem}.test.ts' under cli/tests/unit/cli/. Every command must have a unit test.`,
        kind: 'missing-test-sibling',
      });
    }
  }
  return violations;
}

function collectTestFiles(node, ctx) {
  const out = [...node.files];
  for (const child of ctx.graph.children(node)) {
    out.push(...collectTestFiles(child, ctx));
  }
  return out;
}
