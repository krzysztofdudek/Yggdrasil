// Trivial deterministic check — this fixture exists to exercise a git-level
// lock merge of committed LLM verdicts (see svc-review/), not this rule's
// own content, so it always passes.
export function check(_ctx) {
  return [];
}
