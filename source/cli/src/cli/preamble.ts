import path from 'node:path';
import { stat } from 'node:fs/promises';
import chalk from 'chalk';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { loadGraph, UnsupportedSchemaVersionError, OutdatedSchemaVersionError, MalformedSchemaVersionError, FlowLoadError } from '../core/graph-loader.js';
import { LockInvalidError } from '../io/lock-store.js';
import type { Graph } from '../model/graph.js';

/**
 * Format and emit an unexpected error from a generic catch block, then
 * process.exit(1). Used as the fallback path after specific error
 * classifications have failed. The `context` string describes what was
 * being attempted, so the message reads "Unexpected error while <context>".
 */
export function abortOnUnexpectedError(error: unknown, context: string): never {
  // Recoverable STATE problems carry a fully-formed what/why/next message with
  // concrete recovery steps — render it directly instead of wrapping it as
  // "Unexpected error ... file an issue". The lock-invalid error (garbled /
  // version / conflict-markered lock, fail-closed) is the verdict-lock engine's
  // fail-closed gate for corrupted or unrecognized lock files.
  if (error instanceof LockInvalidError) {
    process.stderr.write(chalk.red(`Error: ${error.message}\n`));
    process.exit(1);
  }
  const message = error instanceof Error ? error.message : String(error);
  const formatted = buildIssueMessage({
    what: `Unexpected error while ${context}: ${message}`,
    why: 'The CLI encountered an error it does not classify.',
    next: 'This is a bug — please file an issue with the command you ran and the full error output.',
  });
  process.stderr.write(chalk.red(`Error: ${formatted}\n`));
  process.exit(1);
}

/**
 * Load the graph from the given root, or print a uniform what/why/next error
 * and exit(1).
 *
 * Centralizes the "No .yggdrasil/ directory found" error that previously
 * appeared inline in every CLI command. On ENOENT-shaped loader failures
 * (root not found, model/ missing) this helper writes a structured message
 * to stderr and calls process.exit(1) — it does not return. Any other error
 * is rethrown so the caller can decide.
 */
export async function loadGraphOrAbort(
  rootPath: string,
  options: { tolerateInvalidConfig?: boolean; noSecrets?: boolean } = {},
): Promise<Graph> {
  try {
    return await loadGraph(rootPath, options);
  } catch (err) {
    if (err instanceof UnsupportedSchemaVersionError) {
      const formatted = buildIssueMessage({
        what: `Graph schema version ${err.detectedVersion} is newer than this CLI supports (max: ${err.maxSupportedVersion}).`,
        why: 'This CLI cannot safely read a graph written for a newer schema — it may misinterpret or skip fields it does not understand.',
        next: `Upgrade the yg CLI to a version that supports schema ${err.detectedVersion} (e.g. \`npm i -g @chrisdudek/yg\`), then re-run this command.`,
      });
      process.stderr.write(chalk.red(`Error: ${formatted}\n`));
      process.exit(1);
    }
    if (err instanceof OutdatedSchemaVersionError) {
      const formatted = buildIssueMessage({
        what: `the .yggdrasil graph is at version ${err.detectedVersion}, older than this CLI (${err.minSupportedVersion}).`,
        why: `${err.minSupportedVersion} reads only the current on-disk format; older formats are upgraded by a migration, not parsed directly.`,
        next: `run \`yg init --upgrade\` to migrate the graph to ${err.minSupportedVersion}, then re-run.`,
      });
      process.stderr.write(chalk.red(`Error: ${formatted}\n`));
      process.exit(1);
    }
    if (err instanceof MalformedSchemaVersionError) {
      const formatted = buildIssueMessage({
        what: `yg-config.yaml version "${err.detectedVersion}" is not valid semver.`,
        why: 'The CLI cannot determine graph compatibility without a parseable version — reading the graph anyway could pass over a format it never confirmed it can read.',
        next: 'Restore the version field in .yggdrasil/yg-config.yaml from version control, or re-run `yg init`, then re-run this command.',
      });
      process.stderr.write(chalk.red(`Error: ${formatted}\n`));
      process.exit(1);
    }
    // A flow file that is missing / a directory / unparseable / mis-shaped is a
    // fault in ONE flow file on an ALREADY-INITIALIZED graph — never "run yg init"
    // and never an unclassified "file an issue" bug. Classify BEFORE the graph-root
    // ENOENT branch (an absent yg-flow.yaml is ENOENT, but the graph exists).
    if (err instanceof FlowLoadError) {
      const formatted = buildIssueMessage({
        what: `Flow file ${err.flowYamlPath} could not be loaded: ${err.detail}`,
        why: 'The graph is initialized, but this flow file is missing, unreadable, or malformed — the graph cannot load until every flow file under .yggdrasil/flows/ is a valid yg-flow.yaml.',
        next: 'Fix the flow file (a valid yg-flow.yaml with a name and a non-empty nodes list), or remove its directory under .yggdrasil/flows/ if the flow is no longer needed.',
      });
      process.stderr.write(chalk.red(`Error: ${formatted}\n`));
      process.exit(1);
    }
    const msg = (err as Error).message ?? '';
    const code = (err as NodeJS.ErrnoException).code;
    // Only the graph-root/.yggdrasil probe means "not initialized". `findYggRoot`
    // and the model/ check convert a genuinely-missing graph into the descriptive
    // messages matched below; a RAW ENOENT is limited to the `.yggdrasil` probe
    // itself (matched by path basename) so a downstream stray ENOENT no longer
    // masquerades as "run yg init".
    const enoentPath = (err as NodeJS.ErrnoException).path;
    const isGraphRootProbe =
      code === 'ENOENT' &&
      typeof enoentPath === 'string' &&
      path.basename(enoentPath) === '.yggdrasil';
    if (
      isGraphRootProbe ||
      msg.includes('No .yggdrasil/ directory found') ||
      msg.includes('does not exist')
    ) {
      const formatted = buildIssueMessage({
        what: 'No .yggdrasil/ directory found in the current project.',
        why: 'Yggdrasil commands require an initialized graph at the project root.',
        next: "Run 'yg init' to bootstrap the graph, then re-run this command.",
      });
      process.stderr.write(chalk.red(`Error: ${formatted}\n`));
      process.exit(1);
    }
    throw err;
  }
}

/**
 * Guard for a command that needs `.yggdrasil/` to exist but must not call
 * `loadGraphOrAbort` (which LOADS the graph): exits with bootstrap guidance
 * when no `.yggdrasil/` exists, so the caller never inlines an ENOENT branch
 * or the missing-graph string itself. The `what` line is fixed — it is the
 * one canonical missing-graph string every caller shares, matching
 * `loadGraphOrAbort`'s own — while `why`/`next` default to `init --upgrade`'s
 * original wording (its own call site passes nothing and is unaffected) but
 * may be overridden by a caller whose situation genuinely differs (e.g.
 * `yg roots index`, which is not an `--upgrade` operation and has no
 * `--upgrade` flag to suggest re-running).
 *
 * `init --upgrade` was the original motivating case: it is the one command
 * that legitimately runs before a graph exists, so it cannot use
 * `loadGraphOrAbort` (the graph may need the very migration --upgrade is
 * about to run, and that helper's own message assumes a normal command).
 */
export async function abortUnlessYggdrasilExists(
  yggRoot: string,
  overrides: { why?: string; next?: string } = {},
): Promise<void> {
  try {
    await stat(yggRoot);
  } catch {
    const formatted = buildIssueMessage({
      what: 'No .yggdrasil/ directory found in the current project.',
      why: overrides.why ?? '`yg init --upgrade` operates on an existing graph; the bootstrap form (without --upgrade) creates one.',
      next: overrides.next ?? "Run 'yg init' to bootstrap a fresh graph, then re-run --upgrade.",
    });
    process.stderr.write(chalk.red(`Error: ${formatted}\n`));
    process.exit(1);
  }
}

/**
 * The read-only sibling of `abortUnlessYggdrasilExists`: the ONE shared
 * "not part of a Yggdrasil project" REPORT string, for a command whose
 * missing-project case is an honest exit-0 answer rather than a refusal
 * (`yg roots status` reports state and never gates anything, so finding no
 * project is a reportable state, not an error). Owned here, beside the
 * canonical abort helper, for the same `cli-command-contract` reason: no
 * command body inlines its own missing-project wording or ENOENT-shaped
 * branch text — this module is the single home for both flavors, refusal
 * and report.
 */
export function missingProjectReport(subject: string, next: string): string {
  return `${subject}: this directory is not part of a Yggdrasil project, so there is nothing to report.\n${next}\n`;
}
