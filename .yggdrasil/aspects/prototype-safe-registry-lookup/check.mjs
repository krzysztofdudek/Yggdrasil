import { walk, report, closest } from '@chrisdudek/yg/ast';

/**
 * prototype-safe-registry-lookup
 *
 * Flags an UNGUARDED computed member READ `OBJ[key]` where:
 *   - OBJ is a module-level `const OBJ: Record<string, V> = { ... }` bound
 *     directly to a plain object literal that has at least one explicit ("own")
 *     key entry, declared in the SAME file (this is a file-local check — no
 *     cross-file dataflow). The declared type must expose a STRING index
 *     (`Record<string, V>`, `{ [k: string]: V }`, or one of those wrapped in
 *     `Partial`/`Readonly`/`Required`). An object whose declared key type is a
 *     finite union / `keyof` / named type (e.g. `Record<SomeUnion, V>`) is NOT
 *     flagged: the type system constrains the index to own keys, so no inherited
 *     key can ever be reached. An un-annotated object literal is likewise skipped
 *     — TypeScript forbids indexing it by an arbitrary string.
 *   - key is a bare identifier (a non-literal, runtime key);
 *   - the access is a READ (right-hand side / expression position), not a write
 *     (`OBJ[k] = ...`), delete, or update target;
 *   - the read is NOT immediately optional-chained (`OBJ[key]?.prop` /
 *     `OBJ[key]?.[i]`): optional chaining onto a data property degrades an
 *     inherited value to `undefined`, which is the "not found" behaviour the
 *     caller expects — so that shape is provably safe and left alone;
 *   - key is not provably-own (not the loop variable of a `for..of` over
 *     `Object.keys/entries/values/getOwnPropertyNames(OBJ)` nor a `for..in OBJ`);
 *   - there is no own-property guard on the SAME object+key anywhere in the
 *     enclosing function scope: `Object.hasOwn(OBJ, key)`,
 *     `Object.prototype.hasOwnProperty.call(OBJ, key)`, `OBJ.hasOwnProperty(key)`,
 *     or a `key in OBJ` test (a `?? `/`||` fallback is NOT a guard — the
 *     inherited value is truthy — and is intentionally not treated as one).
 *
 * A reserved key inherited from Object.prototype (constructor, toString,
 * hasOwnProperty, valueOf, __proto__) resolves to an inherited value instead of
 * undefined, bypassing a `=== undefined` guard.
 *
 * errs: under — every reported violation is a provable defect. When any of the
 * above cannot be proven from the file's own syntax tree, the check stays
 * silent (false negatives preferred over false positives).
 */

const FUNCTION_TYPES = [
  'function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
  'generator_function',
  'generator_function_declaration',
];

// Object-literal named-child types that represent an explicit ("own") key.
// (An object with only `spread_element` children, or an empty object, is NOT a
// lookup table for this check's purposes.)
const OWN_KEY_CHILDREN = new Set(['pair', 'shorthand_property_identifier', 'method_definition']);

// Object.<...> iterators that yield only own keys.
const OWN_KEY_ITERATORS = new Set(['keys', 'entries', 'values', 'getOwnPropertyNames']);

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue; // skip non-parseable files (no tree-sitter AST)

    const registries = collectRegistries(file.ast.rootNode);
    if (registries.size === 0) continue;

    walk(file.ast.rootNode, (node) => {
      if (node.type !== 'subscript_expression') return;

      const objNode = node.childForFieldName('object');
      const keyNode = node.childForFieldName('index');
      if (!objNode || !keyNode) return;

      // OBJ must be a bare identifier bound to a same-file module-const object literal.
      if (objNode.type !== 'identifier') return;
      const objName = objNode.text;
      if (!registries.has(objName)) return;

      // key must be a bare identifier (non-literal, runtime key).
      if (keyNode.type !== 'identifier') return;
      const keyName = keyNode.text;

      // Must be a READ — writes / deletes / update targets are a different concern.
      if (isWriteOrDeleteTarget(node)) return;

      // Optional-chained navigation (`OBJ[key]?.prop`) degrades an inherited
      // value to undefined — provably safe, so leave it alone.
      if (isOptionalChainedRead(node)) return;

      // Skip provably-own iteration contexts (keys are own by construction).
      if (inOwnKeyIteration(node, objName, keyName)) return;

      // Skip if a same-object+key own-property guard exists in the enclosing scope.
      const scopeRoot = closest(node, FUNCTION_TYPES) ?? file.ast.rootNode;
      if (hasGuard(scopeRoot, objName, keyName)) return;

      violations.push(
        report(
          file,
          node,
          `Unguarded dynamic read '${objName}[${keyName}]' of the module-level object-literal registry '${objName}'. ` +
            `A reserved key inherited from Object.prototype (constructor, toString, hasOwnProperty, valueOf, __proto__) ` +
            `resolves to an inherited value instead of undefined, bypassing a '=== undefined' guard and either crashing ` +
            `or fabricating output. Guard the read with Object.hasOwn(${objName}, ${keyName}), ` +
            `Object.prototype.hasOwnProperty.call(${objName}, ${keyName}), or a '${keyName} in ${objName}' branch — ` +
            `or back the registry with a Map or Object.create(null).`,
        ),
      );
    });
  }
  return violations;
}

/**
 * Collect names of module-level `const NAME: Record<string, V> = { ... }`
 * object-literal registries declared in this file. Module scope = the
 * declaration is a direct child of the program, or of an `export_statement`
 * that is a direct child of the program.
 *
 * The declared type MUST expose a string index (see `typeAllowsStringIndex`).
 * That is exactly the shape a runtime string key can reach inherited
 * Object.prototype members through; a union / `keyof` / named key type, or no
 * annotation at all, keeps the index constrained to own keys and is skipped.
 */
function collectRegistries(root) {
  const names = new Set();
  walk(root, (node) => {
    if (node.type !== 'lexical_declaration') return;
    const kind = node.childForFieldName('kind');
    if (!kind || kind.text !== 'const') return;
    if (!isModuleScoped(node)) return;
    for (const child of node.namedChildren) {
      if (child.type !== 'variable_declarator') continue;
      const nameNode = child.childForFieldName('name');
      const valueNode = child.childForFieldName('value');
      const typeNode = child.childForFieldName('type');
      if (!nameNode || nameNode.type !== 'identifier') continue;
      // Value must be a plain object literal — NOT a call (Object.create/…),
      // `new Map`, a type assertion (`… as …`), a spread, etc.
      if (!valueNode || valueNode.type !== 'object') continue;
      // Require at least one explicit own-key entry (excludes `{}` and spread-only).
      if (!valueNode.namedChildren.some((c) => OWN_KEY_CHILDREN.has(c.type))) continue;
      // Require a declared type that is indexable by an arbitrary string — the
      // only shape where a runtime key can reach an inherited prototype member.
      if (!typeNode || typeNode.type !== 'type_annotation') continue;
      if (!typeAllowsStringIndex(typeNode.namedChildren[0])) continue;
      names.add(nameNode.text);
    }
  });
  return names;
}

function isModuleScoped(lexNode) {
  const parent = lexNode.parent;
  if (!parent) return false;
  if (parent.type === 'program') return true;
  if (parent.type === 'export_statement' && parent.parent && parent.parent.type === 'program') return true;
  return false;
}

/**
 * True when the type node is indexable by an arbitrary `string`:
 *   - `Record<string, V>`
 *   - `{ [k: string]: V }`
 *   - `Partial<…>` / `Readonly<…>` / `Required<…>` wrapping one of the above.
 * A `number` index is deliberately NOT accepted: numeric keys never collide with
 * Object.prototype's string-named members, so they are not vulnerable.
 */
function typeAllowsStringIndex(t) {
  if (!t) return false;
  if (t.type === 'object_type') {
    return t.namedChildren.some((c) => {
      if (c.type !== 'index_signature') return false;
      const idx = c.childForFieldName('index_type');
      return idx && idx.type === 'predefined_type' && idx.text === 'string';
    });
  }
  if (t.type === 'generic_type') {
    const name = t.childForFieldName('name');
    const args = t.childForFieldName('type_arguments');
    if (!name || !args) return false;
    if (name.text === 'Record') {
      const first = args.namedChildren[0];
      return first !== undefined && first.type === 'predefined_type' && first.text === 'string';
    }
    if (name.text === 'Partial' || name.text === 'Readonly' || name.text === 'Required') {
      return typeAllowsStringIndex(args.namedChildren[0]);
    }
  }
  return false;
}

/** True when the subscript's value is immediately consumed by optional chaining. */
function isOptionalChainedRead(subscript) {
  const parent = subscript.parent;
  if (!parent) return false;
  if (parent.type !== 'member_expression' && parent.type !== 'subscript_expression') return false;
  if (!sameNode(parent.childForFieldName('object'), subscript)) return false;
  const oc = parent.childForFieldName('optional_chain');
  return oc !== null && oc !== undefined;
}

/** True when the subscript is the target of a write / delete / ++/-- (not a value read). */
function isWriteOrDeleteTarget(subscript) {
  const parent = subscript.parent;
  if (!parent) return false;
  if (parent.type === 'assignment_expression' || parent.type === 'augmented_assignment_expression') {
    return sameNode(parent.childForFieldName('left'), subscript);
  }
  if (parent.type === 'update_expression') return true; // OBJ[k]++ / --OBJ[k]
  if (parent.type === 'unary_expression') {
    const op = parent.childForFieldName('operator');
    if (op && op.text === 'delete') return true;
  }
  if (parent.type === 'for_in_statement') {
    return sameNode(parent.childForFieldName('left'), subscript);
  }
  return false;
}

/** True when the read sits inside an own-key iteration over the SAME object. */
function inOwnKeyIteration(subscript, objName, keyName) {
  let cur = subscript.parent;
  while (cur) {
    if (cur.type === 'for_in_statement') {
      const left = cur.childForFieldName('left');
      const op = cur.childForFieldName('operator');
      const right = cur.childForFieldName('right');
      if (left && left.type === 'identifier' && left.text === keyName && op) {
        // for (const key of Object.keys(OBJ)) { OBJ[key] }
        if (op.text === 'of' && iteratesOwnKeysOf(right, objName)) return true;
        // for (const key in OBJ) { OBJ[key] } — Object.prototype members are
        // non-enumerable, so for..in over a plain object yields only own keys.
        if (op.text === 'in' && right && right.type === 'identifier' && right.text === objName) return true;
      }
    }
    cur = cur.parent;
  }
  return false;
}

function iteratesOwnKeysOf(callNode, objName) {
  if (!callNode || callNode.type !== 'call_expression') return false;
  const fn = callNode.childForFieldName('function');
  if (!fn || fn.type !== 'member_expression') return false;
  const fnObj = fn.childForFieldName('object');
  const fnProp = fn.childForFieldName('property');
  if (!fnObj || fnObj.type !== 'identifier' || fnObj.text !== 'Object') return false;
  if (!fnProp || !OWN_KEY_ITERATORS.has(fnProp.text)) return false;
  const args = callNode.childForFieldName('arguments');
  if (!args) return false;
  return args.namedChildren.some((a) => a.type === 'identifier' && a.text === objName);
}

/** Search the enclosing scope subtree for an own-property guard on OBJ+key. */
function hasGuard(scopeRoot, objName, keyName) {
  let found = false;
  walk(scopeRoot, (node) => {
    if (found) return false; // prune once a guard is located
    if (node.type === 'binary_expression') {
      const op = node.childForFieldName('operator');
      if (op && op.text === 'in') {
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        if (
          left &&
          left.type === 'identifier' &&
          left.text === keyName &&
          right &&
          right.type === 'identifier' &&
          right.text === objName
        ) {
          found = true;
          return false;
        }
      }
      return;
    }
    if (node.type === 'call_expression' && isHasOwnGuard(node, objName, keyName)) {
      found = true;
      return false;
    }
  });
  return found;
}

function isHasOwnGuard(callNode, objName, keyName) {
  const fn = callNode.childForFieldName('function');
  const args = callNode.childForFieldName('arguments');
  if (!fn || fn.type !== 'member_expression' || !args) return false;
  const prop = fn.childForFieldName('property');
  const propName = prop ? prop.text : '';
  const argNodes = args.namedChildren;
  const argIsIdent = (i, name) => argNodes[i] && argNodes[i].type === 'identifier' && argNodes[i].text === name;

  // Object.hasOwn(OBJ, key)
  if (propName === 'hasOwn') {
    const fnObj = fn.childForFieldName('object');
    if (fnObj && fnObj.type === 'identifier' && fnObj.text === 'Object' && argIsIdent(0, objName) && argIsIdent(1, keyName)) {
      return true;
    }
  }
  // OBJ.hasOwnProperty(key)
  if (propName === 'hasOwnProperty') {
    const fnObj = fn.childForFieldName('object');
    if (fnObj && fnObj.type === 'identifier' && fnObj.text === objName && argIsIdent(0, keyName)) return true;
  }
  // Object.prototype.hasOwnProperty.call(OBJ, key)  /  {}.hasOwnProperty.call(OBJ, key)
  if (propName === 'call') {
    const inner = fn.childForFieldName('object');
    if (inner && inner.type === 'member_expression') {
      const innerProp = inner.childForFieldName('property');
      if (innerProp && innerProp.text === 'hasOwnProperty' && argIsIdent(0, objName) && argIsIdent(1, keyName)) return true;
    }
  }
  return false;
}

/** Identity by source span — web-tree-sitter may hand back distinct wrappers for one node. */
function sameNode(a, b) {
  if (!a || !b) return false;
  const as = a.startPosition;
  const bs = b.startPosition;
  const ae = a.endPosition;
  const be = b.endPosition;
  return as.row === bs.row && as.column === bs.column && ae.row === be.row && ae.column === be.column;
}
