import { walk, report, inFile, closest } from '@chrisdudek/yg/ast';

// Approved error-emission helpers that wrap buildIssueMessage internally.
const ALLOWED_HELPERS = new Set(['loadGraphOrAbort', 'abortOnUnexpectedError']);

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

      for (const h of ALLOWED_HELPERS) {
        if (scopeText.includes(`${h}(`)) return;
      }

      violations.push(
        report(
          file,
          node,
          'raw stderr error write — command errors must be constructed via buildIssueMessage or routed through loadGraphOrAbort / abortOnUnexpectedError',
        ),
      );
    });
  }
  return violations;
}
