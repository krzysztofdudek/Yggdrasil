#!/usr/bin/env node
// metamorphic (analysis e) — DOGFOOD calibration instrument. An OFFLINE probe that
// rewrites example code in MEANING-PRESERVING ways and checks whether the LLM
// reviewer's verdict wobbles. Read-only w.r.t. the real repo: it NEVER writes the
// real lock, the events sidecar, the drill-results sidecar, or any graph file. It
// makes verdict calls ONLY through `yg aspect-test` (which never writes the lock),
// and only ever against THROWAWAY temp fixtures it creates and deletes. Nothing it
// does folds into any verdict hash.
//
// WHAT: for an LLM rule it takes two of the rule's own example files — a
// `satisfies-*` case (expected: satisfied) and its `violates-*` counterpart
// (expected: refused) — and generates surface variants of each:
//   * INVARIANT transforms (identifier rename, whitespace normalization) preserve
//     program meaning, so the verdict SHOULD NOT change.
//   * The `violates-*` file is the COVARIANT counterpart: its meaning was changed
//     to break the rule, so it SHOULD stay refused — even under invariant surface
//     noise layered on top.
// Each variant is written into a throwaway temp fixture (a minimal `.yggdrasil/`
// graph mapping one file) and judged by the REAL reviewer via
// `yg aspect-test --aspect <id> --node probe`; the one-line verdict stamp is parsed.
//
// WHY (§10): the pilot MEASURES INCONSISTENCY, NOT CORRECTNESS. A per-aspect line
//   `<id>: k/m invariant transforms preserved the verdict; j/n covariant cases stayed refused`
// says how ROBUST the reviewer's judgment is to meaning-preserving rewrites — NOT
// whether the rule is "right". An invariant transform that flips the verdict is
// measured rule/judge sensitivity (a candidate to sharpen content.md so the reading
// is forced); a covariant case that goes satisfied is a missed violation. Neither is
// a correctness certificate for the rule.
//
// SEMANTIC SAFETY: a careless rename that collides with a real symbol would poison
// the counter (it would change meaning, not preserve it), so the rename is
// AST-SCOPED, never a regex substitution. It renames ONLY genuine `identifier`
// tokens (never property keys, shorthand properties, type names, import/export
// names, or free globals) of a LOCALLY-BOUND name, uniformly across the file, to a
// FRESH name that collides with no existing identifier — a sound alpha-rename. If no
// such name exists it reports "no safe rename" and leaves the file untouched. The
// reformat transform normalizes whitespace deterministically and idempotently while
// leaving string/template/comment spans byte-identical.
//
// HONESTY: every figure is small-N at this repo's scale — one flaky reviewer run is
// noise, not a measured wobble rate. An `incomplete`/`error` run (reviewer infra) is
// UNKNOWN and is excluded from every count — unknown is never a preserved or refused
// vote. Absence of a probe is not a certificate of stability.
//
// BUILD DEPENDENCY: this script imports the built parser wrapper from
// source/cli/dist/ (the `walk`/`closest` AST wrappers) and loads the built
// tree-sitter WASM grammars from source/cli/dist/grammars/, and it spawns the built
// CLI at source/cli/dist/bin.js. Run `npm run build` in source/cli first (the repo
// quality gate builds before it runs anything). Parsing itself uses web-tree-sitter,
// the CLI's OWN already-installed parser dependency (no new dependency is added):
// the public dist/ast surface exposes the AST wrappers but not a parse entry point.
//
// USAGE:
//   node scripts/metamorphic.mjs           # OFFLINE self-check of the transforms
//                                           # (parse + rename + reformat + determinism),
//                                           # no reviewer calls — the CI/spawn smoke.
//   node scripts/metamorphic.mjs --run      # run the PILOT against the real reviewer
//                                           # (billed to the configured reviewer; with
//                                           # a keyless provider like claude-code, $0).

import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const out = (m = '') => process.stdout.write(m + '\n');
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

// Self-locate the repo layout from THIS module's path (never from cwd, so the pure
// transforms below can be imported by the test runner from any working directory).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLI = path.join(ROOT, 'source', 'cli');
const BIN = path.join(CLI, 'dist', 'bin.js');
const GRAMMARS = path.join(CLI, 'dist', 'grammars');
const AST_WRAPPERS = path.join(CLI, 'dist', 'ast.js');
const REAL_ASPECTS = path.join(ROOT, '.yggdrasil', 'aspects');

// ─────────────────────────────────────────────────────────────────────────────
// AST machinery — parse via web-tree-sitter (the CLI's own installed parser) +
// the built grammars; traverse via the built `walk`/`closest` wrappers from dist.
// ─────────────────────────────────────────────────────────────────────────────

const WASM_FOR_EXT = {
  '.ts': 'tree-sitter-typescript.wasm',
  '.tsx': 'tree-sitter-tsx.wasm',
  '.js': 'tree-sitter-javascript.wasm',
  '.mjs': 'tree-sitter-javascript.wasm',
  '.cjs': 'tree-sitter-javascript.wasm',
  '.jsx': 'tree-sitter-javascript.wasm',
};

let _tsPromise = null;
async function ast() {
  if (!_tsPromise) {
    _tsPromise = (async () => {
      const require = createRequire(path.join(CLI, 'package.json'));
      const wts = await import(pathToFileURL(require.resolve('web-tree-sitter')).href);
      await wts.Parser.init();
      const wrappers = await import(pathToFileURL(AST_WRAPPERS).href);
      return { Parser: wts.Parser, Language: wts.Language, walk: wrappers.walk, closest: wrappers.closest };
    })();
  }
  return _tsPromise;
}

const _langCache = new Map();
async function parserFor(ext) {
  const wasm = WASM_FOR_EXT[ext];
  if (!wasm) throw new Error(`metamorphic: no grammar for extension '${ext}'`);
  const { Parser, Language } = await ast();
  let lang = _langCache.get(wasm);
  if (!lang) {
    lang = await Language.load(path.join(GRAMMARS, wasm));
    _langCache.set(wasm, lang);
  }
  const parser = new Parser();
  parser.setLanguage(lang);
  return parser;
}

const sameSpan = (a, b) => !!a && !!b && a.startIndex === b.startIndex && a.endIndex === b.endIndex;
const isIdentifierLike = (t) => t === 'identifier' || t.endsWith('_identifier');

// A node is a genuine local BINDING occurrence (a declaration site) — the anchor
// that proves a name is declared inside the file (not a free global reference).
function isBinding(n) {
  const p = n.parent;
  if (!p) return false;
  const pt = p.type;
  const nameOf = (D) => (D.childForFieldName ? D.childForFieldName('name') : null);
  if (pt === 'variable_declarator' && sameSpan(n, nameOf(p))) return true;
  if (pt === 'required_parameter' || pt === 'optional_parameter') return true; // the pattern identifier
  if (pt === 'formal_parameters') return true; // bare identifier param
  if (pt === 'catch_clause' && sameSpan(n, p.childForFieldName ? p.childForFieldName('parameter') : null)) return true;
  if (pt === 'arrow_function' && sameSpan(n, p.childForFieldName ? p.childForFieldName('parameter') : null)) return true;
  if ((pt === 'function_declaration' || pt === 'generator_function_declaration' ||
       pt === 'function_signature' || pt === 'class_declaration' || pt === 'abstract_class_declaration')
      && sameSpan(n, nameOf(p))) return true;
  return false;
}

// A node is the module's PUBLIC EXPORT name — renaming it would change the module's
// interface, so it is never a safe alpha-rename target. Precise (NOT "anything under
// an export statement": params/locals of an exported function are internal).
function isExportedName(n, closest) {
  if (closest(n, 'export_specifier')) return true;
  const p = n.parent;
  if (!p) return false;
  const nameOf = (D) => (D.childForFieldName ? D.childForFieldName('name') : null);
  if ((p.type === 'function_declaration' || p.type === 'generator_function_declaration' ||
       p.type === 'class_declaration' || p.type === 'abstract_class_declaration' ||
       p.type === 'interface_declaration' || p.type === 'enum_declaration' ||
       p.type === 'function_signature')
      && sameSpan(n, nameOf(p)) && p.parent && p.parent.type === 'export_statement') return true;
  if (p.type === 'variable_declarator' && sameSpan(n, nameOf(p))) {
    const decl = p.parent; // lexical_declaration | variable_declaration
    if (decl && decl.parent && decl.parent.type === 'export_statement') return true;
  }
  return false;
}

/**
 * Parse `source` and collect the facts the rename transform needs. Returns:
 *   idTokens        — every genuine `identifier` leaf as { text, start, end }
 *   allNames        — text of ALL identifier-like leaves (collision universe for a new name)
 *   shorthandTexts  — text appearing as a shorthand/pattern property (fusion risk)
 *   importExport    — text that is an import binding OR a public export name
 *   bound           — text with at least one local binding occurrence
 */
async function collectIdentifiers(source, ext) {
  const { walk, closest } = await ast();
  const parser = await parserFor(ext);
  const tree = parser.parse(source);
  const idTokens = [];
  const allNames = new Set();
  const shorthandTexts = new Set();
  const importExport = new Set();
  const bound = new Set();
  try {
    walk(tree.rootNode, (n) => {
      const t = n.type;
      if (n.childCount !== 0 || !isIdentifierLike(t)) return;
      allNames.add(n.text);
      if (t === 'shorthand_property_identifier' || t === 'shorthand_property_identifier_pattern') {
        shorthandTexts.add(n.text);
      }
      if (t !== 'identifier') return;
      idTokens.push({ text: n.text, start: n.startIndex, end: n.endIndex });
      if (closest(n, 'import_statement') || isExportedName(n, closest)) importExport.add(n.text);
      if (isBinding(n)) bound.add(n.text);
    });
  } finally {
    tree.delete();
  }
  return { idTokens, allNames, shorthandTexts, importExport, bound };
}

// Splice a replacement into disjoint token spans; descending order keeps earlier
// byte offsets valid. Offsets are UTF-16 units (they match JS string slicing).
function spliceSpans(source, spans, replacement) {
  const sorted = [...spans].sort((a, b) => b.start - a.start);
  let outStr = source;
  for (const s of sorted) outStr = outStr.slice(0, s.start) + replacement + outStr.slice(s.end);
  return outStr;
}

/**
 * LOW-LEVEL rename: rewrite every genuine `identifier` token whose text is `from`
 * to `to`, guarded so the result is a sound alpha-rename. Returns
 * `{ ok: true, code }` or `{ ok: false, reason }` (source left untouched). The
 * collision guard is the load-bearing invariant: a `to` that already occurs as any
 * identifier in the file is refused ("no safe rename") rather than silently merging
 * two distinct symbols.
 */
export async function renameIdentifier(source, ext, from, to) {
  const facts = await collectIdentifiers(source, ext);
  const occurrences = facts.idTokens.filter((tk) => tk.text === from);
  if (occurrences.length === 0) return { ok: false, reason: `no safe rename: '${from}' is not a renameable identifier` };
  if (facts.shorthandTexts.has(from)) return { ok: false, reason: `no safe rename: '${from}' is used as a shorthand property (renaming it would desync key and value)` };
  if (facts.importExport.has(from)) return { ok: false, reason: `no safe rename: '${from}' is an import or export name (part of the module interface)` };
  if (facts.allNames.has(to)) return { ok: false, reason: `no safe rename: target '${to}' collides with an existing identifier` };
  return { ok: true, code: spliceSpans(source, occurrences, to) };
}

// Derive a fresh name for `from` that collides with nothing in `allNames`.
function freshName(from, allNames) {
  let cand = `${from}_r`;
  let i = 0;
  while (allNames.has(cand)) cand = `${from}_r${++i}`;
  return cand;
}

/**
 * HIGH-LEVEL invariant rename: pick the first safe LOCAL identifier (deterministic:
 * earliest by source position) and rename it uniformly to a fresh name. A safe
 * candidate is a name that is locally bound, not imported/exported, and not fused
 * into a shorthand property. Returns `{ ok: true, code, from, to }` or
 * `{ ok: false, reason: 'no safe rename' }`.
 */
export async function autoRename(source, ext) {
  const facts = await collectIdentifiers(source, ext);
  const seen = new Set();
  const candidates = [];
  for (const tk of facts.idTokens) {
    if (seen.has(tk.text)) continue;
    seen.add(tk.text);
    if (!facts.bound.has(tk.text)) continue;         // not declared locally → maybe a free global
    if (facts.importExport.has(tk.text)) continue;    // import/export name → interface
    if (facts.shorthandTexts.has(tk.text)) continue;  // shorthand fusion risk
    candidates.push({ text: tk.text, start: tk.start });
  }
  candidates.sort((a, b) => a.start - b.start);
  if (candidates.length === 0) return { ok: false, reason: 'no safe rename' };
  const from = candidates[0].text;
  const to = freshName(from, facts.allNames);
  const occurrences = facts.idTokens.filter((tk) => tk.text === from);
  return { ok: true, code: spliceSpans(source, occurrences, to), from, to };
}

// Whitespace-only leaf spans whose content is meaning-sensitive and must be left
// byte-identical (strings/templates/comments/regex).
const PROTECTED_TYPES = new Set(['string', 'template_string', 'comment', 'regex']);

async function protectedSpans(source, ext) {
  const { walk } = await ast();
  const parser = await parserFor(ext);
  const tree = parser.parse(source);
  const spans = [];
  try {
    walk(tree.rootNode, (n) => {
      if (PROTECTED_TYPES.has(n.type)) {
        spans.push([n.startIndex, n.endIndex]);
        return false; // outermost only — do not descend into nested substitutions
      }
    });
  } finally {
    tree.delete();
  }
  spans.sort((a, b) => a[0] - b[0]);
  return spans;
}

// Idempotent normalization of a PLAIN (non-protected) region.
function normalizePlain(s) {
  return s
    .replace(/\r\n?/g, '\n')            // CRLF / lone CR → LF
    .replace(/[ \t]+\n/g, '\n')          // strip trailing horizontal whitespace
    .replace(/\n(?:[ \t]*\n)+/g, '\n');  // collapse blank lines (insignificant outside strings)
}

/**
 * Reformat transform: normalize whitespace deterministically and idempotently,
 * leaving every string/template/comment/regex span byte-identical (so the transform
 * is genuinely meaning-preserving). Removes CRLFs, trailing whitespace, and
 * insignificant blank lines, and ensures a single final newline.
 */
export async function reformat(source, ext) {
  const spans = await protectedSpans(source, ext);
  let outStr = '';
  let cursor = 0;
  for (const [s, e] of spans) {
    outStr += normalizePlain(source.slice(cursor, s));
    outStr += source.slice(s, e); // verbatim
    cursor = e;
  }
  outStr += normalizePlain(source.slice(cursor));
  // Trailing whitespace at EOF is plain by construction (a valid source cannot end
  // inside an unterminated protected token) — safe to normalize to one newline.
  outStr = outStr.replace(/[ \t\r\n]+$/, '') + '\n';
  return outStr;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pilot aspects — each pairs a satisfies/violates drill case from the rule's own
// corpus with a fixture subject path chosen to read as the rule's target layer.
// ─────────────────────────────────────────────────────────────────────────────

const PILOT = [
  {
    id: 'what-why-next',
    subjectPath: 'source/cli/src/cli/report-unverified.ts',
    filename: 'report-unverified.ts',
    satisfies: 'satisfies-buildissuemessage',
    violates: 'violates-adhoc-remediation',
  },
  {
    id: 'diagnostic-logging',
    subjectPath: 'source/cli/src/io/read-config.ts',
    filename: 'read-config.ts',
    satisfies: 'satisfies-debugwrite',
    violates: 'violates-silent-catch',
  },
];

const ARCH_YAML = `node_types:
  probe:
    description: 'Metamorphic probe fixture node — maps one throwaway subject file.'
    log_required: false
    when:
      path: "source/cli/src/**/*.ts"
`;

const CONFIG_YAML = `version: "5.1.0"
quality:
  max_direct_relations: 20
reviewer:
  default: standard
  tiers:
    standard:
      provider: claude-code
      consensus: 1
      max_prompt_chars: 64000
      config:
        model: sonnet
`;

const nodeYaml = (aspect) => `name: Probe
description: Metamorphic probe subject.
type: probe
mapping:
  - ${aspect.subjectPath}
aspects:
  - ${aspect.id}
`;

function drillSource(aspect, kind) {
  return readFileSync(path.join(REAL_ASPECTS, aspect.id, 'drills', aspect[kind], aspect.filename), 'utf8');
}

function buildFixture(aspect) {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-metamorphic-'));
  const yg = path.join(dir, '.yggdrasil');
  mkdirSync(path.join(yg, 'aspects', aspect.id), { recursive: true });
  mkdirSync(path.join(yg, 'model', 'probe'), { recursive: true });
  mkdirSync(path.join(dir, path.dirname(aspect.subjectPath)), { recursive: true });
  writeFileSync(path.join(yg, 'yg-architecture.yaml'), ARCH_YAML);
  writeFileSync(path.join(yg, 'yg-config.yaml'), CONFIG_YAML);
  copyFileSync(path.join(REAL_ASPECTS, aspect.id, 'yg-aspect.yaml'), path.join(yg, 'aspects', aspect.id, 'yg-aspect.yaml'));
  copyFileSync(path.join(REAL_ASPECTS, aspect.id, 'content.md'), path.join(yg, 'aspects', aspect.id, 'content.md'));
  writeFileSync(path.join(yg, 'model', 'probe', 'yg-node.yaml'), nodeYaml(aspect));
  return { dir, subjectAbs: path.join(dir, aspect.subjectPath) };
}

// Run one variant through the REAL reviewer against the fixture; parse the one-line
// verdict stamp. 'incomplete'/'error' are reviewer-infra UNKNOWNs, never a vote.
let reviewerCalls = 0;
function judge(fixture, aspectId, variantSource) {
  writeFileSync(fixture.subjectAbs, variantSource);
  reviewerCalls++;
  const res = spawnSync('node', [BIN, 'aspect-test', '--aspect', aspectId, '--node', 'probe'], {
    cwd: fixture.dir,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 300000,
  });
  if (res.error) return 'error';
  const text = stripAnsi(res.stdout || '');
  if (/yg aspect-test: satisfied/.test(text)) return 'satisfied';
  if (/yg aspect-test: refused/.test(text)) return 'refused';
  if (/yg aspect-test: incomplete/.test(text)) return 'incomplete';
  return 'error';
}

// Build the invariant surface variants of a source (only GENUINE changes — a
// "no safe rename" or a no-op reformat is reported, never counted).
async function invariantVariants(source, ext) {
  const variants = [];
  const rn = await autoRename(source, ext);
  if (!rn.ok) variants.push({ kind: 'rename', status: 'no-safe-rename', note: rn.reason });
  else if (rn.code === source) variants.push({ kind: 'rename', status: 'no-op' });
  else variants.push({ kind: 'rename', status: 'genuine', code: rn.code, label: `${rn.from}->${rn.to}` });
  const rf = await reformat(source, ext);
  if (rf === source) variants.push({ kind: 'reformat', status: 'no-op' });
  else variants.push({ kind: 'reformat', status: 'genuine', code: rf, label: 'whitespace normalized' });
  return variants;
}

async function runPilot() {
  header();
  out('Pilot — REAL reviewer via yg aspect-test on throwaway temp fixtures.');
  out('');
  const lines = [];
  for (const aspect of PILOT) {
    const ext = path.extname(aspect.subjectPath);
    const fixture = buildFixture(aspect);
    try {
      // ── INVARIANT arm: from the satisfies case; variants must MATCH the baseline. ──
      const satSrc = drillSource(aspect, 'satisfies');
      const satBaseline = judge(fixture, aspect.id, satSrc);
      const invVariants = await invariantVariants(satSrc, ext);
      let k = 0, m = 0;
      const invDetail = [];
      const decided = satBaseline === 'satisfied' || satBaseline === 'refused';
      for (const v of invVariants) {
        if (v.status !== 'genuine') { invDetail.push(`    ${v.kind}: ${v.status}${v.note ? ` (${v.note})` : ''} — not counted`); continue; }
        const verdict = judge(fixture, aspect.id, v.code);
        if (verdict !== 'satisfied' && verdict !== 'refused') { invDetail.push(`    ${v.kind} (${v.label}): ${verdict} — reviewer infra UNKNOWN, excluded`); continue; }
        if (!decided) { invDetail.push(`    ${v.kind} (${v.label}): ${verdict} — baseline undecided, excluded`); continue; }
        m++;
        const preserved = verdict === satBaseline;
        if (preserved) k++;
        invDetail.push(`    ${v.kind} (${v.label}): ${verdict} — ${preserved ? 'preserved' : 'FLIPPED vs baseline (measured sensitivity)'}`);
      }

      // ── COVARIANT arm: from the violates case; every case must stay refused. ──
      const vioSrc = drillSource(aspect, 'violates');
      const vioBaseline = judge(fixture, aspect.id, vioSrc);
      const covCases = [{ label: 'baseline', verdict: vioBaseline }];
      const covVariants = await invariantVariants(vioSrc, ext);
      const covDetail = [];
      for (const v of covVariants) {
        if (v.status !== 'genuine') { covDetail.push(`    ${v.kind}: ${v.status}${v.note ? ` (${v.note})` : ''} — not counted`); continue; }
        const verdict = judge(fixture, aspect.id, v.code);
        covCases.push({ label: `${v.kind} (${v.label})`, verdict });
      }
      let j = 0, n = 0;
      for (const c of covCases) {
        if (c.verdict !== 'satisfied' && c.verdict !== 'refused') { covDetail.push(`    ${c.label}: ${c.verdict} — reviewer infra UNKNOWN, excluded`); continue; }
        n++;
        const stayed = c.verdict === 'refused';
        if (stayed) j++;
        covDetail.push(`    ${c.label}: ${c.verdict} — ${stayed ? 'stayed refused' : 'MISS (violation not caught)'}`);
      }

      lines.push(`${aspect.id}: ${k}/${m} invariant transforms preserved the verdict; ${j}/${n} covariant cases stayed refused`);
      lines.push(`  invariant baseline (${aspect.satisfies}): ${satBaseline}`);
      lines.push(...invDetail);
      lines.push(`  covariant baseline (${aspect.violates}): ${vioBaseline}`);
      lines.push(...covDetail);
      lines.push('');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  }
  for (const l of lines) out(l);
  out(`reviewer calls: ${reviewerCalls} (provider from the fixture config: claude-code — keyless, $0)`);
  footer();
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Offline self-check (default) — exercises the exact transforms the pilot uses,
// with NO reviewer calls: parse, rename, reformat, and prove determinism +
// idempotency + a sound alpha-rename over the pilot corpus. This is the spawn smoke.
// ─────────────────────────────────────────────────────────────────────────────

async function runSelfCheck() {
  header();
  out('Offline self-check — transforms only, NO reviewer calls.');
  out('  (Run with --run to execute the pilot against the real reviewer.)');
  out('');
  let failures = 0;
  for (const aspect of PILOT) {
    const ext = path.extname(aspect.subjectPath);
    for (const kind of ['satisfies', 'violates']) {
      let src;
      try { src = drillSource(aspect, kind); }
      catch (e) { out(`  ${aspect.id}/${kind}: drill source unavailable (${e.message}) — skipped`); continue; }

      // Rename: deterministic (same twice) + a sound alpha-rename or an honest "no safe rename".
      const rn1 = await autoRename(src, ext);
      const rn2 = await autoRename(src, ext);
      const rnStable = JSON.stringify(rn1) === JSON.stringify(rn2);
      if (!rnStable) { failures++; out(`  ${aspect.id}/${kind}: rename NOT deterministic — FAIL`); }
      if (rn1.ok) {
        // Prove it is an alpha-rename: after renaming, `from` no longer occurs as an
        // identifier and `to` now does.
        const after = await collectIdentifiers(rn1.code, ext);
        const fromGone = !after.idTokens.some((t) => t.text === rn1.from);
        const toPresent = after.idTokens.some((t) => t.text === rn1.to);
        if (!(fromGone && toPresent && rn1.code !== src)) { failures++; out(`  ${aspect.id}/${kind}: rename ${rn1.from}->${rn1.to} did not cleanly rewrite — FAIL`); }
        else out(`  ${aspect.id}/${kind}: rename ${rn1.from}->${rn1.to} (${after.idTokens.filter((t) => t.text === rn1.to).length} spans) — ok, deterministic`);
      } else {
        out(`  ${aspect.id}/${kind}: rename — ${rn1.reason} (deterministic)`);
      }

      // Reformat: deterministic (same twice) + idempotent (reformat∘reformat == reformat).
      const rf1 = await reformat(src, ext);
      const rf2 = await reformat(src, ext);
      const rf3 = await reformat(rf1, ext);
      if (rf1 !== rf2) { failures++; out(`  ${aspect.id}/${kind}: reformat NOT deterministic — FAIL`); }
      else if (rf3 !== rf1) { failures++; out(`  ${aspect.id}/${kind}: reformat NOT idempotent — FAIL`); }
      else out(`  ${aspect.id}/${kind}: reformat ${rf1 === src ? 'no-op' : 'changed'} — ok, deterministic & idempotent`);
    }
  }
  out('');
  if (failures > 0) { out(`self-check: ${failures} FAILURE(S).`); footer(); return 1; }
  out('self-check: all transforms deterministic, idempotent, and semantics-preserving over the pilot corpus.');
  footer();
  return 0;
}

function header() {
  out('metamorphic (e) — invariant/covariant reviewer consistency');
  out('  Rewrites example code in MEANING-PRESERVING ways (identifier rename,');
  out('  whitespace normalization) and checks whether the reviewer\'s verdict wobbles.');
  out('  This MEASURES INCONSISTENCY, NOT CORRECTNESS (§10): a flip is measured');
  out('  rule/judge sensitivity, never a claim that a rule is right or wrong.');
  out('');
}

function footer() {
  out('');
  out('— honesty labels —');
  out('  measures inconsistency, not correctness — a preserved verdict says the reviewer was ROBUST to a surface change, not that the rule is correct.');
  out('  small-N — at this repo\'s scale every probe is indicative, not significant; one flaky reviewer run is noise, not a measured wobble rate.');
  out('  unknown ≠ zero — an incomplete/error run (reviewer infra) is excluded from every count, never a preserved or a refused vote.');
}

async function main() {
  const runPilotMode = process.argv.slice(2).includes('--run');
  try {
    const code = runPilotMode ? await runPilot() : await runSelfCheck();
    process.exit(code);
  } catch (e) {
    process.stderr.write(`metamorphic: ${e instanceof Error ? e.stack || e.message : String(e)}\n`);
    process.stderr.write('metamorphic: if this is a module/parser load error, build the CLI first: (cd source/cli && npm run build)\n');
    process.exit(2);
  }
}

// Only run as a CLI; when imported (by tests) the pure transforms are used directly.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
