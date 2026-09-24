import type { SymbolTable } from './symbol-table.js';
import type { OwnerIndex } from './owner-index.js';
import type { DetectedDep, TargetHint } from './extractors/types.js';
import { isRubyExternalConstant } from './extractors/ruby-resolve.js';

export interface ResolvedTarget { ownerNode: string; resolvedFile: string }
export interface ResolverDeps {
  ownerIndex: OwnerIndex;
  symbolTable: SymbolTable;
  /** language-specific path → repo-rel file (or undefined). Injected per language. */
  resolvePathToFile: (specifier: string, fromFile: string, language: string, isPackage?: boolean) => string | undefined;
}

/**
 * The tri-state outcome of probing ONE candidate hint:
 *  - `resolved`  — the hint names exactly one definition (a unique mapped owner). That is
 *                  the binding: emit one edge, stop the group.
 *  - `ambiguous` — the hint names a key that WOULD bind here but has ≥2 definitions (a real
 *                  unresolvable ambiguity, symbol axis only). Stop the group with silence;
 *                  do NOT fall through to a farther candidate.
 *  - `absent`    — the hint resolves to no in-graph definition, or to an UNMAPPED file (the
 *                  D7 non-event). Continue to the next, farther candidate.
 */
export type Classification =
  | { kind: 'resolved'; ownerNode: string; resolvedFile: string }
  | { kind: 'ambiguous' }
  | { kind: 'absent' };

export interface TargetResolver {
  resolve(hint: TargetHint, fromFile: string, language: string): ResolvedTarget | undefined;
  classify(hint: TargetHint, fromFile: string, language: string): Classification;
  /**
   * The raw resolved file for a candidate hint, independent of node ownership: 0 or ≥2
   * distinct files (unresolved or ambiguous) both yield undefined; exactly one file is
   * returned regardless of whether `ownerIndex` maps it to a node. This is the SAME
   * file-resolution computation `classify` runs internally, minus its final
   * `ownerIndex.ownerOf` step — so a caller that already received `classify`'s `absent`
   * outcome for this SAME hint (which collapses "no file resolved" and "resolved to an
   * unmapped file" into one non-committal answer, by design — D7) can distinguish the two
   * without a second, independent resolution algorithm. Used ONLY by the live
   * type-relation gate's typed-edge construction (relations/pass.ts) to test whether an
   * otherwise-unmapped candidate names a TYPE-COVERED file instead; the node-owned
   * candidate walk (`resolveCandidateGroup`/`classify`) never calls this and is
   * unaffected by its existence.
   */
  resolveFile(hint: TargetHint, fromFile: string, language: string): string | undefined;
}

/**
 * The ordered first-unique-match-wins walk over a detected reference's candidate group:
 * nearest binding first (member → enclosing namespace → unique using-import → verbatim),
 * farther candidates last. Returns the owner node of the resolved binding, or undefined when
 * the group silences (a nearer candidate is present-but-ambiguous, or no candidate binds). For
 * a one-element group this is byte-identical to a single resolve.
 *
 * This is the SINGLE definition of the candidate walk, shared by the live relation pass and the
 * reference-case test runner so the two can never drift. Self-edge filtering and declared-
 * relation verification are the caller's concern (they happen at different stages).
 */
export function resolveCandidateGroup(
  candidates: readonly TargetHint[],
  resolver: TargetResolver,
  fromFile: string,
  language: string,
): string | undefined {
  for (const cand of candidates) {
    const outcome = resolver.classify(cand, fromFile, language);
    if (outcome.kind === 'resolved') return outcome.ownerNode;
    if (outcome.kind === 'ambiguous') return undefined; // present-but-ambiguous → silence the group
    // outcome.kind === 'absent' → continue to the next, farther candidate
  }
  return undefined; // end of list, nothing bound → silence (external / unmapped)
}

/**
 * Resolve every detected reference of ONE file through {@link resolveCandidateGroup} and
 * return the bound edges, each `(line, ownerNode)` at most once. Several references on one
 * line often bind to the same node (a Python `from m import a, b` offers the module and each
 * name as candidates that all land in one file; a C# line names one type twice); they are one
 * dependency, so they are reported once. Shared by the live pass and the reference-case runner
 * so the two report the same rows.
 */
export function resolveDetectedEdges(
  detected: readonly DetectedDep[],
  resolver: TargetResolver,
  fromFile: string,
  language: string,
): Array<{ line: number; ownerNode: string }> {
  const out: Array<{ line: number; ownerNode: string }> = [];
  const seen = new Set<string>();
  for (const dep of detected) {
    const ownerNode = resolveCandidateGroup(dep.candidates, resolver, fromFile, language);
    if (ownerNode === undefined) continue;
    const key = `${dep.line}\0${ownerNode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ line: dep.line, ownerNode });
  }
  return out;
}

/**
 * The candidate symbol keys for ONE dotted symbol reference: the verbatim dot-only key,
 * PLUS the guarded nested-type `+`-boundary splits. For a dotted candidate `s1...sn`, for
 * each split index `k` in `[1, n-1]` the key `s1..sk + '+' + s_{k+1}..sn` is added ONLY
 * when `s1..sk` is itself a declared TYPE in the table (`SymbolTable.has`, ≥1 def). This is
 * the language's true semantics — under a type you can only nest a type, never a namespace —
 * so splitting at a declared-type boundary recovers the real nested-type meaning (`Outer.Inner`
 * → the `Outer+Inner` declaration key), and never splitting at a namespace boundary keeps it
 * sound. A key with no `.` (already a bare or `+` key) has no split. Separator isolation: the
 * `+` keys live in a string space disjoint from the dot-only namespace candidates.
 */
function nestedSplitKeys(symbolTable: SymbolTable, language: string, symbolKey: string): string[] {
  const keys = [symbolKey];
  const segs = symbolKey.split('.');
  for (let k = 1; k < segs.length; k++) {
    const prefix = segs.slice(0, k).join('.');
    if (!symbolTable.has(language, prefix)) continue; // guard: split only at a declared TYPE
    keys.push(`${prefix}+${segs.slice(k).join('+')}`);
  }
  return keys;
}

/**
 * The guarded nested-type `+`-split keys ONLY (the verbatim dotted form excluded). This is the
 * R4 reading: a `using A;` prefix on a multi-segment ref `B.Type` may bind `A.B+Type` (B a type,
 * Type nested) but MUST NOT bind the dotted `A.B.Type` (which would mean B is a sub-namespace,
 * and `using A;` imports the types of EXACTLY A, never A's nested namespaces). A single-segment
 * key (no `.`) has no split → empty.
 */
function nestedOnlySplitKeys(symbolTable: SymbolTable, language: string, symbolKey: string): string[] {
  const keys: string[] = [];
  const segs = symbolKey.split('.');
  for (let k = 1; k < segs.length; k++) {
    const prefix = segs.slice(0, k).join('.');
    if (!symbolTable.has(language, prefix)) continue; // guard: split only at a declared TYPE
    keys.push(`${prefix}+${segs.slice(k).join('+')}`);
  }
  return keys;
}

/**
 * Ruby root-anchoring guard. A Ruby constant reference `A::B::C` resolves to an in-repo
 * declaration ONLY when its ROOT segment `A` is itself a declared in-repo symbol. Ruby's
 * COMPACT declaration form (`module Rackup::Handler`) records the full `Rackup::Handler`
 * key but REOPENS a namespace (`Rackup`) that must already exist — so when `Rackup` has no
 * in-repo declaration of its own, it is an EXTERNAL library and the compact form merely
 * extends it. A reference to `Rackup::Handler` then means the external entity, and binding
 * it to the in-repo reopening would be a FALSE POSITIVE (the real case: a test stub `module
 * Rackup::Handler` wrongly pulled in by a library file's `defined?(Rackup::Handler)`).
 * Requiring the root to be anchored in-repo (some bare `module Rackup` / `class Rackup`,
 * recorded as a single-segment key) keeps genuine in-repo constants resolvable while
 * silencing reopened-external ones. RUBY-ONLY: C#/Kotlin root at a namespace that is never
 * recorded as a standalone symbol, so this guard must not apply to them.
 */
function rubyRootUnanchored(symbolKey: string, symbolTable: SymbolTable): boolean {
  const idx = symbolKey.indexOf('::');
  if (idx === -1) return false; // single-segment reference: it is its own root
  return !symbolTable.has('ruby', symbolKey.slice(0, idx));
}

/**
 * Ruby's symbol-axis gates, applied before and after the distinct-file count. Returns the
 * forced outcome, or undefined to let the ordinary count decide.
 *  - A reference rooted at a core class or a ubiquitous framework namespace (see
 *    `isRubyExternalConstant`) is external → absent, whatever the repo reopens (a reopening
 *    is not a definition). An unanchored root is absent too (rubyRootUnanchored).
 *  - `rubyAnchor`: the candidate has no definition but its first-segment name does → Ruby
 *    stops there → ambiguous (silence the group, never fall through).
 *  - `rubyInheritGuard`: the top-level fallback binds, but a constant of the same first
 *    segment is nested in some in-repo namespace and could be inherited → ambiguous.
 */
function rubyGate(
  hint: Extract<TargetHint, { kind: 'symbol' }>,
  files: ReadonlySet<string> | undefined,
  symbolTable: SymbolTable,
): 'absent' | 'ambiguous' | undefined {
  if (files === undefined) {
    if (isRubyExternalConstant(hint.symbolKey)) return 'absent';
    if (rubyRootUnanchored(hint.symbolKey, symbolTable)) return 'absent';
    return undefined;
  }
  if (files.size === 0) {
    return hint.rubyAnchor !== undefined && symbolTable.has('ruby', hint.rubyAnchor) ? 'ambiguous' : undefined;
  }
  // >= 1, not === 1: several defining files of ONE node now bind too (owner-node ambiguity), and
  // the inheritance hazard is the same however many files that node spreads the constant over.
  if (files.size >= 1 && hint.rubyInheritGuard !== undefined && symbolTable.hasNestedTail('ruby', hint.rubyInheritGuard)) {
    return 'ambiguous';
  }
  return undefined;
}

/** The languages that share the one JVM namespace (see symbol-table.ts). */
const JVM_LANGUAGES: ReadonlySet<string> = new Set(['java', 'kotlin']);

/** The file-level outcome of a JVM lookup, before node ownership is asked: exactly one file,
 *  a real ambiguity (silence the group), or nothing in-graph. */
type JvmOutcome = { kind: 'file'; file: string } | { kind: 'ambiguous' } | { kind: 'none' };

/**
 * The "declarations incomplete" markers a Kotlin file declares when part of it could not be
 * parsed (kotlin.ts): `<package>.*` — the file may declare anything in its package — and
 * `<package>.<Type>+*` — the file declares `Type` but some of its members were unreadable.
 * A marker never names a real symbol, so it never creates a binding. It only keeps an
 * ambiguity the unreadable declarations might have created: when a binding key `k` has a
 * definer, every marker that could cover `k` contributes its file, and a marker file other
 * than the definer makes the lookup ambiguous (fail closed).
 *
 * Only the binding key's OWN package can be covered: a file of package `a` cannot declare
 * `a.b.C` as a top-level member, and declaring it as `a.b+C` (a type `b` nesting `C`) while a
 * package `a.b` exists is a JVM class/package clash, so a marker of an enclosing package never
 * covers a sub-package key.
 */
function incompletenessMarkers(bindingKey: string): string[] {
  const plus = bindingKey.indexOf('+');
  const typePart = plus === -1 ? bindingKey : bindingKey.slice(0, plus);
  const dot = typePart.lastIndexOf('.');
  const markers = [dot === -1 ? '*' : `${typePart.slice(0, dot)}.*`];
  if (plus !== -1) markers.push(`${typePart}+*`);
  return markers;
}

export function makeResolver(deps: ResolverDeps): TargetResolver {
  /** The DISTINCT defining files a dotted symbol candidate maps to, across the verbatim key
   *  AND the guarded nested-type `+`-splits. The set-level rule: 0 distinct files → absent,
   *  exactly 1 → that file, ≥2 → ambiguous (silence). Counting every defining file (not the
   *  unique-or-undefined per-key result) keeps a genuine ambiguity — a single key with two
   *  defs, OR two plausible splits resolving to different files — as ≥2 distinct files, so the
   *  group silences rather than leaking to a farther candidate. */
  const symbolFiles = (language: string, symbolKey: string): Set<string> => {
    const files = new Set<string>();
    for (const key of nestedSplitKeys(deps.symbolTable, language, symbolKey)) {
      for (const f of deps.symbolTable.filesFor(language, key)) files.add(f);
    }
    return files;
  };

  /** The distinct defining files of one symbol-set member, honoring `nestedOnly` (R4): a
   *  `nestedOnly` member contributes ONLY its guarded `+`-split files, never the verbatim
   *  dotted reading. A plain member contributes the verbatim key + all guarded splits. */
  const memberFiles = (language: string, key: string, nestedOnly: boolean): Set<string> => {
    if (!nestedOnly) return symbolFiles(language, key);
    const files = new Set<string>();
    for (const splitKey of nestedOnlySplitKeys(deps.symbolTable, language, key)) {
      for (const f of deps.symbolTable.filesFor(language, splitKey)) files.add(f);
    }
    return files;
  };

  /** The distinct files a symbol HINT maps to: the union across its `set` members (each honoring
   *  its own `nestedOnly`) when a set is present, else the single `symbolKey` honoring the hint's
   *  own `nestedOnly`. ≥2 distinct files anywhere = a real ambiguity (CS0104 / co-definition). */
  const hintFiles = (
    hint: Extract<TargetHint, { kind: 'symbol' }>,
    language: string,
  ): Set<string> => {
    if (hint.set !== undefined) {
      const files = new Set<string>();
      for (const m of hint.set) {
        for (const f of memberFiles(language, m.symbolKey, m.nestedOnly === true)) files.add(f);
      }
      return files;
    }
    return memberFiles(language, hint.symbolKey, hint.nestedOnly === true);
  };

  /**
   * One dotted JVM symbol (a Kotlin import, a Java or Kotlin inline FQN type, or a Java import
   * the source-root probe missed) in the shared JVM namespace: the verbatim key plus its guarded
   * `+`-splits, counted by OWNER NODE like the generic symbol axis (B4, see symbolOutcome):
   * 0 files → none; 1 file, or 2+ files that all belong to ONE owner node (Kotlin expect/actual,
   * top-level overloads spread over files) → that file (the lexicographically first); 2+ owners,
   * or 2+ files including an unmapped one → ambiguous. Then the incompleteness markers: a marker
   * file other than the definers that could cover a binding key makes the lookup ambiguous (fail
   * closed) — UNLESS it belongs to the same owner node as the definers, because an unreadable
   * declaration in that node can only name that node again and can never flip the edge.
   */
  const jvmSymbolOutcome = (language: string, symbolKey: string): JvmOutcome => {
    const keys = nestedSplitKeys(deps.symbolTable, language, symbolKey);
    const files = new Set<string>();
    const bindingKeys: string[] = [];
    for (const key of keys) {
      const defs = deps.symbolTable.filesFor(language, key);
      if (defs.length > 0) bindingKeys.push(key);
      for (const f of defs) files.add(f);
    }
    if (files.size === 0) return { kind: 'none' };
    const sorted = [...files].sort();
    // The owner every definer shares; undefined for a lone unmapped definer (then any other
    // marker file is ambiguous, exactly as before owner collapse).
    const owner = deps.ownerIndex.ownerOf(sorted[0]);
    if (sorted.length >= 2) {
      if (owner === undefined || sorted.some((f) => deps.ownerIndex.ownerOf(f) !== owner)) return { kind: 'ambiguous' };
    }
    for (const key of bindingKeys) {
      for (const marker of incompletenessMarkers(key)) {
        for (const f of deps.symbolTable.filesFor(language, marker)) {
          if (files.has(f)) continue;
          if (owner === undefined || deps.ownerIndex.ownerOf(f) !== owner) return { kind: 'ambiguous' };
        }
      }
    }
    return { kind: 'file', file: sorted[0] };
  };

  /**
   * A star / on-demand import of `prefix` (Kotlin `import a.b.*`, a Java `import a.b.*;` whose
   * package directory the source-root probe did not find): every file declaring a direct
   * top-level member of package `prefix`, plus the declaring file of a CLASSIFIER named `prefix`
   * (a star import of an enum's entries or an object's members), collapsed by owner exactly like
   * Java's on-disk wildcard: one owning node → one of its files; two or more owners → ambiguous;
   * no owner at all → a file anyway (so `resolveFile` can still see a type-covered target; the
   * ownership step turns it into `absent`), or none when nothing in-graph declares into it.
   */
  const jvmStarOutcome = (language: string, prefix: string): JvmOutcome => {
    const files = new Set<string>(deps.symbolTable.filesInPackage(language, prefix));
    for (const f of symbolFiles(language, prefix)) files.add(f);
    if (files.size === 0) return { kind: 'none' };
    const sorted = [...files].sort();
    let sole: string | undefined;
    for (const f of sorted) {
      const owner = deps.ownerIndex.ownerOf(f);
      if (owner === undefined) continue;
      if (sole === undefined) sole = owner;
      else if (owner !== sole) return { kind: 'ambiguous' };
    }
    if (sole === undefined) return { kind: 'file', file: sorted[0] };
    return { kind: 'file', file: sorted.find((f) => deps.ownerIndex.ownerOf(f) === sole)! };
  };

  /** The JVM route for a hint, or undefined when the hint is not a JVM hint this route owns: a
   *  Kotlin star import (`<prefix>.*`), any plain JVM symbol hint, or — only after the Java
   *  source-root probe returned nothing (`pathMissed`) — a Java import resolved through the
   *  shared JVM namespace (cross-module, test → main, Java → Kotlin class or file facade). */
  const jvmOutcome = (hint: TargetHint, language: string, pathMissed: boolean): JvmOutcome | undefined => {
    if (!JVM_LANGUAGES.has(language)) return undefined;
    if (hint.kind === 'symbol') {
      if (hint.set !== undefined || hint.nestedOnly === true) return undefined;
      if (language === 'kotlin' && hint.symbolKey.endsWith('.*')) {
        return jvmStarOutcome(language, hint.symbolKey.slice(0, -2));
      }
      return jvmSymbolOutcome(language, hint.symbolKey);
    }
    if (language !== 'java' || !pathMissed) return undefined;
    return hint.isPackage === true
      ? jvmStarOutcome(language, hint.specifier)
      : jvmSymbolOutcome(language, hint.specifier);
  };

  const classifyJvm = (outcome: JvmOutcome): Classification => {
    if (outcome.kind === 'ambiguous') return { kind: 'ambiguous' };
    if (outcome.kind === 'none') return { kind: 'absent' };
    const ownerNode = deps.ownerIndex.ownerOf(outcome.file);
    return ownerNode ? { kind: 'resolved', ownerNode, resolvedFile: outcome.file } : { kind: 'absent' };
  };

  /**
   * The symbol-axis outcome for a hint's distinct defining files, counted by OWNER NODE (B4):
   * one file → that file (mapped or not, as before); 2+ files that ALL belong to the same owner
   * node → that node, reported with the lexicographically first file; 2+ files spanning 2+ owners,
   * or including any unmapped file → ambiguous. Language-agnostic: C# partial classes and the
   * `Result` / `Result<T>` split, Kotlin expect/actual and overloads spread over files, and any
   * other declaration split across files of ONE node name exactly one dependency target — the
   * ambiguity that must silence is between NODES, never between files of one node.
   */
  const symbolOutcome = (files: Set<string>): Classification => {
    if (files.size === 0) return { kind: 'absent' };
    const sorted = [...files].sort();
    if (sorted.length === 1) {
      const ownerNode = deps.ownerIndex.ownerOf(sorted[0]);
      // Resolved-but-UNMAPPED is the D7 non-event → absent (continue), never ambiguous.
      return ownerNode ? { kind: 'resolved', ownerNode, resolvedFile: sorted[0] } : { kind: 'absent' };
    }
    const owners = new Set<string | undefined>(sorted.map((f) => deps.ownerIndex.ownerOf(f)));
    if (owners.size !== 1 || owners.has(undefined)) return { kind: 'ambiguous' };
    return { kind: 'resolved', ownerNode: [...owners][0] as string, resolvedFile: sorted[0] };
  };

  const resolve: TargetResolver['resolve'] = (hint, fromFile, language) => {
    const jvmFirst = hint.kind === 'symbol' ? jvmOutcome(hint, language, false) : undefined;
    if (jvmFirst !== undefined) {
      const c = classifyJvm(jvmFirst);
      return c.kind === 'resolved' ? { ownerNode: c.ownerNode, resolvedFile: c.resolvedFile } : undefined;
    }
    if (hint.kind === 'symbol') {
      if (language === 'ruby' && rubyGate(hint, undefined, deps.symbolTable) !== undefined) return undefined;
      const files = hintFiles(hint, language);
      if (language === 'ruby' && rubyGate(hint, files, deps.symbolTable) !== undefined) return undefined;
      const outcome = symbolOutcome(files);
      // absent / ambiguous (2+ owners) → silence; resolved (one file, or one owner) → edge.
      return outcome.kind === 'resolved' ? { ownerNode: outcome.ownerNode, resolvedFile: outcome.resolvedFile } : undefined;
    }
    const file = deps.resolvePathToFile(hint.specifier, fromFile, language, hint.isPackage);
    if (!file) {
      const fallback = jvmOutcome(hint, language, true);
      if (fallback === undefined) return undefined; // unresolved → silence
      const c = classifyJvm(fallback);
      return c.kind === 'resolved' ? { ownerNode: c.ownerNode, resolvedFile: c.resolvedFile } : undefined;
    }
    const ownerNode = deps.ownerIndex.ownerOf(file);
    if (!ownerNode) return undefined;            // UNMAPPED target → coverage matter, never a violation (D7)
    return { ownerNode, resolvedFile: file };
  };

  const classify: TargetResolver['classify'] = (hint, fromFile, language) => {
    const jvmFirst = hint.kind === 'symbol' ? jvmOutcome(hint, language, false) : undefined;
    if (jvmFirst !== undefined) return classifyJvm(jvmFirst);
    if (hint.kind === 'symbol') {
      // Ruby: a multi-segment constant whose ROOT namespace is not itself declared in-repo
      // is reopening an EXTERNAL library (e.g. a test stub `module Rackup::Handler`) → absent,
      // never bind a reference to the reopened-external constant (zero-FP). See rubyRootUnanchored.
      // Ruby also treats core classes and framework namespaces as external (a reopening is not
      // a definition) and applies the lexical gates below — see rubyGate.
      if (language === 'ruby') {
        const forced = rubyGate(hint, undefined, deps.symbolTable);
        if (forced !== undefined) return { kind: forced };
      }
      // Symbol axis: collect the distinct files this hint maps to — the union across its `set`
      // members (CS0104 / co-definition), each honoring `nestedOnly` (R4), or the lone
      // `symbolKey`'s verbatim + guarded `+`-splits. Files spanning ≥2 owner nodes is a real
      // ambiguity (silence the group); 0 is absent (continue); one file or one owner binds
      // (B4, see symbolOutcome).
      const files = hintFiles(hint, language);
      if (language === 'ruby') {
        const forced = rubyGate(hint, files, deps.symbolTable);
        if (forced !== undefined) return { kind: forced };
      }
      return symbolOutcome(files);
    }
    // Path axis (PHP/Java/TS/JS/Py/Go/Rust/C/C++): resolution maps to AT MOST ONE file,
    // so the path probe itself has no `ambiguous` outcome — only resolved or absent. The one
    // exception is Java's miss fallback into the shared JVM namespace, where a duplicate
    // declaration or a split package IS an ambiguity.
    const file = deps.resolvePathToFile(hint.specifier, fromFile, language, hint.isPackage);
    if (!file) {
      const fallback = jvmOutcome(hint, language, true);
      return fallback !== undefined ? classifyJvm(fallback) : { kind: 'absent' };
    }
    const ownerNode = deps.ownerIndex.ownerOf(file);
    return ownerNode ? { kind: 'resolved', ownerNode, resolvedFile: file } : { kind: 'absent' };
  };

  const resolveFile: TargetResolver['resolveFile'] = (hint, fromFile, language) => {
    const jvmFirst = hint.kind === 'symbol' ? jvmOutcome(hint, language, false) : undefined;
    if (jvmFirst !== undefined) return jvmFirst.kind === 'file' ? jvmFirst.file : undefined;
    if (hint.kind === 'symbol') {
      if (language === 'ruby' && rubyGate(hint, undefined, deps.symbolTable) !== undefined) return undefined;
      const files = hintFiles(hint, language);
      if (language === 'ruby' && rubyGate(hint, files, deps.symbolTable) !== undefined) return undefined;
      return files.size === 1 ? [...files][0] : undefined; // 0 → unresolved; ≥2 → ambiguous
    }
    const file = deps.resolvePathToFile(hint.specifier, fromFile, language, hint.isPackage);
    if (file) return file;
    const fallback = jvmOutcome(hint, language, true);
    return fallback?.kind === 'file' ? fallback.file : undefined;
  };

  return { resolve, classify, resolveFile };
}
