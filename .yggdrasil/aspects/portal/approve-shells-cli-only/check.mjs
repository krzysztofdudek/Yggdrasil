import { walk, report } from '@chrisdudek/yg/ast';

// Invariant 4 (server arm): the portal's single write — Approve — is an OUT-OF-PROCESS
// shell of the existing CLI, never an in-process fill. This check pins the approve shape
// so a future edit cannot quietly re-implement the write or impersonate the flag:
//
//   1. Every CLI argument VECTOR — an array literal that contains the literal command
//      token 'check' — MUST also contain the literal fill flag '--approve'. The real
//      approve builds this vector in a helper (approveArgs / dryRunArgs return
//      ['check', '--approve', …]) and spreads it into the spawn call, so checking the
//      spawn call's own array (which is `[CLI_BIN, ...args]` — a spread, no 'check'
//      literal) verifies nothing. Checking every 'check'-bearing array literal in the
//      file catches a regression that drops '--approve' from the vector wherever it is
//      constructed.
//   2. No spawn-family call (spawn / spawnSync / execFile / execFileSync) may read
//      `process.env.<X>` anywhere in its argument list — the command, the bin reference,
//      and the fill flag must all be literals / module constants, never swapped at
//      runtime (`process.execPath` is not `process.env`, so the real spawn is fine).
//   3. The server may not call the engine's in-process fill entry points (runFill,
//      fillLlmPair, runApprove) by imported name — the fill is reached ONLY through the
//      spawned CLI.
//
// DETECTION IS AST-ONLY: only array-literal elements, spawn-call argument subtrees, and
// callee identifiers are inspected. A plain string literal that merely contains
// '--approve' in a comment or message is never a violation.

// Child-process spawn APIs the approve handler uses to run the CLI.
const SPAWN_APIS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync']);

// In-process fill entry points the server may not call directly — the fill is shelled.
const IN_PROCESS_FILL = new Set(['runFill', 'fillLlmPair', 'runApprove']);

const CHECK_TOKEN = 'check';
const APPROVE_FLAG = '--approve';

/** Literal value of a `string` / no-substitution `template_string` node, else undefined. */
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

/** Collect every `array` node among the call's arguments (the spawn arg list lives in one). */
function argArrayNodes(argsNode) {
  return (argsNode?.namedChildren ?? []).filter((a) => a.type === 'array');
}

/** True iff a node-subtree contains a `process.env.<x>` member access. */
function containsProcessEnv(node) {
  let found = false;
  walk(node, (n) => {
    if (found) return false;
    if (n.type === 'member_expression') {
      const obj = n.childForFieldName('object');
      // `process.env` is itself a member_expression; `process.env.X` nests it as the object.
      if (obj && obj.type === 'member_expression') {
        const innerObj = obj.childForFieldName('object');
        const innerProp = obj.childForFieldName('property');
        if (innerObj && innerProp && innerObj.text === 'process' && innerProp.text === 'env') {
          found = true;
          return false;
        }
      }
      if (obj && obj.text === 'process') {
        const prop = n.childForFieldName('property');
        if (prop && prop.text === 'env') {
          found = true;
          return false;
        }
      }
    }
    return true;
  });
  return found;
}

/** The literal string values among an array literal's elements. */
function literalElements(arrayNode) {
  const out = [];
  for (const el of arrayNode.namedChildren) {
    const v = stringValue(el);
    if (v !== undefined) out.push(v);
  }
  return out;
}

export function check(ctx) {
  const violations = [];

  for (const file of ctx.files) {
    if (!file.ast) continue;

    walk(file.ast.rootNode, (node) => {
      // (1) Every CLI arg VECTOR (array literal containing the 'check' token) must
      // carry a literal '--approve' — wherever it is built (approveArgs/dryRunArgs
      // return it and it is spread into the spawn call).
      if (node.type === 'array') {
        const literals = literalElements(node);
        if (literals.includes(CHECK_TOKEN) && !literals.includes(APPROVE_FLAG)) {
          violations.push(
            report(
              file,
              node,
              `Portal CLI argument vector runs 'check' but the fill flag '--approve' is not a literal ` +
                `element. Approve must shell 'check' with a literal '--approve' (add '--only-deterministic' ` +
                `for the free path) — never build the flag from a variable or env, which could no-op the write.`,
            ),
          );
        }
        return true;
      }

      if (node.type !== 'call_expression') return true;
      const fn = node.childForFieldName('function');
      if (!fn) return true;

      // (3) Direct call to an in-process fill entry point — banned.
      if (fn.type === 'identifier' && IN_PROCESS_FILL.has(fn.text)) {
        violations.push(
          report(
            file,
            node,
            `Portal server may not call the in-process fill entry point '${fn.text}'. The single write ` +
              `(Approve) must SHELL the CLI as a child process — spawn the bin with a literal '--approve'.`,
          ),
        );
        return true;
      }

      // (2) Spawn-family call — ban any process.env read anywhere in its argument list
      // (bin reference and flags must be literals / module constants, never impersonated).
      const calleeName = fn.type === 'identifier' ? fn.text : fn.type === 'member_expression' ? fn.childForFieldName('property')?.text : undefined;
      if (calleeName && SPAWN_APIS.has(calleeName)) {
        const argsNode = node.childForFieldName('arguments');
        if (argsNode && containsProcessEnv(argsNode)) {
          violations.push(
            report(
              file,
              node,
              `Portal server's spawn argument list reads process.env. The command, bin reference, and ` +
                `fill flag must all be literals / module constants — no runtime impersonation of the write path.`,
            ),
          );
        }
      }

      return true;
    });
  }

  // De-duplicate by (line, column, message).
  const seen = new Set();
  return violations.filter((v) => {
    const key = `${v.line}:${v.column}:${v.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
