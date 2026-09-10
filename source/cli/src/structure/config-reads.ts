import { withParsedFile } from '../ast/parser.js';
import { walk } from '../ast/walk.js';
import type { Node } from 'web-tree-sitter';

/**
 * source/cli/src/structure/config-reads.ts — which `ctx.config` keys a rule
 * script reads, worked out statically, without running it.
 *
 * The runtime answer to this question already exists and lives next door:
 * `hook-loader.ts` hands a rule a `ctx.config` Proxy that records every key the
 * rule actually asks for, which is what puts a setting's value into that rule's
 * verdict. That answer needs the rule to run, and running a rule needs a graph.
 * A marketplace repository has neither — it publishes law, it does not enforce
 * any — so the pre-publish check needs the same question answered from the text
 * alone. This module is that reading, and it lives beside the runtime one so the
 * two accounts of "what does this rule consult" stay in each other's sight.
 *
 * It is deliberately CONSERVATIVE rather than clever. Every access it cannot
 * resolve to a literal key — an alias, a computed subscript, the object handed
 * to something else whole — sets `dynamic` instead of guessing at a name. That
 * asymmetry is the whole design: a key it reports is one it can point at in the
 * source, so "read but never declared" can be an error; `dynamic` says the
 * reading is incomplete, so "declared but never read" cannot be concluded at all
 * and the caller must fall silent on that direction.
 */

/** What a static reading of one rule script found. */
export interface ConfigReads {
  /** Keys resolved to a literal name, sorted and deduplicated. */
  keys: string[];
  /**
   * True when the script reaches the configuration object in a way no static
   * reading can name a key for. `keys` is then a lower bound, not the whole set.
   */
  dynamic: boolean;
}

/**
 * The parameter name a rule script's `check` function gives its context.
 *
 * Conventionally `ctx`, and every example in the documentation writes it that
 * way — but it is an ordinary parameter and an author may call it anything.
 * Reading the real name off the declaration costs one pass and is the difference
 * between analysing the script in front of us and analysing the one we expected.
 */
function contextParamName(root: Node): string {
  let found: string | null = null;
  walk(root, (node) => {
    if (found !== null) return false;
    const isNamedCheck =
      node.type === 'function_declaration' &&
      node.childForFieldName('name')?.text === 'check';
    const isAssignedCheck =
      node.type === 'variable_declarator' &&
      node.childForFieldName('name')?.text === 'check' &&
      (node.childForFieldName('value')?.type === 'arrow_function' ||
        node.childForFieldName('value')?.type === 'function_expression');
    if (!isNamedCheck && !isAssignedCheck) return;
    const fn = isNamedCheck ? node : node.childForFieldName('value');
    const params = fn?.childForFieldName('parameters') ?? fn?.childForFieldName('parameter');
    const first = params?.namedChild(0) ?? null;
    if (first !== null && first.type === 'identifier') found = first.text;
  });
  return found ?? 'ctx';
}

/** True when `node` is the member expression `<ctxName>.config`. */
function isConfigObject(node: Node, ctxName: string): boolean {
  if (node.type !== 'member_expression') return false;
  return (
    node.childForFieldName('object')?.text === ctxName &&
    node.childForFieldName('property')?.text === 'config'
  );
}

/** The literal key a string node names, or null when it is not a plain literal. */
function literalKey(node: Node): string | null {
  if (node.type === 'string') {
    const inner = node.namedChildren.find((c) => c?.type === 'string_fragment');
    // An empty string literal has no fragment child; it names the empty key,
    // which is a key like any other and not a failure to read one.
    return inner?.text ?? '';
  }
  // A template string with no substitution is still a literal name; one with a
  // substitution is not, and falls through to the dynamic path.
  if (node.type === 'template_string' && node.namedChildren.length === 0) {
    return node.text.slice(1, -1);
  }
  return null;
}

/**
 * Every key `<ctxName>.config` is read for in `source`.
 *
 * Four shapes resolve to a name — `.key`, `['key']`, a destructuring of the
 * object, and a shorthand rename inside one. A fifth, any other appearance of
 * the object at all, is what `dynamic` reports: passing it to a helper, spreading
 * it, storing it in a variable and reading that variable later. None of those can
 * be followed without becoming a small interpreter, and a wrong guess here would
 * put a key nobody wrote into a refusal.
 */
export async function collectConfigReads(filePath: string, source: string): Promise<ConfigReads> {
  return withParsedFile(filePath, source, (tree) => {
    const root = tree.rootNode;
    const ctxName = contextParamName(root);
    const keys = new Set<string>();
    let dynamic = false;

    walk(root, (node) => {
      if (!isConfigObject(node, ctxName)) return;
      const parent = node.parent;
      if (parent === null) {
        dynamic = true;
        return;
      }

      // `<ctx>.config.<key>` — the object of an outer member expression.
      if (parent.type === 'member_expression' && parent.childForFieldName('object')?.id === node.id) {
        const property = parent.childForFieldName('property');
        if (property !== null && property.type === 'property_identifier') {
          keys.add(property.text);
        } else {
          dynamic = true;
        }
        return;
      }

      // `<ctx>.config[<expr>]` — a literal subscript names a key, anything else
      // is undecidable by construction.
      if (parent.type === 'subscript_expression' && parent.childForFieldName('object')?.id === node.id) {
        const index = parent.childForFieldName('index');
        const key = index === null ? null : literalKey(index);
        if (key === null) dynamic = true;
        else keys.add(key);
        return;
      }

      // `const { threshold, label: name } = <ctx>.config` — every property the
      // pattern names is a read, and a rest element is not (it takes whatever is
      // left, which is exactly what cannot be named).
      if (parent.type === 'variable_declarator' && parent.childForFieldName('value')?.id === node.id) {
        const pattern = parent.childForFieldName('name');
        if (pattern === null || pattern.type !== 'object_pattern') {
          dynamic = true;
          return;
        }
        for (const child of pattern.namedChildren) {
          if (child === null) continue;
          if (child.type === 'shorthand_property_identifier_pattern') keys.add(child.text);
          else if (child.type === 'pair_pattern') {
            const name = child.childForFieldName('key');
            if (name !== null) keys.add(name.text);
            else dynamic = true;
          } else dynamic = true;
        }
        return;
      }

      dynamic = true;
    });

    return { keys: [...keys].sort(), dynamic };
  });
}
