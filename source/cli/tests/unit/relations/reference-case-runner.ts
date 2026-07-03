import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

import { ensureLoaderRegistered } from '../../../src/ast/loader-hook.js';
import { parseFile } from '../../../src/ast/parser.js';
import { getLanguageForExtension } from '../../../src/core/graph/language-registry.js';
import { extractorForLanguage } from '../../../src/relations/extractors/registry.js';
import {
  csharpUses,
  collectGlobalUsings,
  collectGlobalUsingAliases,
} from '../../../src/relations/extractors/csharp.js';
import { SymbolTable } from '../../../src/relations/symbol-table.js';
import { buildOwnerIndex } from '../../../src/relations/owner-index.js';
import { makeResolver, resolveCandidateGroup } from '../../../src/relations/resolver.js';
import { makeResolvePathToFile } from '../../../src/relations/resolve-path.js';
import type { ParsedFile } from '../../../src/relations/extractors/types.js';

/**
 * reference-case-runner — the single canonical relations name-resolution test
 * harness. `runCase('<id>')` is the body of every `it('<id>')` in the matrix
 * suites; the relations reference catalogue (reference/relations/<language>/<id>.md)
 * is its sole input.
 *
 * The runner does NOT reimplement name resolution. It loads the case `.md`, builds
 * an in-memory project from the embedded `## Files`, and drives the EXACT pass.ts
 * pipeline over the REAL extractor + real SymbolTable + real owner index + real
 * resolver: universe symbol table from extractor.declarations(), the C# global-using
 * pre-pass, then the per-reference ordered-candidate walk (resolved → edge + stop;
 * a nearer ambiguous → silence the group; absent → continue). It then asserts every
 * `## Expect` line AND that no unexpected cross-node edge appears — so a case cannot
 * pass while emitting a spurious edge, and the documented code is provably the tested
 * code.
 *
 * Node identity (matching the catalogue's `node:<id>` convention and the matrix owner
 * maps): a file at `<root>/<id>/<...>` belongs to node `<id>` — i.e. the basename of
 * the file's parent directory. The catalogue authors paths as `src/<node>/<File>.ext`.
 */

const CATALOGUE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../reference/relations',
);

interface CaseFile {
  path: string; // repo-rel POSIX path declared in the ```lang path=…``` block
  language: string; // grammar language (from extension)
  code: string;
}

/** A materialize-only support file (go.mod / composer.json / Cargo.toml): the path
 *  resolver reads it from disk to map a specifier → file (module path, PSR-4 map, crate
 *  name), but it carries NO source code to parse — it is excluded from the SymbolTable
 *  and from extractor.uses(). It exists in the temp project ONLY so the REAL resolver
 *  sees the EXACT layout the catalogue documents. */
interface ConfigFile {
  path: string; // repo-rel POSIX path declared in the ```… path=…``` block
  code: string;
}

/** Support-file basenames the path resolvers consume but never parse as source. A
 *  `## Files` block whose extension has no grammar language is accepted ONLY when its
 *  basename is one of these (else it is a typo and throws — the guard is preserved).
 *  Kept in lockstep with resolve-path.ts: Go reads go.mod (and go.work), PHP reads
 *  composer.json, Rust reads Cargo.toml; the lock/sum files are harmless to materialize. */
const CONFIG_BASENAMES = new Set([
  'go.mod',
  'go.work',
  'go.sum',
  'composer.json',
  'Cargo.toml',
  'Cargo.lock',
]);

interface ExpectEdge {
  fromFile: string;
  line: number;
  node: string;
}

interface CaseDoc {
  id: string;
  language: string;
  expectation: 'edge' | 'silence';
  files: CaseFile[];
  configFiles: ConfigFile[];
  expectEdges: ExpectEdge[];
  expectSilence: boolean;
}

/** The node a file belongs to: basename of its parent directory. */
function nodeOf(filePath: string): string {
  const segs = filePath.split('/');
  return segs.length >= 2 ? segs[segs.length - 2] : '';
}

/** Parse the YAML-ish frontmatter block (key: value lines only — enough for cases). */
function parseFrontmatter(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Read and parse `reference/relations/<language>/<id>.md` into a structured case. */
function loadCaseDoc(id: string, mdPath: string): CaseDoc {
  const text = readFileSync(mdPath, 'utf-8');

  const fmMatch = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!fmMatch) throw new Error(`reference-case ${id}: missing frontmatter block`);
  const fm = parseFrontmatter(fmMatch[1]);
  const language = fm.language;
  if (!language) throw new Error(`reference-case ${id}: frontmatter has no language`);
  const expectation = fm.expectation as 'edge' | 'silence';
  if (expectation !== 'edge' && expectation !== 'silence') {
    throw new Error(`reference-case ${id}: expectation must be edge|silence, got ${fm.expectation}`);
  }

  const body = text.slice(fmMatch[0].length);

  // ## Files — every ```<lang> path=<repo-rel>``` fenced block. A block whose extension
  // maps to a grammar language is a SOURCE file (parsed, indexed, run through uses()); a
  // block whose extension has no language but whose basename is a known resolver support
  // file (go.mod / composer.json / Cargo.toml) is a CONFIG file — materialized only, never
  // parsed. Any other unknown extension throws (typo guard).
  const files: CaseFile[] = [];
  const configFiles: ConfigFile[] = [];
  const fenceRe = /```[a-zA-Z+]*\s+path=([^\s`]+)\n([\s\S]*?)```/g;
  const filesSection = sectionBody(body, 'Files');
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(filesSection)) !== null) {
    const fpath = m[1].trim();
    const ext = path.extname(fpath);
    const lang = getLanguageForExtension(ext);
    if (lang) {
      files.push({ path: fpath, language: lang, code: m[2] });
    } else if (CONFIG_BASENAMES.has(path.posix.basename(fpath))) {
      configFiles.push({ path: fpath, code: m[2] });
    } else {
      throw new Error(`reference-case ${id}: no language for extension '${ext}' (${fpath})`);
    }
  }
  if (files.length === 0) throw new Error(`reference-case ${id}: ## Files has no path-tagged code blocks`);

  // ## Expect — edge lines `file:line -> node:<id>` and/or a bare `silence` line.
  const expectEdges: ExpectEdge[] = [];
  let expectSilence = false;
  const expectSection = sectionBody(body, 'Expect');
  for (const raw of expectSection.split('\n')) {
    let line = raw.trim();
    if (line.startsWith('-')) line = line.slice(1).trim();
    if (line === '') continue;
    const stripped = line.replace(/#.*$/, '').trim(); // drop trailing inline comment
    if (stripped === '') continue;
    if (stripped === 'silence') {
      expectSilence = true;
      continue;
    }
    const edge = /^(\S+):(\d+)\s*->\s*node:(\S+)$/.exec(stripped);
    if (!edge) throw new Error(`reference-case ${id}: unparseable ## Expect line: '${raw.trim()}'`);
    expectEdges.push({ fromFile: edge[1], line: Number(edge[2]), node: edge[3] });
  }
  if (!expectSilence && expectEdges.length === 0) {
    throw new Error(`reference-case ${id}: ## Expect has neither an edge line nor a 'silence' line`);
  }

  return { id, language, expectation, files, configFiles, expectEdges, expectSilence };
}

/** Extract the text under a `## <name>` heading, up to the next `## ` heading or EOF. */
function sectionBody(body: string, name: string): string {
  const re = new RegExp(`(^|\\n)##\\s+${name}\\s*\\n`);
  const start = re.exec(body);
  if (!start) throw new Error(`missing required section ## ${name}`);
  const from = start.index + start[0].length;
  const rest = body.slice(from);
  const next = /\n##\s+/.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

async function parse(file: CaseFile): Promise<ParsedFile> {
  const tree = await parseFile(file.path, file.code);
  return { path: file.path, content: file.code, tree, language: file.language };
}

/**
 * Run one reference case end-to-end through the real relation pass. Throws/fails the
 * assertion if the documented `## Expect` is not met or an unexpected edge appears.
 */
export async function runCase(id: string): Promise<void> {
  ensureLoaderRegistered();

  // language is the first path segment of the id-bearing file; the catalogue path is
  // reference/relations/<language>/<id>.md, so read frontmatter to find it without
  // guessing. We probe each declared language dir's <id>.md.
  const mdPath = locateCaseMd(id);
  const doc = loadCaseDoc(id, mdPath);

  // 1. Parse every embedded file with the real parser.
  const parsedByPath = new Map<string, ParsedFile>();
  for (const f of doc.files) parsedByPath.set(f.path, await parse(f));

  // 2. Universe SymbolTable — real extractor.declarations() over EVERY file of the
  //    case's language (pass.ts step 4: broad universe so ambiguity is detected).
  const symbolTable = new SymbolTable();
  for (const f of doc.files) {
    const extractor = extractorForLanguage(f.language);
    if (!extractor) continue;
    const parsed = parsedByPath.get(f.path)!;
    for (const decl of extractor.declarations(parsed)) {
      symbolTable.declare(f.language, decl.symbolKey, f.path);
    }
  }

  // 3. C# global-using pre-pass (pass.ts step 4.5): namespace prefixes AND project-wide aliases.
  const csharpGlobalUsings = new Set<string>();
  const csharpGlobalUsingAliasMap = new Map<string, string>();
  for (const f of doc.files) {
    if (f.language !== 'csharp') continue;
    for (const prefix of collectGlobalUsings(parsedByPath.get(f.path)!)) csharpGlobalUsings.add(prefix);
    for (const [name, fqn] of collectGlobalUsingAliases(parsedByPath.get(f.path)!)) {
      csharpGlobalUsingAliasMap.set(name, fqn);
    }
  }
  const csharpGlobalUsingsList = [...csharpGlobalUsings];
  const csharpGlobalUsingAliasesList = [...csharpGlobalUsingAliasMap.entries()];

  // 4. Owner index over the in-memory graph (one node per file's parent dir).
  const nodes = new Map<string, { path: string; meta: { mapping: string[] } }>();
  for (const f of doc.files) {
    const nodeId = nodeOf(f.path);
    let entry = nodes.get(nodeId);
    if (!entry) {
      entry = { path: nodeId, meta: { mapping: [] } };
      nodes.set(nodeId, entry);
    }
    entry.meta.mapping.push(f.path);
  }
  const ownerIndex = buildOwnerIndex(nodes as any);

  // 5. Real resolver. Symbol-axis languages (C#, Kotlin) resolve through the SymbolTable;
  //    path-axis languages (Java, Go, PHP, TS/JS, Python, Rust, C/C++, Ruby) resolve by the
  //    package/module = file/directory convention through `makeResolvePathToFile`, which is
  //    pure filesystem access. To drive the IDENTICAL production path resolver (never a copy),
  //    materialize the embedded `## Files` into a throwaway project root and point the real
  //    `makeResolvePathToFile` at it. The whole pipeline — extractor.uses(), the path resolver,
  //    the owner-set-collapse for a wildcard package import — is then byte-identical to pass.ts.
  const projectRoot = materializeProject(doc.files, doc.configFiles);
  try {
    const resolver = makeResolver({
      ownerIndex,
      symbolTable,
      resolvePathToFile: makeResolvePathToFile(projectRoot, ownerIndex.ownerOf),
    });

    // 6. Per file: real extractor.uses() (C# injects the global-using tier), then the
    //    EXACT pass.ts ordered-candidate walk → resolved cross-node edges.
    const edges: ExpectEdge[] = [];
    for (const f of doc.files) {
      const extractor = extractorForLanguage(f.language);
      if (!extractor) continue;
      const parsed = parsedByPath.get(f.path)!;
      const fromNode = nodeOf(f.path);
      const detected =
        f.language === 'csharp'
          ? csharpUses(parsed, {
              projectGlobalUsings: csharpGlobalUsingsList,
              projectGlobalUsingAliases: csharpGlobalUsingAliasesList,
            })
          : extractor.uses(parsed);
      for (const dep of detected) {
        // The SAME candidate walk the live pass runs (resolveCandidateGroup) — never a copy, so
        // a catalogue case can never pass on resolution logic that diverges from `yg check`.
        const ownerNode = resolveCandidateGroup(dep.candidates, resolver, f.path, f.language);
        if (ownerNode !== undefined && ownerNode !== fromNode) {
          edges.push({ fromFile: f.path, line: dep.line, node: ownerNode });
        }
      }
    }

    // 7. Assertions.
    const edgeKey = (e: ExpectEdge): string => `${e.fromFile}:${e.line}->${e.node}`;
    const actual = new Set(edges.map(edgeKey));
    const expected = new Set(doc.expectEdges.map(edgeKey));

    // every expected edge present
    for (const e of doc.expectEdges) {
      expect(actual, `case ${id}: expected edge ${edgeKey(e)} not emitted (got ${[...actual].join(', ') || 'none'})`).toContain(edgeKey(e));
    }
    // no unexpected cross-node edge (covers silence cases and edge cases alike)
    for (const a of actual) {
      expect(expected, `case ${id}: unexpected cross-node edge ${a}`).toContain(a);
    }
    // a `silence` expectation must yield zero edges
    if (doc.expectSilence && doc.expectEdges.length === 0) {
      expect(edges, `case ${id}: expected silence but emitted ${edges.map(edgeKey).join(', ')}`).toHaveLength(0);
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

/**
 * Materialize the embedded `## Files` into a throwaway temp project root and return its
 * absolute path. Each file's repo-relative POSIX path is created verbatim under the root, so
 * the path resolver sees the EXACT package = directory layout the catalogue documents. The
 * caller removes the directory in a `finally`. This is the path-axis analogue of building the
 * SymbolTable for the symbol-axis languages — both feed the SAME production resolver.
 */
function materializeProject(files: CaseFile[], configFiles: ConfigFile[] = []): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yg-refcase-'));
  for (const f of [...files, ...configFiles]) {
    const abs = path.join(root, f.path);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.code, 'utf-8');
  }
  return root;
}

/** Find the case `.md` by scanning each declared language dir for `<id>.md`. */
function locateCaseMd(id: string): string {
  for (const entry of readdirSync(CATALOGUE_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(CATALOGUE_ROOT, entry.name, `${id}.md`);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`reference-case ${id}: no <language>/${id}.md under ${CATALOGUE_ROOT}`);
}
