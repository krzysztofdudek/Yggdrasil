import { walk, report } from '@chrisdudek/yg/ast';

// Invariant 1: count parity with `yg check` is a release blocker. The portal must
// REUSE the CLI's read-only functions to derive every count — never recompute one
// by hashing inputs itself or by hand-rolling a reducer over raw lock verdicts.
//
// THE REAL GUARANTEE IS THE POSITIVE ARM plus the count-parity integration test:
//   - POSITIVE (a node-TYPE manifest): every node of the portal's engine-facade type
//     MUST call its required reuse functions — runCheck + computeExpectedPairs. Keyed
//     on the node's architecture type, not on a file basename or a node id, so
//     renaming or splitting a file or a node cannot evade the requirement. A node
//     whose type the manifest does not know fails closed.
//   - the integration test asserts the emitted counts equal `yg check` on the real graph.
// The NEGATIVE arms below are a TRIPWIRE, not the guarantee: a hand-rolled reducer over
// raw lock verdicts (or a verdict-hashing import) is the obvious way to drift, so we
// catch the common shapes. They are inherently heuristic — a sufficiently obfuscated
// re-count can evade them — which is exactly why the positive manifest + the parity
// test carry the real weight. scope: per node — the whole node's subject set is in
// ctx.files for one verdict.

// Required reuse callees per node TYPE. Each listed function MUST appear as a call
// somewhere in the node's files. The portal reaches the engine ONLY through the single
// facade type (portal-engine-api), so the reuse requirement lives THERE — the facade is
// where runCheck + computeExpectedPairs are actually called; the pipeline reuses the
// facade and so has no call of its own to require (only the negative arms apply to it).
// Every type this aspect is attached to must have an entry: a node of an unlisted type
// is reported, so attaching the rule to a new type forces a decision here instead of
// silently skipping the positive arm.
const REQUIRED_REUSE_BY_TYPE = {
  'portal-engine-api': ['runCheck', 'computeExpectedPairs'],
  'portal-pipeline': [],
};

/** Trailing name of a callee: bare `f` or member `ns.f` → `f`. */
function calleeName(callNode) {
  const fn = callNode.childForFieldName('function');
  if (!fn) return '';
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'member_expression') {
    const prop = fn.childForFieldName('property');
    return prop ? prop.text : '';
  }
  return fn.text.split('.').pop() ?? '';
}

function stringValue(node) {
  if (!node) return undefined;
  if (node.type !== 'string' && node.type !== 'template_string') return undefined;
  if (node.type === 'template_string' && node.namedChildren.some((c) => c.type === 'template_substitution')) {
    return undefined;
  }
  const frag = node.namedChildren.find((c) => c.type === 'string_fragment');
  if (frag) return frag.text;
  const t = node.text;
  return t.length >= 2 ? t.slice(1, -1) : '';
}

// A receiver expression that reads RAW lock verdicts directly (the hand-roll smell).
// Tightened from `\.verdicts\b`: a member access (`.verdicts.x`) and a subscript
// (`.verdicts[i]`) both follow `.verdicts` without a word boundary, so the bare-\b form
// missed them. `verification.pairs`, `result.issues`, etc. are engine RESULTS — they do
// NOT match, so iterating an engine return value is allowed (that is reuse).
const RAW_VERDICT_RECEIVER_RE = /\.verdicts(\b|\.|\[)/;

export function check(ctx) {
  const violations = [];
  const seenCallees = new Set();

  for (const file of ctx.files) {
    if (!file.ast) continue;

    // Locals that alias the raw lock-verdicts map, so a loop over the LOCAL (not the
    // `.verdicts` expression itself) is still caught:
    //   const entries = lock.verdicts;          → entries
    //   const { verdicts } = lock;              → verdicts (destructured)
    const verdictLocals = collectVerdictLocals(file.ast.rootNode);

    walk(file.ast.rootNode, (node) => {
      // NEGATIVE 1: ban a verdict-hashing import (re-deriving a verdict by hashing).
      if (node.type === 'import_statement' || node.type === 'export_statement') {
        const spec = stringValue(node.childForFieldName('source'));
        if (typeof spec === 'string' && (/(^|\/)hash(\.js)?$/.test(spec) || spec === 'node:crypto' || spec === 'crypto')) {
          walk(node, (n) => {
            if (n.type === 'import_specifier') {
              const imported = n.namedChildren[0]?.text;
              if (imported === 'createHash' || imported === 'hashInputs' || imported === 'hashBytes') {
                violations.push(
                  report(
                    file,
                    node,
                    `Portal pipeline may not hash inputs to re-derive a verdict ('${imported}') — ` +
                      `call verifyLock / runCheck and read the result.`,
                  ),
                );
              }
            }
          });
        }
        return true;
      }

      if (node.type === 'call_expression') {
        seenCallees.add(calleeName(node));
        // NEGATIVE 2: a reducer/iterator over RAW lock verdicts (re-counting by hand),
        // whether the receiver is `<x>.verdicts` directly OR a local bound from it.
        const fn = node.childForFieldName('function');
        if (fn && fn.type === 'member_expression') {
          const method = fn.childForFieldName('property')?.text ?? '';
          if (['reduce', 'map', 'filter', 'forEach', 'flatMap'].includes(method)) {
            const receiverNode = fn.childForFieldName('object');
            const receiver = receiverNode?.text ?? '';
            const receiverIsLocal = receiverNode?.type === 'identifier' && verdictLocals.has(receiver);
            if (RAW_VERDICT_RECEIVER_RE.test(receiver) || receiverIsLocal) {
              violations.push(
                report(
                  file,
                  node,
                  `Do not iterate raw lock verdicts by hand to re-count or re-classify them — ` +
                    `call verifyLock / computeExpectedPairs and read the engine result.`,
                ),
              );
            }
          }
        }
        return true;
      }

      // NEGATIVE 2b: a for-of / for loop over raw lock verdicts — directly via a
      // `.verdicts` receiver OR over a local bound from `lock.verdicts`.
      if (node.type === 'for_in_statement' || node.type === 'for_statement') {
        if (RAW_VERDICT_RECEIVER_RE.test(node.text) || loopsOverVerdictLocal(node, verdictLocals)) {
          violations.push(
            report(
              file,
              node,
              `Do not loop over raw lock verdicts by hand to derive a state or count — ` +
                `reuse the engine read-only functions.`,
            ),
          );
        }
      }

      return true;
    });
  }

  // POSITIVE: every required reuse callee for this node's type must be present.
  // ctx.node is absent in ad-hoc (--files) runs and for a file enforced by its type
  // alone; the manifest is keyed by node type, so the positive arm applies to a real
  // graph node only.
  const nodeType = ctx.node?.type;
  let required = [];
  if (ctx.node) {
    if (!Object.hasOwn(REQUIRED_REUSE_BY_TYPE, nodeType)) {
      const first = ctx.files[0];
      violations.push({
        file: first ? first.path : undefined,
        line: 1,
        column: 0,
        message:
          `Node '${ctx.node.id}' has type '${nodeType}', which the count-parity reuse manifest ` +
          `does not know — add the type to REQUIRED_REUSE_BY_TYPE with the engine functions its ` +
          `nodes must call (an empty list if it reaches the engine only through the facade).`,
      });
    } else {
      required = REQUIRED_REUSE_BY_TYPE[nodeType];
    }
  }
  for (const fnName of required) {
    if (!seenCallees.has(fnName)) {
      const first = ctx.files[0];
      violations.push({
        file: first ? first.path : undefined,
        line: 1,
        column: 0,
        message:
          `Node '${ctx.node.id}' must derive its counts by calling '${fnName}' (reuse, do not ` +
          `re-implement) — it is absent from this node's files.`,
      });
    }
  }

  // De-duplicate by (line, column, message): a hand-rolled `.verdicts` access matched by
  // BOTH the regex and the local-alias arm yields one violation, not two.
  const seen = new Set();
  return violations.filter((v) => {
    const key = `${v.file}:${v.line}:${v.column}:${v.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Collect local identifiers that alias the raw lock-verdicts map within a file:
 *   const entries = <anything>.verdicts;   → 'entries'
 *   const { verdicts } = <anything>;       → 'verdicts'  (object-pattern destructure)
 * The RHS object expression is intentionally unconstrained — any `.verdicts` read or
 * any destructure of a `verdicts` property is the raw-verdict hand-roll smell. Engine
 * results are read off `.pairs` / `.issues`, never `.verdicts`, so this does not catch
 * the legitimate reuse path.
 */
function collectVerdictLocals(rootNode) {
  const locals = new Set();
  walk(rootNode, (node) => {
    if (node.type !== 'variable_declarator') return true;
    const nameNode = node.childForFieldName('name');
    const valueNode = node.childForFieldName('value');
    if (!nameNode || !valueNode) return true;

    // const entries = <x>.verdicts
    if (nameNode.type === 'identifier' && valueNode.type === 'member_expression') {
      const prop = valueNode.childForFieldName('property')?.text;
      if (prop === 'verdicts') locals.add(nameNode.text);
      return true;
    }

    // const { verdicts } = <x>   (and const { verdicts: alias } = <x>)
    if (nameNode.type === 'object_pattern') {
      for (const child of nameNode.namedChildren) {
        // shorthand: `{ verdicts }` → shorthand_property_identifier_pattern 'verdicts'
        if (child.type === 'shorthand_property_identifier_pattern' && child.text === 'verdicts') {
          locals.add('verdicts');
        }
        // renamed: `{ verdicts: alias }` → pair_pattern key 'verdicts', value the local name
        if (child.type === 'pair_pattern') {
          const key = child.childForFieldName('key')?.text;
          const val = child.childForFieldName('value');
          if (key === 'verdicts' && val && val.type === 'identifier') locals.add(val.text);
        }
      }
    }
    return true;
  });
  return locals;
}

/** True iff a for-of loop iterates one of the verdict-aliased locals (`for (… of entries)`). */
function loopsOverVerdictLocal(loopNode, verdictLocals) {
  if (verdictLocals.size === 0) return false;
  // tree-sitter `for_in_statement` exposes the iterated expression on the `right` field.
  const right = loopNode.childForFieldName('right');
  if (right && right.type === 'identifier' && verdictLocals.has(right.text)) return true;
  return false;
}
