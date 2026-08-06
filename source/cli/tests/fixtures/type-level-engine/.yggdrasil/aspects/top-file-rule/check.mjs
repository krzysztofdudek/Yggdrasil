// Trivial deterministic check — the type-effective engine is a pure graph
// computation that never executes a reviewer, so this file exists only to
// make the aspect a real, loadable deterministic rule rather than a
// content-less stub.
export function check(_ctx) {
  return [];
}
