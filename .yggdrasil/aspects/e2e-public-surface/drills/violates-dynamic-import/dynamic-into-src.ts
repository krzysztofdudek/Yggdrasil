// DRILL — expected verdict: REFUSED (1 violation).
// A dynamic import() that resolves into the CLI internal source tree is caught
// exactly like a static import — the rule inspects the string argument of
// import()/require() calls, not just top-level import statements.
export async function loadExtractor(): Promise<unknown> {
  const mod = await import('../../../../../source/cli/src/portal/extract.js');
  return mod;
}
