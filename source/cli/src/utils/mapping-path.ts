import { minimatch } from 'minimatch';

/**
 * Canonical mapping-path normalizer shared by the structure fs-gate, the
 * structure file-in-context check, and io/paths mapping expansion. One
 * function so the allowed-reads set and membership tests agree byte-for-byte.
 *
 * Order matters: trim first (strip operator-typed whitespace), then convert
 * backslashes, then strip a single leading './', then strip trailing slashes.
 * A leading './' is a no-op prefix that callers sometimes emit; stripping it
 * keeps './src/a.ts' and 'src/a.ts' in the same equivalence class.
 */
export function normalizeMappingPath(p: string): string {
  return p
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

/**
 * True if a mapping/when path entry is a glob — i.e. contains a `*` wildcard
 * (`*` matches within a path segment, `**` across segments).
 *
 * ONLY `*` triggers glob interpretation. Other minimatch metacharacters
 * (`?`, `[ ]`, `{ }`) are treated as literal path characters, so a file whose
 * real name contains them — e.g. a Next.js / SvelteKit route like
 * `app/[id]/page.tsx` — maps literally instead of being misread as a pattern
 * (and `normalizeMappingPath` strips backslashes, so such names could not be
 * escaped anyway). A `*`-glob that also contains `[ ]` / `{ }` still has them
 * interpreted by minimatch — opting into glob via `*` opts into the rest.
 */
export function isGlobPattern(entry: string): boolean {
  return entry.includes('*');
}

/**
 * The single glob-matching primitive for the whole CLI — the ONLY site that
 * calls minimatch. Every glob match (node mapping, coverage roots, architecture
 * when.path, the AST file-pattern DSL) routes through here so glob semantics
 * live in exactly one place. `{ dot: true }` so a leading-dot segment matches
 * like any other. This primitive matches the given strings verbatim; callers
 * that need normalization apply it first.
 *
 * Enforced by the deterministic aspect `no-direct-minimatch`: no other source
 * file may import minimatch.
 */
export function globMatch(file: string, pattern: string): boolean {
  return minimatch(file, pattern, { dot: true });
}

/**
 * Does a mapping ENTRY match a repo-relative FILE path?
 *
 * - Glob entry (contains glob metachars): segment-aware glob via globMatch —
 *   the same semantics as architecture when.path (`*` does not cross `/`, `**`
 *   does).
 * - Plain entry: exact file match OR directory-prefix (entry/...), exactly as
 *   before.
 *
 * Both args are normalized via normalizeMappingPath first.
 */
export function mappingEntryMatchesFile(entry: string, file: string): boolean {
  const e = normalizeMappingPath(entry);
  const f = normalizeMappingPath(file);
  if (e === '') return false;
  if (isGlobPattern(e)) return globMatch(f, e);
  return f === e || f.startsWith(e + '/');
}

/**
 * The SINGLE owner-selection rule shared by every file→owning-node resolver
 * (the live relation-conformance owner index, the blast-radius reverse map, and
 * the GC detachment proof). Given two candidate mappings that both match a file,
 * returns true when `candidate` should win over `current`:
 *
 *   1. Longer mapping string wins — a more specific mapping owns the file.
 *   2. On a mapping-length tie, the DEEPER node wins ("child wins"): a node
 *      nested under another (a strictly longer hierarchy path) is the more
 *      specific owner, matching the graph's documented single-ownership /
 *      child-carve-out model (getChildMappingExclusions).
 *   3. On a full tie (same length, same depth — an unrelated overlap the
 *      overlap validator flags), fall back to lexicographic node path so every
 *      resolver agrees deterministically instead of on Map-iteration order.
 *
 * Keeping this in one place is what stops the three resolvers from silently
 * disagreeing on a tie (which produced a live false positive on the built-in
 * relation-conformance gate).
 */
export function isBetterMappingOwner(
  candidate: { nodePath: string; mappingLen: number },
  current: { nodePath: string; mappingLen: number },
): boolean {
  if (candidate.mappingLen !== current.mappingLen) return candidate.mappingLen > current.mappingLen;
  const candDepth = candidate.nodePath.split('/').length;
  const curDepth = current.nodePath.split('/').length;
  if (candDepth !== curDepth) return candDepth > curDepth;
  return candidate.nodePath < current.nodePath;
}
