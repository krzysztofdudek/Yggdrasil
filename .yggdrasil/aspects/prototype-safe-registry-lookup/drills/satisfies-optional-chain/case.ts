// Optional chaining onto a data property degrades an inherited value to
// undefined, which is the "not found" behaviour the caller expects — provably
// safe, so this shape must NOT be flagged. Must pass.
interface Def {
  extensions: string[];
}

const REGISTRY: Record<string, Def> = {
  ts: { extensions: ['.ts'] },
};

export function extensionsFor(lang: string): string[] {
  return REGISTRY[lang]?.extensions ?? [];
}
