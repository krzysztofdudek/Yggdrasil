import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { debugWrite } from '../utils/debug-log.js';
import type { RulesArtifacts } from '../core/checks/digest-gate.js';
import { digestSha256 } from '../templates/digest.js';
import { resolveCaseVariant } from '../templates/platform.js';
import { AGENTS_FILENAME, CLAUDE_FILENAME, CLINERULES_DIR, CLINERULES_FILENAME } from '../utils/rules-artifact-names.js';

/**
 * The BOUNDARY reader for the committed-digest staleness gate — the single
 * place the three rules-distribution artifacts are snapshotted off disk.
 *
 * It lives here, in shared command-layer support, rather than inside the `yg
 * check` command file, because there are TWO boundaries that must inject the
 * same snapshot into `runCheck`: the CLI (`cli/check.ts`) and the portal's
 * engine facade (`portal/engine-api.ts`). Core receives only the resulting
 * strings and skips the gate entirely when the snapshot is absent, so a
 * boundary that forgets to read shows the user a repo with NO digest warning
 * while the other boundary shows one — the portal silently greener than the
 * command line, over the very drift this gate exists to surface. One reader,
 * used by both, makes that divergence impossible to reintroduce by omission.
 *
 * A missing file reads as `null`, never throws: the gate itself decides what an
 * absence means (`.clinerules/yggdrasil.md` absent is a finding; a read that
 * fails for any OTHER reason is an operational problem, not a graph finding).
 *
 * AGENTS.md and CLAUDE.md are resolved through the INSTALLER'S OWN
 * case-variant resolver, not by their canonical spelling: `yg init` reuses an
 * existing `Agents.md` / `Claude.md` and writes the block there. On a
 * case-sensitive filesystem, reading the hardcoded name in such a repo returns
 * nothing, and the gate would report a correctly-installed repo's digest block
 * as missing — a warning `yg init --upgrade` can never clear, since the
 * installer would keep writing to the variant the reader ignores. Reader and
 * writer share one resolver so they cannot disagree.
 * (`.clinerules/yggdrasil.md` is wholly ours and always written at that exact
 * path, so it needs no resolution.)
 */
export async function readRulesArtifacts(projectRoot: string): Promise<RulesArtifacts> {
  const readAbs = async (abs: string): Promise<string | null> => {
    try {
      return await readFile(abs, 'utf-8');
    } catch (error) {
      // A file that simply does not exist is the NORMAL state for an optional
      // artifact (a repo with no `.clinerules/` directory, or one whose
      // universal install was never run) — the gate already reports that as a
      // "missing" finding, so a debug line here would be pure noise on the
      // common path. Every OTHER failure (permissions, a directory in place of
      // the file, an I/O error) is indistinguishable from absence in the
      // returned value, so it is recorded: without it, an unreadable-but-present
      // AGENTS.md looks exactly like one that was never installed.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        debugWrite(`[check] readRulesArtifacts: ${abs}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return null;
    }
  };
  const readVariant = async (name: string): Promise<string | null> =>
    readAbs(await resolveCaseVariant(projectRoot, name));
  return {
    agentsMd: await readVariant(AGENTS_FILENAME),
    claudeMd: await readVariant(CLAUDE_FILENAME),
    clinerules: await readAbs(path.join(projectRoot, CLINERULES_DIR, CLINERULES_FILENAME)),
    canonicalDigestHash: digestSha256(),
  };
}
