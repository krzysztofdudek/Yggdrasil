import { walk, report } from '@chrisdudek/yg/ast';

/**
 * One place writes the check result: runCheck, in source/cli/src/core/check*.ts.
 *
 * Outside those files this flags
 *   - an assignment to `<expr>.issues` or `<expr>.suggestedNext`, and
 *   - a call to `<expr>.issues.push / unshift / splice`.
 * A local array named `issues` (`issues.push(…)`) is not a member write and is
 * never a hit: building a list of findings before returning it is how every
 * check phase works. The formatters may assign `suggestedNext` on the machine
 * document they render. Test code is exempt.
 */

const OWNER = /^source\/cli\/src\/core\/check[^/]*\.ts$/;
const RENDERERS = /^source\/cli\/src\/formatters\//;
const MUTATORS = new Set(['push', 'unshift', 'splice']);

function isTestFile(filePath) {
  return filePath.startsWith('source/cli/tests/') || /\.(test|spec)\.[cm]?tsx?$/.test(filePath);
}

/** The property name of a member expression (`a.b` → 'b'), or undefined. */
function propertyOf(node) {
  if (!node || node.type !== 'member_expression') return undefined;
  const prop = node.childForFieldName('property');
  return prop ? prop.text : undefined;
}

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;
    if (isTestFile(file.path) || OWNER.test(file.path)) continue;
    walk(file.ast.rootNode, (node) => {
      if (node.type === 'assignment_expression') {
        const field = propertyOf(node.childForFieldName('left'));
        if (field === 'issues' || (field === 'suggestedNext' && !RENDERERS.test(file.path))) {
          violations.push(report(file, node, `${file.path} assigns '.${field}' — only runCheck (source/cli/src/core/check*.ts) writes a check result's ${field === 'issues' ? 'findings' : 'suggested next step'}. Hand what this surface contributes to runCheck as an option, so yg check and the portal report the same thing.`));
        }
        return;
      }
      if (node.type === 'call_expression') {
        const callee = node.childForFieldName('function');
        if (!MUTATORS.has(propertyOf(callee) ?? '')) return;
        if (propertyOf(callee.childForFieldName('object')) !== 'issues') return;
        violations.push(report(file, node, `${file.path} appends to '.issues' after the fact — only runCheck (source/cli/src/core/check*.ts) writes a check result's findings. Hand what this surface contributes to runCheck as an option, so yg check and the portal report the same thing.`));
      }
    });
  }
  return violations;
}
