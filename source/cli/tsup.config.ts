import { defineConfig } from 'tsup';
import { copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Every shipped grammar: which npm package provides the prebuilt WASM and the
// exact `.wasm` filename (matching language-registry.ts `wasmFile`, the name the
// parser resolves from dist/grammars/). Keep in sync with the registry — a parse
// smoke test per language in repo-check/CI fails the gate if a copy is missing.
//
// `nodeTypesCandidates`: ordered list of relative paths (within the package dir)
// to try when locating node-types.json.  The first one that exists wins.
const GRAMMARS: { pkg: string; wasm: string; nodeTypesCandidates: string[] }[] = [
  { pkg: 'tree-sitter-typescript', wasm: 'tree-sitter-typescript.wasm', nodeTypesCandidates: ['typescript/src/node-types.json'] },
  { pkg: 'tree-sitter-typescript', wasm: 'tree-sitter-tsx.wasm',        nodeTypesCandidates: ['tsx/src/node-types.json'] },
  { pkg: 'tree-sitter-javascript', wasm: 'tree-sitter-javascript.wasm', nodeTypesCandidates: ['src/node-types.json'] },
  { pkg: 'tree-sitter-python',     wasm: 'tree-sitter-python.wasm',     nodeTypesCandidates: ['src/node-types.json'] },
  { pkg: 'tree-sitter-go',         wasm: 'tree-sitter-go.wasm',         nodeTypesCandidates: ['src/node-types.json'] },
  { pkg: 'tree-sitter-rust',       wasm: 'tree-sitter-rust.wasm',       nodeTypesCandidates: ['src/node-types.json'] },
  { pkg: 'tree-sitter-java',       wasm: 'tree-sitter-java.wasm',       nodeTypesCandidates: ['src/node-types.json'] },
  { pkg: 'tree-sitter-c-sharp',    wasm: 'tree-sitter-c_sharp.wasm',    nodeTypesCandidates: ['src/node-types.json'] },
  { pkg: 'tree-sitter-c',          wasm: 'tree-sitter-c.wasm',          nodeTypesCandidates: ['src/node-types.json'] },
  { pkg: 'tree-sitter-cpp',        wasm: 'tree-sitter-cpp.wasm',        nodeTypesCandidates: ['src/node-types.json'] },
  // tree-sitter-php ships two dialects; we ship php_only (the one the registry uses)
  { pkg: 'tree-sitter-php',        wasm: 'tree-sitter-php_only.wasm',   nodeTypesCandidates: ['php_only/src/node-types.json', 'php/src/node-types.json'] },
  { pkg: 'tree-sitter-ruby',       wasm: 'tree-sitter-ruby.wasm',       nodeTypesCandidates: ['src/node-types.json'] },
  { pkg: 'tree-sitter-json',       wasm: 'tree-sitter-json.wasm',       nodeTypesCandidates: ['src/node-types.json'] },
  { pkg: '@tree-sitter-grammars/tree-sitter-kotlin', wasm: 'tree-sitter-kotlin.wasm', nodeTypesCandidates: ['src/node-types.json'] },
  { pkg: '@tree-sitter-grammars/tree-sitter-yaml',   wasm: 'tree-sitter-yaml.wasm',   nodeTypesCandidates: ['src/node-types.json'] },
  { pkg: '@tree-sitter-grammars/tree-sitter-toml',   wasm: 'tree-sitter-toml.wasm',   nodeTypesCandidates: ['src/node-types.json'] },
];

async function copyWasmGrammars() {
  const grammarsDir = path.resolve('dist/grammars');
  await mkdir(grammarsDir, { recursive: true });

  // Copy each grammar under the name the parser actually resolves (the registry
  // `wasmFile`, e.g. `tree-sitter-<lang>.wasm`) — NOT a short `<lang>.wasm`. The
  // short names were never found in a published install (only the dev
  // `node_modules` fallback worked).
  for (const { pkg, wasm } of GRAMMARS) {
    const src = findFile(pkg, [wasm, `bindings/node/${wasm}`], 'WASM');
    await copyFile(src, path.join(grammarsDir, wasm));
  }

  console.log(`Copied ${GRAMMARS.length} WASM grammars to dist/grammars/`);
}

async function copyNodeTypeFiles() {
  const grammarsDir = path.resolve('dist/grammars');
  await mkdir(grammarsDir, { recursive: true });

  let copied = 0;
  for (const { pkg, wasm, nodeTypesCandidates } of GRAMMARS) {
    const outName = wasm.replace(/\.wasm$/, '.node-types.json');
    const src = findFile(pkg, nodeTypesCandidates, 'node-types.json', /* optional */ true);
    if (!src) {
      console.warn(`  [node-types] skipped ${pkg} (${outName}) — no node-types.json found`);
      continue;
    }
    await copyFile(src, path.join(grammarsDir, outName));
    copied++;
  }

  console.log(`Copied ${copied} node-types.json files to dist/grammars/ (${GRAMMARS.length - copied} skipped)`);
}

function findFile(pkg: string, candidates: string[], label: string, optional: true): string | null;
function findFile(pkg: string, candidates: string[], label: string, optional?: false): string;
function findFile(pkg: string, candidates: string[], label: string, optional?: boolean): string | null {
  const pkgDir = path.dirname(require.resolve(`${pkg}/package.json`));
  for (const candidate of candidates) {
    const p = path.join(pkgDir, candidate);
    if (existsSync(p)) return p;
  }
  if (optional) return null;
  throw new Error(
    `Could not find ${label} file for ${pkg}. Tried: ${candidates.join(', ')}`
  );
}

export default defineConfig({
  entry: {
    bin: 'src/bin.ts',
    ast: 'src/ast/index.ts',
    structure: 'src/structure/index.ts',
    // Non-self-executing entry that re-surfaces the `yg structure` command's own
    // read-only structural-edge-universe accessor (computeStructuralEdgeUniverse)
    // for offline observation scripts (scripts/spectral-headroom.mjs) — the single
    // source of truth for the structural graph, no drifting second reader.
    'structure-universe': 'src/cli/structure.ts',
    'loader-hook-impl': 'src/ast/loader-hook-impl.ts',
    // Standalone worker entry spawned by the deterministic worker pool. Emitted
    // flat as dist/det-worker.js so the pool resolves it beside its own bundle.
    'det-worker': 'src/structure/det-worker.ts',
  },
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  dts: true,
  sourcemap: true,
  splitting: false,
  async onSuccess() {
    // Copy templates (existing behavior)
    const { execSync } = await import('node:child_process');
    execSync('node scripts/copy-templates.cjs', { stdio: 'inherit' });
    // Copy WASM grammars and node-types.json reference files
    await copyWasmGrammars();
    await copyNodeTypeFiles();
  },
});
