import { Command } from 'commander';
import chalk from 'chalk';
import { mkdir, writeFile, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { DEFAULT_CONFIG, DEFAULT_ARCHITECTURE } from '../templates/default-config.js';
import { installRulesForPlatform, PLATFORMS, type Platform } from '../templates/platform.js';
import { fetchAnthropicModels, fetchOpenAIModels, fetchGoogleModels, fetchOllamaModels } from '../llm/model-fetcher.js';
import { testApiProvider, testCliProvider } from '../llm/reviewer-test.js';
import type { ReviewerProvider } from '../model/graph.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getGraphSchemasDir(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.join(currentDir, '..');
  return path.join(packageRoot, 'graph-schemas');
}

async function refreshSchemas(yggRoot: string): Promise<void> {
  const schemasDir = path.join(yggRoot, 'schemas');
  await mkdir(schemasDir, { recursive: true });
  const graphSchemasDir = getGraphSchemasDir();
  try {
    const entries = await readdir(graphSchemasDir, { withFileTypes: true });
    const schemaFiles = entries.filter((e) => e.isFile()).map((e) => e.name);
    for (const file of schemaFiles) {
      const srcPath = path.join(graphSchemasDir, file);
      const content = await readFile(srcPath, 'utf-8');
      await writeFile(path.join(schemasDir, file), content, 'utf-8');
    }
  } catch {
    // Ignore schema copy errors
  }
}

function isTTY(): boolean {
  return process.stdout.isTTY === true && process.stdin.isTTY === true;
}

function assertNotCancelled<T>(value: T | symbol): asserts value is T {
  if (p.isCancel(value)) {
    p.cancel('Operation cancelled.');
    process.exit(0);
  }
}

const GITIGNORE_CONTENT = `yg-secrets.yaml
`;

const SECRETS_EXAMPLE_CONTENT = `# Copy this to yg-secrets.yaml and fill in sensitive values (never commit yg-secrets.yaml)
reviewer:
  ollama:
    endpoint: http://localhost:11434     # override endpoint
    model: qwen3.5:9b                   # override model
    temperature: 0                      # override temperature
    max_tokens: auto                    # override max tokens (int or "auto")
    context_length_field: ""            # ollama model_info key for context window size
  claude-code:
    model: haiku                        # override model (haiku, sonnet, opus)
`;

const API_PROVIDERS: ReviewerProvider[] = ['anthropic', 'openai', 'google', 'openai-compatible', 'ollama'];
const CLI_PROVIDERS: ReviewerProvider[] = ['claude-code', 'codex', 'gemini-cli'];
const ALL_PROVIDERS: ReviewerProvider[] = [...API_PROVIDERS, ...CLI_PROVIDERS];

const CLAUDE_CODE_ALIASES = [
  { value: 'haiku', label: 'haiku' },
  { value: 'sonnet', label: 'sonnet' },
  { value: 'opus', label: 'opus' },
];

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
// Reviewer configuration flow
// ---------------------------------------------------------------------------

function needsApiKey(provider: ReviewerProvider): boolean {
  return !CLI_PROVIDERS.includes(provider) && provider !== 'ollama';
}

function needsEndpoint(provider: ReviewerProvider): boolean {
  return provider === 'openai-compatible' || provider === 'ollama';
}

async function promptApiKey(provider: ReviewerProvider): Promise<string> {
  const key = await p.text({
    message: `Enter API key for ${provider}`,
    validate: (v) => (v.trim().length === 0 ? 'API key cannot be empty' : undefined),
  });
  assertNotCancelled(key);
  return key.trim();
}

async function promptEndpoint(provider: ReviewerProvider): Promise<string> {
  const defaultEndpoint = provider === 'ollama' ? 'http://localhost:11434' : undefined;
  const endpoint = await p.text({
    message: `Enter endpoint URL for ${provider}`,
    placeholder: defaultEndpoint,
    defaultValue: defaultEndpoint,
    validate: (v) => (v.trim().length === 0 ? 'Endpoint cannot be empty' : undefined),
  });
  assertNotCancelled(endpoint);
  return endpoint.trim();
}

async function fetchModels(
  provider: ReviewerProvider,
  apiKey: string,
  endpoint?: string,
): Promise<{ ok: boolean; models: string[]; error?: string; is401?: boolean }> {
  let result;
  switch (provider) {
    case 'anthropic':
      result = await fetchAnthropicModels(apiKey);
      break;
    case 'openai':
    case 'openai-compatible':
      result = await fetchOpenAIModels(apiKey, endpoint);
      break;
    case 'google':
      result = await fetchGoogleModels(apiKey);
      break;
    case 'ollama':
      result = await fetchOllamaModels(endpoint);
      break;
    default:
      return { ok: false, models: [], error: `Unsupported provider for model fetch: ${provider}` };
  }
  const is401 = !result.ok && result.error?.includes('401');
  return { ...result, is401 };
}

async function promptModelFromList(models: string[]): Promise<string> {
  const model = await p.select<string>({
    message: 'Select a model',
    options: models.map((m) => ({ value: m, label: m })),
  });
  assertNotCancelled(model);
  return model;
}

async function promptModelText(provider: ReviewerProvider): Promise<string> {
  let hint = '';
  if (provider === 'codex') {
    hint = ' (see https://platform.openai.com/docs/models)';
  } else if (provider === 'gemini-cli') {
    hint = ' (see https://ai.google.dev/gemini-api/docs/models)';
  }
  const model = await p.text({
    message: `Enter model name${hint}`,
    validate: (v) => (v.trim().length === 0 ? 'Model name cannot be empty' : undefined),
  });
  assertNotCancelled(model);
  return model.trim();
}

async function runReviewerConfigFlow(): Promise<{
  provider: ReviewerProvider;
  model: string;
  apiKey?: string;
  endpoint?: string;
} | null> {
  // 1. Provider selection
  const provider = await p.select<ReviewerProvider>({
    message: 'Select reviewer provider',
    options: ALL_PROVIDERS.map((pr) => ({ value: pr, label: pr })),
  });
  assertNotCancelled(provider);

  // CLI providers: no API key needed
  if (CLI_PROVIDERS.includes(provider)) {
    // Model selection for CLI providers
    let model: string;
    if (provider === 'claude-code') {
      const selected = await p.select<string>({
        message: 'Select model alias',
        options: CLAUDE_CODE_ALIASES,
      });
      assertNotCancelled(selected);
      model = selected;
    } else {
      model = await promptModelText(provider);
    }

    // Validate CLI is installed
    const s = p.spinner();
    s.start(`Checking ${provider} installation...`);
    const testResult = await testCliProvider(provider);
    s.stop(testResult.ok ? `${provider} found` : `${provider} not found`);

    if (!testResult.ok) {
      p.log.warning(`${provider} not found on PATH: ${testResult.error}`);
      p.log.info('You can install it later. Configuration will be saved.');
    }

    return { provider, model };
  }

  // API providers
  let apiKey = '';
  if (needsApiKey(provider)) {
    apiKey = await promptApiKey(provider);
  }

  let endpoint: string | undefined;
  if (needsEndpoint(provider)) {
    endpoint = await promptEndpoint(provider);
  }

  // Fetch models
  const s = p.spinner();
  s.start('Fetching available models...');
  let fetchResult = await fetchModels(provider, apiKey, endpoint);

  // On 401: re-prompt API key once
  if (fetchResult.is401 && needsApiKey(provider)) {
    s.stop('Authentication failed (401).');
    p.log.warning('Invalid API key. Please try again.');
    apiKey = await promptApiKey(provider);
    s.start('Retrying model fetch...');
    fetchResult = await fetchModels(provider, apiKey, endpoint);
  }

  let model: string;
  if (fetchResult.ok && fetchResult.models.length > 0) {
    s.stop(`Found ${fetchResult.models.length} models.`);
    model = await promptModelFromList(fetchResult.models);
  } else {
    s.stop(fetchResult.error ? `Could not fetch models: ${fetchResult.error}` : 'No models found.');
    p.log.info('Enter model name manually.');
    model = await promptModelText(provider);
  }

  // Validation test
  const testSpinner = p.spinner();
  testSpinner.start('Testing connection...');
  const testResult = await testApiProvider(provider, apiKey, model, endpoint);
  testSpinner.stop(testResult.ok ? 'Connection successful.' : 'Connection test failed.');

  if (!testResult.ok) {
    p.log.warning(`Test failed: ${testResult.error}`);
    p.log.info('Configuration will be saved anyway. You can fix it later.');
  }

  return { provider, model, apiKey: apiKey || undefined, endpoint };
}

// ---------------------------------------------------------------------------
// Write reviewer config into yg-config.yaml
// ---------------------------------------------------------------------------

async function writeReviewerConfig(
  yggRoot: string,
  config: { provider: ReviewerProvider; model: string; endpoint?: string },
): Promise<void> {
  const configPath = path.join(yggRoot, 'yg-config.yaml');
  let raw: Record<string, unknown> = {};
  try {
    const content = await readFile(configPath, 'utf-8');
    raw = (yamlParse(content) as Record<string, unknown>) ?? {};
  } catch {
    // File doesn't exist yet
  }

  // Build reviewer section
  const providerConfig: Record<string, unknown> = { model: config.model };
  if (config.endpoint) {
    providerConfig.endpoint = config.endpoint;
  }

  const reviewer: Record<string, unknown> = {
    [config.provider]: providerConfig,
  };

  raw.reviewer = reviewer;

  await writeFile(configPath, yamlStringify(raw), 'utf-8');
}

// ---------------------------------------------------------------------------
// Write API key to yg-secrets.yaml
// ---------------------------------------------------------------------------

async function writeSecretsFile(
  yggRoot: string,
  provider: ReviewerProvider,
  apiKey: string,
): Promise<void> {
  const secretsPath = path.join(yggRoot, 'yg-secrets.yaml');
  let raw: Record<string, unknown> = {};
  try {
    const content = await readFile(secretsPath, 'utf-8');
    raw = (yamlParse(content) as Record<string, unknown>) ?? {};
  } catch {
    // File doesn't exist yet
  }

  if (!raw.reviewer || typeof raw.reviewer !== 'object') {
    raw.reviewer = {};
  }
  const reviewerSection = raw.reviewer as Record<string, unknown>;

  if (!reviewerSection[provider] || typeof reviewerSection[provider] !== 'object') {
    reviewerSection[provider] = {};
  }
  (reviewerSection[provider] as Record<string, unknown>).api_key = apiKey;

  await writeFile(secretsPath, yamlStringify(raw), 'utf-8');
}

// ---------------------------------------------------------------------------
// Fresh init
// ---------------------------------------------------------------------------

async function freshInit(projectRoot: string, platformFlag?: string): Promise<void> {
  const yggRoot = path.join(projectRoot, '.yggdrasil');

  // Non-TTY: no prompts
  if (!isTTY()) {
    const platform = (platformFlag ?? 'generic') as Platform;
    await createYggdrasilStructure(projectRoot, yggRoot, platform);
    process.stdout.write(chalk.green('✓ Yggdrasil initialized.') + '\n\n');
    process.stdout.write('Created:\n');
    process.stdout.write('  .yggdrasil/yg-config.yaml\n');
    process.stdout.write('  .yggdrasil/yg-architecture.yaml\n');
    process.stdout.write('  .yggdrasil/model/\n');
    process.stdout.write('  .yggdrasil/aspects/\n');
    process.stdout.write('  .yggdrasil/flows/\n');
    process.stdout.write('  .yggdrasil/schemas/\n');
    return;
  }

  p.intro(chalk.bold('Initialize Yggdrasil'));

  // 1. Platform selection
  let platform: Platform;
  if (platformFlag !== undefined) {
    platform = platformFlag as Platform;
    p.log.info(`Platform: ${platform}`);
  } else {
    platform = await promptPlatform();
  }

  // 2. Reviewer?
  const configureReviewer = await p.confirm({
    message: 'Configure a reviewer?',
  });
  assertNotCancelled(configureReviewer);

  let reviewerConfig: {
    provider: ReviewerProvider;
    model: string;
    apiKey?: string;
    endpoint?: string;
  } | null = null;

  if (configureReviewer) {
    reviewerConfig = await runReviewerConfigFlow();
  }

  // 3. Create structure
  await createYggdrasilStructure(projectRoot, yggRoot, platform);

  // 4. Write reviewer config if selected
  if (reviewerConfig) {
    await writeReviewerConfig(yggRoot, reviewerConfig);
    if (reviewerConfig.apiKey) {
      await writeSecretsFile(yggRoot, reviewerConfig.provider, reviewerConfig.apiKey);
    }
  }

  p.outro(chalk.green('Yggdrasil initialized. Run yg check to get started.'));
}

async function createYggdrasilStructure(
  projectRoot: string,
  yggRoot: string,
  platform: Platform,
): Promise<void> {
  await mkdir(path.join(yggRoot, 'model'), { recursive: true });
  await mkdir(path.join(yggRoot, 'aspects'), { recursive: true });
  await mkdir(path.join(yggRoot, 'flows'), { recursive: true });
  const schemasDir = path.join(yggRoot, 'schemas');
  await mkdir(schemasDir, { recursive: true });

  const graphSchemasDir = getGraphSchemasDir();
  try {
    const entries = await readdir(graphSchemasDir, { withFileTypes: true });
    const schemaFiles = entries.filter((e) => e.isFile()).map((e) => e.name);
    for (const file of schemaFiles) {
      const srcPath = path.join(graphSchemasDir, file);
      const content = await readFile(srcPath, 'utf-8');
      await writeFile(path.join(schemasDir, file), content, 'utf-8');
    }
  } catch (err) {
    process.stderr.write(
      chalk.yellow(`Warning: Could not copy graph schemas: ${(err as Error).message}\n`),
    );
  }

  await writeFile(path.join(yggRoot, 'yg-config.yaml'), DEFAULT_CONFIG, 'utf-8');
  await writeFile(path.join(yggRoot, 'yg-architecture.yaml'), DEFAULT_ARCHITECTURE, 'utf-8');
  await writeFile(path.join(yggRoot, '.gitignore'), GITIGNORE_CONTENT, 'utf-8');
  await writeFile(path.join(yggRoot, 'yg-secrets.example.yaml'), SECRETS_EXAMPLE_CONTENT, 'utf-8');

  await installRulesForPlatform(projectRoot, platform);
}

// ---------------------------------------------------------------------------
// Existing repo menu
// ---------------------------------------------------------------------------

async function existingInit(
  projectRoot: string,
  platformFlag?: string,
  upgradeFlag?: boolean,
): Promise<void> {
  const yggRoot = path.join(projectRoot, '.yggdrasil');

  // --upgrade flag
  if (upgradeFlag) {
    const platform = (platformFlag ?? 'generic') as Platform;
    if (!PLATFORMS.includes(platform)) {
      process.stderr.write(chalk.red(`Error: Unknown platform '${platform}'. Use: ${PLATFORMS.join(', ')}\n`));
      process.exit(1);
    }
    await refreshSchemas(yggRoot);

    // Ensure architecture file exists
    const architecturePath = path.join(yggRoot, 'yg-architecture.yaml');
    try {
      await stat(architecturePath);
    } catch {
      await writeFile(architecturePath, DEFAULT_ARCHITECTURE, 'utf-8');
    }

    if (platformFlag !== undefined) {
      const rulesPath = await installRulesForPlatform(projectRoot, platform);
      process.stdout.write(chalk.green('✓ Rules refreshed.\n'));
      process.stdout.write(`  ${path.relative(projectRoot, rulesPath)}\n`);
    } else {
      process.stdout.write(chalk.green('✓ Schemas refreshed.\n'));
    }
    return;
  }

  // --platform flag without --upgrade: change platform
  if (platformFlag !== undefined) {
    const platform = platformFlag as Platform;
    if (!PLATFORMS.includes(platform)) {
      process.stderr.write(chalk.red(`Error: Unknown platform '${platform}'. Use: ${PLATFORMS.join(', ')}\n`));
      process.exit(1);
    }
    const rulesPath = await installRulesForPlatform(projectRoot, platform);
    process.stdout.write(chalk.green('✓ Platform changed.\n'));
    process.stdout.write(`  ${path.relative(projectRoot, rulesPath)}\n`);
    return;
  }

  // Non-TTY: nothing to do
  if (!isTTY()) {
    process.stderr.write(chalk.yellow('.yggdrasil/ already exists. Use --upgrade to refresh.\n'));
    return;
  }

  // Interactive menu
  p.intro(chalk.bold('Yggdrasil Configuration'));

  const action = await p.select<string>({
    message: 'What would you like to do?',
    options: [
      { value: 'upgrade', label: 'Upgrade rules and schemas' },
      { value: 'reviewer', label: 'Configure reviewer' },
      { value: 'platform', label: 'Change platform' },
    ],
  });
  assertNotCancelled(action);

  switch (action) {
    case 'upgrade': {
      const platform = await promptPlatform();
      await refreshSchemas(yggRoot);

      const architecturePath = path.join(yggRoot, 'yg-architecture.yaml');
      try {
        await stat(architecturePath);
      } catch {
        await writeFile(architecturePath, DEFAULT_ARCHITECTURE, 'utf-8');
      }

      const rulesPath = await installRulesForPlatform(projectRoot, platform);
      p.outro(chalk.green(`Rules and schemas refreshed: ${path.relative(projectRoot, rulesPath)}`));
      break;
    }
    case 'reviewer': {
      const reviewerConfig = await runReviewerConfigFlow();
      if (reviewerConfig) {
        await writeReviewerConfig(yggRoot, reviewerConfig);
        if (reviewerConfig.apiKey) {
          await writeSecretsFile(yggRoot, reviewerConfig.provider, reviewerConfig.apiKey);
        }
        p.outro(chalk.green('Reviewer configured.'));
      }
      break;
    }
    case 'platform': {
      const platform = await promptPlatform();
      const rulesPath = await installRulesForPlatform(projectRoot, platform);
      p.outro(chalk.green(`Platform changed: ${path.relative(projectRoot, rulesPath)}`));
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
    .option(
      '--platform <name>',
      'Agent platform: ' + PLATFORMS.join(', '),
    )
    .option('--upgrade', 'Refresh rules and schemas (when .yggdrasil/ already exists)')
    .action(async (options: { platform?: string; upgrade?: boolean }) => {
      try {
        const projectRoot = process.cwd();
        const yggRoot = path.join(projectRoot, '.yggdrasil');

        // Check if .yggdrasil/ already exists
        let exists = false;
        try {
          const statResult = await stat(yggRoot);
          if (!statResult.isDirectory()) {
            process.stderr.write(chalk.red('Error: .yggdrasil exists but is not a directory.\n'));
            process.exit(1);
          }
          exists = true;
        } catch {
          // Directory does not exist
        }

        // Validate platform if provided
        if (options.platform !== undefined && !PLATFORMS.includes(options.platform as Platform)) {
          process.stderr.write(
            chalk.red(`Error: Unknown platform '${options.platform}'. Use: ${PLATFORMS.join(', ')}\n`),
          );
          process.exit(1);
        }

        if (exists) {
          await existingInit(projectRoot, options.platform, options.upgrade);
        } else {
          if (options.upgrade) {
            process.stderr.write(chalk.red('Error: .yggdrasil/ does not exist. Run yg init first.\n'));
            process.exit(1);
          }
          await freshInit(projectRoot, options.platform);
        }
      } catch (err) {
        process.stderr.write(chalk.red(`Error: ${(err as Error).message}\n`));
        process.exit(1);
      }
    });
}
