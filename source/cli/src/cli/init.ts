import { Command } from 'commander';
import chalk from 'chalk';
import { mkdir, writeFile, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, DEFAULT_ARCHITECTURE, resolveProjectName } from '../templates/default-config.js';
import { installRulesForPlatform, PLATFORMS, type Platform } from '../templates/platform.js';

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

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize Yggdrasil graph in current project')
    .option(
      '--platform <name>',
      'Agent platform: cursor, claude-code, copilot, cline, roocode, codex, windsurf, aider, gemini, amp, generic',
      'generic',
    )
    .option('--upgrade', 'Refresh rules only (when .yggdrasil/ already exists)')
    .action(async (options: { platform?: string; upgrade?: boolean }) => {
      try {
      const projectRoot = process.cwd();
      const yggRoot = path.join(projectRoot, '.yggdrasil');

      let upgradeMode = false;
      try {
        const statResult = await stat(yggRoot);
        if (!statResult.isDirectory()) {
          process.stderr.write(chalk.red('Error: .yggdrasil exists but is not a directory.\n'));
          process.exit(1);
        }
        if (options.upgrade) {
          upgradeMode = true;
        } else {
          process.stderr.write(
            chalk.red('Error: .yggdrasil/ already exists. Use --upgrade to refresh rules only.\n'),
          );
          process.exit(1);
        }
      } catch {
        // Directory does not exist — proceed with full init
      }

      const platform = (options.platform ?? 'generic') as Platform;
      if (!PLATFORMS.includes(platform)) {
        process.stderr.write(
          chalk.red(`Error: Unknown platform '${platform}'. Use: ${PLATFORMS.join(', ')}\n`),
        );
        process.exit(1);
      }

      if (upgradeMode) {
        // Refresh schemas (copy latest schema files)
        await refreshSchemas(yggRoot);

        // Create or refresh architecture file (if missing)
        const architecturePath = path.join(yggRoot, 'yg-architecture.yaml');
        try {
          await stat(architecturePath);
        } catch {
          // File doesn't exist, create it
          await writeFile(architecturePath, DEFAULT_ARCHITECTURE, 'utf-8');
        }

        // Refresh rules
        const rulesPath = await installRulesForPlatform(projectRoot, platform);
        process.stdout.write(chalk.green('✓ Rules refreshed.\n'));
        process.stdout.write(`  ${path.relative(projectRoot, rulesPath)}\n`);
        return;
      }

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
          chalk.yellow(`Warning: Could not copy graph schemas from ${graphSchemasDir}: ${(err as Error).message}\n`),
        );
      }

      const projectName = await resolveProjectName(projectRoot);
      const config = DEFAULT_CONFIG.replace('name: ""', `name: "${projectName}"`);
      await writeFile(path.join(yggRoot, 'yg-config.yaml'), config, 'utf-8');
      await writeFile(path.join(yggRoot, 'yg-architecture.yaml'), DEFAULT_ARCHITECTURE, 'utf-8');
      await writeFile(path.join(yggRoot, '.gitignore'), GITIGNORE_CONTENT, 'utf-8');
      await writeFile(path.join(yggRoot, 'yg-secrets.example.yaml'), SECRETS_EXAMPLE_CONTENT, 'utf-8');

      const rulesPath = await installRulesForPlatform(projectRoot, platform);

      process.stdout.write(chalk.green('✓ Yggdrasil initialized.') + '\n\n');
      process.stdout.write('Created:\n');
      process.stdout.write('  .yggdrasil/yg-config.yaml\n');
      process.stdout.write('  .yggdrasil/yg-architecture.yaml\n');
      process.stdout.write('  .yggdrasil/.gitignore\n');
      process.stdout.write('  .yggdrasil/yg-secrets.example.yaml\n');
      process.stdout.write('  .yggdrasil/model/\n');
      process.stdout.write('  .yggdrasil/aspects/\n');
      process.stdout.write('  .yggdrasil/flows/\n');
      process.stdout.write('  .yggdrasil/schemas/ (yg-config, yg-node, yg-aspect, yg-flow)\n');
      process.stdout.write(`  ${path.relative(projectRoot, rulesPath)} (rules)\n\n`);
      process.stdout.write('Next steps:\n');
      process.stdout.write('  1. Edit .yggdrasil/yg-config.yaml — set name and configure node types\n');
      process.stdout.write('  2. Create nodes under .yggdrasil/model/\n');
      process.stdout.write('  3. Run: yg check\n');
      } catch (err) {
        process.stderr.write(chalk.red(`Error: ${(err as Error).message}\n`));
        process.exit(1);
      }
    });
}
