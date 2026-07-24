<!-- yggdrasil:start -->
<!-- yggdrasil:digest cli=5.5.1 sha256=a94d3f23a66367520d042063e75e36f6ef1ad1ab5d131592f5f34160912c506f -->
## Yggdrasil

This repository is managed by Yggdrasil — continuous architecture enforcement.
An architecture graph in `.yggdrasil/` defines the rules; a reviewer verifies
source code against them, and `yg check` blocks CI whenever an enforced rule
is violated or unverified.

**Required first step:** run `yg prime` and follow the protocol it prints
before making any change. The full, current operating manual comes from the
installed CLI — this block is only the standing summary. If `yg prime` is not
a recognized command, the installed Yggdrasil CLI predates this integration:
update the `@chrisdudek/yg` package before proceeding.

Non-negotiable invariants (they hold even before reading the manual):

- Never write a `yg-suppress` marker without the user's explicit
  confirmation. The reviewer honors suppressions unconditionally — an
  unauthorized suppress silently disables a rule.
- Never change a rule's `review_by:` date; renewing or retiring a rule is
  the user's decision.
- Treat `yg advise` items and incidents as proposals: dismissing, deferring,
  or recording one requires the user's approval. Never fabricate an incident.
- Changes to `.yggdrasil/yg-architecture.yaml` require the user's
  confirmation.
- Log entries (`yg log add`) carry WHY in self-contained prose — no
  references to plans, file paths, steps, or conversation state.
- Never hand-edit `.yggdrasil/` lock files.
- If the user explicitly requests a code-only change without graph updates,
  comply but warn: the affected rules stay unverified and CI stays red. Do
  not run `yg check --approve` — leave the rules unverified.

Start every session with `yg check`; re-print the manual any time with
`yg prime`.
<!-- yggdrasil:end -->
