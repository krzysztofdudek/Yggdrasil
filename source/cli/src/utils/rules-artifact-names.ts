/**
 * Yggdrasil-installed artifact names — the SINGLE source for the three names
 * `yg init` writes into (and reads back from) an adopter's repository: the
 * digest-block host file (AGENTS.md), the file that imports it (CLAUDE.md),
 * and the standalone Cline-native copy (.clinerules/yggdrasil.md).
 *
 * WHY it lives here rather than beside any one consumer: the installer that
 * WRITES these names is a `template` module (templates/platform.ts), the
 * boundary reader that feeds the committed-digest drift check is a
 * `command-support` module (cli/rules-artifacts.ts), and the check that
 * LABELS findings with them is an `engine` module (core/checks/digest-gate.ts).
 * None of those three node types may import one another (an `engine` module
 * may not depend on a `template` one, nor may either depend on the CLI-layer
 * reader), but all three may call `utility`. Keeping ONE copy of the names is
 * the point: the reader once looked for the literal `AGENTS.md` while the
 * writer resolved case variants (writing to `Agents.md` when that is what a
 * repository already had) — a repository whose file happened to be
 * `Agents.md` was reported as having no rules installed at all, a warning
 * `yg init --upgrade` could never clear, because the two sides typed the same
 * name out independently and drifted. This is the same fix already applied to
 * the marker-block scanner (see `utils/marker-block.ts`) for the same reason.
 *
 * Pure string constants only: no fs, no side effects on import.
 */

/**
 * Canonical spelling of the digest-block host file `yg init` writes to and
 * `yg check` reads from. A repository whose file is differently-cased (e.g.
 * `Agents.md`) is resolved separately — see `resolveCaseVariant` in
 * `templates/platform.ts`, which both the writer and the reader share.
 */
export const AGENTS_FILENAME = 'AGENTS.md';

/**
 * Canonical spelling of the file that imports the digest-block host. Case
 * variants are resolved the same way as `AGENTS_FILENAME`.
 */
export const CLAUDE_FILENAME = 'CLAUDE.md';

/** Directory holding the standalone Cline-native copy of the digest body. */
export const CLINERULES_DIR = '.clinerules';

/** Filename of the standalone Cline-native copy, inside `CLINERULES_DIR`. */
export const CLINERULES_FILENAME = 'yggdrasil.md';

/**
 * POSIX-style relative path to the standalone copy — a human-facing LABEL
 * only (finding text, docs). For filesystem I/O, join `CLINERULES_DIR` and
 * `CLINERULES_FILENAME` instead; this constant is never itself read or
 * written.
 */
export const CLINERULES_RELATIVE_PATH = `${CLINERULES_DIR}/${CLINERULES_FILENAME}`;

/**
 * Lowercased `@AGENTS.md`-style import-line spelling, for case-insensitive
 * matching of the CLAUDE.md import line the installer writes (a repository
 * whose host file is `Agents.md` writes `@Agents.md`, which is the same
 * commitment as `@AGENTS.md`).
 */
export const AGENTS_IMPORT_LINE_LOWER = `@${AGENTS_FILENAME.toLowerCase()}`;
