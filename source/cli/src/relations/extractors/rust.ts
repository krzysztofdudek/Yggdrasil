import type { Node } from 'web-tree-sitter';
import { walk } from '../../ast/walk.js';
import type { DependencyExtractor, DetectedDep, DeclaredSymbol, ParsedFile } from './types.js';
import { single } from './types.js';

/**
 * Rust dependency extractor.
 *
 * v1 scope = EXISTENCE, not relation type. The unit of an inter-component edge in
 * Rust is the `use` IMPORT: a file brings a path from another module into scope with
 * a `use_declaration`. A dependency edge is therefore established ONLY by a `use`
 * declaration. Usage-site nodes (trait impls, supertrait bounds, fully-qualified
 * calls, type references, struct-literal construction) would only REFINE the
 * relation TYPE of an already-importable target, and v1 does not enforce relation
 * type — so this extractor performs NO usage-site refinement. It emits one path
 * hint per imported path whose specifier is the crate-relative `::`-joined path
 * (e.g. `crate::orders::Order`, `super::util::X`, `self::y`). The resolver
 * (`rust-resolve.ts`) maps that path → a `.rs` file through the crate module tree.
 *
 * GROUPED imports: every item of a use tree is resolved ON ITS OWN, joined to the
 * accumulated prefix. `use crate::{billing::Invoice, orders::Order}` emits
 * `crate::billing::Invoice` and `crate::orders::Order` — two modules, two edges — and
 * `use a::b::{C, D}` emits `a::b::C` and `a::b::D`, which the resolver's longest-match
 * walk binds to the same module file when C and D are items of `a::b` (a same-line
 * duplicate edge collapses downstream). The group prefix alone is never the target of an
 * item that names a deeper path: binding `crate::domain::{billing::X}` to module `domain`
 * would point the edge at the parent node. A `self` item means the prefix module itself
 * and emits the prefix. A nested `scoped_use_list` (`use a::{b::{C}}`) recurses with the
 * deeper prefix.
 *
 * INLINE MODULES are a level of the module tree. Inside `mod tests { … }`, `super` names
 * the module that encloses `tests` (the FILE's own module), not the file module's parent,
 * and `self` names `tests`. Every `self`/`super`-rooted specifier — and a file-backed
 * `mod x;` — emitted from inside inline modules is therefore rebased before it leaves the
 * extractor: each leading `super` first pops one enclosing inline module, and what is left
 * of the inline chain is spliced in after `self` (`mod outer { mod inner; }` →
 * `self::outer::inner`, whose file is `<module dir>/outer/inner.rs`). Only when there are
 * more `super`s than enclosing inline modules does the remainder climb from the file's
 * module. A `#[path]` attribute on an enclosing inline module moves its directory in ways a
 * source-only walk cannot pin, so relative specifiers under one are silenced.
 *
 * RAW IDENTIFIERS: `r#gen` is the identifier `gen` (edition 2024 reserves `gen`, and
 * `cargo fix` rewrites it to `r#gen`). The `r#` prefix is stripped from every segment so
 * `mod r#gen;` and `crate::r#gen::X` probe `gen.rs`, the file rustc loads.
 *
 * EXTERN CRATE: `extern crate name [as alias];` emits the bare crate `name` (the alias is a
 * local binding and is dropped). The resolver binds it only when `name` is an in-repo path
 * dependency of the importing crate; `std`, registry crates and `extern crate self` stay
 * silent.
 *
 * GLOB (`use a::b::*`) emits the prefix module `a::b`. RENAMED (`use a::b as c`)
 * strips the alias and emits the real path `a::b`. `pub use` (re-export) is
 * structurally a plain `use` carrying a `visibility_modifier`; the edge is
 * identical, so it is emitted the same way (keyed off the `argument` field, never
 * a child index, so the leading `pub` token does not shift anything).
 *
 * MACROS are invisible: a path appearing inside a `macro_invocation` token_tree is
 * unparsed tokens, never a `use_declaration`, so macro-generated deps are never
 * emitted. EXTERNAL crates (std, serde, …) emit a path hint too, but the resolver
 * returns undefined for any path whose root is not `crate`/`super`/`self` (and not
 * the current crate's own name) — so they never become a violation.
 *
 * MODULE DECLARATIONS: a file-backed `mod foo;` (a `mod_item` with NO body) declares that
 * submodule `foo` lives in `foo.rs` / `foo/mod.rs` beside the current file's module — a real
 * intra-crate file dependency that crosses a node boundary when that file is mapped to another
 * node. It is emitted as the relative path `self::foo`, which the resolver maps through the
 * module tree exactly like any `self::` import. A `#[path = "…"]` attribute OVERRIDES the
 * conventional location; resolving the override correctly requires nesting-sensitive rules a
 * source-only walk cannot get right in every case, so a `#[path]`-annotated `mod` is SKIPPED
 * (silence) rather than risk binding the wrong file. An INLINE `mod foo { … }` (with a body)
 * declares no separate file — its contents are walked in place (its own `use`/paths are
 * caught), and the `mod` itself emits nothing.
 *
 * INLINE PATHS: a fully-qualified path used WITHOUT a `use` — in TYPE position
 * (`field: crate::orders::Order`, `impl crate::traits::T`) a `scoped_type_identifier`, in
 * EXPRESSION position (`crate::logging::Logger::new()`, a `crate::m::macro!()` call) a
 * `scoped_identifier` — is emitted when its ROOT segment is `crate` / `self` / `super`. Those
 * three roots are absolute-within-crate or relative-to-module markers: the path is shadow-free
 * and resolves deterministically through the module tree, so detection is zero false positives.
 * A path rooted at a BARE identifier (`foo::Bar`) is NOT emitted — `foo` may be a `use`-bound
 * alias or the crate's own name, an ambiguity a source-only tool must not guess; the import or
 * a `crate::`-qualified form covers the real edge instead. Only the OUTERMOST scoped node of a
 * chain is read (it carries the complete path); the inner `path` segments are skipped.
 */

/**
 * Render a path-prefix node (`scoped_identifier` | `crate` | `super` | `self` |
 * `identifier`) as a `::`-joined specifier by walking the left-recursive `path`
 * chain down to the leftmost leaf and joining the segment texts in source order.
 *
 * `scoped_identifier` nests via field `path` (the prefix) and field `name` (the
 * final segment). The leftmost leaf is a `crate` / `super` / `self` / `identifier`
 * keyword-or-name node; its `.text` is the first segment. Returns undefined when
 * the structure is unexpected (malformed / error nodes) — silence over a guess.
 */
function pathText(node: Node): string | undefined {
  const segments: string[] = [];
  let cur: Node | null = node;
  // Descend the `path` chain, collecting the `name` segment at each scoped level.
  while (cur !== null && cur.type === 'scoped_identifier') {
    const nameNode = cur.childForFieldName('name');
    if (nameNode === null) return undefined;
    segments.unshift(nameNode.text);
    cur = cur.childForFieldName('path');
  }
  // `cur` is now the leftmost leaf: crate | super | self | identifier (or null when
  // a scoped_identifier had no `path` field, which the grammar does not produce).
  if (cur === null) return undefined;
  if (
    cur.type === 'crate' ||
    cur.type === 'super' ||
    cur.type === 'self' ||
    cur.type === 'identifier'
  ) {
    segments.unshift(cur.text);
  } else {
    return undefined;
  }
  return segments.length > 0 ? segments.join('::') : undefined;
}

/** The prefix node of a `scoped_use_list` / `use_wildcard`: the path before the
 *  `{ … }` list or the `*`. It is a named child that is one of the path-shaped
 *  node types; the trailing `use_list` is excluded. Returns undefined when absent. */
function prefixNode(parent: Node): Node | null {
  for (let i = 0; i < parent.namedChildCount; i++) {
    const c = parent.namedChild(i);
    if (c === null) continue;
    if (
      c.type === 'scoped_identifier' ||
      c.type === 'crate' ||
      c.type === 'super' ||
      c.type === 'self' ||
      c.type === 'identifier'
    ) {
      return c;
    }
  }
  return null;
}

/** The `::`-joined text of a `scoped_type_identifier` (`crate::orders::Order`): its `path`
 *  field (a scoped_identifier or a crate/self/super leaf) joined to its `name` type_identifier.
 *  Returns undefined when the path field is type-rooted (`Outer::Inner`, not crate-absolute)
 *  or structurally unexpected — so a non-crate-rooted type ref is never built. */
function scopedTypePathText(node: Node): string | undefined {
  const pathNode = node.childForFieldName('path');
  const nameNode = node.childForFieldName('name');
  if (pathNode === null || nameNode === null) return undefined;
  const prefix = pathNode.type === 'scoped_identifier' ? pathText(pathNode) : leafRoot(pathNode);
  if (prefix === undefined) return undefined;
  return `${prefix}::${nameNode.text}`;
}

/** The text of a path-ROOT leaf node, but ONLY for the crate-relative roots
 *  (`crate` / `super` / `self`). Any other leaf (a bare `identifier`, a `type_identifier`)
 *  returns undefined so a non-crate-rooted path is not built. */
function leafRoot(node: Node): string | undefined {
  if (node.type === 'crate' || node.type === 'super' || node.type === 'self') return node.text;
  return undefined;
}

/** True when the `::`-path's root segment is a crate-relative marker (`crate`/`self`/`super`)
 *  — the only roots that resolve deterministically shadow-free. A bare-identifier root
 *  (`foo::Bar`, an external crate or a `use`-bound alias) is excluded. */
function isCrateRelativeRoot(specifier: string): boolean {
  const root = specifier.split('::', 1)[0];
  return root === 'crate' || root === 'self' || root === 'super';
}

/** Strip the raw-identifier prefix `r#` from one path segment (`r#gen` → `gen`). */
function unraw(segment: string): string {
  return segment.startsWith('r#') ? segment.slice(2) : segment;
}

/** Strip `r#` from every `::` segment of a specifier. */
function unrawPath(specifier: string): string {
  return specifier.split('::').map(unraw).join('::');
}

/** The enclosing INLINE modules of `node`, outermost first: every `mod_item` ancestor that
 *  has a body. `unpinned` is true when any of them carries a `#[path]` attribute, which
 *  relocates its directory, or has no readable name (a malformed tree) — the caller then
 *  emits nothing relative (silence over a guess). */
function inlineModChain(node: Node): { names: string[]; unpinned: boolean } {
  const names: string[] = [];
  let unpinned = false;
  for (let p: Node | null = node.parent; p !== null; p = p.parent) {
    if (p.type !== 'mod_item' || p.childForFieldName('body') === null) continue;
    const name = p.childForFieldName('name')?.text ?? '';
    names.unshift(unraw(name));
    if (name === '' || modHasPathOverride(p)) unpinned = true;
  }
  return { names, unpinned };
}

/**
 * Rebase a `self`/`super`-rooted specifier emitted from inside the (non-empty) inline
 * modules `names` (outermost first) so it reads relative to the FILE's module, which is what
 * the resolver anchors on. Each leading `super` pops one inline module; the inline modules
 * left over are spliced in after `self`; any `super`s beyond the inline depth climb from the
 * file's module.
 */
function rebaseForInlineMods(specifier: string, names: readonly string[]): string {
  const segs = specifier.split('::');
  if (segs[0] === 'self') return ['self', ...names, ...segs.slice(1)].join('::');
  let supers = 0;
  while (supers < segs.length && segs[supers] === 'super') supers++;
  const rest = segs.slice(supers);
  if (supers <= names.length) {
    return ['self', ...names.slice(0, names.length - supers), ...rest].join('::');
  }
  return [...new Array<string>(supers - names.length).fill('super'), ...rest].join('::');
}

/** True when `modItem` is preceded by a `#[path = "…"]` attribute that overrides its
 *  conventional file location. Attributes parse as preceding `attribute_item` siblings. */
function modHasPathOverride(modItem: Node): boolean {
  let sib: Node | null = modItem.previousNamedSibling;
  while (sib !== null && sib.type === 'attribute_item') {
    const attr = sib.namedChild(0); // attribute
    if (attr !== null && attr.type === 'attribute') {
      const id = attr.namedChild(0);
      if (id !== null && id.type === 'identifier' && id.text === 'path') return true;
    }
    sib = sib.previousNamedSibling;
  }
  return false;
}

function uses(file: ParsedFile): DetectedDep[] {
  const out: DetectedDep[] = [];
  const seen = new Set<string>();

  const emit = (raw: string | undefined, node: Node): void => {
    if (raw === undefined || raw === '') return;
    let specifier = unrawPath(raw);
    const root = specifier.split('::', 1)[0];
    if (root === 'self' || root === 'super') {
      // Relative to the module the node sits in: rebase across enclosing inline modules.
      const chain = inlineModChain(node);
      if (chain.names.length > 0) {
        if (chain.unpinned) return; // a #[path]-relocated (or nameless) inline module → silence
        specifier = rebaseForInlineMods(specifier, chain.names);
      }
    }
    const line = node.startPosition.row + 1;
    const dedupKey = `${specifier} ${line}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);
    out.push(single({ kind: 'path', specifier }, 'import', line));
  };

  /** Emit an inline path ONLY when it is crate-relative (`crate`/`self`/`super` root). */
  const emitInline = (specifier: string | undefined, node: Node): void => {
    if (specifier === undefined || specifier === '') return;
    if (!isCrateRelativeRoot(specifier)) return;
    emit(specifier, node);
  };

  // Resolve one `use` argument node (or a list item) to its specifier and emit.
  // `prefix` is the `::`-joined module prefix accumulated from enclosing
  // scoped_use_lists (empty at the top level). Recurses into nested groups.
  const handleArgument = (arg: Node, prefix: string): void => {
    switch (arg.type) {
      case 'scoped_identifier': {
        const tail = pathText(arg);
        if (tail !== undefined) emit(join(prefix, tail), arg);
        return;
      }
      case 'self': {
        // `prefix::{self}` names the prefix module itself.
        emit(prefix, arg);
        return;
      }
      case 'identifier':
      case 'crate':
      case 'super': {
        emit(join(prefix, arg.text), arg);
        return;
      }
      case 'use_as_clause': {
        // Resolve via the `path` field only; the `alias` is a local binding.
        const p = arg.childForFieldName('path');
        if (p !== null) handleArgument(p, prefix);
        return;
      }
      case 'use_wildcard': {
        // `prefix::*` — emit the prefix module. The wildcard's child is the prefix path.
        const pre = prefixNode(arg);
        if (pre === null) {
          // bare `use *;` is not valid Rust; nothing to emit.
          return;
        }
        const tail = pre.type === 'scoped_identifier' ? pathText(pre) : pre.text;
        if (tail !== undefined) emit(join(prefix, tail), arg);
        return;
      }
      case 'scoped_use_list': {
        // `prefix::{ items }` — extend the prefix with this group's path, then resolve
        // EVERY item on its own under that prefix: a path item (`billing::Invoice`) names
        // its own module, never the prefix module. A group with no usable prefix
        // (`use {a, b};`, non-idiomatic) resolves each item from the top level.
        const pre = prefixNode(arg);
        const groupPrefix =
          pre === null
            ? prefix
            : join(prefix, pre.type === 'scoped_identifier' ? pathText(pre) : pre.text);
        if (groupPrefix === undefined) return; // unrenderable prefix → silence
        const list = arg.childForFieldName('list');
        if (list !== null) {
          for (let i = 0; i < list.namedChildCount; i++) {
            const item = list.namedChild(i);
            if (item !== null) handleArgument(item, groupPrefix);
          }
        }
        return;
      }
      default:
        return;
    }
  };

  walk(file.tree.rootNode, (node) => {
    if (node.type === 'use_declaration') {
      const arg = node.childForFieldName('argument');
      if (arg !== null) handleArgument(arg, '');
      return false; // do not descend into the use tree again
    }

    // File-backed `mod foo;` (no body) → the submodule file, addressed as `self::foo`. A
    // `#[path]`-overridden mod is skipped (silence); an inline `mod foo { … }` (body present)
    // emits nothing here and is descended into so its own paths are caught.
    if (node.type === 'mod_item') {
      const body = node.childForFieldName('body');
      if (body === null && !modHasPathOverride(node)) {
        const name = node.childForFieldName('name');
        if (name !== null) emit(`self::${name.text}`, node);
      }
      return undefined;
    }

    // `extern crate name [as alias];` → the bare crate name (never `self`); the resolver
    // binds it only to an in-repo path dependency.
    if (node.type === 'extern_crate_declaration') {
      const name = node.childForFieldName('name');
      if (name !== null && name.type === 'identifier' && name.text !== 'self') emit(name.text, node);
      return false;
    }

    // Inline FQN in TYPE position — the outermost scoped_type_identifier carries the full path.
    if (node.type === 'scoped_type_identifier' && node.parent?.type !== 'scoped_type_identifier') {
      emitInline(scopedTypePathText(node), node);
      return undefined;
    }

    // Inline FQN in EXPRESSION position — the outermost scoped_identifier (a call/macro path,
    // an associated-fn path). Inner scoped_identifiers (incl. the `path` of a
    // scoped_type_identifier) have a scoped parent and are skipped.
    if (
      node.type === 'scoped_identifier' &&
      node.parent?.type !== 'scoped_identifier' &&
      node.parent?.type !== 'scoped_type_identifier'
    ) {
      emitInline(pathText(node), node);
      return undefined;
    }

    return undefined;
  });

  return out;
}

/** Join a `::`-module prefix with a tail. Empty prefix → the tail itself; undefined
 *  tail → undefined (propagates a resolution failure rather than guessing). */
function join(prefix: string, tail: string | undefined): string | undefined {
  if (tail === undefined) return undefined;
  if (prefix === '') return tail;
  return `${prefix}::${tail}`;
}

/**
 * Top-level declarations — a thin parity layer (Rust resolves dependencies by PATH
 * through the crate module tree, not by a symbol index, so a Rust SymbolTable is not
 * load-bearing). Emits the names of top-level item declarations:
 *   - `struct_item` / `enum_item` / `trait_item` / `function_item` / `mod_item`
 *     (each carries field `name`).
 * Only top-level items (direct children of the file root) are emitted — items nested
 * inside an inline `mod { … }` are same-file detail, not the node's public surface.
 */
function declarations(file: ParsedFile): DeclaredSymbol[] {
  const out: DeclaredSymbol[] = [];
  const root = file.tree.rootNode;
  for (let i = 0; i < root.namedChildCount; i++) {
    const node = root.namedChild(i);
    if (node === null) continue;
    if (
      node.type === 'struct_item' ||
      node.type === 'enum_item' ||
      node.type === 'trait_item' ||
      node.type === 'function_item' ||
      node.type === 'mod_item'
    ) {
      const nameNode = node.childForFieldName('name');
      if (nameNode !== null) {
        out.push({ symbolKey: nameNode.text, line: node.startPosition.row + 1 });
      }
    }
  }
  return out;
}

export const rustExtractor: DependencyExtractor = {
  languages: new Set(['rust']),
  rev: 2,
  declarations,
  uses,
};
