import { defineConfig } from 'tsup';

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
    // Every shipped grammar comes from its pin in the language registry (source,
    // version and the sha256 of the wasm and its node-types.json). The script
    // materializes each pin (an npm devDependency, a GitHub release asset, or a
    // source build at a pinned commit), verifies both files against the pin, and
    // writes them to dist/grammars/ under the registry `wasmFile` name, the name
    // the parser resolves.
    execSync('node scripts/grammars.mjs', { stdio: 'inherit' });
  },
});
