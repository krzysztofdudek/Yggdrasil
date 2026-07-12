import { walk, report } from '@chrisdudek/yg/ast';

// example-self-contained (advisory, errs: under)
//
// Each example project must be copy-and-run self-contained: you can copy its own
// directory somewhere else and it still works, because nothing inside it reaches
// out to a path in a SIBLING directory. This check flags any statically-resolvable
// RELATIVE module reference (`./…` or `../…`) whose resolved target escapes the
// example's own directory.
//
// SCOPE — JS/TS-family files only (.ts .tsx .js .jsx .mjs .cjs), and only
// statically-resolvable relative module references:
//   - `import … from '../x'`            (incl. `import type`, side-effect `import '../x'`)
//   - `export … from '../x'`            (re-exports, incl. `export * from`)
//   - `require('../x')`                 (CommonJS)
//   - `import('../x')`                  (dynamic import)
// Bare package specifiers (`lodash`, `@scope/pkg`, `node:fs`) and non-literal
// specifiers (`require(name)`, `import(`../${x}`)`) are NOT references to a repo
// path and are skipped. This makes the check UNDER-approximate the full
// self-containment concept (it never fires on Python relative imports, string
// `fs.read('../x')` calls, or non-static references) — every violation it DOES
// report is a provable cross-directory reference, so it has no false positives by
// design (errs: under). That is why it can start advisory and be trusted.
//
// EXAMPLE ROOT DETECTION (path-only; the drill runs check.mjs over case files with
// NO graph context, so the example directory must be derivable from the file path
// alone). The example root is the first path segment BENEATH the examples
// container. Two containers are recognised:
//   - production: a segment named exactly `examples` (the examples node maps
//     `examples/**`, so every real subject file lives under `examples/<name>/…`).
//   - drill fixtures: a `violates-*` / `satisfies-*` verdict directory (the
//     Yggdrasil drill convention), whose immediate child is the synthetic example.
// The first recognised container in the path wins; the example root is
// `<container>/<child>`. A file that is not strictly inside such a `<child>`
// directory has no determinable example and is skipped.

const JS_TS_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/i;
const VERDICT_DIR = /^(?:violates|satisfies)-/;

/** The example root (`<container>/<child>`) for a repo-relative POSIX path, or null. */
function exampleRootOf(filePath) {
  const segs = filePath.split('/');
  // The container must have a child directory (i+1) AND the file must live strictly
  // below that child (index >= i+2), i.e. the child is a directory, not the file.
  for (let i = 0; i + 2 <= segs.length - 1; i++) {
    if (segs[i] === 'examples' || VERDICT_DIR.test(segs[i])) {
      return segs.slice(0, i + 2).join('/');
    }
  }
  return null;
}

/** Normalise `<fromDir>/<spec>` to a repo-relative POSIX path, resolving `.`/`..`. */
function resolveRelative(fromDir, spec) {
  const out = [];
  for (const part of `${fromDir}/${spec}`.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      out.pop(); // climbing above the accumulated root collapses to []; the escape
      continue; // is then visible because the result no longer starts with the root
    }
    out.push(part);
  }
  return out.join('/');
}

/** True iff `resolved` is the example root itself or a descendant of it. */
function isInside(root, resolved) {
  return resolved === root || resolved.startsWith(`${root}/`);
}

/** Directory portion of a repo-relative POSIX file path (''-safe). */
function dirOf(filePath) {
  const i = filePath.lastIndexOf('/');
  return i === -1 ? '' : filePath.slice(0, i);
}

/** Literal string content of a tree-sitter `string` node, or null if not a plain literal. */
function stringLiteralText(node) {
  if (!node || node.type !== 'string') return null;
  const frag = node.namedChildren.find((c) => c.type === 'string_fragment');
  return frag ? frag.text : ''; // an empty literal ('' / "") yields ''
}

/**
 * Collect every statically-resolvable relative module specifier in a file's AST,
 * paired with the node to anchor the violation position on.
 */
function relativeSpecifiers(rootNode) {
  const found = [];
  const push = (strNode, anchor) => {
    const spec = stringLiteralText(strNode);
    if (spec !== null && (spec.startsWith('./') || spec.startsWith('../'))) {
      found.push({ spec, anchor });
    }
  };

  walk(rootNode, (node) => {
    if (node.type === 'import_statement' || node.type === 'export_statement') {
      // `source` field is present for `import … from '…'` and `export … from '…'`.
      push(node.childForFieldName('source'), node);
      return;
    }
    if (node.type === 'call_expression') {
      const fn = node.childForFieldName('function');
      const isRequire = fn && fn.type === 'identifier' && fn.text === 'require';
      const isDynamicImport = fn && fn.type === 'import';
      if (isRequire || isDynamicImport) {
        const args = node.childForFieldName('arguments');
        const firstString = args && args.namedChildren.find((c) => c.type === 'string');
        push(firstString, node);
      }
    }
  });

  return found;
}

export function check(ctx) {
  const violations = [];

  for (const file of ctx.files) {
    if (!JS_TS_EXT.test(file.path)) continue; // JS/TS-family module references only
    if (!file.ast) continue; // non-parseable (should not happen for these extensions)

    const root = exampleRootOf(file.path);
    if (root === null) continue; // no determinable example directory for this file

    const fromDir = dirOf(file.path);
    for (const { spec, anchor } of relativeSpecifiers(file.ast.rootNode)) {
      const resolved = resolveRelative(fromDir, spec);
      if (isInside(root, resolved)) continue;
      violations.push(
        report(
          file,
          anchor,
          `Example '${root}' references a path outside itself: '${spec}'. ` +
            `Each example must be copy-and-run self-contained; a cross-directory ` +
            `reference breaks that copy. Move the referenced file inside '${root}', or inline it.`,
        ),
      );
    }
  }

  return violations;
}
