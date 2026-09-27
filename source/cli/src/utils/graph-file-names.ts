/**
 * The two committed graph files a change can edit that reach the whole graph —
 * the architecture and the configuration — spelled REPO-RELATIVE, with the
 * graph directory in front, exactly as a change's touched-file set spells them.
 *
 * One spelling, imported by everything that intersects a touched set with them:
 * the burn table that decides when a change reaches everything
 * (core/progressive-scope.ts), the code-to-fixed-input map of the check's code
 * taxonomy (utils/check-codes.ts), and the change-scope measurement that reads
 * them at the reference. A hand-spelled copy silently never matches — both were
 * once written bare (`yg-config.yaml`) and could not have matched anything.
 * They live in the utility layer because every one of those callers may call
 * it, while the code taxonomy may not call the engine.
 */
export const ARCHITECTURE_FILE = '.yggdrasil/yg-architecture.yaml';
export const CONFIG_FILE = '.yggdrasil/yg-config.yaml';
