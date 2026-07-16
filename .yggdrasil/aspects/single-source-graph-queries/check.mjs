import { walk, report, inFile } from '@chrisdudek/yg/ast';

// Reserved graph-query helper names. These live only under core/graph/.
// Engine files outside core/graph/ must import from there, not redefine.
// Regenerated from core/graph/'s actual graph-query / aspect-resolution export
// surface. Language-registry exports (EXTENSION, LANGUAGES, get*Language*, …) are
// deliberately EXCLUDED: they are a different concern and their names are too
// generic to reserve without risking a false positive on an unrelated local.
const RESERVED_NAMES = new Set([
  // hierarchy / flow / dependency traversal
  'collectAncestors',
  'collectDescendants',
  'collectParticipatingFlows',
  'collectDependencyAncestors',
  'collectReverseDependents',
  'collectIndirectDependents',
  'buildTransitiveChains',
  'touchedReferencesFile',
  'classifyInvalidations',
  'nodesWithRefusedVerdict',
  'yggPrefixOf',
  // aspect resolution
  'computeEffectiveAspects',
  'computeEffectiveAspectStatuses',
  'getAspectSource',
  'getAspectStatusSources',
  'hasNonDraftEffectiveAspects',
  'isAggregateAspect',
  'inferAspectDisplayKind',
]);

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;
    // The canonical module is the only allowed definition site.
    if (inFile(file, { glob: '**/core/graph/**/*.ts' })) continue;
    // Only engine files (under src/core/).
    if (!inFile(file, { glob: '**/src/core/**/*.ts' })) continue;

    walk(file.ast.rootNode, (node) => {
      // function_declaration form
      if (node.type === 'function_declaration') {
        const nameNode = node.childForFieldName('name');
        if (nameNode !== undefined && nameNode !== null && RESERVED_NAMES.has(nameNode.text)) {
          violations.push(
            report(
              file,
              node,
              `redefinition of reserved graph-query helper '${nameNode.text}' — import from core/graph instead`,
            ),
          );
        }
        return;
      }

      // const name = (...) => { ... } / function (...) { ... }
      if (node.type === 'variable_declarator') {
        const nameNode = node.childForFieldName('name');
        const valueNode = node.childForFieldName('value');
        if (nameNode === null || nameNode === undefined) return;
        if (valueNode === null || valueNode === undefined) return;
        if (!RESERVED_NAMES.has(nameNode.text)) return;
        if (
          valueNode.type === 'arrow_function' ||
          valueNode.type === 'function' ||
          valueNode.type === 'function_expression'
        ) {
          violations.push(
            report(
              file,
              node,
              `redefinition of reserved graph-query helper '${nameNode.text}' as arrow/function expression — import from core/graph instead`,
            ),
          );
        }
      }
    });
  }
  return violations;
}
