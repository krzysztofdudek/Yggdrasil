import { walk, report } from '@chrisdudek/yg/ast';

const ALLOWED = new Set(['0', '1']);

// The two ways a command ends the process: `process.exit(code)` directly, and
// `exitAfterFlush(code)`, the helper that drains stdout/stderr first and then
// calls process.exit with the same code. Either one sets the exit code.
function exitCallee(callNode) {
  const fn = callNode.childForFieldName('function');
  if (!fn) return null;
  if (fn.type === 'identifier' && fn.text === 'exitAfterFlush') return 'exitAfterFlush';
  if (fn.type === 'member_expression') {
    const obj = fn.childForFieldName('object');
    const prop = fn.childForFieldName('property');
    if (!obj || !prop) return null;
    if (obj.text === 'process' && prop.text === 'exit') return 'process.exit';
    if (prop.text === 'exitAfterFlush') return 'exitAfterFlush';
  }
  return null;
}

// Every numeric literal the argument can evaluate to, when that is provable from
// the syntax alone: a literal, a parenthesised literal, or a conditional whose
// branches are provable in turn (`failed ? 2 : 0`). Anything else (a variable, a
// call, arithmetic) cannot be judged here and yields null — errs: under.
function provableLiterals(node) {
  if (!node) return null;
  if (node.type === 'number') return [node.text];
  if (node.type === 'parenthesized_expression') {
    const inner = node.namedChildren[0];
    return inner ? provableLiterals(inner) : null;
  }
  if (node.type === 'ternary_expression') {
    const a = provableLiterals(node.childForFieldName('consequence'));
    const b = provableLiterals(node.childForFieldName('alternative'));
    return a && b ? [...a, ...b] : null;
  }
  return null;
}

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;
    walk(file.ast.rootNode, (node) => {
      if (node.type !== 'call_expression') return;
      const callee = exitCallee(node);
      if (!callee) return;
      const argsNode = node.childForFieldName('arguments');
      const first = argsNode ? argsNode.namedChildren[0] : undefined;
      const codes = provableLiterals(first);
      if (!codes) return;
      for (const code of codes) {
        if (!ALLOWED.has(code)) {
          violations.push(report(file, node, `${callee}(${first.text}) can exit with ${code} — command exit codes must be 0 or 1`));
          break;
        }
      }
    });
  }
  return violations;
}
