// Lattice row: EXCLUDED-ROOT MATCH. Matches `util` (its any_of's third clause
// names this exact file) but sits under vendor/, a coverage.excluded root —
// the excluded-mute rule skips it ENTIRELY before classification, so it must
// appear in no issue at all despite the match.
module.exports = { tool: true };
