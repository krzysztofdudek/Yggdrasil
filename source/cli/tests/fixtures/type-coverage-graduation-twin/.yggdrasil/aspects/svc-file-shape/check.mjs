// Trivial deterministic check — this fixture exists to exercise graduation
// (a type-covered file's transition to an explicit node), not this rule's
// own content, so it always passes.
export function check(_ctx) {
  return [];
}
