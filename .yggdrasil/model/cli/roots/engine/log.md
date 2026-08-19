## [2026-08-19T09:24:17.702Z]
Lands the roots engine's config seam: config.ts exports rootsConfigHash, a pure sha256-of-canonical-JSON fold over the parsed roots config subtree. Parsing itself stays in the parser-adapter layer (io/config-parser.ts) since engine-layer code may not call ConfigParseError's home module or buildIssueMessage; this file only hashes the already-parsed result.
## [2026-08-19T11:32:18.710Z]
Added binding.ts: spec §6.2's binding derivation (deriveBinding) computing a grammar's scope/import/decorator node-type sets and heritage pattern purely from its already-parsed node-types.json, plus bindingHash and the two extraction-time helpers (the lexical @/[ decoration marker, the decoration attribution window) a later extraction module will consume rather than re-derive.
