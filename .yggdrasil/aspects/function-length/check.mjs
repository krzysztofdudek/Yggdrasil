import { walk, report } from '@chrisdudek/yg/ast';
import config from './config.json' with { type: 'json' };

/**
 * Function length cap for the CLI's shipped source.
 *
 * A function that runs to hundreds of lines is read, changed and reviewed as one
 * block: every edit to it re-reads all of it, and a phase buried in the middle of
 * it has no name a reader can find. The fix is the same every time — cut it into
 * named phases, each its own function — so the rule points at the function and
 * leaves the cut to the author.
 *
 * The cap lives in config.json beside this file (`maxLines`), so moving it is a
 * one-value edit that re-runs every pair of the rule and nothing else.
 *
 * What counts: every function-shaped construct — a declaration, a method, an
 * arrow function, a function expression — from its first line to its last,
 * nested functions included in the outer span (a callback that is a whole
 * command body is exactly what the rule is for). A nested function over the cap
 * is reported on its own as well.
 *
 * Scope: TypeScript under source/cli/src/, tests excluded — the shipped code.
 */

const GUARDED_PREFIX = 'source/cli/src/';

const MAX_LINES = Number.isInteger(config.maxLines) && config.maxLines > 0 ? config.maxLines : 150;

const FUNCTION_TYPES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'function',
  'generator_function',
  'arrow_function',
  'method_definition',
]);

function nameOf(node) {
  const own = node.childForFieldName('name');
  if (own) return own.text;
  const parent = node.parent;
  if (!parent) return 'anonymous function';
  if (parent.type === 'variable_declarator') {
    const name = parent.childForFieldName('name');
    if (name) return name.text;
  }
  if (parent.type === 'pair') {
    const key = parent.childForFieldName('key');
    if (key) return key.text;
  }
  if (parent.type === 'public_field_definition') {
    const name = parent.childForFieldName('name');
    if (name) return name.text;
  }
  if (parent.type === 'assignment_expression') {
    const left = parent.childForFieldName('left');
    if (left) return left.text;
  }
  if (parent.type === 'arguments' && parent.parent && parent.parent.type === 'call_expression') {
    const callee = parent.parent.childForFieldName('function');
    if (callee) {
      const tail = callee.type === 'member_expression' ? callee.childForFieldName('property') : callee;
      return `callback passed to ${(tail ?? callee).text}()`;
    }
  }
  return 'anonymous function';
}

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;
    if (!file.path.startsWith(GUARDED_PREFIX) || !file.path.endsWith('.ts')) continue;
    if (file.path.endsWith('.test.ts') || file.path.endsWith('.d.ts')) continue;
    walk(file.ast.rootNode, (node) => {
      if (!FUNCTION_TYPES.has(node.type)) return;
      const lines = node.endPosition.row - node.startPosition.row + 1;
      if (lines <= MAX_LINES) return;
      violations.push(
        report(
          file,
          node,
          `Function '${nameOf(node)}' spans ${lines} lines (cap ${MAX_LINES}). Cut it into named phases, each its own function, so a reader can find a phase by its name and an edit to one phase does not re-read the rest.`,
        ),
      );
    });
  }
  return violations;
}
