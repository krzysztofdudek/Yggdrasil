#!/usr/bin/env node
// The grammar pipeline: turns every pin in the language registry
// (src/utils/language-registry.ts, `grammar:` of each language) into the two files
// that ship in dist/grammars/ — `<wasmFile>` and `<name>.node-types.json`.
//
// Every grammar is pinned by the sha256 of both files. A file is written only after
// its bytes have been hashed and matched against the pin, whatever its source:
//
// - `npm`: read from the installed devDependency, whose version must equal the pin.
// - `github-release`: the release's wasm asset is downloaded; node-types.json is read
//   from the repository at the pinned commit.
// - `source`: the repository is fetched at the pinned commit, the listed patches
//   (scripts/grammar-patches/) are applied, `tree-sitter generate` runs when asked, and
//   `tree-sitter build --wasm` compiles it with the pinned tree-sitter-cli
//   devDependency. The output is byte-reproducible (the same bytes from Linux x64
//   and macOS arm64), so the pinned sha256 is also the reproducibility check.
//
// Downloaded and built files land in a content-addressed cache, each named by its
// sha256 (YG_GRAMMAR_CACHE, default ~/.cache/yggdrasil/grammars), and are re-hashed
// on every read: a warm cache needs no network and no toolchain, and a damaged
// entry is evicted, never shipped. YG_GRAMMAR_REBUILD=1 ignores the cache and
// re-derives every non-npm grammar (a reproducibility audit). YG_GRAMMAR_OFFLINE=1
// forbids downloads and source builds: a grammar missing from the cache is an error.
//
// Run by the build (tsup.config.ts onSuccess). Usage:
//   node scripts/grammars.mjs [--out <dir>] [--only <languageId>,...]
//
// The registry is read by transpiling its TypeScript source in memory (it is pure
// data with no imports), so this script needs no build of the CLI to run first.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireFromCli = createRequire(path.join(CLI_ROOT, 'package.json'));

const REPIN_HINT =
  'If the pin in src/utils/language-registry.ts was changed on purpose, set the sha256 to the value above ' +
  'after reviewing the grammar change (the node-types.json diff and the full relation/AST test suite); ' +
  'otherwise what was downloaded or built is not the pinned grammar.';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function fail(message) {
  process.stderr.write(`[grammars] FAIL: ${message}\n`);
  process.exit(1);
}

function verifyPinned(what, bytes, expected) {
  const actual = sha256(bytes);
  if (actual !== expected) {
    throw new Error(`grammar pin mismatch for ${what}: expected sha256 ${expected}, got ${actual}. Nothing was written. ${REPIN_HINT}`);
  }
  return bytes;
}

async function loadLanguages() {
  const ts = requireFromCli('typescript');
  const source = readFileSync(path.join(CLI_ROOT, 'src/utils/language-registry.ts'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
  return mod.LANGUAGES;
}

function readCache(cacheDir, expected) {
  const p = path.join(cacheDir, expected);
  if (!existsSync(p)) return undefined;
  const bytes = readFileSync(p);
  if (sha256(bytes) === expected) return bytes;
  rmSync(p, { force: true });
  process.stderr.write(`[grammars] evicted a damaged cache entry ${p}\n`);
  return undefined;
}

function writeCache(cacheDir, bytes) {
  mkdirSync(cacheDir, { recursive: true });
  const name = sha256(bytes);
  const tmp = path.join(cacheDir, `.${name}.${process.pid}.tmp`);
  writeFileSync(tmp, bytes);
  renameSync(tmp, path.join(cacheDir, name));
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`grammar download failed: ${url} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function git(cwd, args) {
  execFileSync('git', ['-c', 'advice.detachedHead=false', ...args], { cwd, stdio: ['ignore', 'ignore', 'inherit'] });
}

function checkout(dir, repo, commit) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '.']);
  git(dir, ['fetch', '-q', '--depth', '1', repo, commit]);
  git(dir, ['checkout', '-q', 'FETCH_HEAD']);
}

function treeSitterCli(wanted) {
  let bin;
  try {
    bin = path.join(path.dirname(requireFromCli.resolve('tree-sitter-cli/package.json')), 'tree-sitter');
  } catch {
    throw new Error('building a grammar from source needs the tree-sitter-cli devDependency: run `npm ci` in source/cli.');
  }
  const version = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim().split(/\s+/)[1];
  if (version !== wanted) {
    throw new Error(`the grammar pin was built with tree-sitter-cli ${wanted}, but ${version} is installed: run \`npm ci\` in source/cli.`);
  }
  return bin;
}

function buildFromSource(pin) {
  const src = pin.source;
  const bin = treeSitterCli(pin.cli);
  const work = mkdtempSync(path.join(os.tmpdir(), 'yg-grammar-'));
  try {
    const repoDir = path.join(work, 'repo');
    checkout(repoDir, pin.repo, pin.commit);
    for (const patch of src.patches ?? []) git(repoDir, ['apply', path.join(CLI_ROOT, 'scripts/grammar-patches', patch)]);
    for (const dep of src.deps ?? []) checkout(path.join(repoDir, dep.path), dep.repo, dep.commit);
    const grammarDir = path.join(repoDir, src.dir);
    if (src.generate) execFileSync(bin, ['generate'], { cwd: grammarDir, stdio: ['ignore', 'ignore', 'inherit'] });
    const out = path.join(work, 'out.wasm');
    execFileSync(bin, ['build', '--wasm', '-o', out, grammarDir], { cwd: repoDir, stdio: ['ignore', 'ignore', 'inherit'] });
    return { wasm: readFileSync(out), nodeTypes: readFileSync(path.join(grammarDir, 'src/node-types.json')) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function rawNodeTypesUrl(pin) {
  const repo = pin.repo.replace(/^https:\/\/github\.com\//, '');
  return `https://raw.githubusercontent.com/${repo}/${pin.commit}/src/node-types.json`;
}

async function materialize(def, opts) {
  const pin = def.grammar;
  const src = pin.source;
  const what = (file) => `${def.id} (${file})`;

  if (src.kind === 'npm') {
    const pkgJsonPath = requireFromCli.resolve(`${src.package}/package.json`);
    const installed = JSON.parse(readFileSync(pkgJsonPath, 'utf8')).version;
    if (installed !== pin.version) {
      throw new Error(
        `grammar ${def.id}: ${src.package}@${installed} is installed, but its pin in src/utils/language-registry.ts ` +
          `is ${pin.version}. A 0.x grammar minor can rename or restructure node types, so a bump is reviewed, not ` +
          `taken silently: update the pin (version, commit, both sha256) once the full relation/AST suite passes on ` +
          `the new grammar — or, if node_modules drifted from package-lock.json, run \`npm ci\`.`,
      );
    }
    const pkgDir = path.dirname(pkgJsonPath);
    return {
      wasm: verifyPinned(what(def.wasmFile), readFileSync(path.join(pkgDir, src.wasmPath)), pin.wasmSha256),
      nodeTypes: verifyPinned(what('node-types.json'), readFileSync(path.join(pkgDir, src.nodeTypesPath)), pin.nodeTypesSha256),
    };
  }

  if (!opts.rebuild) {
    const wasm = readCache(opts.cacheDir, pin.wasmSha256);
    const nodeTypes = readCache(opts.cacheDir, pin.nodeTypesSha256);
    if (wasm && nodeTypes) return { wasm, nodeTypes };
  }
  if (opts.offline) {
    throw new Error(`grammar ${def.id} is not in the cache (${opts.cacheDir}) and YG_GRAMMAR_OFFLINE=1 forbids fetching or building it.`);
  }

  let files;
  if (src.kind === 'github-release') {
    process.stdout.write(`  [grammars] downloading ${def.id} ${pin.version} from ${src.wasmUrl}\n`);
    files = { wasm: await download(src.wasmUrl), nodeTypes: await download(rawNodeTypesUrl(pin)) };
  } else {
    process.stdout.write(`  [grammars] building ${def.id} from ${pin.repo} at ${pin.commit} with tree-sitter-cli ${pin.cli}\n`);
    files = buildFromSource(pin);
  }
  verifyPinned(what(def.wasmFile), files.wasm, pin.wasmSha256);
  verifyPinned(what('node-types.json'), files.nodeTypes, pin.nodeTypesSha256);
  writeCache(opts.cacheDir, files.wasm);
  writeCache(opts.cacheDir, files.nodeTypes);
  return files;
}

function parseArgs(argv) {
  const args = { out: path.join(CLI_ROOT, 'dist/grammars'), only: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = path.resolve(argv[++i]);
    else if (argv[i] === '--only') args.only = new Set(argv[++i].split(','));
    else fail(`unknown argument ${argv[i]}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const opts = {
  cacheDir: process.env.YG_GRAMMAR_CACHE || path.join(os.homedir(), '.cache', 'yggdrasil', 'grammars'),
  rebuild: process.env.YG_GRAMMAR_REBUILD === '1',
  offline: process.env.YG_GRAMMAR_OFFLINE === '1',
};
try {
  const languages = Object.values(await loadLanguages()).filter((d) => !args.only || args.only.has(d.id));
  if (args.only && languages.length !== args.only.size) fail(`--only names a language the registry does not have: ${[...args.only].join(', ')}`);
  // Materialize everything first, write after: a failing pin leaves no partial set behind.
  const outputs = [];
  for (const def of languages) outputs.push([def, await materialize(def, opts)]);
  mkdirSync(args.out, { recursive: true });
  for (const [def, files] of outputs) {
    writeFileSync(path.join(args.out, def.wasmFile), files.wasm);
    writeFileSync(path.join(args.out, def.wasmFile.replace(/\.wasm$/, '.node-types.json')), files.nodeTypes);
  }
  process.stdout.write(`Wrote ${outputs.length} pinned grammars (wasm + node-types.json, sha256-verified) to ${path.relative(CLI_ROOT, args.out) || args.out}/\n`);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
