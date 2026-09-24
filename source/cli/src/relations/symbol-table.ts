export class SymbolTable {
  private readonly defs = new Map<string, Set<string>>(); // `${language}\0${symbolKey}` → set of defining files
  private readonly nestedTails = new Set<string>(); // `${language}\0${lastSegment}` of every `A::B`-style key
  private key(language: string, symbolKey: string): string {
    return `${language}\0${symbolKey}`;
  }
  declare(language: string, symbolKey: string, file: string): void {
    const k = this.key(language, symbolKey);
    let s = this.defs.get(k);
    if (!s) { s = new Set(); this.defs.set(k, s); }
    s.add(file);
    const sep = symbolKey.lastIndexOf('::');
    if (sep !== -1) this.nestedTails.add(this.key(language, symbolKey.slice(sep + 2)));
  }
  /** True when some `::`-qualified key ends in the segment `name` (e.g. `Admin::Order` for
   *  `Order`): a constant of that name is nested in some namespace. Ruby's lexical guard. */
  hasNestedTail(language: string, name: string): boolean {
    return this.nestedTails.has(this.key(language, name));
  }
  /** Exactly one same-language definition → that file; zero or 2+ (ambiguous, incl. off-graph) → undefined. */
  resolveUnique(language: string, symbolKey: string): string | undefined {
    const s = this.defs.get(this.key(language, symbolKey));
    if (!s || s.size !== 1) return undefined;
    return [...s][0];
  }
  /** Number of distinct files declaring `symbolKey` in `language` (0 = absent, ≥2 = ambiguous).
   *  Lets the tri-state resolver tell an ambiguous candidate (≥2) from an absent one (0) —
   *  a distinction `resolveUnique` collapses to undefined. */
  defCount(language: string, symbolKey: string): number {
    return this.defs.get(this.key(language, symbolKey))?.size ?? 0;
  }
  /** True when at least one definition exists (the declared-type guard; ≥1 def). */
  has(language: string, symbolKey: string): boolean {
    return this.defCount(language, symbolKey) > 0;
  }
  /** Every distinct file declaring `symbolKey` in `language` (empty when absent). Unlike
   *  `resolveUnique` it does NOT collapse a multi-def key to undefined — the resolver's
   *  set-level nested-split rule needs the full file set to count distinct files across the
   *  verbatim key plus its guarded `+`-splits (≥2 distinct files anywhere → ambiguous). */
  filesFor(language: string, symbolKey: string): string[] {
    const s = this.defs.get(this.key(language, symbolKey));
    return s ? [...s] : [];
  }
}
