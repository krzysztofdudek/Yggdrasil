import path from 'node:path';
import { stat } from 'node:fs/promises';
import chalk from 'chalk';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { loadGraph, UnsupportedSchemaVersionError, OutdatedSchemaVersionError, MalformedSchemaVersionError, MissingSchemaVersionError, FlowLoadError, CLI_SUPPORTED_SCHEMA } from '../core/graph-loader.js';
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
/**
 * The what/why/next for a yg-config.yaml whose `version:` field is unusable —
 * absent, or present but not a string (an unquoted `version: 5.1` is a YAML
 * number). Shared by the graph load path and `yg init --upgrade`, which refuse
 * the same two cases and must say the same thing about them.
 */
export function schemaVersionFieldIssue(
  problem: { kind: 'absent' } | { kind: 'not-string'; shown: string },
): { what: string; why: string; next: string } {
  if (problem.kind === 'absent') {
    return {
      what: '.yggdrasil/yg-config.yaml has no version: field.',
      why: 'The version field records which graph schema this graph was written for. Without it the CLI cannot tell whether it can read the graph, cannot choose migrations, and reading the graph anyway would pass over a format it never confirmed it can read.',
      next: `Restore the field from version control. If you know this graph was written for this CLI's schema, add version: "${CLI_SUPPORTED_SCHEMA}" to .yggdrasil/yg-config.yaml. Then re-run.`,
    };
  }
  return {
    what: `.yggdrasil/yg-config.yaml has version: ${problem.shown}, which YAML reads as a number, not a version string.`,
    why: 'The schema version must be a full semver string such as "6.0.0". A bare number cannot be compared against the schema this CLI reads, and reading the graph anyway would pass over a format it never confirmed it can read.',
    next: `Write the version as a quoted three-part string, e.g. version: "${CLI_SUPPORTED_SCHEMA}". Restore it from version control if you are unsure which schema the graph was written for. Then re-run.`,
  };
}

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
    if (err instanceof MissingSchemaVersionError) {
      process.stderr.write(chalk.red(`Error: ${buildIssueMessage(schemaVersionFieldIssue({ kind: 'absent' }))}\n`));
      process.exit(1);
    }
    if (err instanceof MalformedSchemaVersionError && err.notAString) {
      process.stderr.write(chalk.red(`Error: ${buildIssueMessage(schemaVersionFieldIssue({ kind: 'not-string', shown: err.detectedVersion }))}\n`));
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
 * Guard for `yg init --upgrade`: exit with bootstrap guidance when no
 * `.yggdrasil/` exists. `init` is the one command that legitimately runs
 * before a graph exists, so its --upgrade path cannot use `loadGraphOrAbort`
 * (which loads the graph — the graph may need the very migration --upgrade is
 * about to run — and emits a generic message). Centralizing the missing-graph
 * guard here keeps the command handler from inlining an ENOENT branch or the
 * missing-graph string itself.
 */
export async function abortUnlessYggdrasilExists(yggRoot: string): Promise<void> {
  try {
    await stat(yggRoot);
  } catch {
    const formatted = buildIssueMessage({
      what: 'No .yggdrasil/ directory found in the current project.',
      why: '`yg init --upgrade` operates on an existing graph; the bootstrap form (without --upgrade) creates one.',
      next: "Run 'yg init' to bootstrap a fresh graph, then re-run --upgrade.",
    });
    process.stderr.write(chalk.red(`Error: ${formatted}\n`));
    process.exit(1);
  }
}
