#!/usr/bin/env node
// Dead-export gate for the shipped CLI source (source/cli/src).
//
// An `export` is a promise that some other module reads the name. One that no
// other file reads is noise at best — it widens the surface a reader has to
// hold, and hides dead code behind "someone might import it". This script
// builds the TypeScript program over src/ and tests/, resolves every
// identifier in every file to the declaration it names (through import
// aliases, re-exports, namespace access and `import('…').X` type queries), and
// reports each exported declaration of a src/ file that is used from no other
// file.
//
// Exempt:
//   - the package's public entry modules (what tsup bundles as an entry and
//     what package.json exports or node loads by path), and the relation files
//     the Grain repository vendors by path: their exports are read from outside
//     this program;
//   - names listed in dead-exports-allowlist.json, each under a reason.
//
// A name that only tests read is reported too, unless it is on the allowlist:
// a test that reaches an internal is tied to how the code is built rather than
// to what the CLI does, so each such seam is kept on purpose, under a reason,
// and a new one has to be added there deliberately. An allowlist entry that a
// source file now reads, or that no test reads any more, is reported as stale.
//
// Exit 0 when clean; 1 with one line per finding, then one what / why / next
// block. `--json` prints the findings as JSON instead.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// The CLI package root; a path given as the first argument replaces it (the
// script's own tests point it at a small fixture package).
const rootArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const CLI_ROOT = rootArg !== undefined ? path.resolve(rootArg) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(CLI_ROOT, 'src') + path.sep;

/** Modules whose exports are read from outside the program: tsup entries and node-loaded files. */
const ENTRY_MODULES = new Set([
  'src/bin.ts',
  'src/ast/index.ts', // package export @chrisdudek/yg/ast (check.mjs imports it)
  'src/structure/index.ts', // package export @chrisdudek/yg/structure
  'src/cli/structure.ts', // tsup entry structure-universe (read by scripts/spectral-headroom.mjs)
  'src/ast/loader-hook-impl.ts', // node:module customization hook: node calls resolve/load by name
  'src/structure/det-worker.ts', // worker entry spawned by the deterministic worker pool
]);

/**
 * Files the Grain repository vendors from this source tree by path
 * (Grain's plugins/grain/scripts/build-relations.mjs copies them into its
 * engine/vendor/relations/ and strips the types), so every name they export is
 * read by Grain's engine and tests — from outside this program, where no
 * import here can show it. Keep this in step with that script's FILES list
 * (symbol-table, resolver, resolve-path, repo-layout, every extractors/*.ts)
 * and its ast/walk.ts copy.
 */
const VENDORED_BY_GRAIN = [
  /^src\/relations\/(symbol-table|resolver|resolve-path|repo-layout)\.ts$/,
  /^src\/relations\/extractors\/[^/]+\.ts$/,
  /^src\/ast\/walk\.ts$/,
];

/** A module whose exports are read from outside this program. */
function isEntrySurface(rel) {
  return ENTRY_MODULES.has(rel) || VENDORED_BY_GRAIN.some((re) => re.test(rel));
}

function loadAllowlist() {
  const file = path.join(CLI_ROOT, 'scripts', 'dead-exports-allowlist.json');
  if (!existsSync(file)) return new Map();
  const raw = JSON.parse(readFileSync(file, 'utf-8'));
  const allowed = new Map();
  for (const group of raw.groups ?? []) {
    for (const entry of group.exports) allowed.set(entry, group.reason);
  }
  return allowed;
}

function program() {
  const configPath = path.join(CLI_ROOT, 'tsconfig.check.json');
  const cfg = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); } });
  // The portal Playwright specs are type-checked on their own tsconfig, but they
  // read src/ too — a name only they use is still used.
  const e2e = ts.sys.readDirectory(path.join(CLI_ROOT, 'tests', 'portal-e2e'), ['.ts']);
  return ts.createProgram([...cfg.fileNames, ...e2e], cfg.options);
}

function rel(file) {
  return path.relative(CLI_ROOT, file).split(path.sep).join('/');
}

function isSrc(file) {
  return path.resolve(file).startsWith(SRC);
}

/** The declarations a symbol names, through import/export aliases. */
function targetDeclarations(checker, symbol) {
  let s = symbol;
  if (s.flags & ts.SymbolFlags.Alias) {
    try { s = checker.getAliasedSymbol(s); } catch { /* unresolvable alias */ }
  }
  return s.declarations ?? [];
}

function main() {
  const asJson = process.argv.includes('--json');
  const prog = program();
  const checker = prog.getTypeChecker();
  const files = prog.getSourceFiles().filter((f) => !f.isDeclarationFile && !f.fileName.includes('/node_modules/'));

  // Every exported declaration of a src/ file, keyed `file#name`.
  const exported = new Map(); // key -> { file, name, line, bySrc, byTest }
  const declToKey = new Map();
  for (const sf of files) {
    if (!isSrc(sf.fileName)) continue;
    const r = rel(sf.fileName);
    if (isEntrySurface(r)) continue;
    const mod = checker.getSymbolAtLocation(sf);
    if (!mod) continue;
    for (const sym of checker.getExportsOfModule(mod)) {
      // A re-export (`export { x } from './y.js'`) is an alias; the name it
      // forwards is judged where it is declared.
      if (sym.flags & ts.SymbolFlags.Alias) continue;
      // Values only: an interface or type alias named in an exported function's
      // signature is part of what that function says, even when no caller
      // spells the type's name.
      if (!(sym.flags & ts.SymbolFlags.Value)) continue;
      const decls = (sym.declarations ?? []).filter((d) => d.getSourceFile() === sf);
      if (decls.length === 0) continue;
      const key = `${r}#${sym.name}`;
      const line = sf.getLineAndCharacterOfPosition(decls[0].getStart()).line + 1;
      exported.set(key, { file: r, name: sym.name, line, bySrc: false, byTest: false });
      for (const d of decls) declToKey.set(d, key);
    }
  }

  // Mark every export some OTHER file names.
  for (const sf of files) {
    const fromSrc = isSrc(sf.fileName);
    const mark = (sym) => {
      for (const d of targetDeclarations(checker, sym)) {
        if (d.getSourceFile() === sf) continue;
        const key = declToKey.get(d);
        if (!key) continue;
        if (fromSrc) exported.get(key).bySrc = true;
        else exported.get(key).byTest = true;
      }
    };
    const visit = (node) => {
      if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
        const sym = checker.getSymbolAtLocation(node);
        if (sym) mark(sym);
      }
      // `const { x } = await import('./m.js')`: the name in the pattern binds a
      // local; the export it reads is a property of the module's type.
      if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const key = node.propertyName ?? node.name;
        if (ts.isIdentifier(key)) {
          const prop = checker.getTypeAtLocation(node.parent).getProperty(key.text);
          if (prop) mark(prop);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  const allow = loadAllowlist();
  const all = [...exported.entries()];
  // Read by nothing outside its own file.
  const dead = all.filter(([key, e]) => !e.bySrc && !e.byTest && !allow.has(key)).map(([, e]) => e);
  // Read by tests only, and not on the list of seams tests are allowed to reach.
  const testOnly = all.filter(([key, e]) => !e.bySrc && e.byTest && !allow.has(key)).map(([, e]) => e);
  // An allowlist entry that no longer earns its place.
  const stale = [...allow.keys()]
    .filter((k) => !exported.has(k) || exported.get(k).bySrc || (!exported.get(k).byTest))
    .map((k) => ({ key: k, why: !exported.has(k) ? 'is no longer an export of that file' : exported.get(k).bySrc ? 'another source file uses it now' : 'no test uses it any more' }));
  const failed = dead.length + testOnly.length + stale.length > 0;

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ checked: exported.size, dead, testOnly, stale }, null, 2)}\n`);
  } else {
    for (const e of dead) process.stdout.write(`${e.file}:${e.line}  ${e.name}  exported, but no other file uses it\n`);
    for (const e of testOnly) process.stdout.write(`${e.file}:${e.line}  ${e.name}  exported, but only tests use it\n`);
    for (const s of stale) process.stdout.write(`scripts/dead-exports-allowlist.json  ${s.key}  allowlisted, but it ${s.why}\n`);
    if (failed) {
      process.stdout.write('\nerror[dead-export]: an export of source/cli/src is not read by any other source file\n');
      process.stdout.write('why:  an export is a promise that another module reads the name; one nothing reads widens the surface a reader has to hold and hides dead code behind "someone might import it", and one only a test reads couples the test to an internal instead of to what the CLI does.\n');
      process.stdout.write('next: drop the `export` keyword (and the declaration, if its own file does not use it either); test through the module that uses it instead of the internal; remove a stale entry from scripts/dead-exports-allowlist.json. A test seam kept on purpose goes on that list under a reason; a name read from outside the program (a package entry) goes in ENTRY_MODULES in scripts/dead-exports.mjs.\n');
    } else {
      process.stdout.write(`dead-exports: ${exported.size} exports checked (${allow.size} test seams on the allowlist), none unused\n`);
    }
  }
  process.exitCode = failed ? 1 : 0;
}

main();
