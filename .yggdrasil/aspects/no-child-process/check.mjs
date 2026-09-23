import { walk, report, inFile } from '@chrisdudek/yg/ast';

const CHILD_PROCESS_MODULES = new Set(['node:child_process', 'child_process']);

// The utility layer's process adapters: the only utility modules allowed to start
// a child process. git.ts, git-introspect.ts and git-pack-fetch.ts run git (the
// last one clones a package remote over the network); binary-check.ts runs
// `<binary> --version` to probe for a reviewer CLI. Everything else this rule
// reaches — the engine, and the rest of utility — may only CALL these adapters.
const PROCESS_ADAPTER_GLOBS = ['**/src/utils/git*.ts', '**/src/utils/binary-check.ts'];

// A statement-level type-only import is erased at compile time and starts no
// process, so it is never a hit (the same guard no-direct-fs uses).
function isTypeOnly(node) {
  return node.children.some((c) => c.type === 'type');
}

function stringValue(node) {
  if (!node || node.type !== 'string') return undefined;
  const frag = node.namedChildren.find((c) => c.type === 'string_fragment');
  return frag ? frag.text : '';
}

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;
    if (PROCESS_ADAPTER_GLOBS.some((glob) => inFile(file, { glob }))) continue;
    walk(file.ast.rootNode, (node) => {
      let spec;
      if (node.type === 'import_statement' || node.type === 'export_statement') {
        if (isTypeOnly(node)) return;
        spec = stringValue(node.childForFieldName('source'));
      } else if (node.type === 'call_expression') {
        // require('child_process') and a dynamic import('node:child_process').
        const fn = node.childForFieldName('function');
        if (!fn || (fn.text !== 'require' && fn.type !== 'import')) return;
        const args = node.childForFieldName('arguments');
        spec = stringValue(args ? args.namedChildren[0] : undefined);
      } else {
        return;
      }
      if (spec === undefined || !CHILD_PROCESS_MODULES.has(spec)) return;
      violations.push(
        report(
          file,
          node,
          `'${spec}' reached outside a process adapter — only utils/git*.ts and utils/binary-check.ts may ` +
            `start a child process; call one of them (e.g. the git helpers in utils/git-introspect.ts) instead.`,
        ),
      );
    });
  }
  return violations;
}
