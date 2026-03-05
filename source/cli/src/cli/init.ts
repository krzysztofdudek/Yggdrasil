import { Command } from 'commander';
import { mkdir, writeFile, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { gt, valid } from 'semver';
import { DEFAULT_CONFIG } from '../templates/default-config.js';
import { installRulesForPlatform, PLATFORMS, type Platform } from '../templates/platform.js';
import { detectVersion, runMigrations } from '../core/migrator.js';
import { MIGRATIONS } from '../migrations/index.js';

function getGraphSchemasDir(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.join(currentDir, '..');
  return path.join(packageRoot, 'graph-schemas');
}

function getCliVersion(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.join(currentDir, '..');
  const pkg = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf-8')) as {
    version: string;
  };
  return pkg.version;
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

const GITIGNORE_CONTENT = `.journal.yaml
.drift-state
journals-archive/
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
      const projectRoot = process.cwd();
      const yggRoot = path.join(projectRoot, '.yggdrasil');

      let upgradeMode = false;
      try {
        const statResult = await stat(yggRoot);
        if (!statResult.isDirectory()) {
          process.stderr.write('Error: .yggdrasil exists but is not a directory.\n');
          process.exit(1);
        }
        if (options.upgrade) {
          upgradeMode = true;
        } else {
          process.stderr.write(
            'Error: .yggdrasil/ already exists. Use --upgrade to refresh rules only.\n',
          );
          process.exit(1);
        }
      } catch {
        // Directory does not exist — proceed with full init
      }

      const platform = (options.platform ?? 'generic') as Platform;
      if (!PLATFORMS.includes(platform)) {
        process.stderr.write(
          `Error: Unknown platform '${platform}'. Use: ${PLATFORMS.join(', ')}\n`,
        );
        process.exit(1);
      }

      if (upgradeMode) {
        const projectVersion = await detectVersion(yggRoot);

        if (!projectVersion) {
          process.stderr.write('Error: No Yggdrasil project found. Run `yg init` first.\n');
          process.exit(1);
        }

        const cliVersion = getCliVersion();

        // Warn if project is newer than CLI
        if (valid(projectVersion) && valid(cliVersion) && gt(projectVersion, cliVersion)) {
          process.stderr.write(
            `Warning: Project version (${projectVersion}) is newer than CLI (${cliVersion}). Upgrade your CLI.\n`,
          );
          process.exit(1);
        }

        // Run migrations if project is older than CLI
        if (valid(projectVersion) && valid(cliVersion) && gt(cliVersion, projectVersion)) {
          process.stdout.write(`Migrating from ${projectVersion} to ${cliVersion}...\n\n`);
          const results = await runMigrations(projectVersion, MIGRATIONS, yggRoot);
          for (const result of results) {
            for (const action of result.actions) {
              process.stdout.write(`  ✓ ${action}\n`);
            }
            for (const warning of result.warnings) {
              process.stdout.write(`  ⚠ ${warning}\n`);
            }
          }
          if (results.length > 0) {
            process.stdout.write('\n');
          }
        }

        // Refresh schemas (copy latest schema files)
        await refreshSchemas(yggRoot);

        // Refresh rules
        const rulesPath = await installRulesForPlatform(projectRoot, platform);
        process.stdout.write('✓ Rules refreshed.\n');
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
          `Warning: Could not copy graph schemas from ${graphSchemasDir}: ${(err as Error).message}\n`,
        );
      }

      await writeFile(path.join(yggRoot, 'yg-config.yaml'), DEFAULT_CONFIG, 'utf-8');
      await writeFile(path.join(yggRoot, '.gitignore'), GITIGNORE_CONTENT, 'utf-8');

      const rulesPath = await installRulesForPlatform(projectRoot, platform);

      process.stdout.write('✓ Yggdrasil initialized.\n\n');
      process.stdout.write('Created:\n');
      process.stdout.write('  .yggdrasil/yg-config.yaml\n');
      process.stdout.write('  .yggdrasil/.gitignore\n');
      process.stdout.write('  .yggdrasil/model/\n');
      process.stdout.write('  .yggdrasil/aspects/\n');
      process.stdout.write('  .yggdrasil/flows/\n');
      process.stdout.write('  .yggdrasil/schemas/ (yg-config, yg-node, yg-aspect, yg-flow)\n');
      process.stdout.write(`  ${path.relative(projectRoot, rulesPath)} (rules)\n\n`);
      process.stdout.write('Next steps:\n');
      process.stdout.write('  1. Edit .yggdrasil/yg-config.yaml — set name and configure node types\n');
      process.stdout.write('  2. Create nodes under .yggdrasil/model/\n');
      process.stdout.write('  3. Run: yg validate\n');
    });
}
