import { walk, report } from '@chrisdudek/yg/ast';

const FS_MODULES = new Set(['node:fs', 'node:fs/promises', 'fs', 'fs/promises']);

// A statement-level type-only import (`import type { Stats } from 'node:fs'`) is
// fully erased at compile time — it creates NO runtime filesystem dependency, so
// flagging it would break this aspect's errs: under (no-false-positives) contract.
// The `type` modifier surfaces as a direct child token of the import statement;
// an inline `import { type X, y }` keeps `type` inside the specifier (not a direct
// child), so a value import is never mistakenly skipped. (Mirrors the guard in
// events-reader-boundary / instrument-import-fence.)
function isTypeOnly(node) {
  return node.children.some((c) => c.type === 'type');
}

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;
    walk(file.ast.rootNode, (node) => {
      if (node.type !== 'import_statement') return;
      if (isTypeOnly(node)) return;
      const sourceNode = node.childForFieldName('source');
      if (!sourceNode) return;
      // strip surrounding quotes
      const source = sourceNode.text.slice(1, -1);
      if (!FS_MODULES.has(source)) return;
      violations.push(
        report(
          file,
          node,
          `direct import from '${source}' — route file-system calls through io/graph-fs.ts instead`,
        ),
      );
    });
  }
  return violations;
}
