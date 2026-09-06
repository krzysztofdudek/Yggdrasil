// Trivial deterministic check: always satisfied. The point of this aspect in
// the fixture is to exercise the channel-6 port contract (provider declares it
// on a port, consumer inherits it via consumes) — not to flag any code. It is
// language-agnostic and never reads file content, so the happy path is clean.
export function check(ctx) {
  void ctx;
  return [];
}
