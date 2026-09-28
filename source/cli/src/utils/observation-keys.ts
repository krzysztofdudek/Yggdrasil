/**
 * source/cli/src/utils/observation-keys.ts — the pure half of the observation
 * contract (spec §3.1), part of the FROZEN pair-hash contract.
 *
 * A deterministic check's reads are folded into its pair hash as observations:
 * one `[key, value]` pair per thing it read. This module builds both halves —
 * the key (`<kind>:<target>`) and the canonical text or bytes each value is the
 * digest of — without hashing anything itself. The digest is injected by the
 * caller as a {@link ContentHasher}: the verdict path passes io/hash.ts's sha256
 * helpers, so the structure runtime that records observations and the engine
 * that re-observes them build byte-identical values from one definition while
 * neither reaches into the other's layer.
 *
 * BREAKING: changing a key's spelling, a canonical text, or the digest a caller
 * injects changes every deterministic hash that carries the observation and
 * invalidates those stored verdicts. Golden tests in pair-hash.test.ts pin the
 * output.
 */

/**
 * The observation kinds a check's ctx read boundary records.
 *
 *   read / list / exists — file/dir content + existence probes (target: repo-relative POSIX path)
 *   graph                — a single node's yg-node.yaml bytes (or absent) (target: node path)
 *   graph-children       — the SET of child node ids of <target> (membership fold)
 *   graph-bytype         — the SET of node ids of type <target> (membership fold)
 *   graph-flow           — the SET of declared participant ids of flow <target>
 *   config               — the VALUE of the configuration key <target> the rule read
 *   node-files           — the SET of paths `ctx.node.files` of node <target> was built from
 *   graph-files          — the SET of paths `.files` of node <target>, reached through
 *                          ctx.graph, was built from
 *   grammar              — the grammar + runtime identity of a language id's syntax tree
 *
 * `config` was added when a rule gained settings a repository can adapt. It does
 * NOT invalidate a single stored verdict: no entry written before it exists can
 * carry a key with this prefix, so every such entry's `touched` set — and
 * therefore its hash — is byte-for-byte what it was. The only pairs it can move
 * are ones recorded after a rule started reading configuration at all.
 *
 * `node-files` and `graph-files` were added because a check can decide from a
 * node's file NAMES alone — walking a file list and reading only each `.path` —
 * and then no content observation and no subject hash carries the list itself: a
 * file joining the node without becoming this pair's subject left the verdict
 * standing. They are two kinds, not one, because the two lists differ for the
 * same node (`ctx.node.files` drops files a descendant node owns and binary
 * files; a node reached through ctx.graph drops neither), so one key per node
 * would record two values in a check that reads both. Like `config`, they move
 * no stored verdict: an entry written before them carries neither prefix.
 *
 * `grammar` (target: a registry language id) was added so a verdict that read a
 * syntax tree is keyed on the grammar and runtime that built it: the value is
 * ast/parser.ts grammarDigest (grammar wasm + web-tree-sitter wasm). Recorded when
 * a check is handed a tree (a file's `.ast`, ctx.parseAst, the nodeless subject)
 * or when its suppression scan reads one, so a grammar upgrade re-opens those
 * verdicts and no others.
 */
export type ObservationKind =
  | 'read' | 'list' | 'exists' | 'graph' | 'graph-children' | 'graph-bytype' | 'graph-flow' | 'config'
  | 'node-files' | 'graph-files' | 'grammar';

/**
 * Encode an observation key: `<kind>:<target>`. Key encoding is part of the
 * frozen contract — changing it changes all deterministic hashes that include
 * observations.
 */
export function observationKey(kind: ObservationKind, target: string): string {
  return `${kind}:${target}`;
}

/**
 * Sentinel value for a re-observation whose target vanished (a deleted file, dir,
 * or absent graph node). It is NOT a valid 64-hex sha256, so it can never equal a
 * stored content hash — a now-missing target therefore always reads as a CHANGED
 * value (⇒ unverified) and never collides with a genuinely-empty stored
 * observation. The recorder uses it to fold a NEGATIVE graph-node probe
 * (ctx.graph.node() returning undefined) and the verifier uses it for every
 * vanished re-observation, so the two sides stay byte-identical for an
 * absent-then-still-absent target (spec §3.1: missing during re-observation =
 * changed value, never a throw). Part of the FROZEN CONTRACT.
 */
export const MISSING_OBSERVATION = 'missing';

/**
 * Serialize any JSON-representable value to a canonical JSON string where
 * object keys are sorted in Unicode code-point order (never localeCompare —
 * localeCompare is environment-sensitive and therefore banned from any path
 * that contributes to a stored hash).
 *
 * Rules:
 *   - null and primitives: standard JSON.stringify
 *   - arrays: elements in their existing order (callers sort before passing)
 *   - objects: keys sorted by code-point, undefined values omitted
 *
 * Notes for callers:
 *   (a) Key ordering is UTF-16 code-unit order (standard JS string comparison).
 *       Astral-plane keys (code points > U+FFFF) are out of scope — all real
 *       keys in this codebase are ASCII.
 *   (b) Callers must pass finite numbers only — NaN and Infinity stringify to
 *       null in JSON.stringify and will silently produce the wrong hash.
 *   (c) undefined values are dropped from objects; array elements must never
 *       be undefined (JSON.stringify converts them to null, breaking the hash).
 */
export function codePointCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(codePointCanonicalJson).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  // Code-point sort: String.prototype.localeCompare is NEVER used here.
  // The standard < / > comparator on strings is code-point order for BMP chars.
  const entries = Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${codePointCanonicalJson(v)}`).join(',')}}`;
}

/** The digest the caller injects: one for a canonical text, one for raw bytes. */
export interface ContentHasher {
  /** Digest of a canonical text built here. */
  text(content: string): string;
  /** Digest of bytes a check read (a file's content, a node's yg-node.yaml). */
  bytes(content: Buffer): string;
}

/** The value of every observation kind, computed through an injected {@link ContentHasher}. */
export interface ObservationHashes {
  /** A file read (or a graph node's yg-node.yaml): the digest of the raw bytes. */
  read(bytes: Buffer): string;
  /**
   * A directory listing: the digest of the sorted `name:kind` lines
   * (newline-joined), so readdir order never matters while a rename or a
   * dir-to-file swap does. Golden-pinned in pair-hash-golden.json.
   */
  list(entries: Array<{ name: string; kind: 'file' | 'dir' }>): string;
  /**
   * An existence probe: the three outcomes ('file', 'dir', false) as distinct
   * tokens, so a file renamed to a directory changes the value.
   */
  exists(result: 'file' | 'dir' | false): string;
  /**
   * A node-id SET (ctx.graph.children / nodesByType / a flow's participants):
   * the digest of the code-point-sorted ids joined by newline. Membership only
   * — a content edit to an unchanged member rides its own graph: observation.
   * An empty set folds to the digest of '' — distinct from MISSING_OBSERVATION.
   */
  nodeSet(nodeIds: string[]): string;
  /**
   * A file-list SET (`node-files:` / `graph-files:`): the digest of the
   * deduplicated, code-point-sorted paths joined by newline. Membership only —
   * never order, content, or how often a path was listed. An empty list folds to
   * the digest of '' — distinct from MISSING_OBSERVATION. Golden-pinned in
   * pair-hash.test.ts.
   */
  fileSet(paths: string[]): string;
  /**
   * A configuration value the rule read: the digest of its canonical JSON, so
   * `1` and `"1"` are different observations. A key nothing declares
   * (`undefined`) folds MISSING_OBSERVATION, so the key later appearing is a
   * change and can never be confused with a real value.
   */
  config(value: unknown): string;
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Bind the observation contract to a digest. Pure: every canonical text is
 * built here, and the only hashing is the injected `hasher`'s.
 */
export function observationHashes(hasher: ContentHasher): ObservationHashes {
  return {
    read: (bytes) => hasher.bytes(bytes),
    list: (entries) =>
      hasher.text(
        [...entries]
          .sort((a, b) => byCodePoint(a.name, b.name))
          .map((e) => `${e.name}:${e.kind}`)
          .join('\n'),
      ),
    exists: (result) => hasher.text(result === false ? 'false' : result),
    nodeSet: (nodeIds) => hasher.text([...nodeIds].sort(byCodePoint).join('\n')),
    fileSet: (paths) => hasher.text([...new Set(paths)].sort(byCodePoint).join('\n')),
    config: (value) => (value === undefined ? MISSING_OBSERVATION : hasher.text(codePointCanonicalJson(value))),
  };
}
