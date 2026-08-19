## [2026-08-19T09:24:17.702Z]
Lands the roots engine's config seam: config.ts exports rootsConfigHash, a pure sha256-of-canonical-JSON fold over the parsed roots config subtree. Parsing itself stays in the parser-adapter layer (io/config-parser.ts) since engine-layer code may not call ConfigParseError's home module or buildIssueMessage; this file only hashes the already-parsed result.
