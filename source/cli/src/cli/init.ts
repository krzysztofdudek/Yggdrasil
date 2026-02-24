import { Command } from 'commander';
import { mkdir, writeFile, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '../templates/default-config.js';
import { installRulesForPlatform, PLATFORMS, type Platform } from '../templates/platform.js';

function getGraphTemplatesDir(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.join(currentDir, '..');
  return path.join(packageRoot, 'graph-templates');
}

const GITIGNORE_CONTENT = `.journal.yaml
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
        const rulesPath = await installRulesForPlatform(projectRoot, platform);
        process.stdout.write('✓ Rules refreshed.\n');
        process.stdout.write(`  ${path.relative(projectRoot, rulesPath)}\n`);
        return;
      }

      await mkdir(path.join(yggRoot, 'model'), { recursive: true });
      await mkdir(path.join(yggRoot, 'aspects'), { recursive: true });
      await mkdir(path.join(yggRoot, 'flows'), { recursive: true });
      await mkdir(path.join(yggRoot, 'knowledge', 'decisions'), { recursive: true });
      await mkdir(path.join(yggRoot, 'knowledge', 'patterns'), { recursive: true });
      await mkdir(path.join(yggRoot, 'knowledge', 'invariants'), { recursive: true });
      const templatesDir = path.join(yggRoot, 'templates');
      await mkdir(templatesDir, { recursive: true });

      const graphTemplatesDir = getGraphTemplatesDir();
      try {
        const entries = await readdir(graphTemplatesDir, { withFileTypes: true });
        const templateFiles = entries.filter((e) => e.isFile()).map((e) => e.name);
        for (const file of templateFiles) {
          const srcPath = path.join(graphTemplatesDir, file);
          const content = await readFile(srcPath, 'utf-8');
          await writeFile(path.join(templatesDir, file), content, 'utf-8');
        }
      } catch (err) {
        process.stderr.write(
          `Warning: Could not copy graph templates from ${graphTemplatesDir}: ${(err as Error).message}\n`,
        );
      }

      await writeFile(path.join(yggRoot, 'config.yaml'), DEFAULT_CONFIG, 'utf-8');
      await writeFile(path.join(yggRoot, '.gitignore'), GITIGNORE_CONTENT, 'utf-8');

      const rulesPath = await installRulesForPlatform(projectRoot, platform);

      process.stdout.write('✓ Yggdrasil initialized.\n\n');
      process.stdout.write('Created:\n');
      process.stdout.write('  .yggdrasil/config.yaml\n');
      process.stdout.write('  .yggdrasil/.gitignore\n');
      process.stdout.write('  .yggdrasil/model/\n');
      process.stdout.write('  .yggdrasil/aspects/\n');
      process.stdout.write('  .yggdrasil/flows/\n');
      process.stdout.write('  .yggdrasil/knowledge/ (decisions, patterns, invariants)\n');
      process.stdout.write(
        '  .yggdrasil/templates/ (node, aspect, flow, knowledge)\n',
      );
      process.stdout.write(`  ${path.relative(projectRoot, rulesPath)} (rules)\n\n`);
      process.stdout.write('Next steps:\n');
      process.stdout.write('  1. Edit .yggdrasil/config.yaml — set name, stack, standards\n');
      process.stdout.write('  2. Create nodes under .yggdrasil/model/\n');
      process.stdout.write('  3. Run: yg validate\n');
    });
}
