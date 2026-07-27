import { Command } from 'commander';
import chalk from 'chalk';
import { writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import * as p from '@clack/prompts';
import { DEFAULT_ARCHITECTURE } from '../templates/default-config.js';
import { installRules, DEPRECATED_PLATFORMS, type InstallReport } from '../templates/platform.js';
import { loadGraph, CLI_SUPPORTED_SCHEMA } from '../core/graph-loader.js';
import { blockingUnmappedPaths } from '../core/check-coverage-tiers.js';
import { DEFAULT_COVERAGE } from '../io/config-parser.js';
import { ZERO_CLASSIFYING_TYPES_NOTICE } from '../core/check.js';
import { cliVersion } from './cli-version.js';
import type { ReviewerProvider } from '../model/graph.js';
import { detectVersion } from '../core/migrator.js';
import { runVersionUpgrade as coreRunVersionUpgrade } from '../core/migrator-runner.js';
import { abortOnUnexpectedError, abortUnlessYggdrasilExists } from './preamble.js';
import { MIGRATIONS } from '../migrations/index.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { debugWrite } from '../utils/debug-log.js';
import {
  assertNotCancelled,
  ALL_PROVIDERS,
  resolveReviewerConfigFromFlags,
  type ResolveReviewerResult,
  runReviewerConfigFlow,
  writeReviewerConfig,
  writeSecretsFile,
} from './init-reviewer-setup.js';
import {
  createYggdrasilStructure,
  ensureGitattributes,
  ensureYggdrasilGitignore,
} from './init-scaffold.js';

// The .gitattributes / .gitignore maintenance helpers now live in the scaffold
// sibling; re-exported here so tests and existing importers resolve them from
// the init module unchanged.
export { ensureGitattributes, ensureYggdrasilGitignore };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTTY(): boolean {
  return process.stdout.isTTY === true && process.stdin.isTTY === true;
}

/**
 * Validate a `--provider` flag value, exiting 1 with a buildIssueMessage error
 * if it does not match a supported reviewer provider. Defined once and called
 * from every dispatch branch that needs the check, instead of repeating the
 * "Unknown provider" block inline at each call site.
 */
function ensureKnownProvider(provider: string): asserts provider is ReviewerProvider {
  if (!ALL_PROVIDERS.includes(provider as ReviewerProvider)) {
    process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
      what: `Unknown provider '${provider}'.`,
      why: 'The --provider value must match one of the supported reviewer providers.',
      next: `Use one of: ${ALL_PROVIDERS.join(', ')}`,
    })}\n`));
    process.exit(1);
  }
}

/**
 * `--platform` is retired: agent rules now install identically for every
 * agent (AGENTS.md digest + CLAUDE.md import + .clinerules), so there is no
 * per-platform choice left to make. The flag is still ACCEPTED — for any
 * value, including the thirteen retired platform names and anything unknown
 * — so a script that passed it before never hard-fails; it now just prints
 * this notice and the run proceeds exactly as if the flag had been omitted.
 * No-ops silently when the flag was not given.
 */
function noticeDeprecatedPlatform(platform: string | undefined): void {
  if (!platform) return;
  process.stdout.write(chalk.yellow(`${buildIssueMessage({
    what: `--platform ${platform} is deprecated and was ignored.`,
    why: 'Rules are now installed universally for every agent at once (AGENTS.md digest + CLAUDE.md import + .clinerules) — there is no per-platform choice.',
    next: 'Drop --platform from this invocation; everything else works unchanged.',
  })}\n`));
}

/**
 * Render a plain, user-facing summary of what installRules() did this run —
 * the paths it wrote/updated, any legacy per-platform artifacts it cleaned
 * up, and the standing reminder that nothing here was committed. Every
 * render site that reports on rules artifacts uses this ONE renderer so the
 * wording never drifts between the --upgrade flag path, the interactive
 * menu, and the existing-repo reconfigure path. `written` is empty on a
 * no-op re-run — rendered as "already up to date", never as a failure.
 */
function renderArtifactSummary(report: Pick<InstallReport, 'written' | 'removed'>): string {
  const lines: string[] = [];
  if (report.written.length > 0) {
    lines.push(`Agent rules installed/updated: ${report.written.join(', ')}`);
  }
  if (report.removed.length > 0) {
    lines.push(`Legacy per-platform artifacts cleaned up: ${report.removed.join(', ')}`);
  }
  if (lines.length === 0) {
    lines.push('Agent rules already up to date — nothing changed.');
  }
  lines.push('All changes are plain files — review them with git diff before committing.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Fresh init
// ---------------------------------------------------------------------------

async function freshInit(projectRoot: string): Promise<void> {
  const yggRoot = path.join(projectRoot, '.yggdrasil');

  p.intro(chalk.bold('Yggdrasil Setup'));

  p.log.info(
    'Yggdrasil enforces architectural rules on AI-generated code.\n' +
    '  You write rules (aspects), the agent manages the graph,\n' +
    '  and a reviewer verifies compliance after every change.',
  );

  p.log.info('Universal agent rules will be installed (AGENTS.md digest + CLAUDE.md import + .clinerules) — every agent reads the same files, so there is nothing to choose here.');

  // Reviewer — the LLM that verifies aspects against source code
  p.log.step('Reviewer provider');
  p.log.info(
    'The reviewer checks your source code against aspect rules during yg check --approve.\n' +
    '  If you already run an agent CLI (Claude Code, Codex, Gemini), pick it — the\n' +
    '  reviewer then needs no API key and adds no separate API bill. Ollama runs\n' +
    '  locally with no API cost. API providers (Anthropic, OpenAI, Google) need a key.\n' +
    '  Or pick "None for now": script rules, dependency control and the CI gate all\n' +
    '  work with no reviewer, and one can be added the day a judgment rule needs it.',
  );
  const reviewerConfig = await runReviewerConfigFlow();

  // Create structure + write config
  await createYggdrasilStructure(projectRoot, yggRoot, cliVersion());

  if (reviewerConfig) {
    await writeReviewerConfig(yggRoot, reviewerConfig);
    if (reviewerConfig.apiKey) {
      await writeSecretsFile(yggRoot, reviewerConfig.apiKey);
    }
  }

  await ensureGitattributes(projectRoot);

  p.outro(chalk.green(
    reviewerConfig
      ? `Yggdrasil initialized.\n${ZERO_CLASSIFYING_TYPES_NOTICE}\nAll changes are plain files — review them with git diff before committing. Run yg check to get started.`
      : `Yggdrasil initialized keyless — no reviewer configured, no keys, nothing to pay.\n${KEYLESS_WORKING_NOW}\n${ZERO_CLASSIFYING_TYPES_NOTICE}\nAll changes are plain files — review them with git diff before committing. Run yg check to get started.`,
  ));
}

// ---------------------------------------------------------------------------
// Shared reviewer resolve + persist (used by both non-interactive init paths)
// ---------------------------------------------------------------------------

/** The success branch of the resolver's result — the validated config plus any
 *  key-missing warning. Derived from the single source of truth so a new field
 *  on the resolver flows here without a parallel hand-written shape to sync. */
type ResolvedReviewerOk = Extract<ResolveReviewerResult, { ok: true }>;

/**
 * Resolve a reviewer config from flags/env and validate it. On a resolution
 * error, render it via buildIssueMessage and exit(1); otherwise return the
 * validated result. Kept SEPARATE from the write step so the fresh path can
 * fail-fast BEFORE scaffolding — a resolution error must never leave a partial
 * .yggdrasil/ behind (which would flip the next run onto the existing-repo path).
 */
function resolveReviewerOrExit(opts: {
  provider: ReviewerProvider;
  model?: string;
  endpoint?: string;
}): ResolvedReviewerOk {
  const resolved = resolveReviewerConfigFromFlags(opts);
  if (!resolved.ok) {
    process.stderr.write(chalk.red(`Error: ${buildIssueMessage(resolved.issue)}\n`));
    process.exit(1);
  }
  return resolved;
}

/**
 * Persist a validated reviewer config: write the tier into yg-config.yaml and,
 * when the environment supplied a key, the secret overlay — otherwise surface
 * the key-missing warning. Callers scaffold (fresh) or not (existing) before
 * calling this; here we only write the reviewer section, which must already
 * have a yg-config.yaml to merge into.
 */
async function persistReviewerConfig(
  yggRoot: string,
  resolved: ResolvedReviewerOk,
): Promise<void> {
  const { provider, model, endpoint, apiKey } = resolved.config;
  await writeReviewerConfig(yggRoot, { provider, model, endpoint });
  if (apiKey) {
    await writeSecretsFile(yggRoot, apiKey);
  } else if (resolved.keyWarning) {
    process.stdout.write(chalk.yellow(`${buildIssueMessage(resolved.keyWarning)}\n`));
  }
}

// ---------------------------------------------------------------------------
// Non-interactive fresh init (Docker / devcontainer / CI bootstrap)
// ---------------------------------------------------------------------------

/**
 * Non-interactive fresh bootstrap. Runs the SAME write-path as interactive
 * freshInit (createYggdrasilStructure + writeReviewerConfig [+ writeSecretsFile])
 * but takes every choice from flags instead of prompts, and performs NO model
 * fetch or connection test — so it works in a non-TTY context (Docker,
 * devcontainer, CI) where the wizard cannot run.
 *
 * The caller has already validated that `provider` is a recognized value.
 * Here: CLI-agent providers fall back to a built-in default model when
 * --model is omitted; API/local providers require --model. Ollama defaults its
 * endpoint; openai-compatible requires --endpoint. API keys are read from the
 * provider's env var (never a flag, so they never land in shell history); a
 * missing key is non-fatal — the config is written and can be fixed later,
 * mirroring the interactive flow's "saved anyway".
 */
export async function freshInitNonInteractive(
  projectRoot: string,
  yggRoot: string,
  opts: { provider: ReviewerProvider; model?: string; endpoint?: string },
): Promise<void> {
  // Validate the reviewer flags BEFORE scaffolding, so a bad flag combo exits
  // without leaving a partial .yggdrasil/ behind; scaffold, then write the tier
  // (writeReviewerConfig merges into the yg-config.yaml the scaffold just wrote).
  const resolved = resolveReviewerOrExit(opts);
  await createYggdrasilStructure(projectRoot, yggRoot, cliVersion());
  await persistReviewerConfig(yggRoot, resolved);
  await ensureGitattributes(projectRoot);

  process.stdout.write(chalk.green(
    `Yggdrasil initialized (provider: ${resolved.config.provider}, model: ${resolved.config.model}).\n` +
    `${ZERO_CLASSIFYING_TYPES_NOTICE}\n` +
    'All changes are plain files — review them with git diff before committing.\n' +
    'Run yg check to get started.\n',
  ));
}

// ---------------------------------------------------------------------------
// Non-interactive keyless fresh init (no reviewer configured)
// ---------------------------------------------------------------------------

/**
 * What a project without a reviewer can already do, and how to add one. Shared
 * verbatim by every keyless landing (the wizard's "None for now", the explicit
 * flag, and the no-terminal bootstrap) so the same choice never reads as a
 * working setup on one path and a degraded one on another.
 */
const KEYLESS_WORKING_NOW =
  '  Working now, free: script rules, dependency control, yg check in CI.\n' +
  '  Add a judge for judgment rules any time: yg init --provider <name> [--model <m>].';

/**
 * Keyless non-interactive bootstrap: scaffold + universal agent rules,
 * writing NO reviewer section. Script rules, dependency control and the CI
 * gate work immediately with no key; a judge can be added later (yg init
 * --provider …). Legal only because checkReviewerPresence is conditional
 * (Task 1).
 *
 * Reached two ways: an explicit `--no-reviewer`, which works in a terminal and
 * out of one alike, and a bare run with no terminal to prompt in.
 */
export async function freshInitKeyless(
  projectRoot: string,
  yggRoot: string,
): Promise<void> {
  await createYggdrasilStructure(projectRoot, yggRoot, cliVersion());
  await ensureGitattributes(projectRoot);
  process.stdout.write(chalk.green(
    `Yggdrasil initialized keyless — no reviewer configured, no keys, nothing to pay.\n${KEYLESS_WORKING_NOW}\n` +
    `  ${ZERO_CLASSIFYING_TYPES_NOTICE}\n` +
    '  All changes are plain files — review them with git diff before committing.\n' +
    '  Run yg check to get started.\n',
  ));
}

// ---------------------------------------------------------------------------
// Version upgrade — shared between the version-mismatch branch and --upgrade flag path
// ---------------------------------------------------------------------------

export interface VersionUpgradeResult {
  /** Rules artifacts written/updated this run (empty on a no-op re-run). */
  rulesPaths: string[];
  /** Legacy per-platform artifacts cleaned up this run (prose labels for partial edits). */
  rulesRemoved: string[];
  migrationActions: string[];
  migrationWarnings: string[];
  /** True when a migration withheld the version bump (incomplete upgrade). */
  withheld: boolean;
  /**
   * Repo-plumbing files this command maintains that the project's own coverage
   * settings will now report as blocking unmapped-file errors. Empty in the
   * ordinary case; non-empty only for a project that requires its whole tree
   * and has neither mapped nor excluded them. Reported, never acted on — which
   * of the two remedies to take is the user's call, and the file that decides
   * it is theirs.
   */
  coverageBlocked: string[];
}

/**
 * Repo plumbing `yg init` writes at the project root and maintains thereafter:
 * the three universal agent-rules artifacts (resolved to the spellings this
 * project actually uses) plus the `.gitattributes` entry. These are the files
 * the coverage prediction below is about.
 */
function managedRootFiles(report: InstallReport): string[] {
  return [...report.managed, '.gitattributes'];
}

/**
 * Which of the managed root files this project's coverage settings will turn
 * into blocking unmapped-file errors.
 *
 * Best-effort by construction: a graph that cannot be loaded (mid-migration,
 * malformed, or simply not this command's business) yields no prediction
 * rather than an error — the upgrade itself succeeded, and a failure to
 * predict must never turn that into a failure.
 */
async function predictCoverageBlockers(projectRoot: string, managed: string[]): Promise<string[]> {
  try {
    const graph = await loadGraph(projectRoot);
    const mappings = [...graph.nodes.values()].flatMap((n) => n.meta.mapping ?? []);
    return blockingUnmappedPaths(managed, mappings, graph.config.coverage ?? DEFAULT_COVERAGE);
  } catch (e: unknown) {
    debugWrite(`[init] coverage prediction skipped: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/**
 * The what/why/next for a project whose coverage settings will now report the
 * files this command maintains as unmapped errors. It names the exact stanza to
 * add — the command never edits the user's configuration itself; which files a
 * project holds under coverage is a decision the file's owner makes.
 */
function renderCoverageBlockedWarning(paths: string[]): string {
  const stanza = ['coverage:', '  excluded:', ...paths.map((p) => `    - ${p}`)].join('\n');
  return buildIssueMessage({
    what: `This project requires every tracked file to belong to a component, and these files it maintains for you belong to none: ${paths.join(', ')}.`,
    why: 'They are repository plumbing — the agent-rules files and the git attributes entry — not project source, so yg check will report them as unmapped errors until they are either excluded from coverage or mapped to a component.',
    next: `Add them to .yggdrasil/yg-config.yaml (merging into an existing coverage block if you have one):\n${stanza}\nOr, if you would rather they belong to a component, add them to that component's file list instead.`,
  });
}

export async function runVersionUpgrade(
  projectRoot: string,
  yggRoot: string,
): Promise<VersionUpgradeResult> {
  const { migrationActions, migrationWarnings, withheld } = await coreRunVersionUpgrade({
    yggRoot, migrations: MIGRATIONS, targetVersion: CLI_SUPPORTED_SCHEMA,
  });

  const architecturePath = path.join(yggRoot, 'yg-architecture.yaml');
  try {
    await stat(architecturePath);
  } catch (e: unknown) {
    debugWrite(`[init] runVersionUpgrade architecture file missing, writing default: ${e instanceof Error ? e.message : String(e)}`);
    await writeFile(architecturePath, DEFAULT_ARCHITECTURE, 'utf-8');
  }

  const report = await installRules(projectRoot, cliVersion());

  // Maintain the lock's .gitattributes line on every upgrade so existing
  // adopters pick it up (both the interactive and non-interactive --upgrade
  // paths route through here). Idempotent.
  await ensureGitattributes(projectRoot);
  // Likewise ensure `.yggdrasil/.gitignore` carries the full set of local
  // rebuildable/secret state (secrets, the relation symbol-index cache, the
  // debug log) so existing adopters pick up the complete set. Idempotent.
  await ensureYggdrasilGitignore(yggRoot);

  return {
    rulesPaths: report.written,
    rulesRemoved: report.removed,
    migrationActions,
    migrationWarnings,
    withheld,
    coverageBlocked: await predictCoverageBlockers(projectRoot, managedRootFiles(report)),
  };
}

// ---------------------------------------------------------------------------
// Non-interactive reconfigure of an existing repo (flags authoritative)
// ---------------------------------------------------------------------------

/**
 * Apply the union of the operations named by flags to an existing .yggdrasil/:
 * --provider [+ --model/--endpoint] (re)writes the reviewer tier; --platform
 * is retired — accepted for backward compatibility, it prints a deprecation
 * notice and then just refreshes the universal agent rules (same artifacts
 * every other path installs). Prompt-free; mirrors freshInitNonInteractive's
 * resolver + write-path. Provider values are validated by the caller.
 */
export async function existingInitNonInteractive(
  projectRoot: string,
  yggRoot: string,
  opts: { platform?: string; provider?: ReviewerProvider; model?: string; endpoint?: string },
): Promise<void> {
  if (opts.provider) {
    const resolved = resolveReviewerOrExit({
      provider: opts.provider, model: opts.model, endpoint: opts.endpoint,
    });
    await persistReviewerConfig(yggRoot, resolved);
    process.stdout.write(
      chalk.green(`Reviewer configured (provider: ${resolved.config.provider}, model: ${resolved.config.model}).\n`),
    );
  }

  if (opts.platform) {
    noticeDeprecatedPlatform(opts.platform);
    const report = await installRules(projectRoot, cliVersion());
    process.stdout.write(chalk.green(`${renderArtifactSummary(report)}\n`));
    const blocked = await predictCoverageBlockers(projectRoot, managedRootFiles(report));
    if (blocked.length > 0) {
      process.stdout.write(chalk.yellow(`${renderCoverageBlockedWarning(blocked)}\n`));
    }
  }
}

// ---------------------------------------------------------------------------
// Existing repo menu
// ---------------------------------------------------------------------------

async function existingInit(projectRoot: string): Promise<void> {
  const yggRoot = path.join(projectRoot, '.yggdrasil');

  p.intro(chalk.bold('Yggdrasil Configuration'));

  // Check for pending migrations. The graph version is the SCHEMA version — it
  // advances only when the graph format changes, not on every package release —
  // so compare it against CLI_SUPPORTED_SCHEMA, never the package version. A
  // patch release that leaves the format unchanged needs no upgrade.
  const currentVersion = await detectVersion(yggRoot);

  if (currentVersion && currentVersion !== CLI_SUPPORTED_SCHEMA) {
    p.log.step(`Graph schema ${currentVersion} detected — this CLI uses schema ${CLI_SUPPORTED_SCHEMA}. Upgrade required.`);

    const s = p.spinner();
    s.start('Running migrations and refreshing agent rules...');
    const result = await runVersionUpgrade(projectRoot, yggRoot);
    s.stop('Upgrade complete.');

    for (const action of result.migrationActions) {
      p.log.info(action);
    }
    for (const warning of result.migrationWarnings) {
      p.log.warning(warning);
    }
    if (result.coverageBlocked.length > 0) {
      p.log.warning(renderCoverageBlockedWarning(result.coverageBlocked));
    }

    const landedVersion = (await detectVersion(yggRoot)) ?? currentVersion;
    p.log.step('Next steps:');
    p.log.info('1. Run yg check to verify graph integrity');
    p.log.info('2. Run yg check --approve to record verdicts for the graph');
    p.outro(
      chalk.green(
        `Migrated from ${currentVersion} to ${landedVersion}.\n` +
        renderArtifactSummary({ written: result.rulesPaths, removed: result.rulesRemoved }),
      ),
    );
    return;
  }

  const action = await p.select<string>({
    message: 'What would you like to do?',
    options: [
      { value: 'upgrade', label: 'Refresh agent rules' },
      { value: 'reviewer', label: 'Configure reviewer' },
    ],
  });
  assertNotCancelled(action);

  switch (action) {
    case 'upgrade': {
      const result = await runVersionUpgrade(projectRoot, yggRoot);
      if (result.coverageBlocked.length > 0) {
        p.log.warning(renderCoverageBlockedWarning(result.coverageBlocked));
      }
      p.outro(chalk.green(renderArtifactSummary({ written: result.rulesPaths, removed: result.rulesRemoved })));
      break;
    }
    case 'reviewer': {
      const reviewerConfig = await runReviewerConfigFlow();
      // "None for now" leaves the existing configuration exactly as it was —
      // this menu entry configures a reviewer, it never removes one. Silently
      // rewriting the config to nothing would discard a working setup on what
      // reads as a decline.
      if (!reviewerConfig) {
        p.outro(chalk.green('No reviewer selected — the existing reviewer configuration is unchanged.'));
        break;
      }
      await writeReviewerConfig(yggRoot, reviewerConfig);
      if (reviewerConfig.apiKey) {
        await writeSecretsFile(yggRoot, reviewerConfig.apiKey);
      }
      p.outro(chalk.green('Reviewer configured.'));
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize Yggdrasil graph in current project')
    .option('--upgrade', 'Non-interactive: refresh agent rules')
    .option('--platform <name>', `Deprecated — accepted for backward compatibility only; agent rules now install identically for every agent, so this only prints a notice and is otherwise ignored (formerly one of: ${DEPRECATED_PLATFORMS.join(', ')})`)
    .option('--provider <name>', `Configure a reviewer non-interactively — fresh or existing repo (${ALL_PROVIDERS.join(', ')})`)
    .option('--model <name>', 'Reviewer model (defaults to sonnet for claude-code; required otherwise)')
    .option('--endpoint <url>', 'Reviewer endpoint (ollama defaults localhost; required for openai-compatible)')
    .option('--no-reviewer', 'Bootstrap a fresh project without a reviewer — script rules, dependency control and the CI gate work with no key; add a judge later with --provider')
    .action(async (options: { upgrade?: boolean; platform?: string; provider?: string; model?: string; endpoint?: string; reviewer?: boolean }) => {
      try {
        const projectRoot = process.cwd();
        const yggRoot = path.join(projectRoot, '.yggdrasil');
        // Commander models `--no-reviewer` as the negation of a boolean that
        // defaults to true, so "was it passed" is `=== false`, never falsy.
        const noReviewer = options.reviewer === false;

        if (noReviewer && (options.provider || options.model || options.endpoint)) {
          process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
            what: '--no-reviewer was combined with reviewer flags (--provider / --model / --endpoint).',
            why: 'They ask for opposite things: --no-reviewer bootstraps with no reviewer at all, while --provider configures one. Honoring both would mean ignoring one silently.',
            next: 'Keep exactly one: yg init --no-reviewer to start without a reviewer, or yg init --provider <name> [--model <m>] to configure one.',
          })}\n`));
          process.exit(1);
        }

        // Non-interactive upgrade: --upgrade [--platform <name>]
        if (options.upgrade) {
          if (noReviewer) {
            process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
              what: '--no-reviewer was combined with --upgrade.',
              why: '--upgrade only refreshes the agent rules of an existing project; it never touches the reviewer configuration, so --no-reviewer would be silently ignored.',
              next: 'Run the upgrade alone: yg init --upgrade.',
            })}\n`));
            process.exit(1);
          }
          if (options.provider || options.model || options.endpoint) {
            process.stderr.write(
              chalk.red(
                `Error: ${buildIssueMessage({
                  what: '--upgrade was combined with reviewer flags (--provider / --model / --endpoint).',
                  why: '--upgrade only refreshes the agent rules files; it does not configure a reviewer, so those flags would be silently ignored.',
                  next: 'Run the upgrade alone (yg init --upgrade), then configure the reviewer separately: yg init --provider <name> [--model <m>].',
                })}\n`,
              ),
            );
            process.exit(1);
          }
          noticeDeprecatedPlatform(options.platform);
          // init is the one command that runs before a graph exists; delegate the
          // missing-graph guard to a shared helper rather than inlining an ENOENT
          // branch or the missing-graph string here (cli-command-contract).
          await abortUnlessYggdrasilExists(yggRoot);

          const currentVersion = await detectVersion(yggRoot);
          if (currentVersion === null) {
            process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
              what: 'No graph version detected.',
              why: ".yggdrasil/yg-config.yaml is missing a 'version:' field, so --upgrade cannot determine which migrations to run.",
              next: "Run 'yg init' interactively once to record the current version, then retry 'yg init --upgrade'.",
            })}\n`));
            process.exit(1);
          }
          const result = await runVersionUpgrade(projectRoot, yggRoot);

          // A migration that WITHHELD the version bump (bumpVersion: false)
          // leaves yg-config.yaml at its prior version — an INCOMPLETE upgrade.
          // The interactive path surfaces this; the non-interactive flag path
          // (agents/CI) must signal it too, not report a false success. A
          // COMPLETED upgrade that merely emitted informational warnings still
          // succeeds (exit 0) but surfaces them rather than swallowing them.
          if (result.withheld) {
            process.stderr.write(
              chalk.red(
                `Error: ${buildIssueMessage({
                  what:
                    'Migration withheld — the version bump was NOT applied.\n' +
                    result.migrationWarnings.map((w) => `  - ${w}`).join('\n'),
                  why: 'A migration step could not be safely applied, so the chain stopped and yg-config.yaml was left at its prior version. Reporting success here would hide an incomplete upgrade from agents and CI.',
                  next: 'Fix the listed configuration problems, then re-run yg init --upgrade.',
                })}\n`,
              ),
            );
            process.exit(1);
          }

          if (result.migrationWarnings.length > 0) {
            process.stdout.write(
              chalk.yellow(
                'Migration warnings:\n' +
                  result.migrationWarnings.map((w) => `  - ${w}`).join('\n') +
                  '\n',
              ),
            );
          }

          process.stdout.write(
            `${renderArtifactSummary({ written: result.rulesPaths, removed: result.rulesRemoved })}\n`,
          );
          // An upgrading project that requires its whole tree gets these files
          // as new blocking errors on its very next check. Say so here, where
          // the files were just written, and name the stanza that settles it.
          if (result.coverageBlocked.length > 0) {
            process.stdout.write(chalk.yellow(`${renderCoverageBlockedWarning(result.coverageBlocked)}\n`));
          }
          return;
        }

        // Check if .yggdrasil/ already exists
        let exists = false;
        try {
          const statResult = await stat(yggRoot);
          if (!statResult.isDirectory()) {
            process.stderr.write(
              chalk.red(
                `Error: ${buildIssueMessage({
                  what: '.yggdrasil exists at the project root but is not a directory.',
                  why: 'yg init requires the .yggdrasil path to be a directory it can populate.',
                  next: 'Inspect the path manually; remove or rename the conflicting file, then re-run yg init.',
                })}\n`,
              ),
            );
            process.exit(1);
          }
          exists = true;
        } catch (e: unknown) {
          debugWrite(`[init] .yggdrasil stat: ${e instanceof Error ? e.message : String(e)}`);
          // Directory does not exist
        }

        // --model / --endpoint only configure a judge; meaningless without --provider.
        if ((options.model || options.endpoint) && !options.provider) {
          process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
            what: '--model/--endpoint given without --provider.',
            why: 'A model or endpoint only configures a judge; without --provider there is no judge to configure.',
            next: 'Add --provider <name>, or drop --model/--endpoint (and pass --no-reviewer to start without one).',
          })}\n`));
          process.exit(1);
        }

        if (exists && noReviewer) {
          // --no-reviewer describes how to BOOTSTRAP a project. On an existing
          // one there is nothing it could mean that is not destructive: it
          // would either do nothing at all, or delete a reviewer the user
          // configured deliberately. Say so instead of guessing.
          process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
            what: '--no-reviewer was given, but this project already has a .yggdrasil/ graph.',
            why: 'The flag chooses how to bootstrap a NEW project (with no reviewer); it never removes a reviewer an existing project already configured.',
            next: 'Run yg init with no flags to open the menu, or yg init --provider <name> [--model <m>] to change the reviewer. To go back to no reviewer, delete the reviewer: section from .yggdrasil/yg-config.yaml.',
          })}\n`));
          process.exit(1);
        }

        if (exists) {
          // --platform alone must NOT change whether the interactive menu
          // appears — it carries no operational meaning anymore (mirrors the
          // fresh-repo branch below). Only an explicit --provider forces the
          // non-interactive path regardless of TTY; a bare --platform in a
          // terminal falls through to the same interactive menu a flagless
          // run would open, and a bare --platform with no TTY still performs
          // its one real non-interactive effect (refreshing agent rules) so
          // that genuinely non-interactive combination keeps working exactly
          // as before.
          if (options.provider) {
            ensureKnownProvider(options.provider);
            await existingInitNonInteractive(projectRoot, yggRoot, {
              platform: options.platform,
              provider: options.provider as ReviewerProvider,
              model: options.model,
              endpoint: options.endpoint,
            });
          } else if (isTTY()) {
            noticeDeprecatedPlatform(options.platform);
            await existingInit(projectRoot);
          } else if (options.platform) {
            await existingInitNonInteractive(projectRoot, yggRoot, { platform: options.platform });
          } else {
            process.stdout.write(chalk.yellow(`${buildIssueMessage({
              what: '.yggdrasil/ already exists and no reconfiguration flag was given (no TTY to open the menu).',
              why: 'Reconfiguration needs either the interactive menu or an explicit flag; a bare non-interactive run has nothing to do.',
              next: 'Pass one: --provider <name> [--model <m>] to set the judge, or --upgrade to refresh agent rules.',
            })}\n`));
          }
        } else {
          // Fresh repo. --platform carries no operational meaning anymore — it
          // only ever triggers the deprecation notice below, regardless of
          // which of the three bootstrap paths runs next.
          noticeDeprecatedPlatform(options.platform);

          if (options.provider) {
            // Non-interactive fresh bootstrap WITH a judge (Docker / devcontainer / CI).
            ensureKnownProvider(options.provider);
            await freshInitNonInteractive(projectRoot, yggRoot, {
              provider: options.provider as ReviewerProvider,
              model: options.model,
              endpoint: options.endpoint,
            });
          } else if (noReviewer) {
            // Explicitly asked for no reviewer — honored in a terminal exactly
            // as it is without one, so starting keyless never depends on
            // detaching stdin or on any deprecated flag.
            await freshInitKeyless(projectRoot, yggRoot);
          } else if (isTTY()) {
            await freshInit(projectRoot);
          } else {
            // Bare non-interactive fresh init: keyless universal bootstrap —
            // no prompt is possible (no TTY) and no reviewer flag was given,
            // so scaffold the graph and install the agent rules with no judge
            // configured. A judge can be added any time: yg init --provider <name>.
            await freshInitKeyless(projectRoot, yggRoot);
          }
        }
      } catch (err) {
        debugWrite(`[init] command failed: ${err instanceof Error ? err.message : String(err)}`);
        abortOnUnexpectedError(err, 'running init');
      }
    });
}
