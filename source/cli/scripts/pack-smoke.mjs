#!/usr/bin/env node
// A2 — pack-and-smoke: prove the PUBLISHED tarball actually works, especially that
// the WASM grammars resolve from the package itself (NOT the dev `node_modules`
// fallback, which is absent in a real install — tree-sitter-* are devDeps). This is
// the only thing that exercises the production `dist/grammars` path; the unit/e2e
// tests run from source and always hit the node_modules fallback.
//
// Steps: npm pack → extract to a clean temp dir → install PROD deps only → assert
// every exports/bin path resolves → run a PARSE-requiring command (which loads a
// grammar) and assert it succeeds. Any failure exits non-zero (so repo-check/CI red).

import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (m) => process.stdout.write(`[pack-smoke] ${m}\n`);
const fail = (m) => {
  process.stderr.write(`[pack-smoke] FAIL: ${m}\n`);
  process.exit(1);
};

const work = mkdtempSync(path.join(tmpdir(), 'yg-pack-smoke-'));
try {
  // 1. Pack
  log('npm pack…');
  const tgzName = execFileSync('npm', ['pack', '--silent', '--pack-destination', work], {
    cwd: CLI_ROOT,
    encoding: 'utf-8',
  }).trim().split('\n').pop().trim();
  const tgz = path.join(work, tgzName);
  if (!existsSync(tgz)) fail(`tarball not produced (${tgz})`);

  // 2. Extract
  const extract = path.join(work, 'extract');
  mkdirSync(extract);
  execFileSync('tar', ['-xzf', tgz, '-C', extract], { stdio: 'inherit' });
  const pkgDir = path.join(extract, 'package');
  if (!existsSync(pkgDir)) fail('extracted package/ dir missing');

  // 3. Assert every exports/bin path + the WASM grammars are IN the tarball
  const pkgJson = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf-8'));
  const mustExist = [pkgJson.bin?.yg];
  for (const e of Object.values(pkgJson.exports ?? {})) {
    if (e.import) mustExist.push(e.import);
    if (e.types) mustExist.push(e.types);
  }
  for (const rel of mustExist.filter(Boolean)) {
    if (!existsSync(path.join(pkgDir, rel))) fail(`exports/bin path not in tarball: ${rel}`);
  }
  const grammars = existsSync(path.join(pkgDir, 'dist/grammars'))
    ? readdirSync(path.join(pkgDir, 'dist/grammars')).filter((f) => f.endsWith('.wasm'))
    : [];
  if (grammars.length === 0) fail('no WASM grammars in tarball (dist/grammars/*.wasm)');
  const nodeTypeFiles = existsSync(path.join(pkgDir, 'dist/grammars'))
    ? readdirSync(path.join(pkgDir, 'dist/grammars')).filter((f) => f.endsWith('.node-types.json'))
    : [];
  if (nodeTypeFiles.length === 0) fail('no node-types.json files in tarball (dist/grammars/*.node-types.json)');
  // Every shipped .wasm should have a matching .node-types.json (base name parity)
  for (const wasm of grammars) {
    const expected = wasm.replace(/\.wasm$/, '.node-types.json');
    if (!nodeTypeFiles.includes(expected)) fail(`missing node-types.json for grammar: ${expected}`);
  }
  log(`tarball OK — bin+exports present, ${grammars.length} grammar(s), ${nodeTypeFiles.length} node-types.json file(s)`);

  // 3b. Assert the PORTAL static assets ship. `yg portal` reads shell.html, the
  // CSS bundle, the js modules, and the vendor lib from dist/templates/portal at
  // runtime. A files-allowlist that matches only *.js/*.d.ts/*.wasm silently drops
  // *.html and *.css — the js gets in but shell.html does not, so the server 500s
  // with ENOENT on first page load. Guard every asset kind the server reads.
  const portalDir = path.join(pkgDir, 'dist/templates/portal');
  if (!existsSync(path.join(portalDir, 'shell.html'))) {
    fail('portal shell.html not in tarball (dist/templates/portal/shell.html) — check the "files" allowlist ships *.html');
  }
  const portalCss = existsSync(portalDir) ? readdirSync(portalDir).filter((f) => f.endsWith('.css')) : [];
  if (portalCss.length === 0) {
    fail('no portal CSS in tarball (dist/templates/portal/*.css) — check the "files" allowlist ships *.css');
  }
  if (!existsSync(path.join(portalDir, 'vendor', 'd3-hierarchy.js'))) {
    fail('portal vendor lib not in tarball (dist/templates/portal/vendor/d3-hierarchy.js)');
  }
  log(`portal assets OK — shell.html + ${portalCss.length} css file(s) + vendor lib present`);

  // 4. Install PROD deps only (no devDeps → no tree-sitter-* fallback)
  log('npm install --omit=dev…');
  execSync('npm install --omit=dev --no-audit --no-fund --silent', { cwd: pkgDir, stdio: 'inherit' });
  if (existsSync(path.join(pkgDir, 'node_modules/tree-sitter-typescript'))) {
    fail('tree-sitter-typescript present in prod install — smoke would not exercise dist/grammars');
  }

  const bin = path.join(pkgDir, pkgJson.bin.yg);

  // 5a. Basic bin smoke
  const ver = execFileSync('node', [bin, '--version'], { encoding: 'utf-8' }).trim();
  log(`yg --version → ${ver}`);

  // 5b. PARSE-requiring smoke: a minimal graph with a deterministic AST aspect whose
  // check parses a .ts file via ctx.parseAst. This loads tree-sitter-typescript.wasm
  // FROM THE PACKAGE — the production path that the source-run tests never hit.
  const proj = path.join(work, 'proj');
  const ygg = path.join(proj, '.yggdrasil');
  mkdirSync(path.join(proj, 'src'), { recursive: true });
  mkdirSync(path.join(ygg, 'model', 'svc'), { recursive: true });
  mkdirSync(path.join(ygg, 'aspects', 'parse-smoke'), { recursive: true });
  // One file per a couple of DISTINCT grammars so the smoke proves new-language
  // WASMs (python, go) also resolve from the tarball — not just typescript.
  writeFileSync(path.join(proj, 'src', 'a.ts'), '// a\nexport const a = 1;\n');
  writeFileSync(path.join(proj, 'src', 'a.py'), '# a\na = 1\n');
  writeFileSync(path.join(proj, 'src', 'a.go'), 'package a\n// a\nvar a = 1\n');
  writeFileSync(
    path.join(ygg, 'yg-config.yaml'),
    'version: "5.2.0"\nreviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: m\n        endpoint: "http://127.0.0.1:1"\n',
  );
  writeFileSync(
    path.join(ygg, 'yg-architecture.yaml'),
    'node_types:\n  service:\n    description: "svc"\n    when:\n      path: "src/**"\n',
  );
  writeFileSync(
    path.join(ygg, 'model', 'svc', 'yg-node.yaml'),
    'name: svc\ndescription: "smoke node"\ntype: service\naspects:\n  - parse-smoke\nmapping:\n  - src/a.ts\n  - src/a.py\n  - src/a.go\n',
  );
  writeFileSync(
    path.join(ygg, 'aspects', 'parse-smoke', 'yg-aspect.yaml'),
    'name: ParseSmoke\ndescription: "parses a source file via tree-sitter"\nreviewer:\n  type: deterministic\nstatus: enforced\n',
  );
  // The check parses EVERY mapped file's AST; a missing/renamed/unresolved grammar
  // WASM for any language would throw (failing the gate, not the user).
  writeFileSync(
    path.join(ygg, 'aspects', 'parse-smoke', 'check.mjs'),
    'export function check(ctx) {\n  for (const f of ctx.files) {\n    const tree = ctx.parseAst(f);\n    if (!tree || !tree.rootNode) throw new Error("no AST for " + f.path);\n  }\n  return [];\n}\n',
  );

  log('yg aspect-test (parses .ts/.py/.go via the packaged grammars)…');
  const res = execFileSync('node', [bin, 'aspect-test', '--aspect', 'parse-smoke', '--node', 'svc'], {
    cwd: proj,
    encoding: 'utf-8',
  });
  if (!/No violations|violations|satisfied/i.test(res)) fail(`unexpected aspect-test output:\n${res}`);
  log(`parse smoke OK:\n${res.trim()}`);

  log('PASS — published package parses with grammars resolved from the tarball.');
} finally {
  rmSync(work, { recursive: true, force: true });
}
