/**
 * source/cli/src/cli/roots.ts — `yg roots index` and `yg roots status`, the
 * two commands R1-R3 ships (design §3, `integration-design.md:74-75`: naming
 * uses Yggdrasil's own vocabulary — index, like a build — not the prototype's
 * `learn`; `check`/`where`/`spectrum`/`report`/… are later packages). This is
 * the ONLY file that composes the roots engine (`src/roots/**`) with the
 * roots store (`src/roots/stores.ts`) — Task 1's seam: engine never imports
 * the store, so seeds/config/header assembly all happen here.
 *
 * CONFIG-ONLY LOAD (plan invariant I10): both commands compose
 * `findYggRoot` (`io/paths.ts`) + `parseConfig` (`io/config-parser.ts`)
 * directly and NEVER call `loadGraphOrAbort` / `loadGraph`. Mining touches no
 * graph — a repo with a `.yggdrasil/yg-config.yaml` and nothing else (no
 * `model/`, no aspects) is a complete, valid target for `index`. This does
 * NOT inline its own missing-graph guard: `index`'s one case where
 * `findYggRoot`'s walk-up search finds no `.yggdrasil/` anywhere delegates to
 * the shared `abortUnlessYggdrasilExists` helper (`cli/preamble.ts`) — the
 * SAME helper `init --upgrade`'s own missing-graph guard delegates to, and
 * for the same reason (`cli-command-contract`): that helper owns the
 * canonical missing-graph string and the `exit(1)`, so neither command
 * inlines it or an ENOENT-shaped branch itself. `status` never gates a
 * build, so it has no missing-graph guard to delegate at all — a missing
 * `.yggdrasil/` is just one more honest, read-only state it reports.
 */

import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import type { Command } from 'commander';
import chalk from 'chalk';
import { findYggRoot, projectRootFromGraph } from '../io/paths.js';
import { parseConfig, ConfigParseError } from '../io/config-parser.js';
import { readFileOrDefault } from '../io/read-or-default.js';
import { hashString } from '../io/hash.js';
import {
  hashStoreFile,
  readSeeds,
  writeModel,
  readModel,
  rootsStoreDir,
  ROOTS_VERSION,
  SEEDS_FILENAME,
  DECISIONS_FILENAME,
  LEDGER_FILENAME,
  type RootsModel,
  type RootsModelHeader,
} from '../roots/stores.js';
import { rootsConfigHash } from '../roots/config.js';
import { runRootsIndex } from '../roots/pipeline.js';
import { isMinedModel } from '../roots/mine.js';
import type { YggConfig } from '../model/graph.js';
import { getHeadSha, getHeadCommitterTimestamp, getDirtyFiles } from '../utils/git.js';
import { toPosixPath } from '../utils/posix.js';
import { debugWrite } from '../utils/debug-log.js';
import { buildIssueMessage, type IssueMessage } from '../formatters/message-builder.js';
import { abortOnUnexpectedError, abortUnlessYggdrasilExists } from './preamble.js';

/** Emit a blocking what/why/next error to stderr and exit(1) — nothing is written. `never`-typed so a caller can `return failWith(...)` and keep its own return type. */
function failWith(msg: IssueMessage): never {
  process.stderr.write(chalk.red(`Error: ${buildIssueMessage(msg)}`) + '\n');
  process.exit(1);
}

function handleError(error: unknown): never {
  debugWrite(`[roots] command failed: ${(error as Error).message}`);
  abortOnUnexpectedError(error, 'running roots command');
}

/**
 * `findYggRoot`'s walk-up search for the nearest `.yggdrasil/` (so `index`,
 * like every other command, works from any subdirectory of the project) —
 * or the canonical what/why/next missing-graph error and `exit(1)`, OWNED by
 * the shared `abortUnlessYggdrasilExists` helper (`cli/preamble.ts`), never
 * inlined here (`cli-command-contract`: "commands must never inline that
 * string themselves"). This is the exact delegation shape `init --upgrade`'s
 * own missing-graph guard uses. By the time `findYggRoot` has walked from
 * `process.cwd()` all the way to the filesystem root without finding a
 * `.yggdrasil/` anywhere, `process.cwd()/.yggdrasil` — the very first
 * candidate `findYggRoot` itself checks — is guaranteed absent too, so the
 * helper's own `stat` always confirms that and always calls `exit(1)`; it
 * never returns on this path (`abortUnlessYggdrasilExists` only `stat`s a
 * directory — it never loads the graph, so I10 still holds).
 */
async function findYggRootOrFail(): Promise<string> {
  try {
    return await findYggRoot(process.cwd());
  } catch (err) {
    debugWrite(`[roots] index: no .yggdrasil/ found from ${process.cwd()}: ${(err as Error).message}`);
    await abortUnlessYggdrasilExists(path.join(process.cwd(), '.yggdrasil'), {
      why: '`yg roots index` reads and writes convention-mining state under .yggdrasil/, which requires an initialized graph at the project root.',
      next: "Run 'yg init' to bootstrap the graph, then re-run this command.",
    });
    // Unreachable: abortUnlessYggdrasilExists exits(1) on the only path that
    // reaches here (see doc comment above) — this only satisfies the
    // Promise<string> return type for the type checker.
    throw new Error('unreachable: abortUnlessYggdrasilExists should have exited', { cause: err });
  }
}

/** `parseConfig`, or the parser's own structured error and exit(1). Any OTHER error (a genuine I/O fault) is rethrown for the caller's catch-all. */
async function parseConfigOrFail(configPath: string): Promise<YggConfig> {
  try {
    return await parseConfig(configPath);
  } catch (err) {
    if (err instanceof ConfigParseError) {
      debugWrite(`[roots] index: yg-config.yaml parse failed: ${err.message}`);
      return failWith(err.messageData);
    }
    throw err;
  }
}

const ROOTS_SCAFFOLD_MESSAGE =
  'No `roots:` block found in .yggdrasil/yg-config.yaml — adding it with default settings.\n';

/**
 * Add an empty `roots: {}` block to the committed `yg-config.yaml`, leaving
 * every other key (and every comment) untouched — design
 * `integration-design.md:399-400`: "`yg roots index` on a repo without the
 * block scaffolds it with defaults, printed first." An empty mapping is
 * sufficient: `io/config-parser.ts`'s `parseRootsSection` fills every §4.5
 * key from its documented default the moment the block is merely PRESENT, so
 * writing `{}` and re-parsing is how the caller recovers the fully-defaulted
 * `RootsConfig` — no duplicated default table lives here.
 *
 * Follows the `writeReviewerConfig` precedent (`init-reviewer-setup.ts:263-
 * 301`) in spirit — read the committed file, merge in one new section, write
 * it back — but NOT in mechanism: that precedent round-trips through a plain
 * `yaml.parse`/`yaml.stringify` pair, which re-serializes the WHOLE document
 * and drops every comment in it (acceptable there, since `init` writes a
 * fresh `reviewer:` block on a config an adopter has rarely hand-annotated
 * yet). A `yg-config.yaml` `index` scaffolds into, by contrast, is routinely
 * an already-annotated, long-lived project file (this repository's own is a
 * working example) — silently deleting every comment in it on the FIRST run
 * of an unrelated command would be a surprising, unrecoverable side effect.
 * `yaml`'s `parseDocument`/`Document#set` CST-preserving API edits the
 * document in place instead: every existing key, value, and comment is
 * preserved (the YAML writer may re-space a flow collection's brackets, but
 * loses nothing), and only the new `roots: {}` mapping is appended.
 *
 * Idempotent by construction, not by an extra check here: the ONE call site
 * (`index`'s action, below) only ever invokes this when `config.roots` is
 * already `undefined`, so a project that already carries a `roots:` block
 * never reaches this function on a later run.
 */
export async function scaffoldRootsBlock(configPath: string): Promise<void> {
  const raw = await readFile(configPath, 'utf-8');
  const doc = parseDocument(raw);
  doc.set('roots', {});
  await writeFile(configPath, doc.toString(), 'utf-8');
}

/**
 * The roots model header's working-tree dirty-file content hash (spec
 * `v6-spec.md:80`, the field's ONLY definition): sha256 over the sorted
 * `relPath -> sha256(content)` map of every path {@link getDirtyFiles}
 * reports, with every path under `.yggdrasil/roots/**` EXCLUDED — `index`
 * itself writes that directory, so an unfiltered dirty list would make the
 * header churn on every run even when nothing the adopter touched actually
 * changed (this is exactly what the double-index byte-identity E2E case
 * catches if this exclusion ever regresses). A non-git repository ({@link
 * getDirtyFiles} returning `null`) folds to the hash of the EMPTY map — a
 * real, honest, non-null string (unlike `headSha`/`clock`/`lastIndexedSha`,
 * `dirtyHash`'s header field is never nullable), matching the "no dirty
 * files are knowable" fact for a repo with no git at all. A dirty path that
 * no longer exists on disk (a deletion `git status` reports) hashes as the
 * empty string, the same convention {@link hashStoreFile} uses for an absent
 * store file.
 */
export async function computeDirtyHash(yggRoot: string, repoRoot: string): Promise<string> {
  const dirty = getDirtyFiles(repoRoot) ?? [];
  const rootsRelDir = `${toPosixPath(path.relative(repoRoot, rootsStoreDir(yggRoot)))}/`;
  const filtered = dirty.filter((relPath) => !relPath.startsWith(rootsRelDir)).sort();

  const perFile: Record<string, string> = {};
  for (const relPath of filtered) {
    const content = await readFileOrDefault(path.join(repoRoot, relPath), '');
    perFile[relPath] = hashString(content);
  }
  return hashString(JSON.stringify(perFile, Object.keys(perFile).sort()));
}

/** Every already-computed piece {@link assembleRootsModelHeader} folds into one `RootsModelHeader` — split out so the ownership table's ASSEMBLY step (as opposed to each field's own computation) is a small, independently unit-testable mapping. */
export interface RootsHeaderInputs {
  configHash: string;
  seedsHash: string;
  decisionsHash: string;
  ledgerHash: string;
  headSha: string | null;
  clock: string | null;
  dirtyHash: string;
  bindingHash: string;
  candidateCountLog2: number;
}

/**
 * Assembles the roots model header from its already-computed inputs, per
 * Task 1's ownership table (`integration-design.md:140-142`): `rootsVersion`
 * is this store's own schema constant; `lastIndexedSha` is `null` in every
 * R1-R3 build (no resume state exists yet — a full re-induction every time);
 * `rolesStale` is `false` (R1-R3 always fully re-induces roles, so staleness
 * is knowable and honestly `false`, never an unknown `null`). Every other
 * field is copied straight from `inputs` — this function's only job is
 * naming which input fills which header slot, kept as its own small mapping
 * so a field getting swapped with another (e.g. `configHash` written where
 * `bindingHash` belongs) is a one-function bug with a one-function fix.
 */
export function assembleRootsModelHeader(inputs: RootsHeaderInputs): RootsModelHeader {
  return {
    rootsVersion: ROOTS_VERSION,
    headSha: inputs.headSha,
    lastIndexedSha: null,
    clock: inputs.clock,
    bindingHash: inputs.bindingHash,
    configHash: inputs.configHash,
    seedsHash: inputs.seedsHash,
    decisionsHash: inputs.decisionsHash,
    ledgerHash: inputs.ledgerHash,
    dirtyHash: inputs.dirtyHash,
    candidateCountLog2: inputs.candidateCountLog2,
    rolesStale: false,
  };
}

/**
 * `yg roots status`'s full report, as text — never throws, never signals
 * failure through its return value alone. Every state this repository can
 * genuinely be in (no project, unreadable config, dormant, configured but
 * never indexed, an unreadable or malformed committed model, or a real
 * indexed model) renders as its own honest, read-only paragraph; the
 * outermost catch is a last-resort safety net so a bug elsewhere in this
 * chain still reports SOMETHING rather than crashing the command — spec
 * `v6-spec.md:706` ("All read surfaces exit 0 by default") and design `:84`
 * (R7's `--exit-code` is the only gate-capable roots surface, and it is opt-
 * in, deliberately not shipped here): `status` on a dormant, unconfigured, or
 * even damaged repo is information, never a CI-gating failure.
 */
export async function renderRootsStatus(cwd: string): Promise<string> {
  try {
    return await renderRootsStatusInner(cwd);
  } catch (err) {
    debugWrite(`[roots] status failed unexpectedly: ${(err as Error).message}`);
    return `Roots: status could not be determined (${(err as Error).message}).\n`;
  }
}

async function renderRootsStatusInner(cwd: string): Promise<string> {
  let yggRoot: string;
  try {
    yggRoot = await findYggRoot(cwd);
  } catch (err) {
    debugWrite(`[roots] status: no .yggdrasil/ found from ${cwd}: ${(err as Error).message}`);
    // Deliberately NOT the canonical missing-graph string `abortUnlessYggdrasilExists`
    // owns (cli-command-contract) — `status` never gates a build, so this is
    // an honest read-only report, not the missing-graph refusal `index` uses.
    return (
      'Roots: this directory is not part of a Yggdrasil project, so there is nothing to report.\n' +
      "Run 'yg init' to bootstrap a project, then 'yg roots index' to start mining conventions.\n"
    );
  }

  const configPath = path.join(yggRoot, 'yg-config.yaml');
  let config: YggConfig;
  try {
    config = await parseConfig(configPath);
  } catch (err) {
    const message = err instanceof ConfigParseError ? err.messageData.what : (err as Error).message;
    debugWrite(`[roots] status: yg-config.yaml parse failed: ${message}`);
    return `Roots: .yggdrasil/yg-config.yaml could not be read (${message}).\nFix the config file, then re-run 'yg roots status'.\n`;
  }

  if (config.roots === undefined) {
    return (
      'Roots: dormant — no `roots:` block in .yggdrasil/yg-config.yaml.\n' +
      "Run 'yg roots index' to add it with default settings and start mining conventions.\n"
    );
  }

  let stored: RootsModel | undefined;
  try {
    stored = await readModel(yggRoot);
  } catch (err) {
    debugWrite(`[roots] status: model.json read failed: ${(err as Error).message}`);
    return (
      `Roots: configured, but the committed model at .yggdrasil/roots/model.json could not be read (${(err as Error).message}).\n` +
      "Run 'yg roots index' to regenerate it.\n"
    );
  }

  if (stored === undefined) {
    return (
      'Roots: configured, but never indexed.\n' +
      "Run 'yg roots index' to mine the repository for conventions.\n"
    );
  }

  if (!isMinedModel(stored.body)) {
    return (
      'Roots: the committed model at .yggdrasil/roots/model.json does not have the expected shape.\n' +
      "Run 'yg roots index' to regenerate it.\n"
    );
  }

  const body = stored.body;
  const header = stored.header;
  const totalFacts = body.partitions.reduce((n, p) => n + p.facts.length, 0);
  const totalRoles = body.partitions.reduce((n, p) => n + p.roles.length, 0);
  const totalSeeds = body.partitions.reduce((n, p) => n + p.seeds.length, 0);

  const lastIndexedLine =
    header.headSha !== null && header.clock !== null
      ? `  Last indexed at commit ${header.headSha.slice(0, 7)}, committed ${header.clock}.\n`
      : '  Last indexed outside version control (no git history).\n';

  return (
    `${chalk.green('Roots: indexed.')}\n` +
    lastIndexedLine +
    `  Partitions: ${body.partitions.length}\n` +
    `  Facts: ${totalFacts}\n` +
    `  Roles: ${totalRoles}\n` +
    `  Seeds: ${totalSeeds}\n`
  );
}

export function registerRootsCommand(program: Command): void {
  const roots = program
    .command('roots')
    .description(
      'Convention mining — discovers the naming, structural, and API patterns your codebase already follows and reports on them. Dormant until configured (see `yg roots status`).',
    );

  roots
    .command('index')
    .description(
      'Mine the repository for conventions and write the committed model under .yggdrasil/roots/. Adds a `roots:` block with default settings first, if the project has none.',
    )
    .action(async () => {
      try {
        const yggRoot = await findYggRootOrFail();
        const configPath = path.join(yggRoot, 'yg-config.yaml');
        let config = await parseConfigOrFail(configPath);

        if (config.roots === undefined) {
          await scaffoldRootsBlock(configPath);
          process.stdout.write(ROOTS_SCAFFOLD_MESSAGE);
          config = await parseConfigOrFail(configPath);
        }
        const rootsConfig = config.roots;
        if (rootsConfig === undefined) {
          // parseRootsSection fills every key of an empty `roots: {}` mapping
          // from its documented default — the only way this branch is reached
          // is a genuine I/O fault (the scaffold write silently did not take
          // effect), never a config shape the parser would reject.
          throw new Error(
            `Scaffolded a roots: block into ${configPath} but re-reading it still reports no roots configuration.`,
          );
        }

        const repoRoot = projectRootFromGraph(yggRoot);
        const seeds = await readSeeds(yggRoot);
        const result = await runRootsIndex(repoRoot, rootsConfig, seeds);

        const [seedsHash, decisionsHash, ledgerHash, dirtyHash] = await Promise.all([
          hashStoreFile(yggRoot, SEEDS_FILENAME),
          hashStoreFile(yggRoot, DECISIONS_FILENAME),
          hashStoreFile(yggRoot, LEDGER_FILENAME),
          computeDirtyHash(yggRoot, repoRoot),
        ]);

        const header = assembleRootsModelHeader({
          configHash: rootsConfigHash(rootsConfig),
          seedsHash,
          decisionsHash,
          ledgerHash,
          headSha: getHeadSha(repoRoot),
          clock: getHeadCommitterTimestamp(repoRoot),
          dirtyHash,
          bindingHash: result.bindingSetHash,
          candidateCountLog2: result.candidateCountLog2,
        });

        await writeModel(yggRoot, header, result.body);

        const totalFacts = result.body.partitions.reduce((n, p) => n + p.facts.length, 0);
        const totalRoles = result.body.partitions.reduce((n, p) => n + p.roles.length, 0);
        process.stdout.write(
          chalk.green(
            `Indexed ${result.body.partitions.length} partition(s), ${totalFacts} fact(s), ${totalRoles} role(s). ` +
              `Model written to .yggdrasil/roots/model.json\n`,
          ),
        );
      } catch (error) {
        handleError(error);
      }
    });

  roots
    .command('status')
    .description(
      'Report what `yg roots index` has mined so far — dormancy, configuration, or the current field/fact counts. Always exits 0; never gates a build.',
    )
    .action(async () => {
      try {
        process.stdout.write(await renderRootsStatus(process.cwd()));
      } catch (error) {
        // `status` never gates a build on anything it can determine:
        // `renderRootsStatus` already turns every internal failure (no
        // project, unreadable config, corrupt model, even its own unexpected
        // throws) into an honest fallback string and returns normally, so
        // every reachable state exits 0. Reaching THIS catch means something
        // failed outside that whole pipeline — e.g. the stdout write itself —
        // which is a genuinely unexpected fault, not a status the command
        // could report; the canonical handler is correct here.
        debugWrite(`[roots] status action failed unexpectedly: ${(error as Error).message}`);
        abortOnUnexpectedError(error, 'reporting roots status');
      }
    });
}
