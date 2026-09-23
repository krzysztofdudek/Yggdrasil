import { walk, report, inFile, closest } from '@chrisdudek/yg/ast';

// Approved error-emission helpers that wrap buildIssueMessage internally: the
// graph-load / unexpected-error funnels, and the CLI output layer's error,
// notice and block renderers (cli/output.ts), which every command now reports
// a failure through. Matched against the callee of a real call expression in
// the enclosing scope — never as a substring — so a function merely NAMED
// `fail`, a `failAndExit` read as `fail`, or an unrelated `detail(` can never
// pass for a call to one of them.
const ALLOWED_HELPERS = new Set(['loadGraphOrAbort', 'abortOnUnexpectedError', 'fail', 'failAndExit', 'notice', 'block']);

/** True when `scope` contains a call whose callee is one of ALLOWED_HELPERS. */
function callsAllowedHelper(scope) {
  let found = false;
  walk(scope, (n) => {
    if (found || n.type !== 'call_expression') return;
    const callee = n.childForFieldName('function');
    if (callee !== null && callee.type === 'identifier' && ALLOWED_HELPERS.has(callee.text)) found = true;
  });
  return found;
}

// The function/method kinds whose body scopes an error write. A stderr.write is
// compliant when its ENCLOSING function constructs its message via
// buildIssueMessage (typically into a `formatted` local it then writes), so the
// whole enclosing function is the search scope — precise and AST-based, replacing
// a fixed char window that false-positived when a multi-line buildIssueMessage
// call sat just past the window (e.g. preamble.ts's loader branches).
const FUNCTION_KINDS = [
  'function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
  'generator_function_declaration',
];
// Fallback window (chars) for a write at module scope with no enclosing function.
const FALLBACK_WINDOW = 400;

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;
    if (!inFile(file, { glob: '**/src/cli/*.ts' })) continue;

    const fileText = file.ast.rootNode.text;

    walk(file.ast.rootNode, (node) => {
      if (node.type !== 'call_expression') return;
      const fn = node.childForFieldName('function');
      if (fn === null) return;
      if (fn.text !== 'process.stderr.write') return;

      const args = node.childForFieldName('arguments');
      if (args === null) return;
      const argText = args.text;

      // Allowed: argument contains buildIssueMessage(...) directly.
      if (argText.includes('buildIssueMessage(')) return;

      // Allowed: not error-shaped at all (no chalk.red, no "Error" content,
      // no "ERROR" content). These are progress / info writes; skip.
      const looksLikeError =
        argText.includes('chalk.red') ||
        /\bError:\s/.test(argText) ||
        /\bERROR:\s/.test(argText);
      if (!looksLikeError) return;

      // Allowed: the ENCLOSING function constructs the message via
      // buildIssueMessage (a `formatted` local it then writes) or uses an approved
      // emission helper. Search the whole enclosing function body; fall back to a
      // char window only for a write at module scope with no enclosing function.
      const enclosing = closest(node, FUNCTION_KINDS);
      const scopeText = enclosing
        ? enclosing.text
        : fileText.slice(
            Math.max(0, node.startIndex - FALLBACK_WINDOW),
            Math.min(fileText.length, node.endIndex + FALLBACK_WINDOW),
          );

      if (scopeText.includes('buildIssueMessage(')) return;

      if (enclosing ? callsAllowedHelper(enclosing) : [...ALLOWED_HELPERS].some((h) => scopeText.includes(`${h}(`))) return;

      violations.push(
        report(
          file,
          node,
          'raw stderr error write — command errors must go through the output layer (fail / failAndExit / notice / block), buildIssueMessage, or loadGraphOrAbort / abortOnUnexpectedError',
        ),
      );
    });
  }
  return violations;
}
