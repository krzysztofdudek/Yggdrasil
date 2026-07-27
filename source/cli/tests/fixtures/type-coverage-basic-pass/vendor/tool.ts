// Lattice row: EXCLUDED-ROOT MATCH (by absence, not a false positive — this
// file matches no declared type at all). It sits under vendor/, a
// coverage.excluded root, so the excluded-mute rule skips it entirely before
// classification: it counts toward the check header's "node-owned" bucket
// (today's coveredFiles metric) without ever entering an issue.
module.exports = { tool: true };
