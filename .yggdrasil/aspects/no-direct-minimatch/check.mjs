import { walk, report } from '@chrisdudek/yg/ast';

// The single module allowed to import minimatch — the canonical glob engine.
// Every other source file must route glob/path matching through the helpers it
// exports (globMatch / mappingEntryMatchesFile / isGlobPattern).
const CANONICAL_GLOB_MODULE = 'source/cli/src/utils/mapping-path.ts';

// A statement-level type-only import (`import type { IMinimatch } from 'minimatch'`)
// is erased at compile time — no runtime dependency on the glob engine — so
// flagging it would break this aspect's errs: under (no-false-positives) contract.
function isTypeOnly(node) {
  return node.children.some((c) => c.type === 'type');
}

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;
    if (file.path === CANONICAL_GLOB_MODULE) continue;
    walk(file.ast.rootNode, (node) => {
      if (node.type !== 'import_statement') return;
      if (isTypeOnly(node)) return;
      const sourceNode = node.childForFieldName('source');
      if (!sourceNode) return;
      // strip surrounding quotes
      const source = sourceNode.text.slice(1, -1);
      if (source !== 'minimatch') return;
      violations.push(
        report(
          file,
          node,
          `direct import from 'minimatch' — glob matching must go through utils/mapping-path.ts (globMatch / mappingEntryMatchesFile), the single glob engine`,
        ),
      );
    });
  }
  return violations;
}
