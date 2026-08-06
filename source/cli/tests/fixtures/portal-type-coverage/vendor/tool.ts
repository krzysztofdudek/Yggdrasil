// Matches no declared type at all, and sits under vendor/, a
// coverage.excluded root — the excluded-mute rule skips it entirely before
// classification: it counts toward the "excluded" term, never "node-owned"
// or "type-covered", without ever entering an issue.
export const tool = true;
