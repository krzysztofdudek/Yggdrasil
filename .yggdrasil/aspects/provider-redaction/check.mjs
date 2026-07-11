import { walk, report, inFile } from '@chrisdudek/yg/ast';

// Identifiers that may carry raw LLM prompt or response data
const SENSITIVE_VARS = new Set(['prompt', 'response', 'content', 'body']);

// Collect every sensitive-identifier occurrence within a subtree.
function collectSensitiveIdentifiers(node, out) {
  if (node.type === 'identifier' && SENSITIVE_VARS.has(node.text)) out.push(node);
  for (const child of node.children) collectSensitiveIdentifiers(child, out);
}

// True when this sensitive identifier is enclosed by a redactSecrets(...) call
// WITHIN the logged argument expression. The upward walk is BOUNDED at the argument
// node so the wrapper must actually protect THIS logged value: a redactSecrets that
// wraps something else in the statement — e.g. the log call itself, as in the
// nonsensical redactSecrets(debugWrite(prompt)) — never masks a raw argument, so no
// real leak is silenced. Recognizing the wrapper here lets the natural inline form
// debugWrite(redactSecrets(prompt)) pass instead of over-firing.
function isRedactedWithinArg(idNode, argNode) {
  let cur = idNode;
  while (cur) {
    if (cur.type === 'call_expression') {
      const fn = cur.childForFieldName('function');
      if (fn && fn.text === 'redactSecrets') return true;
    }
    if (cur === argNode) break;
    cur = cur.parent;
  }
  return false;
}

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;
    if (!inFile(file, { glob: '**/src/llm/*.ts' })) continue;

    walk(file.ast.rootNode, (node) => {
      if (node.type !== 'call_expression') return;
      const fn = node.childForFieldName('function');
      if (fn === null) return;

      // Check debugWrite() or process.stderr.write() calls
      const isDebugWrite = fn.type === 'identifier' && fn.text === 'debugWrite';
      const isStderrWrite =
        fn.type === 'member_expression' &&
        fn.childForFieldName('object')?.text === 'process.stderr' &&
        fn.childForFieldName('property')?.text === 'write';
      if (!isDebugWrite && !isStderrWrite) return;

      const argsNode = node.childForFieldName('arguments');
      if (argsNode === null) return;

      for (const arg of argsNode.children) {
        if (arg.type === ',' || arg.type === '(' || arg.type === ')') continue;

        // Evaluate each argument, and each sensitive occurrence WITHIN it, on its own:
        // an argument leaks if it carries any sensitive identifier that is not wrapped
        // in redactSecrets() inside that argument. Per-occurrence keeps a second raw
        // argument refused even when a sibling is redacted —
        // debugWrite(redactSecrets(prompt), response) still flags `response`.
        const sensitives = [];
        collectSensitiveIdentifiers(arg, sensitives);
        for (const idNode of sensitives) {
          if (!isRedactedWithinArg(idNode, arg)) {
            violations.push(
              report(
                file,
                arg,
                `raw sensitive variable referenced in log call without redactSecrets() wrapping`,
              ),
            );
            break;
          }
        }
      }
    });
  }
  return violations;
}
