import { walk, report } from '@chrisdudek/yg/ast';

// Invariant 4: the portal is read-only except the single shelled Approve. No
// in-process lock writer may be reachable from the backend.
//
// AST-based bans:
//   - import the lock-store module (io/lock-store) for anything but its named
//     READERS. The ban is an allowlist, not a list of writers: a writer added to
//     lock-store later (writeLockSync arrived that way) is refused on arrival,
//     where a list of writer names would have let it through.
//   - member-READ anything but a reader off a lock-store namespace alias:
//     `store.writeLock`, whether it is immediately called or first bound to a
//     local (`const persist = store.writeLock`). Binding then calling is a write
//     reachable from the backend just as much as a direct member call, so the
//     member READ itself is the violation.
//   - import a persisting fill module wholesale: core/fill (every symbol persists)
//     and core/fill-writer (the verdict writer and the fill exclusion). The
//     non-persisting primitive (core/fill-det) is allowed, so the module match is
//     exact (`fill.js`, never `fill-det.js`).
//   - import or call a writer SYMBOL by name from ANY module (alias-proof):
//     writeLock, writeLockSync, setEntry (the verdict writer's method), runFill.
// We never scan raw text; a string literal containing "writeLock" is not a hit.

const WRITER_SYMBOLS = new Set(['writeLock', 'writeLockSync', 'setEntry', 'runFill']);

// What the portal may take from io/lock-store: pure readers, path helpers, the
// pure serializer, the error classes and the option type. Anything else it
// exports writes, or takes the approve lock, and is refused.
const LOCK_STORE_READERS = new Set([
  'readLock',
  'readTypeLock',
  'readDetLockAspectIds',
  'readLegacyLock',
  'nondetLockPath',
  'detLockPath',
  'committedLockContentHash',
  'serializeLock',
  'LockInvalidError',
  'LockEnvironmentError',
  'APPROVE_LOCK_FILE_NAME',
  'WriteLockOptions',
]);

const LOCK_STORE_MODULE_RE = /(^|\/)lock-store(\.js)?$/;

// The persisting fill modules, matched EXACTLY so core/fill-det is never caught.
const PERSISTING_FILL_MODULE_RE = /(^|\/)fill(-writer)?(\.js)?$/;

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

function checkImport(file, node, spec, lockStoreNamespaceAliases, violations) {
  if (PERSISTING_FILL_MODULE_RE.test(spec)) {
    violations.push(
      report(
        file,
        node,
        `Portal backend may not import the persisting fill module ('${spec}'). ` +
          `The only write is the out-of-process shelled Approve; use fillDetPair (core/fill-det) ` +
          `for a non-persisting verdict.`,
      ),
    );
    return;
  }
  const fromLockStore = LOCK_STORE_MODULE_RE.test(spec);
  walk(node, (n) => {
    if (fromLockStore && n.type === 'namespace_import') {
      const alias = n.namedChildren.find((c) => c.type === 'identifier');
      if (alias) lockStoreNamespaceAliases.add(alias.text);
    }
    if (n.type === 'import_specifier') {
      const importedName = n.namedChildren[0]?.text;
      if (!importedName) return true;
      if (fromLockStore && !LOCK_STORE_READERS.has(importedName)) {
        violations.push(
          report(
            file,
            node,
            `Portal backend may import only readers from '${spec}'; '${importedName}' is not one ` +
              `(allowed: ${[...LOCK_STORE_READERS].join(', ')}).`,
          ),
        );
      } else if (WRITER_SYMBOLS.has(importedName)) {
        violations.push(report(file, node, `Portal backend may not import lock-writer symbol '${importedName}'.`));
      }
    }
    return true;
  });
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
        if (typeof spec === 'string') checkImport(file, node, spec, lockStoreNamespaceAliases, violations);
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
        // member call: writer.setEntry(...) — a writer method on any object that is NOT a
        // recorded lock-store alias. A lock-store-alias member access is owned by the
        // member-READ pass below, so it is skipped here to avoid a duplicate report.
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

    // Second pass: ANY member READ of a non-reader off a lock-store namespace alias —
    // `store.writeLock` — whether it is called, assigned to a local, passed as a callback,
    // or returned. Binding then calling is a write path, so the member read is the violation.
    if (lockStoreNamespaceAliases.size > 0) {
      walk(file.ast.rootNode, (node) => {
        if (node.type !== 'member_expression') return true;
        const obj = node.childForFieldName('object');
        const prop = node.childForFieldName('property');
        if (obj && prop && lockStoreNamespaceAliases.has(obj.text) && !LOCK_STORE_READERS.has(prop.text)) {
          violations.push(
            report(
              file,
              node,
              `Portal backend may not reference '${obj.text}.${prop.text}' — only the lock-store readers are ` +
                `allowed, and binding a writer to a local then calling it is still an in-process write. ` +
                `The only write is the shelled Approve.`,
            ),
          );
        }
        return true;
      });
    }
  }

  // De-duplicate one violation per (line, column, message).
  const seen = new Set();
  return violations.filter((v) => {
    const key = `${v.line}:${v.column}:${v.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
