import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// E2E suite — multi-language AST support for `deterministic` aspects.
//
// Proves, end-to-end against the real built binary, that every built-in
// tree-sitter grammar actually parses real source: a single deterministic
// aspect's check.mjs receives `file.ast` for a file in EACH of the 16
// supported languages (language auto-detected by extension), and for each it
// asserts (a) the parse produced a non-empty named tree, and (b) the
// per-language comment configuration works (`findComments` locates a marker
// comment written in that language's own comment syntax — JSON has none, so it
// is asserted to find zero). This guards against a missing/renamed grammar
// WASM, a wrong extension mapping, or wrong comment-node types — none of which
// the unit-level registry tests can catch through the real packaged parser.
//
// Hermetic: a fresh mkdtemp graph per run, no network, no committed fixture
// bytes changed; the temp dir is removed in finally.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.join(__dirname, '..', '..', 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

const MARK = 'YGGMARK';

// One representative source file per supported language: a marker comment in
// that language's comment syntax (where it has one) plus a trivial declaration
// so the parse yields a non-empty named tree. `comment` is the expected result
// of findComments locating the marker (false only for JSON, which has none).
const LANGS: Array<{ ext: string; src: string; comment: boolean }> = [
  { ext: 'ts', src: `// ${MARK}\nexport const x = 1;\n`, comment: true },
  { ext: 'tsx', src: `// ${MARK}\nexport const x = 1;\n`, comment: true },
  { ext: 'js', src: `// ${MARK}\nexport const x = 1;\n`, comment: true },
  { ext: 'py', src: `# ${MARK}\nx = 1\n`, comment: true },
  { ext: 'go', src: `// ${MARK}\npackage a\n`, comment: true },
  { ext: 'rs', src: `// ${MARK}\nfn main() {}\n`, comment: true },
  { ext: 'java', src: `// ${MARK}\nclass A {}\n`, comment: true },
  { ext: 'cs', src: `// ${MARK}\nclass A {}\n`, comment: true },
  { ext: 'c', src: `// ${MARK}\nint x;\n`, comment: true },
  { ext: 'cpp', src: `// ${MARK}\nint x;\n`, comment: true },
  { ext: 'php', src: `<?php\n// ${MARK}\n$x = 1;\n`, comment: true },
  { ext: 'rb', src: `# ${MARK}\nx = 1\n`, comment: true },
  { ext: 'json', src: `{ "k": "${MARK}" }\n`, comment: false },
  { ext: 'kt', src: `// ${MARK}\nval x = 1\n`, comment: true },
  { ext: 'yaml', src: `# ${MARK}\nx: 1\n`, comment: true },
  { ext: 'toml', src: `# ${MARK}\nx = 1\n`, comment: true },
];

// The deterministic check: for every file, report a one-line GRAPH-LEVEL
// diagnostic (file: undefined so it is never filtered by the in-context guard,
// and so it needs no @chrisdudek/yg/ast import — which does not resolve inside a
// temp project's check.mjs). It reads file.ast directly (provided on ctx.files),
// counts the root's named children, and walks the tree for a comment node
// carrying the marker — proving, per language, that the real packaged grammar
// parsed the source AND produced the expected comment node type.
const CHECK_MJS = `export function check(ctx) {
  return ctx.files.map((f) => {
    const root = f.ast.rootNode;
    let comment = false;
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (n.type.includes('comment') && n.text.includes('${MARK}')) comment = true;
      for (let i = 0; i < n.childCount; i++) stack.push(n.child(i));
    }
    return { file: undefined, line: 1, column: 0, message: \`LANGAST \${f.path} named=\${root.namedChildCount} comment=\${comment}\` };
  });
}
`;

function run(args: string[], cwd: string): { all: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { all: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status };
}

function makeProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-astlang-'));
  const ygg = path.join(dir, '.yggdrasil');
  mkdirSync(path.join(ygg, 'aspects', 'ast-lang'), { recursive: true });
  mkdirSync(path.join(ygg, 'model', 'code'), { recursive: true });
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(
    path.join(ygg, 'yg-config.yaml'),
    'version: "5.2.0"\nreviewer:\n  tiers:\n    standard:\n      provider: ollama\n      model: llama\n      endpoint: http://localhost:11434\n',
  );
  writeFileSync(
    path.join(ygg, 'yg-architecture.yaml'),
    'node_types:\n  code:\n    description: code under test\n    when:\n      path: "src/**"\n',
  );
  // Explicit per-file mapping (not a bare `src/` directory): a directory mapping
  // would need git-tracked files to expand, and this hermetic temp project is not
  // a git repo — so list every file so the node loads them straight from disk.
  const mapping = LANGS.map((l) => `  - src/a.${l.ext}`).join('\n');
  writeFileSync(
    path.join(ygg, 'model', 'code', 'yg-node.yaml'),
    `name: code\ntype: code\ndescription: multi-language sources\naspects:\n  - ast-lang\nmapping:\n${mapping}\n`,
  );
  writeFileSync(
    path.join(ygg, 'aspects', 'ast-lang', 'yg-aspect.yaml'),
    'name: ast-lang\ndescription: per-language AST parse probe\nreviewer:\n  type: deterministic\nstatus: enforced\n',
  );
  writeFileSync(path.join(ygg, 'aspects', 'ast-lang', 'check.mjs'), CHECK_MJS);
  for (const l of LANGS) {
    writeFileSync(path.join(dir, 'src', `a.${l.ext}`), l.src);
  }
  return dir;
}

describe.skipIf(!distExists)('CLI E2E — multi-language AST parsing', () => {
  it('parses a real source file for each of the 16 built-in grammars and detects comments per language', () => {
    const dir = makeProject();
    try {
      const out = run(['aspect-test', '--aspect', 'ast-lang', '--node', 'code'], dir);
      for (const l of LANGS) {
        const m = out.all.match(
          new RegExp(`LANGAST src/a\\.${l.ext} named=(\\d+) comment=(true|false)`),
        );
        expect(m, `no AST diagnostic emitted for .${l.ext} (grammar failed to load/parse?)`).toBeTruthy();
        // Parse produced a non-empty named tree → the grammar actually parsed the source.
        expect(Number(m![1]), `.${l.ext} parsed to an empty tree`).toBeGreaterThan(0);
        // Per-language comment-node configuration: findComments locates the marker
        // (or, for JSON, correctly finds none).
        expect(m![2], `.${l.ext} comment detection mismatch`).toBe(String(l.comment));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
