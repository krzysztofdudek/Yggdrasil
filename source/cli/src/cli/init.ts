import { Command } from 'commander';
import chalk from 'chalk';
import { writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import * as p from '@clack/prompts';
import { DEFAULT_ARCHITECTURE } from '../templates/default-config.js';
import { installRulesForPlatform, PLATFORMS, type Platform } from '../templates/platform.js';
import type { ReviewerProvider } from '../model/graph.js';
import { detectVersion } from '../core/migrator.js';
import { runVersionUpgrade as coreRunVersionUpgrade } from '../core/migrator-runner.js';
import { CLI_SUPPORTED_SCHEMA } from '../core/graph-loader.js';
import { abortOnUnexpectedError } from './preamble.js';
import { MIGRATIONS } from '../migrations/index.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { debugWrite } from '../utils/debug-log.js';
import { toPosixPath } from '../utils/posix.js';
import {
  assertNotCancelled,
  ALL_PROVIDERS,
  API_KEY_ENV,
  needsApiKey,
  needsEndpoint,
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

// ---------------------------------------------------------------------------
// Platform prompt
// ---------------------------------------------------------------------------

async function promptPlatform(): Promise<Platform> {
  const platform = await p.select<Platform>({
    message: 'Select your agent platform',
    options: PLATFORMS.map((pl) => ({ value: pl, label: pl })),
  });
  assertNotCancelled(platform);
  return platform;
}

// ---------------------------------------------------------------------------
// Fresh init
// ---------------------------------------------------------------------------

async function freshInit(projectRoot: string): Promise<void> {
  const yggRoot = path.join(projectRoot, '.yggdrasil');

  if (!isTTY()) {
    process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
      what: 'yg init requires an interactive terminal (no --provider given).',
      why: 'The interactive wizard needs prompts to configure platform and reviewer. Docker, devcontainer, and CI runs have no TTY.',
      next: `Run yg init in an interactive terminal, OR bootstrap non-interactively: yg init --platform <name> --provider <name> [--model <m>] [--endpoint <url>]. Supported providers: ${ALL_PROVIDERS.join(', ')}.`,
    })}\n`));
    process.exit(1);
  }

  p.intro(chalk.bold('Yggdrasil Setup'));

  p.log.info(
    'Yggdrasil enforces architectural rules on AI-generated code.\n' +
    '  You write rules (aspects), the agent manages the graph,\n' +
    '  and a reviewer verifies compliance after every change.',
  );

  // 1. Platform — determines which rules file the agent reads
  p.log.step('Step 1: AI coding platform');
  p.log.info('This installs a rules file that teaches your agent the Yggdrasil protocol.');
  const platform = await promptPlatform();

  // 2. Reviewer — the LLM that verifies aspects against source code
  p.log.step('Step 2: Reviewer provider');
  p.log.info(
    'The reviewer checks your source code against aspect rules during yg check --approve.\n' +
    '  If you already run an agent CLI (Claude Code, Codex, Gemini), pick it — the\n' +
    '  reviewer then needs no API key and adds no separate API bill. Ollama runs\n' +
    '  locally with no API cost. API providers (Anthropic, OpenAI, Google) need a key.',
  );
  const reviewerConfig = await runReviewerConfigFlow();

  // 3. Create structure + write config
  await createYggdrasilStructure(projectRoot, yggRoot, platform);

  await writeReviewerConfig(yggRoot, reviewerConfig);
  if (reviewerConfig.apiKey) {
    await writeSecretsFile(yggRoot, reviewerConfig.apiKey);
  }

  await ensureGitattributes(projectRoot);

  p.outro(chalk.green('Yggdrasil initialized. Run yg check to get started.'));
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
 * The caller has already validated that `platform` and `provider` are recognized
 * values. Here: CLI-agent providers fall back to a built-in default model when
 * --model is omitted; API/local providers require --model. Ollama defaults its
 * endpoint; openai-compatible requires --endpoint. API keys are read from the
 * provider's env var (never a flag, so they never land in shell history); a
 * missing key is non-fatal — the config is written and can be fixed later,
 * mirroring the interactive flow's "saved anyway".
 */
export async function freshInitNonInteractive(
  projectRoot: string,
  yggRoot: string,
  opts: { platform: Platform; provider: ReviewerProvider; model?: string; endpoint?: string },
): Promise<void> {
  const { platform, provider } = opts;

  const model = opts.model?.trim();
  if (!model) {
    process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
      what: '--model is required for non-interactive init.',
      why: 'Non-interactive init records the reviewer model verbatim and applies no default — the model must be named explicitly.',
      next: `Re-run naming a model: yg init --platform ${platform} --provider ${provider} --model <name>.`,
    })}\n`));
    process.exit(1);
  }

  let endpoint = opts.endpoint?.trim() || undefined;
  if (needsEndpoint(provider) && !endpoint) {
    if (provider === 'ollama') {
      endpoint = 'http://localhost:11434';
    } else {
      process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
        what: `--endpoint is required for provider '${provider}'.`,
        why: 'An OpenAI-compatible provider has no default base URL — the reviewer needs an endpoint to call.',
        next: `Re-run naming an endpoint: yg init --platform ${platform} --provider ${provider} --model ${model} --endpoint <url>.`,
      })}\n`));
      process.exit(1);
    }
  }

  await createYggdrasilStructure(projectRoot, yggRoot, platform);
  await writeReviewerConfig(yggRoot, { provider, model, endpoint });

  if (needsApiKey(provider)) {
    const envVar = API_KEY_ENV[provider];
    const apiKey = (envVar ? process.env[envVar] : undefined)?.trim();
    if (apiKey) {
      await writeSecretsFile(yggRoot, apiKey);
    } else {
      process.stdout.write(chalk.yellow(`${buildIssueMessage({
        what: `No API key found${envVar ? ` in $${envVar}` : ''}; wrote the config without one.`,
        why: 'An API provider needs a key before the reviewer can run; init records the config anyway so setup is not blocked.',
        next: `Set ${envVar ?? 'the provider API key environment variable'} (or add the key to .yggdrasil/yg-secrets.yaml) before running yg check --approve.`,
      })}\n`));
    }
  }

  await ensureGitattributes(projectRoot);

  process.stdout.write(chalk.green(
    `Yggdrasil initialized (platform: ${platform}, provider: ${provider}, model: ${model}). Run yg check to get started.\n`,
  ));
}

// ---------------------------------------------------------------------------
// Version upgrade — shared between the version-mismatch branch and --upgrade --platform flag path
// ---------------------------------------------------------------------------

export interface VersionUpgradeResult {
  rulesPath: string;
  migrationActions: string[];
  migrationWarnings: string[];
  /** True when a migration withheld the version bump (incomplete upgrade). */
  withheld: boolean;
}

export async function runVersionUpgrade(
  projectRoot: string,
  yggRoot: string,
  platform: Platform,
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

  const rawRulesPath = await installRulesForPlatform(projectRoot, platform);
  const rulesPath = toPosixPath(rawRulesPath);

  // Maintain the lock's .gitattributes line on every upgrade so existing
  // adopters pick it up (both the interactive and non-interactive --upgrade
  // paths route through here). Idempotent.
  await ensureGitattributes(projectRoot);
  // Likewise ensure `.yggdrasil/.gitignore` carries the full set of local
  // rebuildable/secret state (secrets, the relation symbol-index cache, the
  // debug log) so existing adopters pick up the complete set. Idempotent.
  await ensureYggdrasilGitignore(yggRoot);

  return { rulesPath, migrationActions, migrationWarnings, withheld };
}

// ---------------------------------------------------------------------------
// Existing repo menu
// ---------------------------------------------------------------------------

async function existingInit(projectRoot: string): Promise<void> {
  const yggRoot = path.join(projectRoot, '.yggdrasil');

  if (!isTTY()) {
    process.stdout.write(chalk.yellow(buildIssueMessage({
      what: '.yggdrasil/ already exists.',
      why: 'Re-configuration requires interactive prompts which are not available in non-TTY mode.',
      next: 'Run yg init interactively in a terminal to reconfigure.',
    }) + '\n'));
    return;
  }

  p.intro(chalk.bold('Yggdrasil Configuration'));

  // Check for pending migrations. The graph version is the SCHEMA version — it
  // advances only when the graph format changes, not on every package release —
  // so compare it against CLI_SUPPORTED_SCHEMA, never the package version. A
  // patch release that leaves the format unchanged needs no upgrade.
  const currentVersion = await detectVersion(yggRoot);

  if (currentVersion && currentVersion !== CLI_SUPPORTED_SCHEMA) {
    p.log.step(`Graph schema ${currentVersion} detected — this CLI uses schema ${CLI_SUPPORTED_SCHEMA}. Upgrade required.`);
    p.log.info('Select the agent platform so the rules are regenerated for the upgrade.');
    const platform = await promptPlatform();

    const s = p.spinner();
    s.start('Running migrations and installing rules...');
    const result = await runVersionUpgrade(projectRoot, yggRoot, platform);
    s.stop('Upgrade complete.');

    for (const action of result.migrationActions) {
      p.log.info(action);
    }
    for (const warning of result.migrationWarnings) {
      p.log.warning(warning);
    }

    const landedVersion = (await detectVersion(yggRoot)) ?? currentVersion;
    p.log.step('Next steps:');
    p.log.info('1. Run yg check to verify graph integrity');
    p.log.info('2. Run yg check --approve to record verdicts for the graph');
    p.outro(
      chalk.green(
        `Migrated from ${currentVersion} to ${landedVersion}. Rules installed: ${toPosixPath(path.relative(projectRoot, result.rulesPath))}`,
      ),
    );
    return;
  }

  const action = await p.select<string>({
    message: 'What would you like to do?',
    options: [
      { value: 'upgrade', label: 'Upgrade rules' },
      { value: 'reviewer', label: 'Configure reviewer' },
      { value: 'platform', label: 'Change platform' },
    ],
  });
  assertNotCancelled(action);

  switch (action) {
    case 'upgrade': {
      const platform = await promptPlatform();
      const result = await runVersionUpgrade(projectRoot, yggRoot, platform);
      p.outro(chalk.green(`Rules refreshed: ${toPosixPath(path.relative(projectRoot, result.rulesPath))}`));
      break;
    }
    case 'reviewer': {
      const reviewerConfig = await runReviewerConfigFlow();
      await writeReviewerConfig(yggRoot, reviewerConfig);
      if (reviewerConfig.apiKey) {
        await writeSecretsFile(yggRoot, reviewerConfig.apiKey);
      }
      p.outro(chalk.green('Reviewer configured.'));
      break;
    }
    case 'platform': {
      const platform = await promptPlatform();
      const rulesPath = await installRulesForPlatform(projectRoot, platform);
      p.outro(chalk.green(`Platform changed: ${toPosixPath(path.relative(projectRoot, rulesPath))}`));
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
    .option('--upgrade', 'Non-interactive: refresh rules')
    .option('--platform <name>', `Platform for rules file (${PLATFORMS.join(', ')})`)
    .option('--provider <name>', `Non-interactive fresh init: reviewer provider (${ALL_PROVIDERS.join(', ')})`)
    .option('--model <name>', 'Non-interactive fresh init: reviewer model (required)')
    .option('--endpoint <url>', 'Non-interactive fresh init: reviewer endpoint (ollama / openai-compatible)')
    .action(async (options: { upgrade?: boolean; platform?: string; provider?: string; model?: string; endpoint?: string }) => {
      try {
        const projectRoot = process.cwd();
        const yggRoot = path.join(projectRoot, '.yggdrasil');

        // Non-interactive upgrade: --upgrade --platform <name>
        if (options.upgrade) {
          if (!options.platform) {
            process.stderr.write(
              chalk.red(
                `Error: ${buildIssueMessage({
                  what: '--upgrade requires --platform.',
                  why: 'yg init --upgrade must know which platform rules to regenerate after migration.',
                  next: `Pass --platform <name>. Supported: ${PLATFORMS.join(', ')}.`,
                })}\n`,
              ),
            );
            process.exit(1);
          }
          if (!PLATFORMS.includes(options.platform as Platform)) {
            process.stderr.write(
              chalk.red(
                `Error: ${buildIssueMessage({
                  what: `Unknown platform '${options.platform}'.`,
                  why: 'The --platform value must match one of the supported agent platforms.',
                  next: `Use one of: ${PLATFORMS.join(', ')}`,
                })}\n`,
              ),
            );
            process.exit(1);
          }
          try {
            await stat(yggRoot);
          } catch (e: unknown) {
            debugWrite(`[init] upgrade: .yggdrasil not found: ${e instanceof Error ? e.message : String(e)}`);
            process.stderr.write(
              chalk.red(
                `Error: ${buildIssueMessage({
                  what: 'No .yggdrasil/ directory found in the current project.',
                  why: '`yg init --upgrade` operates on an existing graph; the bootstrap form (without --upgrade) creates one.',
                  next: "Run 'yg init' to bootstrap a fresh graph, then re-run --upgrade.",
                })}\n`,
              ),
            );
            process.exit(1);
          }

          const currentVersion = await detectVersion(yggRoot);
          if (currentVersion === null) {
            process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
              what: 'No graph version detected.',
              why: ".yggdrasil/yg-config.yaml is missing a 'version:' field, so --upgrade cannot determine which migrations to run.",
              next: "Run 'yg init' interactively once to record the current version, then retry 'yg init --upgrade --platform <name>'.",
            })}\n`));
            process.exit(1);
          }
          const result = await runVersionUpgrade(
            projectRoot,
            yggRoot,
            options.platform as Platform,
          );

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
                  next: 'Fix the listed configuration problems, then re-run yg init --upgrade --platform <name>.',
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
            `Rules refreshed: ${toPosixPath(path.relative(projectRoot, result.rulesPath))}\n`,
          );
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

        if (exists) {
          await existingInit(projectRoot);
        } else if (options.provider) {
          // Non-interactive fresh bootstrap (Docker / devcontainer / CI). Validate
          // platform + provider up front, then run the prompt-free write-path.
          if (!options.platform) {
            process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
              what: '--provider requires --platform for non-interactive init.',
              why: 'A fresh graph must install the rules file for a specific agent platform; there is no prompt to ask in non-interactive mode.',
              next: `Pass --platform <name>. Supported: ${PLATFORMS.join(', ')}.`,
            })}\n`));
            process.exit(1);
          }
          if (!PLATFORMS.includes(options.platform as Platform)) {
            process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
              what: `Unknown platform '${options.platform}'.`,
              why: 'The --platform value must match one of the supported agent platforms.',
              next: `Use one of: ${PLATFORMS.join(', ')}`,
            })}\n`));
            process.exit(1);
          }
          if (!ALL_PROVIDERS.includes(options.provider as ReviewerProvider)) {
            process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
              what: `Unknown provider '${options.provider}'.`,
              why: 'The --provider value must match one of the supported reviewer providers.',
              next: `Use one of: ${ALL_PROVIDERS.join(', ')}`,
            })}\n`));
            process.exit(1);
          }
          await freshInitNonInteractive(projectRoot, yggRoot, {
            platform: options.platform as Platform,
            provider: options.provider as ReviewerProvider,
            model: options.model,
            endpoint: options.endpoint,
          });
        } else {
          await freshInit(projectRoot);
        }
      } catch (err) {
        debugWrite(`[init] command failed: ${err instanceof Error ? err.message : String(err)}`);
        abortOnUnexpectedError(err, 'running init');
      }
    });
}
