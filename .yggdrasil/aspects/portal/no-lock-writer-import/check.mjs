import { walk, report } from '@chrisdudek/yg/ast';

// Invariant 4: the portal is read-only except the single shelled Approve. No
// in-process lock writer may be reachable from the backend.
//
// AST-based bans:
//   - import the PERSISTING fill module (core/fill) wholesale — every symbol it
//     exports persists. The non-persisting primitive (core/fill-det) is allowed,
//     so the module match is exact (`fill.js`, never `fill-det.js`).
//   - import a writer SYMBOL by imported name (alias-proof) from ANY module. The
//     lock-store module is NOT banned wholesale — readLock lives there — only its
//     writer symbols are caught here by name.
//   - call a writer symbol: a bare call `writeLock(...)` or a member call on a
//     namespace alias `store.writeLock(...)`.
//   - READ a writer symbol off a lock-store namespace alias: `store.writeLock` as a
//     member_expression, regardless of whether it is immediately called or first
//     bound to a local (`const persist = store.writeLock`). Binding then calling is
//     a write reachable from the backend just as much as a direct member call, so
//     the member READ itself is the violation.
// We never scan raw text; a string literal containing "writeLock" is not a hit.

const WRITER_SYMBOLS = new Set([
  'writeLock',
  'setEntry',
  'persistEntry',
  'runFill',
  'saveLock',
  'commitLock',
]);

// The lock-store module — its writer symbols may not be member-read off a namespace
// alias. readLock lives there too, so the module is not banned wholesale.
const LOCK_STORE_MODULE_RE = /(^|\/)lock-store(\.js)?$/;

// The persisting fill module, matched EXACTLY so core/fill-det is never caught.
const PERSISTING_FILL_MODULE_RE = /(^|\/)fill(\.js)?$/;

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

export function check(ctx) {
  const violations = [];

  for (const file of ctx.files) {
    if (!file.ast) continue;

    // Namespace aliases bound to the lock-store module: `import * as store from '...lock-store'`.
    const lockStoreNamespaceAliases = new Set();

    walk(file.ast.rootNode, (node) => {
      if (node.type === 'import_statement' || node.type === 'export_statement') {
        const spec = stringValue(node.childForFieldName('source'));
        if (typeof spec === 'string' && PERSISTING_FILL_MODULE_RE.test(spec)) {
          violations.push(
            report(
              file,
              node,
              `Portal backend may not import the persisting fill module ('${spec}'). ` +
                `The only write is the out-of-process shelled Approve; use fillDetPair (core/fill-det) ` +
                `for a non-persisting verdict.`,
            ),
          );
          return true;
        }
        // Record a lock-store namespace alias so member READS of a writer are caught below.
        if (typeof spec === 'string' && LOCK_STORE_MODULE_RE.test(spec)) {
          walk(node, (n) => {
            if (n.type === 'namespace_import') {
              const alias = n.namedChildren.find((c) => c.type === 'identifier');
              if (alias) lockStoreNamespaceAliases.add(alias.text);
            }
          });
        }
        // Writer symbol imported by name, from any module.
        walk(node, (n) => {
          if (n.type === 'import_specifier') {
            const importedName = n.namedChildren[0]?.text;
            if (importedName && WRITER_SYMBOLS.has(importedName)) {
              violations.push(
                report(file, node, `Portal backend may not import lock-writer symbol '${importedName}'.`),
              );
            }
          }
        });
        return true;
      }

      if (node.type === 'call_expression') {
        const fn = node.childForFieldName('function');
        if (!fn) return true;
        // bare call: writeLock(...)
        if (fn.type === 'identifier' && WRITER_SYMBOLS.has(fn.text)) {
          violations.push(report(file, node, `Portal backend may not call lock-writer '${fn.text}'.`));
          return true;
        }
        // member call: store.writeLock(...)  — kept for a writer member call whose object
        // is NOT a recorded lock-store alias (any other object exposing a writer method).
        // A lock-store-alias member call is owned by the member-READ pass below, so we
        // skip it here to avoid a duplicate report at the same location.
        if (fn.type === 'member_expression') {
          const obj = fn.childForFieldName('object');
          const prop = fn.childForFieldName('property');
          const isLockStoreAlias = obj && lockStoreNamespaceAliases.has(obj.text);
          if (prop && WRITER_SYMBOLS.has(prop.text) && !isLockStoreAlias) {
            violations.push(report(file, node, `Portal backend may not call lock-writer '${prop.text}'.`));
          }
        }
      }

      return true;
    });

    // Second pass: ANY member READ of a writer symbol off a lock-store namespace alias —
    // `store.writeLock` — whether it is called, assigned to a local, passed as a callback,
    // or returned. Binding then calling is a write path, so the member read is the violation.
    if (lockStoreNamespaceAliases.size > 0) {
      walk(file.ast.rootNode, (node) => {
        if (node.type !== 'member_expression') return true;
        const obj = node.childForFieldName('object');
        const prop = node.childForFieldName('property');
        if (obj && prop && lockStoreNamespaceAliases.has(obj.text) && WRITER_SYMBOLS.has(prop.text)) {
          violations.push(
            report(
              file,
              node,
              `Portal backend may not reference lock-writer '${obj.text}.${prop.text}' — binding a writer to ` +
                `a local then calling it is still an in-process write. The only write is the shelled Approve.`,
            ),
          );
        }
        return true;
      });
    }
  }

  // De-duplicate: a `store.writeLock(...)` member CALL is reported by both the member-call
  // arm and the member-read arm. Keep one violation per (line, column, message).
  const seen = new Set();
  return violations.filter((v) => {
    const key = `${v.line}:${v.column}:${v.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
