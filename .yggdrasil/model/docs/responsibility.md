# Docs — Responsibility

This node represents the public-facing documentation of Yggdrasil, targeting adopters: developers and teams who want to understand, install, and use Yggdrasil in their own repositories.

## Responsible for

- Guiding new adopters through installation and first-use (`getting-started.md`)
- Explaining the CLI command reference (`cli-reference.md`)
- Describing configuration options (`configuration.md`)
- Listing supported platforms and agents (`platforms.md`)
- Serving as the documentation entry point (`index.md`)

## Not responsible for

- Specifying the internal logical model, algorithms, or design decisions — that belongs to `docs/idea/`
- Describing the semantic graph structure used in this repository — that belongs to `.yggdrasil/`
- Implementation details of the CLI — those live in `source/cli/`

## Audience and quality bar

The primary audience is an adopter: someone who has never seen Yggdrasil before and needs to become productive quickly. Content here must be clear, approachable, and task-oriented. Completeness is secondary to clarity — it is acceptable to simplify or omit edge cases if that makes adoption smoother.
